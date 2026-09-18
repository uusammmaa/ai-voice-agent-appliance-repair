import { z } from "zod";
import type { CallSession } from "../agent/types";

/**
 * The HTTP contract between the call console and the agent.
 *
 * The server is stateless: the browser holds the session and posts it back with each
 * turn. That is a deliberate choice for a demo that runs on serverless functions, where
 * an in-process session map is not reliably the same process twice. It also means the
 * demo has no shared state between visitors and nothing to clean up.
 *
 * In a real telephony deployment the session lives in Redis or Postgres keyed by the
 * call SID, because there the caller cannot be trusted to carry it - see
 * docs/TELEPHONY.md. The runner does not care either way; it is handed a session and
 * hands one back.
 */

export const utteranceSchema = z.object({
  id: z.string(),
  speaker: z.enum(["agent", "caller", "system"]),
  text: z.string(),
  at: z.string(),
  confidence: z.number().optional(),
  bargeIn: z.boolean().optional(),
  turn: z.number().optional(),
});

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  rawArgs: z.unknown(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), retryable: z.boolean() }).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  turn: z.number(),
  round: z.number(),
});

export const bookingSchema = z.object({
  id: z.string(),
  slotId: z.string(),
  technicianId: z.string(),
  technicianName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  customerName: z.string(),
  phone: z.string(),
  address: z.string(),
  appliance: z.string(),
  symptomId: z.string(),
  symptomLabel: z.string(),
  notes: z.string(),
  severity: z.enum(["routine", "urgent", "emergency"]),
  createdAt: z.string(),
  calendarEventId: z.string().optional(),
  calendarHtmlLink: z.string().optional(),
});

export const sessionSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  state: z.enum(["greeting", "identify", "triage", "quote", "schedule", "confirm", "wrap", "escalated", "ended"]),
  fromNumber: z.string().optional(),
  slots: z.record(z.string(), z.unknown()),
  transcript: z.array(utteranceSchema),
  toolCalls: z.array(toolCallSchema),
  bookings: z.array(bookingSchema),
  notifications: z.array(z.string()),
  metrics: z.object({
    turns: z.number(),
    toolCalls: z.number(),
    failedToolCalls: z.number(),
    brainMs: z.number(),
    toolMs: z.number(),
    maxTurnLatencyMs: z.number(),
  }),
  escalation: z.object({ reason: z.string(), at: z.string(), ticketId: z.string().optional() }).optional(),
  outcome: z.string().optional(),
});

export const startRequestSchema = z.object({
  /** Simulated caller ID. Drives the CRM lookup so returning callers are recognised. */
  fromNumber: z.string().optional(),
});

export const turnRequestSchema = z.object({
  session: sessionSchema,
  text: z.string().min(1).max(1000),
  /** Speech-recognition confidence, when the turn came from the microphone. */
  confidence: z.number().min(0).max(1).optional(),
});

export interface RuntimeMode {
  brain: string;
  calendar: string;
  messaging: string;
}

export interface StartResponse {
  session: CallSession;
  say: string;
  mode: RuntimeMode;
}

export interface TurnResponse {
  session: CallSession;
  say: string;
  latencyMs: number;
  ended: boolean;
  mode: RuntimeMode;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/** Seeded so a first-time visitor can click one and hear a full call immediately. */
export const DEMO_CALLERS = [
  {
    label: "Angela Reyes",
    phone: "+14155550142",
    hint: "On file since 2019. Fridge and a Bosch dishwasher.",
    opener: "Hi, my fridge is not cooling at all since yesterday.",
  },
  {
    label: "Tom Whitfield",
    phone: "+14085550198",
    hint: "We replaced his drain pump in June. Still in warranty.",
    opener: "It's the washing machine again - it's not draining.",
  },
  {
    label: "Unknown number",
    phone: "",
    hint: "No record. The agent collects everything from scratch.",
    opener: "There's a burning smell coming from my dryer.",
  },
] as const;
