import { TOOLS } from "../agent/tools";
import { DEFAULT_CONFIG, type AgentConfig } from "../agent/types";
import { buildSystemPrompt } from "../agent/prompt";
import type { CallSession } from "../agent/types";

/**
 * Export the agent as a hosted-platform assistant definition.
 *
 * VAPI, Retell and their peers own the audio pipeline and call out to your webhook for
 * each tool. That is a genuinely good trade for a small shop: sub-second turns, barge-in
 * and call recording without running a WebSocket process. What you give up is control of
 * the turn loop.
 *
 * Because the tool schemas and the prompt are already data in this codebase, the
 * assistant definition is generated rather than maintained by hand - so a tool added to
 * `TOOLS` cannot silently go missing from the hosted deployment.
 */

export interface ProviderExportOptions {
  config?: AgentConfig;
  /** Absolute base URL the provider posts tool calls to. */
  webhookBaseUrl: string;
  voiceProvider?: "11labs" | "playht" | "azure";
  voiceId?: string;
}

/** A session stub, so the prompt builder can render its opening state. */
function promptSeed(): CallSession {
  return {
    id: "template",
    startedAt: new Date(0).toISOString(),
    state: "identify",
    slots: {},
    transcript: [],
    toolCalls: [],
    bookings: [],
    notifications: [],
    metrics: { turns: 0, toolCalls: 0, failedToolCalls: 0, brainMs: 0, toolMs: 0, maxTurnLatencyMs: 0 },
  };
}

export function toVapiAssistant(options: ProviderExportOptions): Record<string, unknown> {
  const config = options.config ?? DEFAULT_CONFIG;
  const systemPrompt = buildSystemPrompt(promptSeed(), config, TOOLS);

  return {
    name: `${config.businessName} - inbound scheduling`,
    firstMessage: `Thanks for calling ${config.businessName}. What's going on with your appliance?`,
    // The caller should hear the greeting immediately, not after a model round trip.
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
      temperature: 0.3,
      maxTokens: 300,
      messages: [{ role: "system", content: systemPrompt }],
      tools: TOOLS.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.jsonSchema },
        server: { url: `${options.webhookBaseUrl}/api/provider/tool`, timeoutSeconds: 15 },
      })),
    },
    voice: {
      provider: options.voiceProvider ?? "11labs",
      voiceId: options.voiceId ?? "rachel",
      // A short chunk size gets audio out faster at the cost of slightly choppier prosody.
      chunkPlan: { enabled: true, minCharacters: 30 },
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en-US", endpointing: 250 },
    // Callers interrupt. Stopping mid-sentence is the difference between a call that
    // feels like a person and one that feels like an IVR.
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingEnabled: true },
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1 },
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    endCallPhrases: ["thanks for calling", "take care", "goodbye"],
    serverUrl: `${options.webhookBaseUrl}/api/provider/events`,
    analysisPlan: {
      summaryPrompt: "Summarise the call in two sentences: the fault, and what was agreed.",
      structuredDataSchema: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["booked", "quoted_no_booking", "escalated", "abandoned"] },
          symptomId: { type: "string" },
          bookingId: { type: "string" },
        },
      },
    },
  };
}

/**
 * Retell uses a different envelope but the same three ingredients, so the mapping is
 * mechanical. Keeping both here makes the point that the agent is not tied to a vendor.
 */
export function toRetellAgent(options: ProviderExportOptions): Record<string, unknown> {
  const config = options.config ?? DEFAULT_CONFIG;
  return {
    agent_name: `${config.businessName} - inbound scheduling`,
    voice_id: options.voiceId ?? "11labs-Rachel",
    language: "en-US",
    responsiveness: 0.9,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_words: ["mm-hm", "right", "okay"],
    response_engine: { type: "custom-llm", llm_websocket_url: `${options.webhookBaseUrl.replace(/^http/, "ws")}/llm` },
    general_prompt: buildSystemPrompt(promptSeed(), config, TOOLS),
    general_tools: TOOLS.map((tool) => ({
      type: "custom",
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
      url: `${options.webhookBaseUrl}/api/provider/tool`,
      speak_during_execution: tool.name === "check_availability" || tool.name === "book_appointment",
      speak_after_execution: true,
    })),
  };
}
