import { MemoryCalendar } from "../integrations/calendar/memory";
import { GoogleCalendar } from "../integrations/calendar/google";
import { MemoryMessaging, SlackMessaging, TelegramMessaging } from "../integrations/messaging/transports";
import { FanOutMessaging, type MessagingPort } from "../integrations/messaging/port";
import { CustomerRepository } from "../domain/customers";
import type { CalendarPort } from "../integrations/calendar/port";
import { AnthropicBrain } from "./brains/anthropic";
import { DeterministicBrain } from "./brains/deterministic";
import { buildSystemPrompt, greeting } from "./prompt";
import { canTransition, inferState, nextLegalStep } from "./state-machine";
import { TOOLS_BY_NAME, toolsForState } from "./tools";
import { redactDeep } from "./redact";
import {
  DEFAULT_CONFIG,
  type AgentConfig,
  type AgentContext,
  type Brain,
  type CallOutcome,
  type CallSession,
  type ConversationState,
  type ToolCall,
  type Utterance,
} from "./types";
import type { EnvLike } from "../config";

/**
 * The turn loop.
 *
 * One caller utterance in, one agent utterance out, with any number of tool calls in
 * between. Everything that could hang a phone line is bounded here: turns, tool calls per
 * turn, and stalled turns before the call goes to a human.
 */

export interface RunnerOptions {
  brain: Brain;
  calendar: CalendarPort;
  messaging: MessagingPort;
  customers?: CustomerRepository;
  config?: Partial<AgentConfig>;
  /** Injected clock; evals pin it so transcripts are byte-identical between runs. */
  now?: () => Date;
  /** Injected id source for the same reason. */
  idFactory?: (prefix: string) => string;
}

export interface TurnResult {
  say: string;
  session: CallSession;
  toolCalls: ToolCall[];
  stateChanged: boolean;
  latencyMs: number;
  ended: boolean;
}

export class CallRunner {
  readonly session: CallSession;
  private readonly ctx: AgentContext;
  private readonly brain: Brain;
  private stalledTurns = 0;
  private idCounter = 0;

  constructor(options: RunnerOptions, sessionId?: string) {
    const config = { ...DEFAULT_CONFIG, ...options.config };
    const now = options.now ?? (() => new Date());
    const nextId =
      options.idFactory ?? ((prefix: string) => `${prefix}_${(++this.idCounter).toString().padStart(4, "0")}`);

    this.brain = options.brain;
    this.session = {
      id: sessionId ?? `call_${now().getTime().toString(36)}`,
      startedAt: now().toISOString(),
      state: "greeting",
      slots: {},
      transcript: [],
      toolCalls: [],
      bookings: [],
      notifications: [],
      metrics: { turns: 0, toolCalls: 0, failedToolCalls: 0, brainMs: 0, toolMs: 0, maxTurnLatencyMs: 0 },
    };

    this.ctx = {
      session: this.session,
      config,
      calendar: options.calendar,
      messaging: options.messaging,
      customers: options.customers ?? new CustomerRepository(),
      now,
      nextId,
    };
  }

  get config(): AgentConfig {
    return this.ctx.config;
  }

  /** Caller ID from the telephony provider, when there is one. */
  setFromNumber(phone: string): void {
    this.session.fromNumber = phone;
    this.session.slots.phone ??= phone;
  }

  /** The line the agent speaks before the caller says anything. */
  open(): string {
    const line = greeting(this.ctx.config);
    this.push("agent", line);
    this.session.state = "identify";
    return line;
  }

  async turn(callerText: string, options: { confidence?: number; bargeIn?: boolean } = {}): Promise<TurnResult> {
    const startedAt = Date.now();
    // Bump the turn counter first so the caller utterance, the agent reply and every
    // tool call in between all carry the same turn number. The provider message builder
    // relies on that grouping.
    this.session.metrics.turns++;
    this.push("caller", callerText, options);

    if (this.session.state === "ended") {
      return this.result("", startedAt, [], false, true);
    }

    if (this.session.metrics.turns > this.ctx.config.maxTurns) {
      return await this.forceEscalate("Call exceeded the maximum number of turns.", startedAt);
    }

    // Low ASR confidence: ask, do not guess. Mishearing an address costs a truck roll.
    if (options.confidence !== undefined && options.confidence < 0.45) {
      const say = "Sorry, the line broke up there - could you say that once more?";
      this.push("agent", say);
      return this.result(say, startedAt, [], false, false);
    }

    const stateBefore = this.session.state;

    /*
     * The turn is a loop, not a single call: the brain asks for tools, the tools run,
     * and the brain gets another go now that it knows the answer. Without this the agent
     * can only ever say "let me check" and the caller hears the quote a turn late.
     *
     * Tools are gated on the state as it is *at the start of each round*, so a tool that
     * becomes legal because of what a previous round learned is usable immediately.
     */
    const executed: ToolCall[] = [];
    let say = "";
    let requestedState: ConversationState | undefined;
    let endCall = false;
    let pending: ToolCall[] = [];
    let lastFailedSignature: string | undefined;

    for (let round = 0; round < this.ctx.config.maxToolRoundsPerTurn; round++) {
      const availableTools = toolsForState(this.session.state);
      const systemPrompt = buildSystemPrompt(this.session, this.ctx.config, availableTools);

      let response;
      const brainStart = Date.now();
      try {
        response = await this.brain.respond({
          session: this.session,
          config: this.ctx.config,
          availableTools,
          systemPrompt,
          pendingToolResults: pending,
          round,
        });
      } catch (err) {
        // A dead model must not be a dead phone line.
        this.session.transcript.push({
          id: this.ctx.nextId("utt"),
          speaker: "system",
          text: `brain_error: ${err instanceof Error ? err.message : String(err)}`,
          at: this.ctx.now().toISOString(),
          turn: this.session.metrics.turns,
        });
        return await this.forceEscalate("The assistant could not complete the turn.", startedAt);
      } finally {
        this.session.metrics.brainMs += Date.now() - brainStart;
      }

      if (response.say.trim()) say = response.say.trim();
      if (response.nextState) requestedState = response.nextState;
      endCall = endCall || Boolean(response.endCall);

      const roundCalls = await this.runTools(
        response.toolCalls.slice(0, this.ctx.config.maxToolCallsPerRound),
        round,
      );
      executed.push(...roundCalls);

      // Nothing ran, so another round would be asked the identical question.
      if (roundCalls.length === 0) break;

      /*
       * Feeding a tool error back is how the brain corrects a bad argument, so one retry
       * is worth having. Repeating the *same* failing call verbatim is not a correction,
       * it is a loop - and on a phone call a loop is dead air. Stop and let the stall
       * detector escalate on the next turn.
       */
      const signature = roundCalls.map((c) => `${c.name}:${JSON.stringify(c.args ?? c.rawArgs)}`).join("|");
      if (roundCalls.every((c) => c.error) && signature === lastFailedSignature) break;
      lastFailedSignature = roundCalls.every((c) => c.error) ? signature : undefined;

      pending = roundCalls;

      // A transfer is terminal - do not let the brain keep talking over it.
      if (roundCalls.some((c) => c.name === "escalate_to_human" && !c.error)) break;
    }

    if (!say) {
      // Silence on a phone line reads as a dropped call.
      say = "Bear with me one moment.";
    }
    this.push("agent", say);

    const target = requestedState ?? inferState(this.session.state, this.session.slots);
    const requested = nextLegalStep(this.session.state, target, this.session.slots) ?? target;
    const transition = canTransition(this.session.state, requested, this.session.slots);
    if (transition.allowed) {
      this.session.state = requested;
    } else if (transition.missing?.length) {
      this.session.transcript.push({
        id: this.ctx.nextId("utt"),
        speaker: "system",
        text: `transition_refused: ${transition.reason} (missing: ${transition.missing.join(", ")})`,
        at: this.ctx.now().toISOString(),
        turn: this.session.metrics.turns,
      });
    }

    const stateChanged = this.session.state !== stateBefore;
    this.stalledTurns = stateChanged || executed.length > 0 ? 0 : this.stalledTurns + 1;
    if (this.stalledTurns >= this.ctx.config.maxStalledTurns && this.session.state !== "escalated") {
      return await this.forceEscalate("The call stopped making progress.", startedAt);
    }

    const ended = endCall || this.session.state === "ended";
    if (ended) this.end(this.deriveOutcome());

    return this.result(say, startedAt, executed, stateChanged, ended);
  }

  /** Close the call and stamp an outcome, for reporting. */
  end(outcome?: CallOutcome): CallSession {
    if (this.session.endedAt) return this.session;
    this.session.endedAt = this.ctx.now().toISOString();
    this.session.outcome ??= outcome ?? this.deriveOutcome();
    if (this.session.state !== "escalated") this.session.state = "ended";
    return this.session;
  }

  /** Session as it should be persisted: PII reduced to what operations actually needs. */
  redactedSession(): CallSession {
    return redactDeep(structuredClone(this.session));
  }

  /* ------------------------------------------------------------------ internals -- */

  private async runTools(
    invocations: Array<{ id: string; name: string; args: unknown }>,
    round: number,
  ): Promise<ToolCall[]> {
    const executed: ToolCall[] = [];

    for (const invocation of invocations) {
      const record: ToolCall = {
        id: invocation.id,
        name: invocation.name,
        rawArgs: invocation.args,
        startedAt: this.ctx.now().toISOString(),
        turn: this.session.metrics.turns,
        round,
      };
      this.session.toolCalls.push(record);
      this.session.metrics.toolCalls++;
      const started = Date.now();

      const tool = TOOLS_BY_NAME.get(invocation.name);
      if (!tool) {
        record.error = { message: `No such tool: ${invocation.name}`, retryable: false };
      } else if (!tool.allowedStates.includes(this.session.state)) {
        record.error = {
          message: `${invocation.name} is not available during ${this.session.state}`,
          retryable: false,
        };
      } else {
        const parsed = tool.schema.safeParse(invocation.args);
        if (!parsed.success) {
          record.error = {
            message: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
            retryable: true,
          };
        } else {
          record.args = parsed.data;
          try {
            record.result = await tool.handler(parsed.data, this.ctx);
          } catch (err) {
            record.error = {
              message: err instanceof Error ? err.message : String(err),
              retryable: true,
            };
          }
        }
      }

      record.finishedAt = this.ctx.now().toISOString();
      record.durationMs = Date.now() - started;
      this.session.metrics.toolMs += record.durationMs;
      if (record.error) this.session.metrics.failedToolCalls++;
      executed.push(record);
    }

    return executed;
  }

  private async forceEscalate(reason: string, startedAt: number): Promise<TurnResult> {
    const say = "Let me get one of the team on the line for you - one moment.";
    this.push("agent", say);
    this.session.state = "escalated";
    this.session.escalation = { reason, at: this.ctx.now().toISOString() };
    this.session.outcome = "escalated";
    /*
     * Awaited, not fired and forgotten. On a serverless runtime the process can be
     * frozen the moment the response is returned, so a dangling promise here is an
     * alert that silently never arrives - and this is the one alert that matters.
     */
    await this.ctx.messaging
      .send({
        channel: "on_call",
        priority: "high",
        title: "Voice agent handed off a call",
        body: reason,
        fields: [
          { label: "Call", value: this.session.id },
          { label: "Caller", value: this.session.slots.callerName ?? this.session.fromNumber ?? "unknown" },
        ],
        idempotencyKey: `${this.session.id}:auto-escalation`,
      })
      .catch(() => undefined);
    return this.result(say, startedAt, [], true, false);
  }

  private deriveOutcome(): CallOutcome {
    if (this.session.escalation) return "escalated";
    if (this.session.slots.bookingId) {
      return this.session.slots.severity === "emergency" ? "emergency_dispatched" : "booked";
    }
    if (this.session.slots.quotedLowUsd !== undefined) return "quoted_no_booking";
    if (this.session.slots.symptomId) return "self_resolved";
    return "abandoned";
  }

  private push(speaker: Utterance["speaker"], text: string, extra: Partial<Utterance> = {}): void {
    this.session.transcript.push({
      id: this.ctx.nextId("utt"),
      speaker,
      text,
      at: this.ctx.now().toISOString(),
      turn: this.session.metrics.turns,
      ...extra,
    });
  }

  private result(
    say: string,
    startedAt: number,
    toolCalls: ToolCall[],
    stateChanged: boolean,
    ended: boolean,
  ): TurnResult {
    const latencyMs = Date.now() - startedAt;
    this.session.metrics.maxTurnLatencyMs = Math.max(this.session.metrics.maxTurnLatencyMs, latencyMs);
    return { say, session: this.session, toolCalls, stateChanged, latencyMs, ended };
  }
}

/* ------------------------------------------------------------------- factories -- */

export interface RuntimeWiring {
  brain: Brain;
  calendar: CalendarPort;
  messaging: MessagingPort;
  /** What the deployment actually resolved to, surfaced in the UI so the demo is honest. */
  mode: { brain: string; calendar: string; messaging: string };
}

/**
 * Resolve real adapters where credentials exist and fall back to in-memory ones where
 * they do not. The mode is reported rather than hidden: a demo that silently pretends to
 * write to Google Calendar is worse than no demo.
 */
export function wireFromEnv(env: EnvLike = process.env): RuntimeWiring {
  const brain = AnthropicBrain.fromEnv(env) ?? new DeterministicBrain();
  const calendar = GoogleCalendar.fromEnv(env) ?? new MemoryCalendar();

  const transports = [TelegramMessaging.fromEnv(env), SlackMessaging.fromEnv(env)].filter(
    (t): t is NonNullable<typeof t> => t !== null,
  );
  const messaging: MessagingPort =
    transports.length === 0
      ? new MemoryMessaging()
      : transports.length === 1
        ? transports[0]!
        : new FanOutMessaging(transports);

  return {
    brain,
    calendar,
    messaging,
    mode: { brain: brain.name, calendar: calendar.name, messaging: messaging.name },
  };
}

export type { ConversationState };
