import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeToolCall } from "./executor";
import { defineTool, type ToolContext } from "./types";

// Generic toy tools: the executor knows nothing about maintenance.

type Deps = { log: string[] };

const ctx = (): ToolContext<Deps> => ({
  runId: "run-1",
  requestId: "req-1",
  actorId: "alice",
  deps: { log: [] },
});

const noteInput = z.strictObject({ owner: z.string(), text: z.string().min(1) });

const writeNote = defineTool<Deps, z.infer<typeof noteInput>, { flagged: boolean }>({
  name: "write_note",
  description: "Write a note",
  input: noteInput,
  authorize: async (c, args) => {
    c.deps.log.push("authorize");
    return args.owner === c.actorId ? null : { code: "forbidden", message: "Not your note" };
  },
  applyPolicy: async (c, args) => {
    c.deps.log.push("policy");
    return { flagged: args.text.includes("urgent") };
  },
  idempotencyKey: (c, args) => {
    c.deps.log.push("idempotency");
    return `${c.requestId}|${args.owner}`;
  },
  execute: async (c, args, { policy, idempotencyKey }) => {
    c.deps.log.push("execute");
    return { saved: args.text, flagged: policy.flagged, idempotencyKey };
  },
});

const explode = defineTool<Deps, Record<string, never>>({
  name: "explode",
  description: "Always fails",
  input: z.strictObject({}),
  execute: async () => {
    throw new Error("connection refused at 10.0.0.5");
  },
});

const tools = [writeNote, explode];

describe("executeToolCall", () => {
  it("runs every stage in order and passes policy and key to execute", async () => {
    const c = ctx();
    const out = await executeToolCall(tools, { name: "write_note", args: { owner: "alice", text: "urgent fix" } }, c);
    expect(out.status).toBe("ok");
    expect(out.stage).toBe("execute");
    expect(out.result).toEqual({
      ok: true,
      data: { saved: "urgent fix", flagged: true, idempotencyKey: "req-1|alice" },
    });
    expect(c.deps.log).toEqual(["authorize", "policy", "idempotency", "execute"]);
  });

  it("rejects an unknown tool at validate", async () => {
    const out = await executeToolCall(tools, { name: "delete_everything", args: {} }, ctx());
    expect(out.result).toMatchObject({ ok: false, stage: "validate", code: "unknown_tool" });
  });

  it("rejects invalid arguments at validate and runs nothing else", async () => {
    const c = ctx();
    const out = await executeToolCall(tools, { name: "write_note", args: { owner: "alice", text: "" } }, c);
    expect(out.status).toBe("rejected");
    expect(out.result).toMatchObject({ ok: false, stage: "validate", code: "invalid_arguments" });
    expect(c.deps.log).toEqual([]);
  });

  it("rejects extra arguments the model invents (e.g. priority)", async () => {
    const out = await executeToolCall(
      tools,
      { name: "write_note", args: { owner: "alice", text: "hi", priority: "low" } },
      ctx(),
    );
    expect(out.result).toMatchObject({ ok: false, stage: "validate" });
  });

  it("stops at authorize before policy or execute", async () => {
    const c = ctx();
    const out = await executeToolCall(tools, { name: "write_note", args: { owner: "bob", text: "hi" } }, c);
    expect(out.result).toEqual({ ok: false, stage: "authorize", code: "forbidden", message: "Not your note" });
    expect(c.deps.log).toEqual(["authorize"]);
  });

  it("turns a thrown error into a generic result and keeps the detail for the trace", async () => {
    const out = await executeToolCall(tools, { name: "explode", args: {} }, ctx());
    expect(out.status).toBe("error");
    expect(out.result).toEqual({
      ok: false,
      stage: "execute",
      code: "internal_error",
      message: "The explode tool failed. Nothing was changed.",
    });
    expect(out.internalError).toBe("connection refused at 10.0.0.5");
  });
});
