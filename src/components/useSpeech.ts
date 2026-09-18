"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser speech input and output.
 *
 * The Web Speech API is the honest choice for a hosted demo: no keys, no per-visitor
 * cost, no audio leaving the machine. It is also not what production uses - a real
 * deployment runs Deepgram or Twilio's recogniser server-side, because the browser API
 * is Chrome-and-Safari-only and gives no control over endpointing.
 *
 * What it does give us, and what matters for the demo, is a confidence score. The agent
 * treats a low-confidence turn as "I did not hear you" rather than acting on it, which
 * is the same rule it applies to a phone recogniser.
 */

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResult };
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface SpeechResult {
  text: string;
  confidence: number;
}

export function useSpeechInput(onFinal: (result: SpeechResult) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  /*
   * Whether the browser has the API is a fact about the environment, not state that
   * changes over time. Reading it lazily keeps it out of an effect - but it must be
   * read lazily rather than at module scope, because the server render has no window
   * and would otherwise disagree with the client's first paint.
   */
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);

  /*
   * The recogniser instance is created once and lives for the life of the component, so
   * its onresult closure would otherwise capture the first render's callback forever.
   * Routing through a ref keeps the latest one reachable; updating that ref in an effect
   * rather than during render keeps it out of the render phase, where a concurrent
   * re-render could observe a value that was never committed.
   */
  const handler = useRef(onFinal);
  useEffect(() => {
    handler.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const instance = new Ctor();
    instance.continuous = false;
    instance.interimResults = true;
    instance.lang = "en-US";
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const best = result[0];
        if (result.isFinal) {
          const text = best.transcript.trim();
          // Some engines report 0 confidence on a perfectly good final result; treating
          // that as "unheard" would make the demo unusable, so it is read as unscored.
          if (text) handler.current({ text, confidence: best.confidence > 0 ? best.confidence : 0.9 });
        } else {
          pending += best.transcript;
        }
      }
      setInterim(pending);
    };

    instance.onerror = (event) => {
      const code = event.error ?? "unknown";
      setError(
        code === "not-allowed"
          ? "Microphone blocked. Allow it in the address bar, or type instead."
          : code === "no-speech"
            ? null
            : `Speech recognition stopped: ${code}`,
      );
      setListening(false);
    };

    instance.onend = () => {
      setListening(false);
      setInterim("");
    };

    recognition.current = instance;
    return () => {
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      instance.abort();
      recognition.current = null;
    };
  }, []);

  const start = useCallback(() => {
    if (!recognition.current || listening) return;
    setError(null);
    try {
      recognition.current.start();
      setListening(true);
    } catch {
      // start() throws if called while already running; the onend handler resets state.
      setListening(false);
    }
  }, [listening]);

  const stop = useCallback(() => {
    recognition.current?.stop();
    setListening(false);
  }, []);

  return { listening, interim, supported, error, start, stop };
}

/**
 * Speaks the agent's turns.
 *
 * Cancelling before each utterance is what gives the demo barge-in: start a new turn and
 * the previous sentence stops mid-word, the way a person stops when you interrupt them.
 */
export function useSpeechOutput(enabled: boolean) {
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      voice.current =
        voices.find((v) => /en-US/.test(v.lang) && /Samantha|Google US English|Jenny|Aria/.test(v.name)) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        null;
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!enabled || typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice.current) utterance.voice = voice.current;
      utterance.rate = 1.05;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    },
    [enabled],
  );

  const silence = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  return { speak, silence };
}
