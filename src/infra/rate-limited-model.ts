import type { ModelInput, ModelPort, ModelResponse } from "@/runtime/model";

// Decorator that spaces calls to respect a provider's requests-per-minute quota,
// instead of hitting it and failing (e.g. Gemini free tier: 15 RPM per model).
// It also owns retries, so every attempt — including retries — takes a slot.
// Use with the inner model's own retries disabled.

const RETRYABLE_STATUS = (status: number) => status === 429 || status >= 500;

export class RateLimitedModel implements ModelPort {
  readonly id: string;
  private nextSlotAt = 0;

  constructor(
    private readonly inner: ModelPort,
    private readonly requestsPerMinute: number,
    private readonly maxRetries = 2,
  ) {
    this.id = inner.id;
  }

  async next(input: ModelInput): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot(input.signal);
      try {
        return await this.inner.next(input);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const retryable = typeof status === "number" && RETRYABLE_STATUS(status);
        if (!retryable || attempt >= this.maxRetries || input.signal?.aborted) throw error;
      }
    }
  }

  private async waitForSlot(signal?: AbortSignal) {
    const interval = 60_000 / this.requestsPerMinute;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + interval;
    if (slot > now) await sleep(slot - now, signal);
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
