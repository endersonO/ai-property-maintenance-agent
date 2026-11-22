import { describe, expect, it } from "vitest";
import { createModelFromEnv } from "./model-config";

describe("createModelFromEnv", () => {
  it("treats empty variables as unset, as copied from .env.example", () => {
    const model = createModelFromEnv({ MODEL_API_KEY: "", GEMINI_API_KEY: "key", MODEL_NAME: "" });
    expect(model.id).toBe("gemini-3.5-flash-lite");
  });

  it("fails clearly without any key", () => {
    expect(() => createModelFromEnv({ GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
  });
});
