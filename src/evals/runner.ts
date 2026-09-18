import { CallRunner } from "@/lib/agent/session";
import { DeterministicBrain } from "@/lib/agent/brains/deterministic";
import { MemoryCalendar } from "@/lib/integrations/calendar/memory";
import { MemoryMessaging } from "@/lib/integrations/messaging/transports";
import { CustomerRepository } from "@/lib/domain/customers";
import type { Brain, CallSession } from "@/lib/agent/types";
import type { Scenario } from "./scenarios";

export interface ScenarioResult {
  scenario: Scenario;
  session: CallSession;
  failures: string[];
  passed: boolean;
  transcript: string;
  durationMs: number;
}

export interface RunOptions {
  /** Defaults to the deterministic brain so the suite is hermetic. */
  brainFactory?: () => Brain;
}

/**
 * Replay one scenario end to end.
 *
 * The clock is pinned and advanced by a fixed step per utterance, so slot labels,
 * event ids and the transcript are byte-identical between runs. Anything that varies
 * between two runs of the same scenario is a bug.
 */
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<ScenarioResult> {
  const started = Date.now();
  const base = new Date(scenario.now).getTime();
  let tick = 0;
  const now = () => new Date(base + tick * 1500);

  const calendar = new MemoryCalendar();
  const messaging = new MemoryMessaging();
  let idCounter = 0;

  const runner = new CallRunner(
    {
      brain: options.brainFactory?.() ?? new DeterministicBrain(),
      calendar,
      messaging,
      customers: new CustomerRepository(),
      now,
      idFactory: (prefix) => `${prefix}_${(++idCounter).toString().padStart(4, "0")}`,
    },
    `eval_${scenario.id}`,
  );

  if (scenario.fromNumber) runner.setFromNumber(scenario.fromNumber);
  runner.open();

  for (const turn of scenario.turns) {
    tick++;
    const text = typeof turn === "string" ? turn : turn.text;
    const confidence = typeof turn === "string" ? undefined : turn.confidence;
    const result = await runner.turn(text, confidence === undefined ? {} : { confidence });
    if (result.ended || runner.session.state === "escalated") break;
  }

  const session = runner.end();
  const failures = checkExpectations(scenario, session, messaging);

  return {
    scenario,
    session,
    failures,
    passed: failures.length === 0,
    transcript: renderTranscript(session),
    durationMs: Date.now() - started,
  };
}

export async function runAll(scenarios: Scenario[], options: RunOptions = {}): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, options));
  return results;
}

function checkExpectations(scenario: Scenario, session: CallSession, messaging: MemoryMessaging): string[] {
  const failures: string[] = [];
  const expect = scenario.expect;
  const succeeded = new Set(session.toolCalls.filter((c) => !c.error).map((c) => c.name));

  if (expect.outcome && session.outcome !== expect.outcome) {
    failures.push(`outcome: expected ${expect.outcome}, got ${session.outcome}`);
  }
  if (expect.finalState && session.state !== expect.finalState) {
    failures.push(`state: expected ${expect.finalState}, got ${session.state}`);
  }
  for (const tool of expect.toolsCalled ?? []) {
    if (!succeeded.has(tool)) failures.push(`tool ${tool} was never called successfully`);
  }
  for (const tool of expect.toolsNotCalled ?? []) {
    if (session.toolCalls.some((c) => c.name === tool)) failures.push(`tool ${tool} should not have been called`);
  }
  for (const [key, value] of Object.entries(expect.slots ?? {})) {
    const actual = (session.slots as Record<string, unknown>)[key];
    if (actual !== value) failures.push(`slot ${key}: expected ${String(value)}, got ${String(actual)}`);
  }
  if (expect.bookingExpected !== undefined) {
    const hasBooking = session.bookings.length > 0;
    if (hasBooking !== expect.bookingExpected) {
      failures.push(`booking: expected ${expect.bookingExpected}, got ${hasBooking}`);
    }
  }
  if (expect.notificationMatching) {
    const found = messaging.sent.some((n) => n.title.includes(expect.notificationMatching as string));
    if (!found) {
      failures.push(
        `no notification titled like "${expect.notificationMatching}" (sent: ${messaging.sent.map((n) => n.title).join(" | ") || "none"})`,
      );
    }
  }

  // Invariants every call must satisfy, regardless of scenario.
  failures.push(...universalInvariants(session));
  failures.push(...(expect.custom?.(session) ?? []));
  return failures;
}

/** Rules that hold for every call. Cheaper to assert here than in twelve scenarios. */
function universalInvariants(session: CallSession): string[] {
  const failures: string[] = [];

  if (session.bookings.length > 1) failures.push("more than one booking on a single call");

  for (const booking of session.bookings) {
    if (!booking.address) failures.push(`booking ${booking.id} has no address`);
    if (!booking.phone) failures.push(`booking ${booking.id} has no callback number`);
    if (new Date(booking.endsAt) <= new Date(booking.startsAt)) failures.push(`booking ${booking.id} ends before it starts`);
  }

  const agentText = session.transcript
    .filter((u) => u.speaker === "agent")
    .map((u) => u.text)
    .join(" ");

  if (/\*|\bAI language model\b|\bas an AI\b|```/i.test(agentText)) {
    failures.push("agent produced text that a TTS engine would read out badly");
  }

  // Any dollar figure the agent said must have come out of a quote_job result.
  const spokenAmounts = [...agentText.matchAll(/\$(\d[\d,]*)/g)].map((m) => Number((m[1] ?? "0").replace(/,/g, "")));
  if (spokenAmounts.length > 0) {
    const quoteResults = session.toolCalls
      .filter((c) => c.name === "quote_job" && !c.error)
      .map((c) => JSON.stringify(c.result));
    for (const amount of spokenAmounts) {
      if (!quoteResults.some((r) => r.includes(String(amount)))) {
        failures.push(`agent said $${amount} but no quote_job result contains it`);
      }
    }
  }

  const failedMutations = session.toolCalls.filter((c) => c.error && c.name === "book_appointment");
  if (failedMutations.length > 0 && session.bookings.length > 0) {
    failures.push("a booking exists despite book_appointment failing");
  }

  return failures;
}

export function renderTranscript(session: CallSession): string {
  const lines: string[] = [];
  for (const utterance of session.transcript) {
    const who = { agent: "AGENT ", caller: "CALLER", system: "  sys " }[utterance.speaker];
    lines.push(`${who} | ${utterance.text}`);
    for (const call of session.toolCalls.filter((c) => c.turn === (utterance.turn ?? 0) && utterance.speaker === "agent")) {
      const status = call.error ? `ERROR ${call.error.message}` : "ok";
      lines.push(`       > ${call.name}(${JSON.stringify(call.args ?? call.rawArgs)}) -> ${status}`);
    }
  }
  return lines.join("\n");
}
