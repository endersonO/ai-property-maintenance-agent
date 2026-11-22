// Request hygiene for /api/chat, applied before any parsing or model call.

export const MAX_BODY_BYTES = 64 * 1024;

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

// Reads the body with a byte cap instead of buffering whatever the client sends.
export async function readJsonCapped(request: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) return { ok: false, status: 413, error: "body_too_large" };
  if (!request.body) return { ok: false, status: 400, error: "invalid_json" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, status: 413, error: "body_too_large" };
    }
    chunks.push(value);
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

// Best-effort client key for abuse limits. Behind a proxy (e.g. Vercel) the first
// x-forwarded-for entry is the client; locally all requests share one key.
export function clientKey(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || headers.get("x-real-ip") || "local";
}
