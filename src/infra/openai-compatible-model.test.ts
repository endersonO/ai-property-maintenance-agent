import { describe, expect, it } from "vitest";
import { OpenAICompatibleModel } from "./openai-compatible-model";
import { RateLimitedModel } from "./rate-limited-model";

// Adapter behaviour against a fake HTTP layer: no network, no key.

type Captured = { body: Record<string, unknown>; signal: AbortSignal | null | undefined };

function fakeProvider(reply: (body: Record<string, unknown>) => unknown, captured: Captured[] = []) {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    captured.push({ body, signal: init.signal });
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

const completion = (message: Record<string, unknown>, finishReason = "stop") => ({
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 20 },
});

const input = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("OpenAICompatibleModel", () => {
  it.each(["length", "content_filter"])("rejects an incomplete response (%s)", async (reason) => {
    const { fetchImpl } = fakeProvider(() => completion({ content: "cut off mid-sen" }, reason));
    const model = new OpenAICompatibleModel({ apiKey: "k", model: "m", fetch: fetchImpl });
    await expect(model.next(input)).rejects.toThrow(`Incomplete model response: ${reason}`);
  });

  it("omits temperature unless configured", async () => {
    const { fetchImpl, captured } = fakeProvider(() => completion({ content: "ok" }));
    await new OpenAICompatibleModel({ apiKey: "k", model: "m", fetch: fetchImpl }).next(input);
    await new OpenAICompatibleModel({ apiKey: "k", model: "m", temperature: 0, fetch: fetchImpl }).next(input);
    expect("temperature" in captured[0].body).toBe(false);
    expect(captured[1].body.temperature).toBe(0);
  });

  it("passes the abort signal to the HTTP request", async () => {
    const { fetchImpl, captured } = fakeProvider(() => completion({ content: "ok" }));
    const controller = new AbortController();
    await new OpenAICompatibleModel({ apiKey: "k", model: "m", fetch: fetchImpl }).next({
      ...input,
      signal: controller.signal,
    });
    controller.abort();
    expect(captured[0].signal?.aborted).toBe(true);
  });

  it("round-trips provider data (thought signatures) and counts reasoning tokens as output", async () => {
    const { fetchImpl, captured } = fakeProvider(() =>
      completion({
        content: null,
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "ping", arguments: "{}" },
            extra_content: { google: { thought_signature: "sig" } },
          },
        ],
      }),
    );
    const model = new OpenAICompatibleModel({ apiKey: "k", model: "m", fetch: fetchImpl });
    const first = await model.next(input);
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 10 });

    await model.next({
      messages: [...input.messages, { role: "assistant", content: null, toolCalls: first.toolCalls }],
      tools: [],
    });
    const sent = (captured[1].body.messages as { tool_calls?: unknown[] }[])[1].tool_calls?.[0];
    expect(sent).toMatchObject({ extra_content: { google: { thought_signature: "sig" } } });
  });

  it("passes malformed tool arguments through for the executor to reject", async () => {
    const { fetchImpl } = fakeProvider(() =>
      completion({ content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: "{oops" } }] }),
    );
    const out = await new OpenAICompatibleModel({ apiKey: "k", model: "m", fetch: fetchImpl }).next(input);
    expect(out.toolCalls[0].args).toBe("{oops");
  });
});

describe("RateLimitedModel", () => {
  const ok = { text: "ok", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };

  it("spaces calls to the configured requests per minute", async () => {
    const model = new RateLimitedModel({ id: "m", next: async () => ok }, 1200); // one call every 50 ms
    const startedAt = Date.now();
    await Promise.all([model.next(input), model.next(input), model.next(input)]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(95);
  });

  it("puts every retry through the limiter", async () => {
    const calls: number[] = [];
    const flaky = {
      id: "m",
      next: async () => {
        calls.push(Date.now());
        if (calls.length < 3) throw Object.assign(new Error("quota"), { status: 429 });
        return ok;
      },
    };
    await new RateLimitedModel(flaky, 1200, 2).next(input);
    expect(calls).toHaveLength(3);
    // 1200 RPM = one slot every 50 ms. Timers can fire a few ms early under load; what matters
    // is that retries wait for the limiter instead of going out immediately.
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(40);
    expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(40);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    const broken = {
      id: "m",
      next: async () => {
        calls++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    };
    await expect(new RateLimitedModel(broken, 1200, 2).next(input)).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});
