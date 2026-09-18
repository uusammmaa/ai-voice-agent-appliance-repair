import type { BusyQuery, CalendarEvent, CalendarEventInput, CalendarPort } from "./port";

/**
 * In-memory calendar. Used by the hosted demo, the eval suite and the unit tests.
 *
 * It honours the same idempotency contract as the Google adapter, which is the point:
 * if a behaviour is only correct against the mock, the test proved nothing.
 */
export class MemoryCalendar implements CalendarPort {
  readonly name = "memory";
  private readonly events = new Map<string, CalendarEvent & { calendarId: string; idempotencyKey: string }>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private seq = 0;

  async listBusy(query: BusyQuery): Promise<Array<{ startsAt: string; endsAt: string }>> {
    const from = new Date(query.from).getTime();
    const to = new Date(query.to).getTime();
    return [...this.events.values()]
      .filter((e) => e.calendarId === query.calendarId && e.status === "confirmed")
      .filter((e) => new Date(e.endsAt).getTime() > from && new Date(e.startsAt).getTime() < to)
      .map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt }));
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.events.get(existingId);
      if (existing) return { ...existing };
    }

    const id = `evt_mem_${(++this.seq).toString().padStart(4, "0")}`;
    const event = {
      id,
      calendarId: input.calendarId,
      idempotencyKey: input.idempotencyKey,
      // Deliberately no htmlLink. Fabricating a calendar.google.com URL here would put a
      // link in the UI that leads nowhere and implies a write that never happened.
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      summary: input.summary,
      status: "confirmed" as const,
    };
    this.events.set(id, event);
    this.byIdempotencyKey.set(input.idempotencyKey, id);
    return { ...event };
  }

  async moveEvent(eventId: string, calendarId: string, startsAt: string, endsAt: string): Promise<CalendarEvent> {
    const event = this.events.get(eventId);
    if (!event || event.calendarId !== calendarId) throw new Error(`No such event: ${eventId}`);
    event.startsAt = startsAt;
    event.endsAt = endsAt;
    return { ...event };
  }

  async cancelEvent(eventId: string, calendarId: string): Promise<void> {
    const event = this.events.get(eventId);
    if (!event || event.calendarId !== calendarId) return;
    event.status = "cancelled";
  }

  /** Test helper - not part of the port. */
  all(): CalendarEvent[] {
    return [...this.events.values()].map((e) => ({ ...e }));
  }
}
