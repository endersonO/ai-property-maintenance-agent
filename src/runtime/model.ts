import { z } from "zod";
import type { AnyTool } from "./types";

// Model port: the runtime only needs "given the conversation and the tools, what next?".
// Implementations: ScriptedModel (evals, CI) and provider adapters (demo, agent evals).

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  // Opaque provider data that must be sent back unchanged on the next turn
  // (e.g. Gemini's thought signatures). The runtime stores it, never reads it.
  providerData?: unknown;
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type Usage = { inputTokens: number; outputTokens: number };

// Either a final answer (no tool calls) or a request to run tools.
export type ModelResponse = { text: string | null; toolCalls: ToolCall[]; usage: Usage };

export type ModelInput = {
  messages: Message[];
  tools: ToolSpec[];
  // Aborted when the run's deadline passes: implementations must cancel in-flight work.
  signal?: AbortSignal;
};

export interface ModelPort {
  readonly id: string;
  next(input: ModelInput): Promise<ModelResponse>;
}

// JSON Schema generated from the same Zod schemas the executor validates with.
export function toToolSpecs<Deps>(tools: AnyTool<Deps>[]): ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.input) as Record<string, unknown>,
  }));
}

export type ScriptStep = { text: string } | { toolCalls: { name: string; args: unknown }[] };

// Deterministic model for evals: returns predefined steps in order and records what it saw.
// It can do what a real model rarely does on demand — repeat a call, target another
// tenant's property, invent arguments — so we test that the system holds when it does.
export class ScriptedModel implements ModelPort {
  readonly id = "scripted";
  readonly seen: Message[][] = [];
  readonly seenTools: ToolSpec[][] = [];
  private step = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async next({ messages, tools }: ModelInput): Promise<ModelResponse> {
    this.seen.push(structuredClone(messages));
    this.seenTools.push(tools);
    const current = this.script[this.step++];
    if (!current) throw new Error(`Script exhausted after ${this.script.length} steps`);
    const usage = { inputTokens: 0, outputTokens: 0 };
    if ("text" in current) return { text: current.text, toolCalls: [], usage };
    return {
      text: null,
      toolCalls: current.toolCalls.map((call, i) => ({ id: `call_${this.step}_${i}`, ...call })),
      usage,
    };
  }
}
