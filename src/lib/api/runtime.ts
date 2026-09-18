import { CallRunner, wireFromEnv } from "../agent/session";
import { MemoryCalendar } from "../integrations/calendar/memory";
import { SLOT_LENGTH_MINUTES } from "../domain/scheduling";
import type { CallSession } from "../agent/types";
import type { RuntimeMode } from "./contract";

/**
 * Builds a runner for one HTTP request.
 *
 * The interesting part is rehydration. The in-memory calendar is fresh on every request,
 * so without replaying what this call already booked, `check_availability` would happily
 * re-offer a window the caller has already taken. Replaying the session's bookings back
 * into the calendar keeps the demo internally consistent; a real deployment reads the
 * same state from Google and needs none of this.
 */
export interface RequestRuntime {
  runner: CallRunner;
  mode: RuntimeMode;
}

export function buildRuntime(session?: CallSession): RequestRuntime {
  const wiring = wireFromEnv();
  const calendar = wiring.calendar;

  if (session && calendar instanceof MemoryCalendar) {
    for (const booking of session.bookings) {
      void calendar.createEvent({
        calendarId: process.env.DISPATCH_CALENDAR_ID ?? "dispatch@northside-appliance.example",
        summary: `${booking.symptomLabel} - ${booking.customerName}`,
        description: `Replayed from session ${session.id}`,
        startsAt: booking.startsAt,
        endsAt:
          booking.endsAt ?? new Date(new Date(booking.startsAt).getTime() + SLOT_LENGTH_MINUTES * 60000).toISOString(),
        idempotencyKey: `${session.id}:${booking.slotId}`,
      });
    }
  }

  const runner = new CallRunner(
    {
      brain: wiring.brain,
      calendar,
      messaging: wiring.messaging,
      session,
      config: process.env.DISPATCH_CALENDAR_ID ? { dispatchCalendarId: process.env.DISPATCH_CALENDAR_ID } : undefined,
    },
    session?.id,
  );

  return { runner, mode: wiring.mode };
}

/** Uniform JSON error body, so the console can show something useful rather than "failed". */
export function problem(status: number, error: string, detail?: string): Response {
  return Response.json({ error, detail }, { status });
}
