"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_CALLERS, type RuntimeMode, type StartResponse, type TurnResponse } from "@/lib/api/contract";
import type { CallSession } from "@/lib/agent/types";
import { Transcript } from "./Transcript";
import { JobCard } from "./JobCard";
import { DispatchFeed, Metrics, StageTrack } from "./CallStatus";
import { useSpeechInput, useSpeechOutput } from "./useSpeech";

const TIME_ZONE = "America/Los_Angeles";

/**
 * Chips so a visitor without a microphone can still drive a whole call.
 *
 * Which chips are right depends on what the agent last did, not only on the slots it has
 * filled: once windows have been offered, "go ahead and book it" is the wrong thing to
 * suggest and "the first one" is the right one. So the offer state is read from the tool
 * log, which is the only place that fact lives.
 */
function hasOfferedWindows(session: CallSession): boolean {
  return session.toolCalls.some((call) => {
    if (call.name !== "check_availability" || call.error) return false;
    const result = call.result as { ok?: boolean; slots?: unknown[] } | undefined;
    return Boolean(result?.ok) && Array.isArray(result?.slots) && result.slots.length > 0;
  });
}

const SUGGESTIONS: Array<{ when: (s: CallSession) => boolean; options: string[] }> = [
  {
    when: (s) => !s.slots.symptomId,
    options: ["My fridge isn't cooling", "The washer won't drain", "Can I speak to a person?"],
  },
  {
    when: (s) => Boolean(s.slots.bookingId),
    options: ["That's all, thanks"],
  },
  {
    when: (s) => Boolean(s.slots.chosenSlotId),
    options: ["My name is Dana Whitlock", "415 555 0171", "12 Alder Street, Berkeley. Gate code 7781."],
  },
  {
    when: hasOfferedWindows,
    options: ["The first one", "The second one", "Neither of those works"],
  },
  {
    when: (s) => s.slots.quotedLowUsd !== undefined,
    options: ["Go ahead and book it", "That's more than I want to spend"],
  },
  {
    when: () => true,
    options: ["What would that cost?", "Just book someone, please", "No thanks, I'll try that first"],
  },
];

function suggestionsFor(session: CallSession): string[] {
  if (session.state === "escalated" || session.state === "ended") return [];
  return SUGGESTIONS.find((group) => group.when(session))?.options ?? [];
}

export function CallConsole() {
  const [session, setSession] = useState<CallSession | null>(null);
  const [mode, setMode] = useState<RuntimeMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const { speak, silence } = useSpeechOutput(voiceOn);

  const send = useCallback(
    async (text: string, confidence?: number) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const current = session;
      if (!current) return;

      // Barge-in: the caller talking is a reason for the agent to stop talking.
      silence();
      setBusy(true);
      setError(null);
      setDraft("");

      try {
        const response = await fetch("/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: current, text: trimmed, confidence }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(body.detail ?? body.error ?? `Request failed (${response.status})`);
        }
        const payload = (await response.json()) as TurnResponse;
        setSession(payload.session);
        setMode(payload.mode);
        setLastLatency(payload.latencyMs);
        speak(payload.say);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The line dropped. Try that again.");
        // Put the text back rather than making them say it again.
        setDraft(trimmed);
      } finally {
        setBusy(false);
      }
    },
    [busy, session, silence, speak],
  );

  const onHeard = useCallback(
    (result: { text: string; confidence: number }) => {
      void send(result.text, result.confidence);
    },
    [send],
  );

  const mic = useSpeechInput(onHeard);

  const startCall = useCallback(
    async (fromNumber: string, opener: string) => {
      setBusy(true);
      setError(null);
      setLastLatency(null);
      try {
        const response = await fetch("/api/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fromNumber ? { fromNumber } : {}),
        });
        if (!response.ok) throw new Error(`Could not open the line (${response.status})`);
        const payload = (await response.json()) as StartResponse;
        setSession(payload.session);
        setMode(payload.mode);
        speak(payload.say);
        setDraft(opener);
        // Let the greeting land before the caller's opener is typed in for them.
        setTimeout(() => inputRef.current?.focus(), 50);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open the line.");
      } finally {
        setBusy(false);
      }
    },
    [speak],
  );

  const hangUp = useCallback(() => {
    silence();
    mic.stop();
    setSession(null);
    setDraft("");
    setLastLatency(null);
    setError(null);
    // `mode` is a property of the deployment, not of the call, so it survives a hang-up.
  }, [mic, silence]);

  // The badges say which adapters are wired. That should be true on the idle page too,
  // not only once a call has started.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { mode?: RuntimeMode } | null) => {
        if (!cancelled && payload?.mode) setMode(payload.mode);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => silence(), [silence]);

  const finished = session?.state === "ended" || session?.state === "escalated";

  return (
    <>
      <Masthead mode={mode} live={Boolean(session) && !finished} />

      <main className="shell">
        <div className="intro">
          <h1 className="intro__title">Take a call</h1>
          <p>
            This is a working voice agent, not a scripted demo. It triages the fault against a service catalogue,
            prices the job from a rate card, holds a real arrival window and writes the booking to a calendar. Watch the
            job card on the right fill in as it goes.
          </p>
          <p>
            Speak or type. Every tool call it makes is shown inline, with what it returned and how long it took.
          </p>
        </div>

        <div className="console">
          <section className="panel" aria-label="Call">
            <div className="panel__head">
              <h2 className="panel__title">{session ? "Line 1 — open" : "Line 1 — idle"}</h2>
              <span className="panel__meta">
                {session ? session.id : "no call"}
                {session ? (
                  <button type="button" className="chip chip--inline" onClick={hangUp}>
                    Hang up
                  </button>
                ) : null}
              </span>
            </div>

            {session ? (
              <>
                <Transcript session={session} thinking={busy} />

                <div className="composer">
                  {finished ? (
                    <p className="notice">
                      {session.state === "escalated"
                        ? "Call handed to a person. The on-call channel has the details."
                        : "Call ended."}{" "}
                      <button type="button" className="chip" onClick={hangUp}>
                        Start another
                      </button>
                    </p>
                  ) : (
                    <>
                      <form
                        className="composer__row"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void send(draft);
                        }}
                      >
                        <label htmlFor="say" className="sr-only">
                          What the caller says
                        </label>
                        <input
                          id="say"
                          ref={inputRef}
                          value={mic.listening && mic.interim ? mic.interim : draft}
                          onChange={(event) => setDraft(event.target.value)}
                          placeholder={mic.listening ? "Listening…" : "Say something, or type it"}
                          disabled={busy}
                          autoComplete="off"
                        />
                        {mic.supported ? (
                          <button
                            type="button"
                            className="btn btn--mic"
                            data-listening={mic.listening}
                            onClick={() => (mic.listening ? mic.stop() : mic.start())}
                            disabled={busy}
                            aria-pressed={mic.listening}
                          >
                            {mic.listening ? "Stop" : "Speak"}
                          </button>
                        ) : null}
                        <button type="submit" className="btn" disabled={busy || !draft.trim()}>
                          Send
                        </button>
                      </form>

                      <div className="suggestions">
                        {suggestionsFor(session).map((option) => (
                          <button
                            key={option}
                            type="button"
                            className="chip"
                            disabled={busy}
                            onClick={() => void send(option)}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {mic.error ? <p className="notice notice--error">{mic.error}</p> : null}
                  {error ? <p className="notice notice--error">{error}</p> : null}

                  <p className="notice">
                    <label>
                      <input
                        type="checkbox"
                        checked={voiceOn}
                        onChange={(event) => {
                          setVoiceOn(event.target.checked);
                          if (!event.target.checked) silence();
                        }}
                      />{" "}
                      Read the agent&apos;s replies aloud
                    </label>
                  </p>
                </div>

                <Metrics session={session} lastLatencyMs={lastLatency} />
              </>
            ) : (
              <div className="starters">
                <p className="notice">
                  Pick who&apos;s calling. The first two are on file, so the agent knows them from the caller ID.
                </p>
                {DEMO_CALLERS.map((caller) => (
                  <button
                    key={caller.label}
                    type="button"
                    className="starter"
                    disabled={busy}
                    onClick={() => void startCall(caller.phone, caller.opener)}
                  >
                    <span className="starter__name">{caller.label}</span>
                    <span className="starter__phone">{caller.phone || "withheld"}</span>
                    <span className="starter__hint">{caller.hint}</span>
                  </button>
                ))}
                {error ? <p className="notice notice--error">{error}</p> : null}
              </div>
            )}
          </section>

          <div className="stack">
            {session ? (
              <>
                <section className="panel" aria-label="Progress">
                  <div className="panel__head">
                    <h2 className="panel__title">Stage</h2>
                  </div>
                  <StageTrack session={session} />
                </section>
                <JobCard session={session} timeZone={TIME_ZONE} />
                <DispatchFeed session={session} />
              </>
            ) : (
              <section className="panel">
                <div className="panel__head">
                  <h2 className="panel__title">Job card</h2>
                  <span className="panel__meta">waiting</span>
                </div>
                <p className="empty">
                  Start a call and this fills in one field at a time — caller, address, fault, estimate, arrival window,
                  technician — in the order the agent establishes them.
                </p>
              </section>
            )}
          </div>
        </div>

        <p className="foot">
          Source, architecture notes and the eval suite:{" "}
          <a href="https://github.com/uusammmaa/ai-voice-agent-appliance-repair" target="_blank" rel="noreferrer">
            github.com/uusammmaa/ai-voice-agent-appliance-repair
          </a>
        </p>
      </main>
    </>
  );
}

function Masthead({ mode, live }: { mode: RuntimeMode | null; live: boolean }) {
  return (
    <header className="masthead">
      <div className="masthead__inner">
        <p className="wordmark">
          Northside <span>Appliance Repair</span>
        </p>
        <span className="masthead__line">Scheduling line · Bay Area</span>
        <div className="badges">
          {live ? <span className="badge badge--live">Call in progress</span> : null}
          <span className="badge">{mode ? modeLabel("Brain", mode.brain) : "Brain: —"}</span>
          <span className="badge">{mode ? modeLabel("Calendar", mode.calendar) : "Calendar: —"}</span>
          <span className="badge">{mode ? modeLabel("Alerts", mode.messaging) : "Alerts: —"}</span>
        </div>
      </div>
    </header>
  );
}

/**
 * Says plainly which adapter is behind each port. A demo that implies it is writing to
 * Google Calendar when it is writing to a map in memory is worse than no demo.
 */
function modeLabel(port: string, adapter: string): string {
  const readable: Record<string, string> = {
    deterministic: "rules fallback",
    anthropic: "Claude",
    memory: "in-memory",
    google: "Google",
    telegram: "Telegram",
    slack: "Slack",
    fanout: "Telegram + Slack",
  };
  return `${port}: ${readable[adapter] ?? adapter}`;
}
