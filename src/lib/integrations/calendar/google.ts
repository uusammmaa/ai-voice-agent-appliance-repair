import { google, type calendar_v3 } from "googleapis";
import { CalendarError, type BusyQuery, type CalendarEvent, type CalendarEventInput, type CalendarPort } from "./port";
import type { EnvLike } from "../../config";

/**
 * Google Calendar adapter.
 *
 * Authenticates with a service account using domain-wide delegation, which is the right
 * model for a dispatch calendar: no per-user OAuth screen, no refresh tokens to babysit,
 * and the technician calendars stay owned by the business.
 *
 * Idempotency: Google lets the client choose the event id. We derive a deterministic id
 * from the booking's idempotency key, so a retried create returns 409 and we read the
 * existing event back instead of double-booking a technician.
 */

export interface GoogleCalendarConfig {
  clientEmail: string;
  privateKey: string;
  /** Mailbox to impersonate via domain-wide delegation. */
  impersonate?: string;
}

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

/** Google event ids: lowercase base32hex, 5-1024 chars. */
function toEventId(idempotencyKey: string): string {
  let hash = 0n;
  for (const ch of idempotencyKey) hash = (hash * 131n + BigInt(ch.codePointAt(0) ?? 0)) % (1n << 96n);
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let out = "";
  let n = hash;
  while (n > 0n) {
    out = alphabet[Number(n % 32n)] + out;
    n /= 32n;
  }
  return `ar${out.padStart(24, "0")}`;
}

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
  return code === 403 || code === 429 || (typeof code === "number" && code >= 500);
}

export class GoogleCalendar implements CalendarPort {
  readonly name = "google";
  private readonly api: calendar_v3.Calendar;

  constructor(config: GoogleCalendarConfig) {
    const auth = new google.auth.JWT({
      email: config.clientEmail,
      // Vercel env vars flatten newlines; restore them before the key is parsed.
      key: config.privateKey.replace(/\\n/g, "\n"),
      scopes: SCOPES,
      subject: config.impersonate,
    });
    this.api = google.calendar({ version: "v3", auth });
  }

  static fromEnv(env: EnvLike = process.env): GoogleCalendar | null {
    const clientEmail = env.GOOGLE_CLIENT_EMAIL;
    const privateKey = env.GOOGLE_PRIVATE_KEY;
    if (!clientEmail || !privateKey) return null;
    return new GoogleCalendar({ clientEmail, privateKey, impersonate: env.GOOGLE_IMPERSONATE_SUBJECT });
  }

  async listBusy(query: BusyQuery): Promise<Array<{ startsAt: string; endsAt: string }>> {
    try {
      const res = await this.api.freebusy.query({
        requestBody: { timeMin: query.from, timeMax: query.to, items: [{ id: query.calendarId }] },
      });
      const busy = res.data.calendars?.[query.calendarId]?.busy ?? [];
      return busy
        .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
        .map((b) => ({ startsAt: b.start, endsAt: b.end }));
    } catch (err) {
      throw new CalendarError("Failed to read calendar availability", isRetryable(err), err);
    }
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const id = toEventId(input.idempotencyKey);
    const body: calendar_v3.Schema$Event = {
      id,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startsAt },
      end: { dateTime: input.endsAt },
      attendees: input.attendeeEmails?.map((email) => ({ email })),
      extendedProperties: { private: { source: "ai-voice-agent", ...input.metadata } },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    };

    try {
      const res = await this.api.events.insert({
        calendarId: input.calendarId,
        requestBody: body,
        sendUpdates: input.attendeeEmails?.length ? "all" : "none",
      });
      return toDomain(res.data);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 409) {
        // Already created by a previous attempt - read it back rather than fail the call.
        const existing = await this.api.events.get({ calendarId: input.calendarId, eventId: id });
        return toDomain(existing.data);
      }
      throw new CalendarError("Failed to create calendar event", isRetryable(err), err);
    }
  }

  async moveEvent(eventId: string, calendarId: string, startsAt: string, endsAt: string): Promise<CalendarEvent> {
    try {
      const res = await this.api.events.patch({
        calendarId,
        eventId,
        requestBody: { start: { dateTime: startsAt }, end: { dateTime: endsAt } },
      });
      return toDomain(res.data);
    } catch (err) {
      throw new CalendarError("Failed to reschedule calendar event", isRetryable(err), err);
    }
  }

  async cancelEvent(eventId: string, calendarId: string): Promise<void> {
    try {
      await this.api.events.delete({ calendarId, eventId });
    } catch (err) {
      // Already gone is a success from the caller's point of view.
      if ((err as { code?: number }).code === 410 || (err as { code?: number }).code === 404) return;
      throw new CalendarError("Failed to cancel calendar event", isRetryable(err), err);
    }
  }
}

function toDomain(event: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: event.id ?? "",
    htmlLink: event.htmlLink ?? undefined,
    startsAt: event.start?.dateTime ?? event.start?.date ?? "",
    endsAt: event.end?.dateTime ?? event.end?.date ?? "",
    summary: event.summary ?? "",
    status: event.status === "cancelled" ? "cancelled" : "confirmed",
  };
}
