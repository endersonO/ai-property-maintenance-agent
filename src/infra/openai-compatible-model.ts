import OpenAI from "openai";
import { ModelOutputError, type Message, type ModelInput, type ModelPort, type ModelResponse } from "@/runtime/model";

// Adapter for any provider exposing the OpenAI Chat Completions API (Gemini, OpenAI,
// Groq, OpenRouter, Ollama...). Switching provider is configuration, not code.

export type OpenAICompatibleConfig = {
  apiKey: string;
  baseURL?: string;
  model: string;
  // Sent only when set: some models reject the parameter entirely.
  temperature?: number;
  // SDK-level retries. Set to 0 when a RateLimitedModel handles retries, so every
  // attempt goes through the rate limiter.
  maxRetries?: number;
  // For tests.
  fetch?: typeof fetch;
};

// Provider extension on tool calls, not in the OpenAI types (e.g. Gemini thought signatures).
type ProviderToolCall = { extra_content?: unknown };

export class OpenAICompatibleModel implements ModelPort {
  readonly id: string;
  private readonly client: OpenAI;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.model;
    // The run's abort signal cancels in-flight requests and any SDK retries.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: config.maxRetries ?? 2,
      ...(config.fetch && { fetch: config.fetch }),
    });
  }

  async next({ messages, tools, signal }: ModelInput): Promise<ModelResponse> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.config.model,
        ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
        messages: messages.map(toProviderMessage),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: withoutSchemaKey(t.parameters) },
        })),
      },
      { signal },
    );

    const choice = completion.choices[0];
    // A truncated or filtered answer must never be treated as a final answer.
    if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
      throw new ModelOutputError(choice.finish_reason);
    }

    const message = choice?.message;
    const usage = completion.usage;
    return {
      text: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? [])
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
