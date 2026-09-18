import type { Severity } from "./catalog";

/**
 * Dispatch rules: which slots exist, which technician can take them, and how urgency
 * changes what the agent is allowed to offer.
 *
 * All times are handled as UTC instants plus an explicit IANA zone. The agent never
 * speaks a UTC time; `describeSlot` renders it in the branch's local zone.
 */

export interface Technician {
  id: string;
  name: string;
  /** Catalogue appliance types this technician is certified for. */
  skills: string[];
  /** Days of week they work, 0 = Sunday. */
  workDays: number[];
  /** Local start/end hour of their shift. */
  shiftStartHour: number;
  shiftEndHour: number;
  /** Van stock lets them complete some jobs in one visit. */
  carriesCommonParts: boolean;
}

export const TIMEZONE = "America/Los_Angeles";

export const TECHNICIANS: readonly Technician[] = [
  {
    id: "tech_marcus",
    name: "Marcus",
    skills: ["refrigerator", "dishwasher", "garbage_disposal", "microwave"],
    workDays: [1, 2, 3, 4, 5],
    shiftStartHour: 8,
    shiftEndHour: 17,
    carriesCommonParts: true,
  },
  {
    id: "tech_dana",
    name: "Dana",
    skills: ["washer", "dryer", "dishwasher"],
    workDays: [1, 2, 3, 4, 5, 6],
    shiftStartHour: 8,
    shiftEndHour: 19,
    carriesCommonParts: true,
  },
  {
    id: "tech_priya",
    name: "Priya",
    skills: ["oven", "cooktop", "microwave", "refrigerator"],
    workDays: [2, 3, 4, 5, 6],
    shiftStartHour: 10,
    shiftEndHour: 19,
    carriesCommonParts: false,
  },
];

/** Arrival windows offered to customers, as local start hours. */
export const SLOT_START_HOURS = [8, 10, 13, 15, 17] as const;
export const SLOT_LENGTH_MINUTES = 120;

export interface Slot {
  /** Stable id: `${techId}:${ISO start}`. Safe to echo back from the model. */
  id: string;
  technicianId: string;
  technicianName: string;
  /** UTC instant. */
  startsAt: string;
  endsAt: string;
  /** Local-zone window as spoken to the caller, e.g. "Tuesday between 10am and 12pm". */
  label: string;
  afterHours: boolean;
  sameDay: boolean;
}

export interface Booking {
  id: string;
  slotId: string;
  technicianId: string;
  technicianName: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  phone: string;
  address: string;
  appliance: string;
  symptomId: string;
  symptomLabel: string;
  notes: string;
  severity: Severity;
  createdAt: string;
  /** Set once the calendar adapter has written the event. */
  calendarEventId?: string;
  calendarHtmlLink?: string;
}

/** Local wall-clock parts of a UTC instant in the branch timezone. */
export function localParts(iso: string, timeZone = TIMEZONE) {
  const date = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
    dayPeriod: (parts.dayPeriod ?? "").toLowerCase(),
  };
}

/** The local-time offset of a zone at a given instant, in minutes. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) === 24 ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return (asUtc - at.getTime()) / 60000;
}

/**
 * Build the UTC instant for a local wall-clock time in `timeZone`.
 * Two passes handle the DST boundary case where the first guess lands in the wrong offset.
 */
export function localWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone = TIMEZONE,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offset = zoneOffsetMinutes(guess, timeZone);
    const corrected = new Date(Date.UTC(year, month - 1, day, hour, 0, 0) - offset * 60000);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess;
}

export function describeSlot(startsAt: string, timeZone = TIMEZONE): string {
  const start = localParts(startsAt, timeZone);
  const end = localParts(new Date(new Date(startsAt).getTime() + SLOT_LENGTH_MINUTES * 60000).toISOString(), timeZone);
  const fmt = (h: string, m: string, p: string) => (m === "00" ? `${h}${p}` : `${h}:${m}${p}`);
  return `${start.weekday} ${start.month} ${start.day}, between ${fmt(start.hour, start.minute, start.dayPeriod)} and ${fmt(end.hour, end.minute, end.dayPeriod)}`;
}

function localDayInfo(at: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "Sun");
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: weekdayIndex,
  };
}

export interface AvailabilityQuery {
  appliance: string;
  severity: Severity;
  /** "now" for the search. Injected so tests and evals are deterministic. */
  now: Date;
  /** Slots already taken, as ISO start instants keyed by technician. */
  busy: ReadonlyArray<{ technicianId: string; startsAt: string }>;
  /** How many days ahead to search. */
  horizonDays?: number;
  limit?: number;
  timeZone?: string;
}

/**
 * Emergencies are offered the earliest slot any qualified technician has today, even
 * after hours. Everything else respects a two-hour lead time so dispatch can route the van.
 */
export function findAvailableSlots(query: AvailabilityQuery): Slot[] {
  const timeZone = query.timeZone ?? TIMEZONE;
  const horizon = query.horizonDays ?? 7;
  const limit = query.limit ?? 4;
  const leadMs = query.severity === "emergency" ? 45 * 60000 : 2 * 60 * 60000;
  const earliest = new Date(query.now.getTime() + leadMs);

  const busyKeys = new Set(query.busy.map((b) => `${b.technicianId}:${new Date(b.startsAt).toISOString()}`));
  const qualified = TECHNICIANS.filter((t) => t.skills.includes(query.appliance));
  const todayLocal = localDayInfo(query.now, timeZone);
  const slots: Slot[] = [];

  for (let dayOffset = 0; dayOffset <= horizon; dayOffset++) {
    const probe = new Date(query.now.getTime() + dayOffset * 86400000);
    const dayInfo = localDayInfo(probe, timeZone);

    for (const startHour of SLOT_START_HOURS) {
      const startsAt = localWallClockToUtc(dayInfo.year, dayInfo.month, dayInfo.day, startHour, timeZone);
      if (startsAt < earliest) continue;

      const afterHours = startHour >= 17 || dayInfo.weekday === 0 || dayInfo.weekday === 6;
      // Only emergencies get after-hours slots offered unprompted.
      if (afterHours && query.severity !== "emergency") continue;

      for (const tech of qualified) {
        if (!tech.workDays.includes(dayInfo.weekday)) continue;
        if (startHour < tech.shiftStartHour) continue;
        if (startHour + SLOT_LENGTH_MINUTES / 60 > tech.shiftEndHour) continue;

        const key = `${tech.id}:${startsAt.toISOString()}`;
        if (busyKeys.has(key)) continue;

        const sameDay =
          dayInfo.year === todayLocal.year && dayInfo.month === todayLocal.month && dayInfo.day === todayLocal.day;

        slots.push({
          id: key,
          technicianId: tech.id,
          technicianName: tech.name,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + SLOT_LENGTH_MINUTES * 60000).toISOString(),
          label: describeSlot(startsAt.toISOString(), timeZone),
          afterHours,
          sameDay,
        });
      }
    }
  }

  slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // One slot per arrival window - the caller should choose a time, not a technician.
  const seen = new Set<string>();
  const deduped = slots.filter((s) => {
    if (seen.has(s.startsAt)) return false;
    seen.add(s.startsAt);
    return true;
  });

  return deduped.slice(0, limit);
}
