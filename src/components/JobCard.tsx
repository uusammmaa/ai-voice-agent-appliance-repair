"use client";

import { useEffect, useRef, useState } from "react";
import type { CallSession } from "@/lib/agent/types";
import type { Severity } from "@/lib/domain/catalog";
import { describeSlot } from "@/lib/domain/scheduling";

/**
 * The job card.
 *
 * This is the point of the whole console: a dispatcher does not care what the model
 * said, they care what ended up on the work order. Each field is a slot the agent has
 * captured, and a field flashes once when it fills so you can see exactly which sentence
 * produced which fact.
 */

interface FieldProps {
  label: string;
  value?: string | null;
  placeholder: string;
  severity?: Severity;
}

function Field({ label, value, placeholder, severity }: FieldProps) {
  const previous = useRef(value);
  const [justFilled, setJustFilled] = useState(false);

  useEffect(() => {
    if (value && value !== previous.current) {
      setJustFilled(true);
      const timer = setTimeout(() => setJustFilled(false), 900);
      previous.current = value;
      return () => clearTimeout(timer);
    }
    previous.current = value;
  }, [value]);

  return (
    <div className="field" data-just-filled={justFilled}>
      <span className="field__label">{label}</span>
      <span className={value ? "field__value" : "field__value field__value--empty"}>
        {value || placeholder}
        {value && severity ? <span className={`severity severity--${severity}`}>{severity}</span> : null}
      </span>
    </div>
  );
}

function money(low?: number, high?: number): string | null {
  if (low === undefined || high === undefined) return null;
  if (low === 0 && high === 0) return "No charge — under warranty";
  return `$${Math.round(low)} – $${Math.round(high)}`;
}

export function JobCard({ session, timeZone }: { session: CallSession; timeZone: string }) {
  const slots = session.slots;
  const booking = session.bookings[0];

  return (
    <section className="panel" aria-label="Job card">
      <div className="panel__head">
        <h2 className="panel__title">Job card</h2>
        <span className="panel__meta">{booking ? booking.id : "not raised"}</span>
      </div>

      <div className="jobcard">
        <Field label="Caller" value={slots.callerName} placeholder="—" />
        <Field label="Callback" value={slots.phone ?? session.fromNumber} placeholder="—" />
        <Field label="Address" value={slots.address} placeholder="—" />
        <Field label="Appliance" value={slots.appliance?.replace(/_/g, " ")} placeholder="—" />
        <Field label="Fault" value={slots.symptomLabel} placeholder="not triaged" severity={slots.severity} />
        <Field
          label="Estimate"
          value={money(slots.quotedLowUsd, slots.quotedHighUsd)}
          placeholder="not quoted"
        />
        <Field
          label="Window"
          value={booking ? describeSlot(booking.startsAt, timeZone) : null}
          placeholder="none held"
        />
        <Field label="Technician" value={booking?.technicianName} placeholder="unassigned" />
        <Field label="Access" value={booking?.notes} placeholder="nothing noted" />
      </div>

      {booking ? (
        <div className="booked">
          <span className="booked__id">Booked · {booking.id}</span>
          <p>
            {booking.technicianName} is due {describeSlot(booking.startsAt, timeZone)} at {booking.address}.
          </p>
          <p>
            {!booking.calendarEventId ? (
              <>Calendar write failed. Dispatch has been alerted to add it by hand.</>
            ) : booking.calendarHtmlLink ? (
              <a href={booking.calendarHtmlLink} target="_blank" rel="noreferrer">
                Open the event in Google Calendar
              </a>
            ) : (
              <>
                Written to the dispatch calendar as {booking.calendarEventId}. Add Google service-account credentials
                and this becomes a real event with a link.
              </>
            )}
          </p>
        </div>
      ) : null}
    </section>
  );
}
