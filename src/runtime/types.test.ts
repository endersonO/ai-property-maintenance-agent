import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "./types";

// Compile-time checks: `pnpm typecheck` fails if a @ts-expect-error line stops erroring.

type Deps = Record<string, never>;
const input = z.object({ id: z.string() });

describe("ToolDefinition contract", () => {
  it("passes the policy outcome to execute when applyPolicy exists", () => {
    const tool = defineTool<Deps, { id: string }, { forceReview: boolean }>({
      name: "with_policy",
      description: "",
      input,
      applyPolicy: async () => ({ forceReview: true }),
      execute: async (_ctx, _args, { policy }) => policy.forceReview,
    });
    expect(tool.name).toBe("with_policy");
  });

  it("rejects execute reading a policy outcome that no applyPolicy provides", () => {
    defineTool<Deps, { id: string }, { forceReview: boolean }>(
      // @ts-expect-error applyPolicy is required when execute consumes a policy outcome
      {
        name: "missing_policy",
        description: "",
        input,
        execute: async (_ctx, _args, { policy }) => policy.forceReview,
      },
    );
  });

  it("types policy as undefined for tools without applyPolicy", () => {
    defineTool<Deps, { id: string }>({
      name: "no_policy",
      description: "",
      input,
      // @ts-expect-error policy is undefined here
      execute: async (_ctx, _args, { policy }) => policy.forceReview,
    });
  });
});
