/**
 * Calendar port.
 *
 * The agent core depends on this interface only. Swapping Google Calendar for Outlook or
 * a dispatch system is a new file in this folder, not a change to the agent.
 */

export interface CalendarEventInput {
  calendarId: string;
  summary: string;
  description: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  attendeeEmails?: string[];
  /** Stable key so a retried booking does not create a second event. */
  idempotencyKey: string;
  /** Free-form metadata written to extendedProperties for downstream reconciliation. */
  metadata?: Record<string, string>;
}

export interface CalendarEvent {
  id: string;
  htmlLink?: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  status: "confirmed" | "cancelled";
}

export interface BusyQuery {
  calendarId: string;
  from: string;
  to: string;
}

export interface CalendarPort {
  readonly name: string;
  listBusy(query: BusyQuery): Promise<Array<{ startsAt: string; endsAt: string }>>;
  createEvent(input: CalendarEventInput): Promise<CalendarEvent>;
  moveEvent(eventId: string, calendarId: string, startsAt: string, endsAt: string): Promise<CalendarEvent>;
  cancelEvent(eventId: string, calendarId: string): Promise<void>;
}

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}
