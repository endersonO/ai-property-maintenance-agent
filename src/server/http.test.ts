import { describe, expect, it } from "vitest";
import { clientKey, readJsonCapped } from "./http";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/chat", { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("readJsonCapped", () => {
  it("parses a small JSON body", async () => {
    expect(await readJsonCapped(post('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects a declared oversized body without reading it", async () => {
    expect(await readJsonCapped(post("{}", { "content-length": "999999" }), 100)).toMatchObject({ status: 413 });
  });

  it("stops reading a streamed body once it exceeds the cap", async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode("x".repeat(50)));
        controller.close();
      },
    });
    expect(await readJsonCapped(post(stream), 100)).toMatchObject({ status: 413 });
  });

  it("rejects invalid JSON", async () => {
    expect(await readJsonCapped(post("{oops"))).toMatchObject({ status: 400, error: "invalid_json" });
  });
});

describe("clientKey", () => {
  it("uses the first forwarded address", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientKey(new Headers())).toBe("local");
  });
});
