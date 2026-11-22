import OpenAI from "openai";
import type { Message, ModelPort, ModelResponse, ToolSpec } from "@/runtime/model";

// Adapter for any provider exposing the OpenAI Chat Completions API (Gemini, OpenAI,
// Groq, OpenRouter, Ollama...). Switching provider is configuration, not code.

export type OpenAICompatibleConfig = {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
};

export class OpenAICompatibleModel implements ModelPort {
  readonly id: string;
  private readonly client: OpenAI;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.model;
    // The SDK retries 429/5xx with backoff ("high demand" spikes on free tiers).
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 2 });
  }

  async next({ messages, tools }: { messages: Message[]; tools: ToolSpec[] }): Promise<ModelResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: this.config.temperature ?? 0,
      messages: messages.map(toProviderMessage),
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: withoutSchemaKey(t.parameters) },
      })),
    });

    const choice = completion.choices[0]?.message;
    const usage = completion.usage;
    return {
      text: choice?.content ?? null,
      toolCalls: (choice?.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          args: parseArgs(call.function.arguments),
          providerData: (call as ProviderToolCall).extra_content,
        })),
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        // Reasoning ("thinking") tokens are billed as output but not always in completion_tokens.
        outputTokens: usage ? usage.total_tokens - usage.prompt_tokens : 0,
      },
    };
  }
}

// Provider extension on tool calls, not in the OpenAI types (e.g. Gemini thought signatures).
type ProviderToolCall = { extra_content?: unknown };

function toProviderMessage(message: Message): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls.length > 0 && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
            ...(call.providerData !== undefined && { extra_content: call.providerData }),
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

// Malformed JSON is passed through as a string: the executor rejects it at validate,
// and the trace shows exactly what the model produced.
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Zod adds a "$schema" key some providers reject in tool parameters.
function withoutSchemaKey(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}
