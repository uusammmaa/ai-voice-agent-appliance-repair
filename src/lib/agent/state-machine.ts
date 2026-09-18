import type { CallSlots, ConversationState } from "./types";

/**
 * The conversation state machine.
 *
 * Two jobs:
 *  1. Gate which tools the model may call, so a confused model cannot book a job before
 *     it knows the address.
 *  2. Give the transcript an auditable shape - every transition is recorded with the
 *     slots that justified it.
 *
 * The model may *request* a transition; this module decides whether it is legal.
 */

export const LEGAL_TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  greeting: ["identify", "triage", "escalated", "ended"],
  identify: ["triage", "escalated", "ended"],
  triage: ["quote", "schedule", "wrap", "escalated", "ended"],
  quote: ["schedule", "wrap", "triage", "escalated", "ended"],
  schedule: ["confirm", "quote", "escalated", "ended"],
  confirm: ["wrap", "schedule", "escalated", "ended"],
  wrap: ["ended", "escalated", "schedule"],
  escalated: ["ended"],
  ended: [],
};

export interface TransitionRequirement {
  /** Slots that must be filled before entering the state. */
  requires: Array<keyof CallSlots>;
  /** Human-readable reason, surfaced in the audit log when a transition is refused. */
  because: string;
}

export const ENTRY_REQUIREMENTS: Partial<Record<ConversationState, TransitionRequirement>> = {
  quote: {
    requires: ["symptomId"],
    because: "a quote is derived from a catalogue symptom, so triage must have completed",
  },
  schedule: {
    requires: ["symptomId"],
    because: "availability depends on which appliance and how urgent the fault is",
  },
  confirm: {
    requires: ["chosenSlotId", "callerName", "phone", "address"],
    because: "a technician cannot be dispatched without a name, a callback number and an address",
  },
};

export interface TransitionResult {
  allowed: boolean;
  from: ConversationState;
  to: ConversationState;
  reason?: string;
  /** Slots that were missing, when the transition was refused on requirements. */
  missing?: Array<keyof CallSlots>;
}

export function canTransition(from: ConversationState, to: ConversationState, slots: CallSlots): TransitionResult {
  if (from === to) return { allowed: true, from, to };

  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    return { allowed: false, from, to, reason: `${from} -> ${to} is not a legal transition` };
  }

  const requirement = ENTRY_REQUIREMENTS[to];
  if (requirement) {
    const missing = requirement.requires.filter((slot) => {
      const value = slots[slot];
      return value === undefined || value === null || value === "";
    });
    if (missing.length > 0) {
      return {
        allowed: false,
        from,
        to,
        reason: `cannot enter ${to}: ${requirement.because}`,
        missing,
      };
    }
  }

  return { allowed: true, from, to };
}

/**
 * The state the conversation *should* be in given what we now know. Used to nudge the
 * model forward when it dithers, and to detect a stalled call.
 */
export function inferState(current: ConversationState, slots: CallSlots): ConversationState {
  if (current === "ended" || current === "escalated") return current;
  if (slots.bookingId) return "wrap";
  if (slots.chosenSlotId) return "confirm";
  if (slots.symptomId && slots.quoteAccepted) return "schedule";
  if (slots.symptomId) return "quote";
  if (slots.callerName && slots.phone) return "triage";
  return current === "greeting" ? "identify" : current;
}

/**
 * The first hop on the shortest legal path from `from` to `target`.
 *
 * A brain that has just learned something often names the state it wants to *end up* in
 * rather than the next one - "we have a symptom, so we're quoting now" while the call is
 * formally still in `identify`. Refusing that outright strands the conversation in a
 * state whose tools it no longer needs. Walking one legal hop toward the target instead
 * keeps the audit trail honest without fighting the brain.
 *
 * Returns `null` when no legal path exists, which is a genuine refusal.
 */
export function nextLegalStep(from: ConversationState, target: ConversationState, slots: CallSlots): ConversationState | null {
  if (from === target) return from;

  const queue: ConversationState[][] = [[from]];
  const seen = new Set<ConversationState>([from]);

  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const tail = path[path.length - 1];
    if (!tail) continue;

    for (const next of LEGAL_TRANSITIONS[tail]) {
      if (seen.has(next)) continue;
      if (!canTransition(tail, next, slots).allowed) continue;
      const extended = [...path, next];
      if (next === target) return extended[1] ?? null;
      seen.add(next);
      queue.push(extended);
    }
  }

  return null;
}

/** Tools permitted per state. The single source of truth is the tool definition itself; */
/** this helper exists so the UI can show the caller-facing state machine honestly. */
export function stateLabel(state: ConversationState): string {
  return {
    greeting: "Greeting",
    identify: "Identifying caller",
    triage: "Triaging the fault",
    quote: "Quoting",
    schedule: "Finding a slot",
    confirm: "Confirming the booking",
    wrap: "Wrapping up",
    escalated: "Handed to a human",
    ended: "Call ended",
  }[state];
}
