# Evals

Twelve scripted callers, replayed end to end against the real tools, the real state machine
and the real domain logic.

```bash
npm run eval:report                          # summary table
npm run eval:report -- --verbose             # every transcript
npm run eval:report -- warranty_repeat_visit # one scenario
npm run test:evals                           # the same thing as a vitest file, for CI
```

## What makes these worth running

**They are hermetic.** The clock is pinned per scenario and advanced by a fixed step per
utterance; ids come from an injected counter; the brain is deterministic. Two runs of the
same scenario produce byte-identical transcripts, and there is a test asserting exactly
that. Anything that varies between runs is a bug, not flake.

**They fail for real reasons.** Because the deterministic brain has no model in it, a
failing scenario means something broke in the tools, the state machine, the scheduler or
the catalogue. There is no "the model was having an off day" to hide behind.

**They assert on outcomes, not wording.** The checks are: which tools ran and in what
order, what landed on the calendar, who got paged, what the caller was told about money,
and what the call was ultimately for. Not "the agent said the word 'sorry'".

## Universal invariants

These run against every scenario, which is cheaper than restating them twelve times:

- **No dollar figure the agent speaks may be absent from a `quote_job` result.** This is
  the one that matters most. It is the difference between an agent that quotes and an
  agent that guesses, and it is enforced mechanically rather than by reading transcripts.
- At most one booking per call.
- Every booking has an address, a callback number, and an end after its start.
- No booking exists if `book_appointment` failed.
- No markdown, asterisks or "as an AI" in anything spoken — a TTS engine reads those out.

## Anatomy

```ts
{
  id: "warranty_repeat_visit",
  title: "Repeat of a fault still inside the workmanship warranty",
  guards: "We do not charge twice for the same repair.",
  now: "2026-09-21T16:00:00.000Z",
  fromNumber: "+14085550198",
  turns: ["It's the washing machine again - it's not draining.", ...],
  expect: {
    bookingExpected: true,
    toolsCalled: ["lookup_customer", "triage_appliance"],
    slots: { warrantyCovered: true },
    custom: (session) => {
      const said = agentSpeech(session);
      const errors = [];
      if (!/warranty|no charge/.test(said)) errors.push("never told the caller it was covered");
      if (session.slots.quotedLowUsd) errors.push("quoted a price for a warranty revisit");
      return errors;
    },
  },
}
```

`guards` is the field that stops the suite rotting. It is one line saying what would break
in the business if this scenario stopped passing, which is the thing a future reader needs
and the thing that is always missing six months later.

## The scenarios

| id | Guards |
|---|---|
| `known_customer_books_fridge` | Caller-ID lookup, triage, quoting from the rate card, a clean booking |
| `new_customer_washer_drip_fed_details` | Slot filling over five turns; never booking before the address exists |
| `dryer_burning_smell_emergency` | Safety script fires, severity escalates, on-call is paged |
| `gas_smell_escalates` | Gas is never handled by the bot; it goes to a person |
| `asks_for_human_immediately` | No sales resistance, no triage detour — transfer on the first ask |
| `angry_caller_escalates_urgently` | Complaints reach a human fast and at emergency priority |
| `declines_after_quote` | A polite no ends the call cleanly instead of pushing |
| `vague_then_specific` | The agent asks a clarifying question rather than guessing an appliance |
| `picks_slot_by_weekday` | Slot selection by weekday, not only by ordinal |
| `warranty_repeat_visit` | We do not charge twice for the same repair |
| `garbled_audio_asks_again` | The agent never acts on audio it did not hear properly |
| `friday_afternoon_rollover` | Lead times and weekend rules at a week boundary |

Two pinned clocks: a Monday morning well inside business hours with no DST edge nearby,
and a Friday afternoon where "today" slots still exist but the week rolls over.

## Adding one

A bug report becomes a scenario:

1. Add an entry to `SCENARIOS` with the caller's actual words.
2. Write `guards` as the business consequence, not the technical symptom.
3. Assert the narrowest thing that would have caught it.
4. Watch it fail, then fix the bug.

If the assertion needs something the expectation shape does not cover, use `custom` rather
than widening the shape. Most one-off checks are genuinely one-off.

## What these do not cover

**Model behaviour.** The suite runs the deterministic brain, so it says nothing about
whether Claude phrases the quote well or knows when to stop talking. Running the same
scenarios against `AnthropicBrain` is a one-line change (`runScenario(scenario, { brainFactory })`),
but the assertions would need to become fuzzy — tool *sets* rather than sequences, outcomes
rather than exact slots — and it costs money per run, so it is not in CI.

The split is deliberate. This suite answers "is the machinery correct". A model eval
answers "does it sound like a person". Mixing them gives you a suite that fails for two
unrelated reasons and tells you nothing about either.

**Audio.** No ASR, no TTS, no barge-in timing, no network jitter. Those need a real call
and a stopwatch.

**Concurrency.** Every scenario is one call at a time.
