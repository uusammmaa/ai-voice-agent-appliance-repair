# Architecture

Why the pieces are where they are, and what would break if they moved.

## The one rule

`src/lib/agent` imports nothing from Next.js, nothing from a telephony vendor and nothing
that does I/O of its own. Every outside effect goes through a port in
`src/lib/integrations`, and the runner is handed those ports.

That is not architecture for its own sake. It is what makes the eval suite mean something:
the twelve scenarios drive the *same* code path a real phone call drives, with the same
tools, the same state machine and the same domain logic. A test suite that exercises a
parallel implementation proves nothing about the thing that answers the phone.

It also means adding a transport is a new file, not a refactor. The browser console, the
Twilio webhook and the eval harness are three callers of one `CallRunner`.

## Layers

```
src/lib/domain/          What the business knows. No model, no I/O, pure functions.
  catalog.ts             13 symptoms across 8 appliance classes: causes with
                         likelihoods, parts ranges, labour minutes, safety flags.
  pricing.ts             Rate card → quote. Arithmetic only.
  scheduling.ts          Technician skills and shifts, slot generation, timezone maths.
  customers.ts           CRM surface. In-memory here; a ServiceTitan adapter in reality.

src/lib/agent/           How the conversation is conducted.
  types.ts               Session, slots, tool contract, brain contract.
  state-machine.ts       Legal transitions, entry requirements, shortest legal hop.
  tools.ts               The tool surface, with handlers that call into domain.
  prompt.ts              System prompt, assembled per turn from the current stage.
  brains/                anthropic.ts (tool calling) and deterministic.ts (rules).
  session.ts             The turn loop, tool execution, escalation, wiring from env.
  redact.ts              PII reduction for anything persisted.

src/lib/integrations/    The outside world, behind ports.
src/lib/telephony/       TwiML, signature verification, call store, provider exports.
src/lib/api/             HTTP contract (zod) and per-request wiring.
src/evals/               Scenarios and the replay harness.
```

## The turn loop

```
turn(callerText)
  ├── confidence < 0.45?  →  "could you say that again"  (no tools, no model call)
  ├── turn count exceeded? →  escalate
  │
  ├── round 0
  │     brain.respond({ session, availableTools: toolsForState(state), pendingToolResults: [] })
  │     → runTools(response.toolCalls)
  │
  ├── round 1
  │     brain.respond({ ..., pendingToolResults: round0Results })
  │     → runTools(...)          ← usually empty; this is the round that speaks
  │
  ├── round 2 (cap)
  │
  ├── push the agent's line
  ├── state := nextLegalStep(state, requestedOrInferredState)
  └── stalled 3 turns running?  →  escalate
```

Three bounds, each for a different failure:

- `maxToolCallsPerRound` — a model that asks for nine tools at once.
- `maxToolRoundsPerTurn` — a model that keeps calling tools instead of speaking.
- `maxTurns` / `maxStalledTurns` — a call that will never end, and a call that is going
  nowhere.

Plus one more: if a round's tool calls are byte-identical to the previous round's *and all
of them failed*, the loop stops. Feeding an error back once is how a model corrects a bad
argument; doing it twice is a loop, and on a phone line a loop is dead air.

## Why tool gating lives in the state machine

Each tool declares `allowedStates`. The runner checks it before executing, and the prompt
only lists the tools legal right now.

This is belt and braces on purpose. Narrowing the prompt keeps the model on task; checking
at execution time means a model that hallucinates a tool name, or replays an old tool call
from its context, cannot book a job during the greeting. The rejection comes back as a
readable reason, so the model can recover rather than repeat itself.

Entry requirements are the second half. `confirm` requires `chosenSlotId`, `callerName`,
`phone` and `address`. There is no code path that books a job without an address, because
the transition into the stage where booking is legal will not happen without one.

## `nextLegalStep`

A brain that has just learned something usually names the state it wants to *end up* in —
"we have a symptom, so we're quoting" — while the call is formally still in `identify`.
Refusing that outright strands the conversation in a stage whose tools it no longer needs.

So the runner does a breadth-first search over the transition graph, honouring entry
requirements, and takes one hop toward the target. `identify → quote` is not an edge, but
`identify → triage → quote` is a path, so the call moves to `triage` and gets there next
turn. Genuinely illegal destinations still return `null` and are refused and logged.

## The two brains

Both implement:

```ts
interface Brain {
  respond(request: BrainRequest): Promise<BrainResponse>;
}
```

`BrainRequest` carries the session, the tools legal in this stage, the assembled system
prompt, and `pendingToolResults` — what ran earlier in *this* turn.

**`AnthropicBrain`** rebuilds the provider message list from the session on every call.
Anthropic requires each `tool_use` block to be answered by a matching `tool_result` in the
immediately following user message, and reconstructing that pairing from timestamps across
two logs is exactly where this kind of code breaks. So the runner stamps every utterance
and every tool call with its turn and round, and the message builder just walks that
structure. The system prompt is marked for caching and the transcript is windowed, because
prompt length is latency and latency is the whole game on a call.

**`DeterministicBrain`** is a slot-filling dialogue manager. Round 0 reads the caller's
utterance and calls the tool that moves things on; round 1 reads the tool results and says
something useful. It handles intent (price, booking, affirmation, refusal, transfer
request, safety), entity extraction (name, phone, address, email, gate codes) and slot
selection ("the second one", "Tuesday", "whatever's soonest").

It is keyword-based and will miss phrasings. That is the accepted cost of a dependency-free
fallback, and the evals pin its behaviour so regressions surface.

## Where state lives

| Deployment | Session lives in | Why |
|---|---|---|
| Browser console | The browser, posted back each turn | Serverless has no reliable in-process memory, and there is no shared state to clean up |
| Twilio webhook | `CallStore`, server-side | Twilio sends a `CallSid` and nothing else, and the caller is not a trustworthy place to keep a session |
| VAPI / Retell | The provider | They own the turn loop; we own the tools |

`CallStore` is three methods — `get`, `set`, `delete` — with an in-process implementation
and a REST-Redis one. Which you need depends on whether your host keeps a process alive,
and that should be a config change rather than a refactor.

## Idempotency

Two independent layers, because they fail differently.

**At the tool.** `book_appointment` checks `slots.bookingId` and returns the existing job
rather than creating a second one. That covers a model retrying within a call.

**At the adapter.** The Google adapter derives a deterministic event id from the booking's
idempotency key (`${sessionId}:${slotId}`) and lets Google reject the duplicate with a 409,
then reads the existing event back. That covers a network retry where the first request
actually succeeded and we never saw the response — the case the tool-level check cannot
see.

## Degradation

Ordered by what the caller notices.

1. **Messenger down.** Recorded on the call record as `FAILED <priority>: <title>`. The
   caller notices nothing. Dispatch reconciles from the calendar.
2. **Calendar down.** The booking still happens. Dispatch gets a high-priority alert
   naming the window and the address so a human can add it by hand. The caller keeps their
   slot — losing the job to protect a database row would be the wrong trade.
3. **Model down.** The call transfers to a person and on-call is paged. If configured, the
   deterministic brain can take over instead of transferring.
4. **Everything down.** The Twilio path falls back to `<Say>` plus `<Hangup>` with a
   promise of a callback, which is still better than a dropped line.

## Privacy

The live session holds real values because the agent needs them. Anything persisted goes
through `redactDeep` first: phone numbers become `***-***-1234`, emails keep two
characters and the domain, card-length digit runs are dropped entirely, and addresses keep
the street number and the city but lose the street — enough for a technician log to be
useful, not enough to be a leak.

Card-length runs are matched *before* phone numbers, so a caller reading out a card number
is redacted as a card rather than partially preserved as a phone number.
