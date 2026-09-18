import { matchAppliance, matchSymptom } from "../../domain/catalog";
import type { Brain, BrainRequest, BrainResponse, BrainToolInvocation, CallSession, ToolCall } from "../types";

/**
 * A rules-based brain over the *same* tool schema the LLM brain uses.
 *
 * Why this exists, rather than just mocking the LLM:
 *  - The hosted demo works with no API key and no per-visitor cost.
 *  - The eval suite gets a deterministic baseline. If a scenario fails here it is a bug
 *    in the tools, the state machine or the domain, not model variance - and that
 *    separation is what makes the LLM evals readable.
 *  - Production can fall back to it when the model provider is down. A rigid agent that
 *    still books jobs beats a dead phone line.
 *
 * It runs in the same two-phase loop as the LLM brain:
 *   round 0 - react to what the caller said, and call the tool that moves things on;
 *   round 1 - react to what the tools returned, and say something the caller can use.
 */

const AFFIRMATIVE = [
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please", "go ahead", "sounds good",
  "that works", "lets do it", "book it", "absolutely", "correct", "right", "fine",
  "perfect", "great", "do it", "works for me",
];

const NEGATIVE = [
  "no", "nope", "not now", "dont", "later", "maybe not", "ill pass", "no thanks",
  "not right now", "never mind", "forget it",
];

const HUMAN_REQUEST = [
  "speak to a human", "talk to a human", "real person", "speak to someone", "talk to someone",
  "a manager", "your manager", "customer service", "operator", "transfer me", "put me through",
  "speak to a person", "human being", "are you a robot", "are you a bot",
];

const ANGRY = ["ridiculous", "unacceptable", "furious", "complaint", "complain", "terrible service", "waste of my time"];

const SAFETY = ["gas", "smoke", "smoking", "burning", "fire", "sparks", "sparking", "shock", "flooding", "flooded"];

const DONE = [
  "that is it", "that is all", "that is everything", "nothing else", "no thanks",
  "i am good", "all good", "we are done", "thats me",
];

/** The caller is asking what it costs. */
const PRICE_INTENT = [
  "how much", "what would it cost", "what does it cost", "cost", "price", "quote",
  "charge", "expensive", "ballpark", "estimate", "damage", "what am i looking at",
];

/** The caller wants a technician. */
const BOOKING_INTENT = [
  "book", "booking", "appointment", "come out", "send someone", "get someone out",
  "schedule", "slot", "when can you", "get someone back out", "visit",
];

/** Strip punctuation and apostrophes so "don't" and "dont" compare equal. */
function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/['']/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function contains(text: string, needles: string[]): boolean {
  const t = normalise(text);
  return needles.some((n) => t.includes(` ${n} `));
}

function isAffirmative(text: string): boolean {
  if (contains(text, NEGATIVE)) return false;
  return contains(text, AFFIRMATIVE);
}

function isNegative(text: string): boolean {
  return contains(text, NEGATIVE);
}

function wantsPrice(text: string): boolean {
  return contains(text, PRICE_INTENT);
}

function wantsBooking(text: string): boolean {
  return contains(text, BOOKING_INTENT);
}

const NAME_CUE = /(?:my name'?s|my name is|this is|it'?s|i'?m|i am|speaking to)\s+/i;
/** A capitalised one-to-three word run: the shape a spoken name arrives in. */
const NAME_SHAPE = /^([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})/;
const NOT_A_NAME = /^(The|My|A|An|It|I|Yes|No|Sure|Okay|Just|Still|Nothing|Sorry)\b/;

/**
 * "my name is Angela", "this is Tom Whitfield", or a bare "Priscilla Nkemdirim".
 *
 * The cue is matched case-insensitively but the name itself is matched against the
 * original casing. A single case-insensitive regex would happily capture "the filter"
 * out of "I checked the filter".
 */
function extractName(text: string): string | undefined {
  const cue = text.match(NAME_CUE);
  if (cue?.index !== undefined) {
    const captured = text.slice(cue.index + cue[0].length).match(NAME_SHAPE)?.[1]?.trim();
    if (captured && !NOT_A_NAME.test(captured)) return captured;
  }

  // A bare answer to "can I take your name?" - capitalised words and nothing else.
  const standalone = text.trim().replace(/[.,!]$/, "").match(/^([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){1,2})$/)?.[1];
  if (standalone && !NOT_A_NAME.test(standalone)) return standalone;

  return undefined;
}

function extractPhone(text: string): string | undefined {
  return text.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/)?.[1]?.trim();
}

/**
 * A street number, a street name, a street-type word, then up to two comma-separated
 * locality parts.
 *
 * The locality class excludes the full stop deliberately: "1204 Cedar Street, Berkeley.
 * There's a dog in the yard" must yield the address and stop at the sentence end, rather
 * than swallowing the next clause into the technician's job sheet.
 */
const ADDRESS =
  /\b(\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|way|terrace|circle|cir|place|pl|boulevard|blvd)\b(?:,?\s+(?:apt|apartment|unit|#)\s*[A-Za-z0-9-]+)?(?:,\s*[A-Za-z][A-Za-z '-]{1,28})?)/i;

function extractAddress(text: string): string | undefined {
  return text.match(ADDRESS)?.[1]?.trim().replace(/\s+/g, " ").replace(/[.,]$/, "");
}

function extractEmail(text: string): string | undefined {
  return text.match(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/)?.[0];
}

interface OfferedSlot {
  slotId: string;
  label: string;
  technician: string;
  sameDay: boolean;
}

/** The windows most recently returned by check_availability on this call. */
function lastOfferedSlots(session: CallSession): OfferedSlot[] {
  for (let i = session.toolCalls.length - 1; i >= 0; i--) {
    const call = session.toolCalls[i];
    if (call?.name !== "check_availability") continue;
    const result = call.result as { ok?: boolean; slots?: OfferedSlot[] } | undefined;
    if (result?.ok && Array.isArray(result.slots)) return result.slots;
  }
  return [];
}

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(?:the )?first\b|\bearliest\b|\bsoonest\b|\bearlier one\b|\bsooner\b/, 0],
  [/\b(?:the )?second\b|\blater one\b/, 1],
  [/\b(?:the )?third\b/, 2],
  [/\b(?:the )?fourth\b|\b(?:the )?last\b/, 3],
];

/** Map "the second one", "Tuesday morning" or "ten am" onto an offered window. */
function chooseSlot(text: string, offered: OfferedSlot[]): OfferedSlot | undefined {
  if (offered.length === 0) return undefined;
  const t = normalise(text);

  for (const [re, index] of ORDINALS) {
    if (re.test(t)) return offered[Math.min(index, offered.length - 1)];
  }

  const scored = offered
    .map((slot) => {
      const label = slot.label.toLowerCase();
      const compact = label.replace(/\s/g, "");
      let score = 0;
      for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
        if (t.includes(day) && label.includes(day)) score += 3;
      }
      for (const match of label.matchAll(/(\d{1,2})(?::\d{2})?\s*(am|pm)/g)) {
        const hour = match[1];
        const meridiem = match[2];
        if (hour && new RegExp(`\\b${hour}\\s*(?:${meridiem}|oclock)?\\b`).test(t)) score += 2;
      }
      if (t.includes(" morning ") && /(?:8|9|10|11)am/.test(compact)) score += 2;
      if (t.includes(" afternoon ") && /(?:1|2|3|4)pm/.test(compact)) score += 2;
      if (t.includes(" today ") && slot.sameDay) score += 3;
      return { slot, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return best && best.score > 0 ? best.slot : undefined;
}

function lastCallerUtterance(session: CallSession): string {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const u = session.transcript[i];
    if (u?.speaker === "caller") return u.text;
  }
  return "";
}

/** Everything the caller has said, so triage can match across several turns. */
function callerNarrative(session: CallSession): string {
  return session.transcript
    .filter((u) => u.speaker === "caller")
    .map((u) => u.text)
    .join(" ");
}

function resultOf<T>(calls: ToolCall[], name: string): T | undefined {
  const call = calls.find((c) => c.name === name && !c.error);
  return call?.result as T | undefined;
}

/** Gate codes, dogs and parking are the three things technicians get stuck on. */
function extractAccessNotes(narrative: string): string | undefined {
  const notes: string[] = [];
  const gate = narrative.match(/gate code(?:\s+is)?\s*([A-Za-z0-9#*]+)/i);
  if (gate?.[1]) notes.push(`Gate code ${gate[1]}`);
  if (/\bdogs?\b/i.test(narrative)) notes.push("Dog on the property");
  if (/\bback (?:door|entrance|gate)\b/i.test(narrative)) notes.push("Use the back entrance");
  if (/\bbuzz(?:er)?\b|\bapartment\b|\bapt\b|\bunit \d/i.test(narrative)) notes.push("Apartment - may need buzzing in");
  return notes.length ? notes.join(". ") : undefined;
}

export class DeterministicBrain implements Brain {
  readonly name = "deterministic";
  private counter = 0;

  private call(name: string, args: unknown): BrainToolInvocation {
    return { id: `det_${++this.counter}`, name, args };
  }

  async respond(request: BrainRequest): Promise<BrainResponse> {
    if (request.round > 0 && request.pendingToolResults.length > 0) {
      return this.reactToTools(request);
    }
    return this.reactToCaller(request);
  }

  /* ----------------------------------------------- round 1+: speak the results -- */

  private reactToTools(request: BrainRequest): BrainResponse {
    const { session, pendingToolResults: results } = request;
    const slots = session.slots;

    if (results.some((r) => r.name === "escalate_to_human")) {
      const escalation = resultOf<{ transferScript?: string }>(results, "escalate_to_human");
      return {
        say: escalation?.transferScript ?? "Let me put you through to the team now - one moment.",
        toolCalls: [],
        nextState: "escalated",
      };
    }

    const booking = resultOf<{ ok: boolean; confirmationScript?: string; window?: string }>(results, "book_appointment");
    if (booking) {
      if (booking.ok && booking.confirmationScript) {
        return { say: booking.confirmationScript, toolCalls: [], nextState: "confirm" };
      }
      return {
        say: "Hmm, that window just went. Let me find you another one.",
        toolCalls: [this.call("check_availability", { preferEarliest: true })],
        nextState: "schedule",
      };
    }

    const availability = resultOf<{ ok: boolean; slots?: OfferedSlot[]; note?: string }>(results, "check_availability");
    if (availability) {
      const offered = availability.slots ?? [];
      if (offered.length === 0) {
        return {
          say: "I haven't got anything in the next week for that, I'm afraid. Let me get dispatch to call you the moment something opens up.",
          toolCalls: [
            this.call("create_ticket", {
              kind: "callback",
              summary: `No availability within a week for ${slots.symptomLabel ?? "the reported fault"}.`,
            }),
          ],
          nextState: "wrap",
        };
      }
      const [first, second] = offered;
      return {
        say: second
          ? `I've got ${first?.label}, or ${second.label}. Which suits you better?`
          : `The next one I've got is ${first?.label}. Does that work for you?`,
        toolCalls: [],
        nextState: "schedule",
      };
    }

    const quote = resultOf<{ ok: boolean; spokenSummary?: string; warrantyCovered?: boolean }>(results, "quote_job");
    if (quote?.spokenSummary) {
      return {
        say: `${quote.spokenSummary} Shall I find you a slot?`,
        toolCalls: [],
        nextState: "quote",
      };
    }

    const triage = resultOf<{
      ok: boolean;
      needsClarification?: boolean;
      clarifyingQuestion?: string;
      symptomLabel?: string;
      safetyCritical?: boolean;
      safetyScript?: string;
      likelyCauses?: Array<{ cause: string; likelihoodPct: number }>;
      selfChecks?: string[];
      warranty?: { covered: boolean };
    }>(results, "triage_appliance");

    if (triage) {
      if (triage.needsClarification) {
        return {
          say: "Which appliance is it, and what's it doing - or not doing?",
          toolCalls: [],
          nextState: "triage",
        };
      }
      if (triage.safetyCritical) {
        return {
          say:
            "Right - switch it off at the wall and stop using it. " +
            "That one we treat as urgent, so let me get someone out to you today. Can I take your name?",
          toolCalls: [],
          nextState: "triage",
        };
      }
      if (triage.warranty?.covered) {
        return {
          say:
            "Hang on - our records show we repaired that same fault for you recently, and it's still under our " +
            "workmanship warranty. So there's no call-out and no charge. Shall I get someone back out?",
          toolCalls: [],
          nextState: "triage",
        };
      }
      const topCause = triage.likelyCauses?.[0];
      const selfCheck = triage.selfChecks?.[0];
      return {
        say:
          `Okay - ${(triage.symptomLabel ?? "that fault").toLowerCase()}. ` +
          (topCause ? `Most of the time that's ${topCause.cause.toLowerCase()}. ` : "") +
          (selfCheck ? `Worth trying this first: ${selfCheck} ` : "") +
          `If it's still playing up, want me to give you a price for getting someone out?`,
        toolCalls: [],
        nextState: "triage",
      };
    }

    const lookup = resultOf<{ ok: boolean; found: boolean; customer?: { name: string } }>(results, "lookup_customer");
    const details = resultOf<{ ok: boolean; stillMissing?: string[] }>(results, "record_caller_details");

    if (details?.stillMissing?.length && slots.chosenSlotId && !slots.bookingId) {
      return { say: askFor(details.stillMissing[0]), toolCalls: [], nextState: "schedule" };
    }

    if (lookup?.found && lookup.customer) {
      return {
        say: `Hi ${lookup.customer.name.split(" ")[0]}, good to hear from you. What's going on?`,
        toolCalls: [],
        nextState: "identify",
      };
    }

    if (resultOf(results, "create_ticket")) {
      return {
        say: "I've logged that for the office and someone will come back to you today. Anything else?",
        toolCalls: [],
        nextState: "wrap",
      };
    }

    // Tools ran but none of them changes what we should say; fall through to the
    // caller-facing logic so the conversation still moves.
    return this.reactToCaller({ ...request, round: 0, pendingToolResults: [] });
  }

  /* ------------------------------------------------ round 0: react to the caller -- */

  private reactToCaller(request: BrainRequest): BrainResponse {
    const { session, config } = request;
    const slots = session.slots;
    const utterance = lastCallerUtterance(session);
    const available = new Set(request.availableTools.map((t) => t.name));
    const toolCalls: BrainToolInvocation[] = [];

    /* 1. Anything that ends the normal flow, checked before everything else. */

    if (contains(utterance, HUMAN_REQUEST) || contains(utterance, ANGRY)) {
      const angry = contains(utterance, ANGRY);
      return {
        say: "Of course - let me put you through to someone on the team. One moment.",
        toolCalls: available.has("escalate_to_human")
          ? [
              this.call("escalate_to_human", {
                reason: angry ? `Caller is unhappy: "${utterance}"` : "Caller asked for a person.",
                urgent: angry,
              }),
            ]
          : [],
        nextState: "escalated",
      };
    }

    /* 2. Harvest any details present in this utterance, always. */

    const details: Record<string, string> = {};
    const name = !slots.callerName ? extractName(utterance) : undefined;
    const phone = extractPhone(utterance);
    const address = extractAddress(utterance);
    const email = extractEmail(utterance);
    if (name) details.name = name;
    if (phone) details.phone = phone;
    if (address) details.address = address;
    if (email) details.email = email;
    if (Object.keys(details).length > 0 && available.has("record_caller_details")) {
      toolCalls.push(this.call("record_caller_details", details));
    }

    /*
     * Caller ID lookup, once per call. This has to be driven off "have we looked yet"
     * rather than "is this the first turn": the runner speaks the greeting before the
     * caller says anything, so by the time the brain first runs there is already a
     * caller utterance on the transcript and a first-turn check never fires.
     * Pushed ahead of any triage call so the CRM hit lands first and triage can see the
     * customer's repair history.
     */
    const lookedUp = session.toolCalls.some((c) => c.name === "lookup_customer");
    if (!lookedUp && !slots.customerId && session.fromNumber && available.has("lookup_customer")) {
      toolCalls.push(this.call("lookup_customer", { phone: session.fromNumber }));
    }

    /* 3. Opening turn: greet, and look the caller up from caller ID. */

    if (session.transcript.filter((u) => u.speaker === "caller").length === 0) {
      if (session.fromNumber && available.has("lookup_customer")) {
        toolCalls.push(this.call("lookup_customer", { phone: session.fromNumber }));
      }
      return {
        say: `Thanks for calling ${config.businessName}. What's going on with your appliance?`,
        toolCalls,
        nextState: "identify",
      };
    }

    /* 4. Triage: nothing useful can happen until we know the fault. */

    if (!slots.symptomId) {
      const narrative = callerNarrative(session);
      const appliance = matchAppliance(narrative) ?? undefined;
      const match = matchSymptom(narrative, appliance);

      if (match && available.has("triage_appliance")) {
        toolCalls.push(
          this.call("triage_appliance", { description: narrative.slice(-400), appliance: match.symptom.appliance }),
        );
        return { say: "", toolCalls, nextState: "triage" };
      }

      if (contains(utterance, SAFETY)) {
        return {
          say:
            "Okay, I'm treating that as urgent. Switch it off at the wall and don't use it again. " +
            "Which appliance is it - the dryer, the oven, or something else?",
          toolCalls,
          nextState: "triage",
        };
      }

      const agentTurns = session.transcript.filter((u) => u.speaker === "agent").length;
      if (agentTurns > 3 && available.has("escalate_to_human")) {
        return {
          say: "I want to make sure I get this right - let me put you through to one of the team.",
          toolCalls: [
            ...toolCalls,
            this.call("escalate_to_human", { reason: "Could not triage the fault from the caller's description." }),
          ],
          nextState: "escalated",
        };
      }
      return {
        say: appliance
          ? `Got it, the ${appliance.replace("_", " ")}. What's it doing, or not doing?`
          : "Which appliance are we talking about, and what's it doing?",
        toolCalls,
        nextState: "triage",
      };
    }

    /* 5. Quote, once. */

    const quotedAlready = session.toolCalls.some((c) => c.name === "quote_job" && !c.error);
    const offered = lastOfferedSlots(session);
    const emergency = slots.severity === "emergency";

    if (!quotedAlready && !slots.warrantyCovered && !emergency && offered.length === 0) {
      if (isNegative(utterance) && !wantsPrice(utterance)) {
        return {
          say: "No problem at all. If it gets worse, give us a ring back and we'll get someone out. Take care.",
          toolCalls,
          nextState: "wrap",
          endCall: true,
        };
      }

      // The caller has not actually asked for a price yet - they answered the previous
      // question. Acknowledge and ask once more rather than quoting at them.
      if (!isAffirmative(utterance) && !wantsPrice(utterance) && !wantsBooking(utterance)) {
        const asked = session.transcript.filter((u) => u.speaker === "agent" && /price|cost/i.test(u.text)).length;
        if (asked < 2) {
          return {
            say: "Understood. Would you like me to price up a visit, so you know where you stand?",
            toolCalls,
            nextState: "triage",
          };
        }
      }

      if (available.has("quote_job")) {
        toolCalls.push(this.call("quote_job", { symptomId: slots.symptomId, emergency }));
        return { say: "", toolCalls, nextState: "quote" };
      }
    }

    /* 6. Offer windows. */

    if (offered.length === 0) {
      if (isNegative(utterance)) {
        return {
          say: "Understood - I'll leave it there. Call us back any time and we'll pick it up. Thanks for calling.",
          toolCalls,
          nextState: "wrap",
          endCall: true,
        };
      }
      if (available.has("check_availability")) {
        toolCalls.push(this.call("check_availability", { preferEarliest: slots.severity === "emergency" }));
        return { say: "", toolCalls, nextState: "schedule" };
      }
    }

    /* 7. Take a slot choice and book, collecting whatever is still missing. */

    if (!slots.bookingId) {
      const chosen =
        chooseSlot(utterance, offered) ??
        (slots.chosenSlotId ? offered.find((s) => s.slotId === slots.chosenSlotId) : undefined) ??
        (isAffirmative(utterance) ? offered[0] : undefined);

      if (chosen) {
        slots.chosenSlotId = chosen.slotId;
        const missing: string[] = [];
        if (!slots.callerName && !details.name) missing.push("name");
        if (!slots.phone && !details.phone && !session.fromNumber) missing.push("phone");
        if (!slots.address && !details.address) missing.push("address");

        if (missing.length > 0) {
          return { say: askFor(missing[0]), toolCalls, nextState: "schedule" };
        }

        if (available.has("book_appointment")) {
          toolCalls.push(
            this.call("book_appointment", {
              slotId: chosen.slotId,
              name: slots.callerName ?? details.name,
              phone: slots.phone ?? details.phone ?? session.fromNumber,
              address: slots.address ?? details.address,
              accessNotes: extractAccessNotes(callerNarrative(session)),
            }),
          );
          return {
            say: `Let me read that back - ${slots.address ?? details.address}, ${chosen.label}.`,
            toolCalls,
            nextState: "confirm",
          };
        }
      }
    }

    /* 8. Booked: confirm and wrap. */

    if (slots.bookingId) {
      if (isNegative(utterance) || contains(utterance, DONE)) {
        return {
          say: `You're all set. We'll text this number when the technician's on the way. Thanks for calling ${config.businessName}.`,
          toolCalls,
          nextState: "wrap",
          endCall: true,
        };
      }
      return { say: "You're booked in. Anything else I can help with while I've got you?", toolCalls, nextState: "wrap" };
    }

    /* 9. Holding windows the caller has not picked from. */

    if (offered.length > 0) {
      if (isNegative(utterance)) {
        return {
          say: "No problem - I'll have dispatch call you back when something closer opens up.",
          toolCalls: available.has("create_ticket")
            ? [
                ...toolCalls,
                this.call("create_ticket", {
                  kind: "callback",
                  summary: "Caller wants an earlier window than we could offer.",
                }),
              ]
            : toolCalls,
          nextState: "wrap",
          endCall: true,
        };
      }
      const [first, second] = offered;
      return {
        say: second
          ? `I've got ${first?.label}, or ${second.label}. Which suits you better?`
          : `The next one I've got is ${first?.label}. Does that work?`,
        toolCalls,
        nextState: "schedule",
      };
    }

    return { say: "Sorry, I didn't catch that - could you say it again?", toolCalls };
  }
}

function askFor(field: string | undefined): string {
  switch (field) {
    case "name":
      return "Perfect. Can I take your name?";
    case "phone":
      return "Great. And the best number to reach you on?";
    case "address":
      return "And what's the full service address?";
    default:
      return "Could you give me that one more time?";
  }
}
