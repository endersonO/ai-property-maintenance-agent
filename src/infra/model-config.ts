import { OpenAICompatibleModel } from "./openai-compatible-model";

// Real model from environment. Defaults to Gemini's OpenAI-compatible endpoint.
// MODEL_NAME was chosen after checking the models available to the key (not guessed).

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.MODEL_API_KEY ?? env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY (or MODEL_API_KEY) to use a real model");

  return new OpenAICompatibleModel({
    apiKey,
    baseURL: env.MODEL_BASE_URL ?? GEMINI_BASE_URL,
    model: env.MODEL_NAME ?? "gemini-3.5-flash-lite",
  });
}
