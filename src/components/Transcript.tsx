"use client";

import { useEffect, useRef } from "react";
import type { CallSession, ToolCall } from "@/lib/agent/types";
import { TOOLS_BY_NAME } from "@/lib/agent/tools";

/**
 * The call, as a log rather than a chat.
 *
 * Tool calls appear inline under the agent turn that issued them, because the thing a
 * reviewer wants to know is which sentence caused which side effect. Mutating tools are
 * coloured differently from reads: on this page, "wrote to a calendar" and "looked
 * something up" are not the same kind of event.
 */

const SPEAKER_LABEL = { agent: "Agent", caller: "Caller", system: "System" } as const;

function summariseArgs(call: ToolCall): string {
  const args = (call.args ?? call.rawArgs) as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.join(", ");
}

function summariseResult(call: ToolCall): string {
  if (call.error) return call.error.message;
  const result = call.result as Record<string, unknown> | undefined;
  if (!result) return "";
  if (result.ok === false) return String(result.reason ?? "rejected");

  // A few results have an obvious headline; everything else falls back to key names.
  if (typeof result.symptomLabel === "string") return result.symptomLabel;
  if (Array.isArray(result.slots)) return `${result.slots.length} windows offered`;
  if (typeof result.bookingId === "string") return `job ${result.bookingId}`;
  if (typeof result.window === "string") return result.window;
  if (typeof result.totalLowUsd === "number") return `$${Math.round(result.totalLowUsd)}–$${Math.round(Number(result.totalHighUsd))}`;
  if (result.found === true) return "customer on file";
  if (result.found === false) return "no record";
  if (Array.isArray(result.stillMissing)) {
    return result.stillMissing.length ? `still needs ${result.stillMissing.join(", ")}` : "complete";
  }
  if (typeof result.ticketId === "string") return result.ticketId;
  return "ok";
}

export function Transcript({ session, thinking }: { session: CallSession; thinking: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [session.transcript.length, thinking]);

  return (
    <div className="transcript" ref={scroller} role="log" aria-live="polite" aria-label="Call transcript">
      {session.transcript.map((utterance) => {
        const calls = session.toolCalls.filter((c) => c.turn === (utterance.turn ?? 0));
        const showTools = utterance.speaker === "agent" && calls.length > 0;

        return (
          <div key={utterance.id} className={`line line--${utterance.speaker}`} data-speaker={utterance.speaker}>
            <span className="line__who">{SPEAKER_LABEL[utterance.speaker]}</span>
            <p className="line__text">{utterance.text}</p>

            {showTools ? (
              <div className="tools">
                {calls.map((call) => {
                  const mutating = TOOLS_BY_NAME.get(call.name)?.mutating ?? false;
                  const className = call.error ? "tool tool--error" : mutating ? "tool tool--mutating" : "tool";
                  return (
                    <div key={call.id} className={className}>
                      <span className="tool__name">{call.name}</span>
                      <span className="tool__detail" title={summariseArgs(call)}>
                        {summariseResult(call)}
                      </span>
                      <span className="tool__ms">{call.durationMs ?? 0} ms</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      {thinking ? (
        <div className="line line--agent">
          <span className="line__who">Agent</span>
          <p className="line__text line__text--pending">
            thinking…
          </p>
        </div>
      ) : null}
    </div>
  );
}
