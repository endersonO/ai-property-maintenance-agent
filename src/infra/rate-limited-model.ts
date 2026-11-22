import type { ModelInput, ModelPort, ModelResponse } from "@/runtime/model";

// Decorator that spaces calls to respect a provider's requests-per-minute quota,
// instead of hitting it and failing (e.g. Gemini free tier: 15 RPM per model).

export class RateLimitedModel implements ModelPort {
  readonly id: string;
  private nextSlotAt = 0;

  constructor(
    private readonly inner: ModelPort,
    private readonly requestsPerMinute: number,
  ) {
    this.id = inner.id;
  }

  async next(input: ModelInput): Promise<ModelResponse> {
    const interval = 60_000 / this.requestsPerMinute;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + interval;
    if (slot > now) await sleep(slot - now, input.signal);
    return this.inner.next(input);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}
