import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainRequest, BrainResponse, BrainToolInvocation, CallSession } from "../types";
import type { EnvLike } from "../../config";

/**
 * Anthropic tool-calling brain.
 *
 * Latency is the whole game on a phone call, so:
 *  - the system prompt is stable within a state and marked for caching;
 *  - `max_tokens` is deliberately small - a long turn is a bug, not a feature;
 *  - the transcript is windowed, because a 40-turn call does not need all 40 turns of
 *    context to decide the next sentence, and prompt length is latency.
 */

export interface AnthropicBrainOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** How many prior utterances to include. Tool results always come from the session. */
  transcriptWindow?: number;
  client?: Anthropic;
}

const DEFAULT_MODEL = "claude-sonnet-5";

export class AnthropicBrain implements Brain {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly window: number;

  constructor(options: AnthropicBrainOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 300;
    this.window = options.transcriptWindow ?? 16;
  }

  static fromEnv(env: EnvLike = process.env): AnthropicBrain | null {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return new AnthropicBrain({ apiKey, model: env.ANTHROPIC_MODEL ?? DEFAULT_MODEL });
  }

  async respond(request: BrainRequest): Promise<BrainResponse> {
    const messages = buildMessages(request.session, this.window);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        {
          type: "text",
          text: request.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: request.availableTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.jsonSchema as Anthropic.Tool.InputSchema,
      })),
      messages,
    });

    const say = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ")
      .trim();

    const toolCalls: BrainToolInvocation[] = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, args: block.input }));

    const escalation = toolCalls.find((c) => c.name === "escalate_to_human");

    return {
      say: stripStageDirections(say),
      toolCalls,
      escalate: escalation ? String((escalation.args as { reason?: string }).reason ?? "model requested transfer") : undefined,
      endCall: response.stop_reason === "end_turn" && /thanks for calling|take care|goodbye/i.test(say),
    };
  }
}

/**
 * Rebuild the provider message list from the session.
 *
 * Anthropic requires every `tool_use` block to be answered by a matching `tool_result`
 * in the immediately following user message. Reconstructing that pairing by timestamp
 * across two separate logs is exactly where this kind of code breaks, so the runner
 * stamps each utterance and each tool call with the turn and round it belongs to, and
 * this function just walks that structure:
 *
 *   turn N: user(caller)
 *           [round 0] assistant(tool_use...) -> user(tool_result...)
 *           [round 1] assistant(tool_use...) -> user(tool_result...)
 *           assistant(what the agent actually said)
 *
 * The current turn has no agent utterance yet, so the list ends on a tool_result - which
 * is precisely the state in which the model is being asked to speak.
 */
function buildMessages(session: CallSession, window: number): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  const turnNumbers = [...new Set(session.transcript.map((u) => u.turn ?? 0))].sort((a, b) => a - b);
  const visible = turnNumbers.slice(-Math.max(1, Math.ceil(window / 2)));

  for (const turn of visible) {
    for (const utterance of session.transcript.filter((u) => (u.turn ?? 0) === turn && u.speaker === "caller")) {
      messages.push({ role: "user", content: utterance.text });
    }

    const calls = session.toolCalls.filter((c) => c.turn === turn);
    for (const round of [...new Set(calls.map((c) => c.round))].sort((a, b) => a - b)) {
      const roundCalls = calls.filter((c) => c.round === round);
      messages.push({
        role: "assistant",
        content: roundCalls.map<Anthropic.ToolUseBlockParam>((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: (call.args ?? call.rawArgs ?? {}) as Record<string, unknown>,
        })),
      });
      messages.push({
        role: "user",
        content: roundCalls.map<Anthropic.ToolResultBlockParam>((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: Boolean(call.error),
          content: JSON.stringify(call.error ?? call.result ?? { ok: true }),
        })),
      });
    }

    for (const utterance of session.transcript.filter((u) => (u.turn ?? 0) === turn && u.speaker === "agent")) {
      if (utterance.text) messages.push({ role: "assistant", content: utterance.text });
    }
  }

  // The API rejects an empty or assistant-led conversation.
  if (messages.length === 0 || messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: "[call connected]" });
  }
  return messages;
}

/** Models occasionally emit *pauses* or (warmly) despite the prompt; TTS reads them out. */
function stripStageDirections(text: string): string {
  return text
    .replace(/\*[^*]{0,60}\*/g, "")
    .replace(/\((?:pause|warmly|softly|laughs)[^)]*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
