import type { z } from "zod";
import type { CalendarPort } from "../integrations/calendar/port";
import type { MessagingPort } from "../integrations/messaging/port";
import type { CustomerRepository } from "../domain/customers";
import type { Booking } from "../domain/scheduling";
import type { ApplianceType, Severity } from "../domain/catalog";

/* ------------------------------------------------------------------ transcript ---- */

export type Speaker = "agent" | "caller" | "system";

export interface Utterance {
  id: string;
  speaker: Speaker;
  text: string;
  at: string;
  /** ASR confidence, 0-1. Absent for agent turns. */
  confidence?: number;
  /** True when the caller talked over the agent and the agent stopped speaking. */
  bargeIn?: boolean;
  /** Which turn of the conversation this belongs to. Used to rebuild provider messages. */
  turn?: number;
}

/* ----------------------------------------------------------------------- tools ---- */

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments as the brain produced them, before validation. */
  rawArgs: unknown;
  args?: unknown;
  result?: unknown;
  error?: { message: string; retryable: boolean };
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Conversation turn this call was issued in. */
  turn: number;
  /** Which brain round inside that turn. Round 0 reacts to the caller, round 1+ to tools. */
  round: number;
}

export interface ToolSpec<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Shown to the model. Written for a model, not for a human reader. */
  description: string;
  schema: TSchema;
  /** JSON Schema handed to the provider's tool-calling API. */
  jsonSchema: Record<string, unknown>;
  /** States in which the model is permitted to call this tool. */
  allowedStates: ConversationState[];
  /** True if the tool mutates the outside world; those are logged at a higher level. */
  mutating: boolean;
  handler: (args: z.infer<TSchema>, ctx: AgentContext) => Promise<unknown>;
}

/**
 * The erased form the runner holds. Keeping the generic out of the registry avoids a
 * heterogeneous-array cast; `defineTool` is the only place the two forms meet, and it
 * is the only place the argument type is asserted.
 */
export interface ToolDefinition extends Omit<ToolSpec, "schema" | "handler"> {
  schema: z.ZodTypeAny;
  /** Args are validated against `schema` by the runner before this is called. */
  handler: (args: unknown, ctx: AgentContext) => Promise<unknown>;
}

export function defineTool<TSchema extends z.ZodTypeAny>(spec: ToolSpec<TSchema>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    jsonSchema: spec.jsonSchema,
    allowedStates: spec.allowedStates,
    mutating: spec.mutating,
    handler: (args, ctx) => spec.handler(args as z.infer<TSchema>, ctx),
  };
}

/* ------------------------------------------------------------------ state model ---- */

export const CONVERSATION_STATES = [
  "greeting",
  "identify",
  "triage",
  "quote",
  "schedule",
  "confirm",
  "wrap",
  "escalated",
  "ended",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** Everything the conversation has established. Slot-filling, in classic IVR terms. */
export interface CallSlots {
  customerId?: string;
  callerName?: string;
  phone?: string;
  address?: string;
  email?: string;
  appliance?: ApplianceType;
  brand?: string;
  symptomId?: string;
  symptomLabel?: string;
  severity?: Severity;
  problemDescription?: string;
  quoteAccepted?: boolean;
  quotedLowUsd?: number;
  quotedHighUsd?: number;
  offeredSlotIds?: string[];
  chosenSlotId?: string;
  bookingId?: string;
  warrantyCovered?: boolean;
  safetyWarningGiven?: boolean;
}

/* --------------------------------------------------------------------- session ---- */

export interface CallMetrics {
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Wall-clock ms spent inside the brain, summed across turns. */
  brainMs: number;
  /** Wall-clock ms spent inside tool handlers, summed. */
  toolMs: number;
  maxTurnLatencyMs: number;
}

export interface CallSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  state: ConversationState;
  /** Caller ID as delivered by the telephony provider, if any. */
  fromNumber?: string;
  slots: CallSlots;
  transcript: Utterance[];
  toolCalls: ToolCall[];
  bookings: Booking[];
  notifications: string[];
  metrics: CallMetrics;
  /** Set when the call was handed to a human, with the reason. */
  escalation?: { reason: string; at: string; ticketId?: string };
  outcome?: CallOutcome;
}

export type CallOutcome =
  | "booked"
  | "rescheduled"
  | "quoted_no_booking"
  | "self_resolved"
  | "escalated"
  | "abandoned"
  | "emergency_dispatched";

/* --------------------------------------------------------------------- context ---- */

export interface AgentConfig {
  businessName: string;
  businessPhone: string;
  serviceArea: string;
  timeZone: string;
  dispatchCalendarId: string;
  /** Hard stop so a stuck model cannot hold a phone line open forever. */
  maxTurns: number;
  /** Tool calls allowed inside a single brain round. */
  maxToolCallsPerRound: number;
  /** Brain round-trips allowed inside one turn before the agent must speak. */
  maxToolRoundsPerTurn: number;
  /** Hand to a human once this many consecutive turns fail to advance the state. */
  maxStalledTurns: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  businessName: "Northside Appliance Repair",
  businessPhone: "+1 (415) 555-0110",
  serviceArea: "the Bay Area, from San Rafael down to San Jose",
  timeZone: "America/Los_Angeles",
  dispatchCalendarId: "dispatch@northside-appliance.example",
  maxTurns: 40,
  maxToolCallsPerRound: 4,
  maxToolRoundsPerTurn: 3,
  maxStalledTurns: 3,
};

export interface AgentContext {
  session: CallSession;
  config: AgentConfig;
  calendar: CalendarPort;
  messaging: MessagingPort;
  customers: CustomerRepository;
  /** Injected clock. Every eval and test pins this; nothing calls `new Date()` directly. */
  now: () => Date;
  /** Deterministic id source, so transcripts are reproducible in evals. */
  nextId: (prefix: string) => string;
}

/* ----------------------------------------------------------------------- brain ---- */

export interface BrainRequest {
  session: CallSession;
  config: AgentConfig;
  /** Tools the state machine permits right now. */
  availableTools: ToolDefinition[];
  systemPrompt: string;
  /**
   * Results of tools executed earlier in this same turn. Empty on the first round.
   * A brain that gets these is being asked "given what you just learned, what do you
   * say?" - which is the round where the caller actually hears something useful.
   */
  pendingToolResults: ToolCall[];
  round: number;
}

export interface BrainToolInvocation {
  id: string;
  name: string;
  args: unknown;
}

export interface BrainResponse {
  /** What the agent says out loud. Empty string means "call tools and think again". */
  say: string;
  toolCalls: BrainToolInvocation[];
  /** Optional explicit state transition request; the state machine may refuse it. */
  nextState?: ConversationState;
  /** Model-reported reason for escalation, if it wants out. */
  escalate?: string;
  endCall?: boolean;
}

export interface Brain {
  readonly name: string;
  respond(request: BrainRequest): Promise<BrainResponse>;
}
