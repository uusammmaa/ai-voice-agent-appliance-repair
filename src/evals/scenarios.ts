import type { CallOutcome, CallSession, CallSlots, ConversationState } from "@/lib/agent/types";

/**
 * Scripted caller scenarios.
 *
 * These are the regression suite for the *agent*, not for the model. Each one pins the
 * clock, replays a caller through the real tools and real state machine, and asserts on
 * what the business cares about: did the right tools fire, did a job get on the calendar,
 * did the right person get alerted, and did the caller get told the truth about price.
 *
 * Adding a scenario is how a bug report becomes a test here.
 */

export interface ScenarioExpectation {
  outcome?: CallOutcome;
  finalState?: ConversationState;
  /** Tools that must have been called successfully at least once. */
  toolsCalled?: string[];
  /** Tools that must never have been called. */
  toolsNotCalled?: string[];
  slots?: Partial<Record<keyof CallSlots, unknown>>;
  bookingExpected?: boolean;
  /** A notification whose title contains this string must have been sent. */
  notificationMatching?: string;
  /** Free-form assertions. Return a list of failure messages, empty when satisfied. */
  custom?: (session: CallSession) => string[];
}

export interface Scenario {
  id: string;
  title: string;
  /** What this scenario is protecting against, in one line. */
  guards: string;
  /** Pinned so slot labels and availability are identical on every run. */
  now: string;
  fromNumber?: string;
  /** Caller utterances, in order. A number is the ASR confidence for that turn. */
  turns: Array<string | { text: string; confidence?: number }>;
  expect: ScenarioExpectation;
}

/** A Monday morning, well inside business hours, with no DST edge nearby. */
const MONDAY_9AM_PT = "2026-09-21T16:00:00.000Z";
/** A Friday afternoon, so "today" slots still exist but the week rolls over. */
const FRIDAY_2PM_PT = "2026-09-25T21:00:00.000Z";

export const SCENARIOS: Scenario[] = [
  {
    id: "known_customer_books_fridge",
    title: "Known customer, fridge not cooling, books the first window",
    guards: "Caller ID lookup, triage, quoting from the rate card, and a clean booking.",
    now: MONDAY_9AM_PT,
    fromNumber: "+14155550142",
    turns: [
      "Hi, my fridge is not cooling at all since yesterday.",
      "I already checked the thermostat, it's set right.",
      "Yes please, give me a price.",
      "Okay let's do it, book someone in.",
      "The first one works.",
      "No that's it, thanks.",
    ],
    expect: {
      outcome: "booked",
      bookingExpected: true,
      toolsCalled: ["lookup_customer", "triage_appliance", "quote_job", "check_availability", "book_appointment"],
      toolsNotCalled: ["escalate_to_human"],
      slots: { symptomId: "fridge_not_cooling", customerId: "cus_1001" },
      notificationMatching: "New job booked",
      custom: (session) => {
        const errors: string[] = [];
        const booking = session.bookings[0];
        if (!booking) return ["no booking recorded"];
        if (!booking.calendarEventId) errors.push("booking has no calendar event id");
        if (booking.address !== "1820 Larkspur Lane, San Rafael, CA") {
          errors.push(`address came from the caller, not the CRM: ${booking.address}`);
        }
        const quoted = session.slots.quotedLowUsd;
        if (!quoted || quoted < 100) errors.push(`quote looks wrong: ${quoted}`);
        return errors;
      },
    },
  },
  {
    id: "new_customer_washer_drip_fed_details",
    title: "New customer gives name, phone and address across separate turns",
    guards: "Slot filling over several turns, and that we never book without an address.",
    now: MONDAY_9AM_PT,
    turns: [
      "My washing machine won't drain, there's water sitting in the drum.",
      "Yeah I checked the filter, nothing in it. What would a repair cost?",
      "Fine, book it in.",
      "The second one.",
      "My name is Daniel Okafor.",
      "It's 415 555 0164.",
      "I'm at 1204 Cedar Street, Berkeley. There's a dog in the yard.",
      "That's all, cheers.",
    ],
    expect: {
      outcome: "booked",
      bookingExpected: true,
      toolsCalled: ["triage_appliance", "record_caller_details", "quote_job", "check_availability", "book_appointment"],
      slots: { symptomId: "washer_not_draining", callerName: "Daniel Okafor" },
      custom: (session) => {
        const errors: string[] = [];
        const booking = session.bookings[0];
        if (!booking) return ["no booking recorded"];
        if (!/Cedar Street/i.test(booking.address)) errors.push(`address not captured: ${booking.address}`);
        if (!/dog/i.test(booking.notes)) errors.push("dog on the property was not passed to the technician");

        // The booking must come after the address was known, never before.
        const bookCall = session.toolCalls.find((c) => c.name === "book_appointment" && !c.error);
        const addressCall = session.toolCalls.find(
          (c) => c.name === "record_caller_details" && /Cedar/i.test(JSON.stringify(c.args ?? {})),
        );
        if (bookCall && addressCall && bookCall.startedAt < addressCall.startedAt) {
          errors.push("booked before the address was recorded");
        }
        return errors;
      },
    },
  },
  {
    id: "dryer_burning_smell_emergency",
    title: "Burning smell from the dryer is treated as an emergency",
    guards: "Safety script fires, severity escalates, and the on-call channel is alerted.",
    now: MONDAY_9AM_PT,
    turns: [
      "There's a burning smell coming from my dryer.",
      "Okay, I've unplugged it.",
      "Yes, today if you can.",
      "The first one please.",
      "Marianne Cole.",
      "415 555 0188.",
      "88 Pine Ridge Road, San Rafael.",
      "No that's everything.",
    ],
    expect: {
      outcome: "emergency_dispatched",
      bookingExpected: true,
      toolsCalled: ["triage_appliance", "check_availability", "book_appointment"],
      slots: { symptomId: "dryer_burning_smell", severity: "emergency", safetyWarningGiven: true },
      notificationMatching: "EMERGENCY",
      custom: (session) => {
        const errors: string[] = [];
        const said = session.transcript
          .filter((u) => u.speaker === "agent")
          .map((u) => u.text)
          .join(" ")
          .toLowerCase();
        if (!/unplug|switch it off|stop using/.test(said)) {
          errors.push("agent never told the caller to stop using the appliance");
        }
        return errors;
      },
    },
  },
  {
    id: "gas_smell_escalates",
    title: "Caller smells gas and asks for help",
    guards: "Gas is never handled by the bot; it goes to a person immediately.",
    now: MONDAY_9AM_PT,
    turns: ["I can smell gas near the oven, is that something you deal with?", "Yes please, put me through to someone."],
    expect: {
      outcome: "escalated",
      finalState: "escalated",
      toolsCalled: ["escalate_to_human"],
      toolsNotCalled: ["book_appointment"],
      notificationMatching: "Live transfer",
    },
  },
  {
    id: "asks_for_human_immediately",
    title: "Caller asks for a person on the first turn",
    guards: "No sales resistance, no triage detour - transfer on the first ask.",
    now: MONDAY_9AM_PT,
    turns: ["Can I speak to a real person please?"],
    expect: {
      outcome: "escalated",
      finalState: "escalated",
      toolsCalled: ["escalate_to_human"],
      toolsNotCalled: ["triage_appliance", "quote_job", "book_appointment"],
      custom: (session) => (session.metrics.turns > 2 ? ["took more than one turn to transfer"] : []),
    },
  },
  {
    id: "angry_caller_escalates_urgently",
    title: "Unhappy caller is routed to the on-call channel",
    guards: "Complaints reach a human fast and at high priority.",
    now: MONDAY_9AM_PT,
    turns: ["This is absolutely unacceptable, your engineer never turned up last week."],
    expect: {
      outcome: "escalated",
      toolsCalled: ["escalate_to_human"],
      custom: (session) => {
        const emergency = session.notifications.some((n) => n.startsWith("emergency"));
        return emergency ? [] : ["complaint was not raised at emergency priority"];
      },
    },
  },
  {
    id: "declines_after_quote",
    title: "Caller takes the estimate and decides not to book",
    guards: "A polite no ends the call cleanly instead of pushing for the sale.",
    now: MONDAY_9AM_PT,
    turns: [
      "My dishwasher isn't draining properly.",
      "How much would it be to fix?",
      "No thanks, that's more than I want to spend right now.",
    ],
    expect: {
      outcome: "quoted_no_booking",
      toolsCalled: ["triage_appliance", "quote_job"],
      toolsNotCalled: ["book_appointment"],
      custom: (session) => {
        const last = session.transcript.filter((u) => u.speaker === "agent").at(-1)?.text ?? "";
        return /call us back|ring us back|any time/i.test(last) ? [] : [`closing line was not a clean exit: "${last}"`];
      },
    },
  },
  {
    id: "vague_then_specific",
    title: "Caller starts vague, then describes the fault",
    guards: "The agent asks a clarifying question rather than guessing an appliance.",
    now: MONDAY_9AM_PT,
    turns: [
      "Hi, something's wrong with one of my appliances.",
      "The oven. It won't get hot any more.",
      "Yes, what's the damage?",
      "No, leave it for now, I'll call back.",
    ],
    expect: {
      outcome: "quoted_no_booking",
      toolsCalled: ["triage_appliance", "quote_job"],
      slots: { symptomId: "oven_not_heating" },
      custom: (session) => {
        // [0] is the scripted greeting; [1] is the first real reply.
        const reply = session.transcript.filter((u) => u.speaker === "agent")[1]?.text ?? "";
        return /which appliance|what.s it doing/i.test(reply)
          ? []
          : [`reply to a vague opener should have asked which appliance: "${reply}"`];
      },
    },
  },
  {
    id: "picks_slot_by_weekday",
    title: "Caller picks a window by naming the day",
    guards: "Slot selection by weekday, not just by ordinal.",
    now: MONDAY_9AM_PT,
    turns: [
      "The burner on my cooktop isn't working.",
      "Yes, price it up for me.",
      "Go ahead and book it.",
      "Tuesday, if you've got it.",
      "Rosa Delgado.",
      "650 555 0123.",
      "9 Vineyard Court, Redwood City.",
      "Nothing else, thanks.",
    ],
    expect: {
      outcome: "booked",
      bookingExpected: true,
      slots: { symptomId: "cooktop_burner_dead" },
      custom: (session) => {
        const booking = session.bookings[0];
        if (!booking) return ["no booking recorded"];
        const weekday = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          weekday: "long",
        }).format(new Date(booking.startsAt));
        return weekday === "Tuesday" ? [] : [`booked ${weekday}, caller asked for Tuesday`];
      },
    },
  },
  {
    id: "warranty_repeat_visit",
    title: "Repeat of a fault still inside the workmanship warranty",
    guards: "We do not charge twice for the same repair.",
    now: MONDAY_9AM_PT,
    fromNumber: "+14085550198",
    turns: [
      "It's the washing machine again - it's not draining.",
      "Yes please, get someone back out.",
      "The first one.",
      "That's all.",
    ],
    expect: {
      bookingExpected: true,
      toolsCalled: ["lookup_customer", "triage_appliance"],
      slots: { warrantyCovered: true },
      custom: (session) => {
        const said = session.transcript
          .filter((u) => u.speaker === "agent")
          .map((u) => u.text)
          .join(" ")
          .toLowerCase();
        const errors: string[] = [];
        if (!/warranty|no charge|no call-?out/.test(said)) errors.push("never told the caller it was covered");
        if (session.slots.quotedLowUsd) errors.push("quoted a price for a warranty revisit");
        return errors;
      },
    },
  },
  {
    id: "garbled_audio_asks_again",
    title: "Low ASR confidence makes the agent ask again",
    guards: "The agent never acts on audio it did not hear properly.",
    now: MONDAY_9AM_PT,
    turns: [
      "My dishwasher is leaving a film on everything.",
      { text: "crackle nine two four mumble", confidence: 0.2 },
      "Sorry, I said yes - what would a visit cost?",
      "No thanks, not today.",
    ],
    expect: {
      toolsCalled: ["triage_appliance", "quote_job"],
      custom: (session) => {
        const replies = session.transcript.filter((u) => u.speaker === "agent").map((u) => u.text);
        return replies.some((r) => /say that once more|broke up/i.test(r))
          ? []
          : ["agent did not ask the caller to repeat a low-confidence turn"];
      },
    },
  },
  {
    id: "friday_afternoon_rollover",
    title: "Friday afternoon call rolls into next week correctly",
    guards: "Slot generation respects the two-hour lead time and weekend rules.",
    now: FRIDAY_2PM_PT,
    turns: [
      "The microwave runs but it doesn't heat anything up.",
      "Yes, how much?",
      "Okay, book me in.",
      "Whatever's soonest.",
      "Ibrahim Nasser.",
      "415 555 0199.",
      "55 Hilltop Drive, San Rafael.",
      "That's it.",
    ],
    expect: {
      outcome: "booked",
      bookingExpected: true,
      custom: (session) => {
        const booking = session.bookings[0];
        if (!booking) return ["no booking recorded"];
        const start = new Date(booking.startsAt).getTime();
        const now = new Date(FRIDAY_2PM_PT).getTime();
        const errors: string[] = [];
        if (start < now + 2 * 60 * 60 * 1000) errors.push("booked inside the two-hour dispatch lead time");
        const weekday = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          weekday: "long",
        }).format(new Date(booking.startsAt));
        if (weekday === "Sunday") errors.push("offered a Sunday slot for a routine job");
        return errors;
      },
    },
  },
];
