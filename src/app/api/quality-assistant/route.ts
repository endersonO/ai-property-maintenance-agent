import { checkAccess } from "@/server/access";
import { getQualityDeps } from "@/server/deps";
import { clientKey, readJsonCapped } from "@/server/http";
import { handleQualityAssistant } from "@/server/quality-assistant";

export const maxDuration = 60;

export async function POST(request: Request) {
  const deps = getQualityDeps();
  const client = clientKey(request.headers);
  const accessCode = request.headers.get("x-demo-access-code");

  const access = checkAccess(accessCode, client, deps.accessCode, deps.accessLimiter);
  if (access === "locked") return Response.json({ error: "too_many_attempts" }, { status: 429 });
  if (access === "denied") return Response.json({ error: "access_code_required" }, { status: 401 });

  const body = await readJsonCapped(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });

  const response = await handleQualityAssistant(body.value, deps, { accessCode, client });
  return Response.json(response.body, { status: response.status });
}
