# AI Voice Agent — Appliance Repair

A production-grade inbound voice agent for an appliance repair company. It answers the
phone, works out what is broken, gives a price the business will stand behind, books a
technician into Google Calendar and alerts dispatch on Telegram or Slack.

**[Take a call →](https://ai-voice-agent-appliance-repair.vercel.app)** — no sign-up, no
API key. Speak or type.

```
AGENT   Thanks for calling Northside Appliance Repair. Is that Tom? What's going on?
        > lookup_customer                                                      1 ms
CALLER  It's the washing machine again - it's not draining.
AGENT   Hang on - our records show we repaired that same fault for you recently, and
        it's still under our workmanship warranty. So there's no call-out and no
        charge. Shall I get someone back out?
        > triage_appliance    Washing machine will not drain                   1 ms
```

---

## What this is really demonstrating

Most voice-agent demos are a prompt and a text-to-speech voice. The hard parts of a
production phone line are elsewhere, and this repo is built around them.

**The model never states a fact the business owns.** It maps free speech onto a catalogue
`symptomId`; every price after that is arithmetic over the catalogue and the rate card.
An eval invariant enforces it — any dollar figure the agent speaks must appear in a
`quote_job` result, or the suite fails. The same applies to arrival windows: the agent can
only offer a window `check_availability` returned, and can only book a slot it offered.

**Failure modes are handled, not hoped about.**

| Failure | What happens |
|---|---|
| Google Calendar returns 5xx mid-booking | Job is kept, dispatch is paged with the window and address, caller keeps their slot |
| A booking is retried | Deterministic event id → 409 → read back. One job, one event |
| Telegram and Slack both down | Recorded on the call record; never surfaced to the caller, never fails a booking |
| The model provider throws | Call transfers to a human and the on-call channel is paged |
| ASR confidence below 0.45 | Agent asks the caller to repeat rather than acting on it |
| Model asks for a tool the current stage forbids | Rejected with a reason it can act on |
| Model repeats an identical failing call | One retry, then stop — a loop is dead air on a phone line |
| Caller mentions gas, smoke or sparks | Safety script first, then emergency dispatch or transfer |
| Caller asks for a person | Immediate transfer. No sales resistance, no triage detour |

**It is honest about what it is doing.** With no credentials the header reads
`Brain: rules fallback · Calendar: in-memory · Alerts: in-memory`, and the in-memory
calendar deliberately emits no link, so nothing on the page points at a Google event that
does not exist.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
  browser demo ───▶ │                                          │
  Twilio <Gather> ─▶│   src/lib/agent   ── the whole agent      │──▶ Google Calendar
  VAPI / Retell ───▶│   (imports no framework, no transport)   │──▶ Telegram / Slack
                    └──────────────────────────────────────────┘──▶ CRM
```

`src/lib/agent` has no dependency on Next.js, on HTTP or on a telephony vendor. That is
what lets the browser console, the Twilio webhook and the eval harness run the *same*
code, and it is why the eval suite is worth anything.

### The turn loop

A turn is a loop, not a single model call:

```
caller speaks
  └─ round 0  brain → [triage_appliance]        → tools run
  └─ round 1  brain → speaks the triage result  → no tools
agent speaks
```

Without the second round the agent can only ever say "let me check" and the caller hears
the answer a turn late. Bounded by `maxTurns`, `maxToolRoundsPerTurn` and
`maxToolCallsPerRound`.

### Two brains, one tool schema

`AnthropicBrain` does tool calling. `DeterministicBrain` is a slot-filling dialogue
manager over the **identical** tool schema. That buys three things:

- the hosted demo runs with no API key and no per-visitor cost;
- the eval suite is hermetic, so a failure is a bug in the tools, the state machine or the
  domain — never model variance;
- production has a fallback. A rigid agent that still books jobs beats a dead phone line.

### The conversation state machine

```
greeting → identify → triage → quote → schedule → confirm → wrap → ended
                ↓        ↓       ↓         ↓         ↓        ↓
              escalated (reachable from every stage)
```

Transitions are a graph with entry requirements. `confirm` requires a name, a callback
number and an address, so a confused model cannot book a job it has nowhere to send a van.
When a brain names the stage it wants to *end up* in rather than the next one,
`nextLegalStep` walks one legal hop toward it instead of stranding the call.

Full write-up: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## The tools

| Tool | Mutating | Available in |
|---|---|---|
| `lookup_customer` | | greeting, identify, triage |
| `record_caller_details` | | all |
| `triage_appliance` | | greeting, identify, triage, quote |
| `quote_job` | | triage, quote, schedule |
| `check_availability` | | triage, quote, schedule, confirm |
| `select_slot` | | schedule, confirm |
| `book_appointment` | ● | schedule, confirm |
| `reschedule_appointment` | ● | schedule, confirm, wrap |
| `send_notification` | ● | all |
| `create_ticket` | ● | all |
| `escalate_to_human` | ● | all |

Handlers never throw for expected failures — they return `{ ok: false, reason, hint }`,
because an unhandled exception on a phone call is silence. Every mutating tool carries an
idempotency key derived from the session.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm run verify       # typecheck + lint + 84 tests
npm run eval:report  # replay all 12 caller scenarios and print the transcripts
npm run test:e2e     # 20 Playwright tests, desktop and mobile
```

Every credential is optional — see [`.env.example`](.env.example). Add
`ANTHROPIC_API_KEY` and Claude drives the call; add Google service-account credentials and
bookings become real calendar events; add a Telegram bot token and dispatch gets pinged.
Each port resolves independently, and the header says which ones are live.

---

## Verification

```
84 unit + eval tests          12/12 caller scenarios, 50 tool calls, 0 rejected
20 Playwright tests           desktop + Pixel 7 viewports
```

The eval suite is the interesting half. Twelve scripted callers are replayed end to end
against the real tools with a pinned clock, asserting the tool sequence, the calendar
write, the notification and the outcome:

| Scenario | What it protects |
|---|---|
| `known_customer_books_fridge` | Caller-ID lookup, triage, quoting, a clean booking |
| `new_customer_washer_drip_fed_details` | Name, number and address arriving over five turns — and never booking before the address exists |
| `dryer_burning_smell_emergency` | Safety script fires, severity escalates, on-call is paged |
| `gas_smell_escalates` | Gas is never handled by the bot |
| `asks_for_human_immediately` | One turn to a transfer, no sales resistance |
| `angry_caller_escalates_urgently` | Complaints reach a person at emergency priority |
| `declines_after_quote` | A polite no ends the call cleanly |
| `vague_then_specific` | Asks which appliance instead of guessing |
| `picks_slot_by_weekday` | "Tuesday, if you've got it" lands on Tuesday |
| `warranty_repeat_visit` | We do not charge twice for the same repair |
| `garbled_audio_asks_again` | Never acts on audio it did not hear |
| `friday_afternoon_rollover` | Lead times and weekend rules at a week boundary |

Adding a scenario is how a bug report becomes a test. More in
**[docs/EVALS.md](docs/EVALS.md)**.

---

## Taking real calls

Two transports, and the choice is a latency/complexity trade-off — **[docs/TELEPHONY.md](docs/TELEPHONY.md)**
covers both.

- **Twilio `<Gather>`** — implemented end to end, including request-signature verification,
  silence handling and warm transfer. Runs anywhere, ~1.5–2.5s turns, no barge-in.
- **VAPI or Retell** — sub-second turns and real barge-in. The assistant definition is
  *generated* from the same `TOOLS` array and prompt builder, so a tool added to the agent
  cannot silently go missing from the hosted deployment.
- **Twilio Media Streams** — lowest latency, needs a long-lived process. Documented, not
  deployed here, because a repair shop should not be running a WebSocket fleet.

---

## Repo map

```
src/lib/domain/         appliance catalogue, rate card, dispatch scheduling, CRM
src/lib/agent/          state machine, tools, prompts, brains, turn loop, redaction
src/lib/integrations/   calendar and messaging ports + Google, Telegram, Slack, in-memory
src/lib/telephony/      TwiML, signature verification, call store, provider exports
src/lib/api/            HTTP contract and per-request wiring
src/evals/              scenarios, replay harness, report script
src/components/         the dispatch console
docs/                   architecture, telephony, integrations, evals
```

---

Built by [Usama Akram](https://github.com/uusammmaa). MIT licensed — take it apart.
