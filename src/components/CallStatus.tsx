"use client";

import { Fragment } from "react";
import { stateLabel } from "@/lib/agent/state-machine";
import type { CallSession, ConversationState } from "@/lib/agent/types";

/**
 * The stage track and the dispatch feed.
 *
 * The track is a progress indicator because the conversation genuinely is a sequence -
 * you cannot book before you triage. When a call is handed to a human the track stops
 * pretending to be a pipeline and says so.
 */

const TRACK: ConversationState[] = ["identify", "triage", "quote", "schedule", "confirm", "wrap"];

export function StageTrack({ session }: { session: CallSession }) {
  const escalated = session.state === "escalated";
  const currentIndex = TRACK.indexOf(session.state);

  return (
    <div className="stages" data-escalated={escalated} aria-label="Call stage">
      {escalated ? (
        <span className="stage" data-current="true">
          <span className="stage__dot" />
          Handed to a person — {session.escalation?.reason ?? "transfer requested"}
        </span>
      ) : (
        TRACK.map((state, index) => (
          <Fragment key={state}>
            {index > 0 ? <span className="stage__link" /> : null}
            <span
              className="stage"
              data-done={currentIndex > index || session.state === "ended"}
              data-current={currentIndex === index}
            >
              <span className="stage__dot" />
              {stateLabel(state)}
            </span>
          </Fragment>
        ))
      )}
    </div>
  );
}

/** Notifications are recorded as "<priority>: <title>", or "FAILED <priority>: <title>". */
function parseAlert(entry: string): { priority: string; title: string; failed: boolean } {
  const failed = entry.startsWith("FAILED ");
  const body = failed ? entry.slice(7) : entry;
  const [priority = "normal", ...rest] = body.split(": ");
  return { priority, title: rest.join(": ") || body, failed };
}

export function DispatchFeed({ session }: { session: CallSession }) {
  return (
    <section className="panel" aria-label="Dispatch alerts">
      <div className="panel__head">
        <h2 className="panel__title">Dispatch feed</h2>
        <span className="panel__meta">
          {session.notifications.length === 0
            ? "quiet"
            : `${session.notifications.length} sent`}
        </span>
      </div>

      {session.notifications.length === 0 ? (
        <p className="empty">
          Nothing to send yet. Bookings, emergencies and transfers push straight to the team&apos;s Telegram or Slack.
        </p>
      ) : (
        <div className="feed">
          {session.notifications.map((entry, index) => {
            const alert = parseAlert(entry);
            const className = alert.failed
              ? "alert alert--failed"
              : alert.priority === "emergency"
                ? "alert alert--emergency"
                : alert.priority === "high"
                  ? "alert alert--high"
                  : "alert";
            return (
              <div key={`${entry}-${index}`} className={className}>
                <span className="alert__where">{alert.failed ? "not sent" : alert.priority}</span>
                <span>{alert.title}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Metrics({ session, lastLatencyMs }: { session: CallSession; lastLatencyMs: number | null }) {
  const m = session.metrics;
  return (
    <div className="metrics">
      <span>
        <b>{m.turns}</b> turns
      </span>
      <span>
        <b>{m.toolCalls}</b> tool calls
      </span>
      {m.failedToolCalls > 0 ? (
        <span>
          <b>{m.failedToolCalls}</b> rejected
        </span>
      ) : null}
      {lastLatencyMs !== null ? (
        <span>
          last turn <b>{lastLatencyMs} ms</b>
        </span>
      ) : null}
      {session.outcome ? (
        <span>
          outcome <b>{session.outcome.replace(/_/g, " ")}</b>
        </span>
      ) : null}
    </div>
  );
}
