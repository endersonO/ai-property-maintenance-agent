import { checkAccess } from "@/server/access";
import { handleChat } from "@/server/chat";
import { getServerDeps } from "@/server/deps";
import { clientKey, readJsonCapped } from "@/server/http";

// Upper bound for the platform; the agent run itself stops at 50 s and fails cleanly.
export const maxDuration = 60;

export async function POST(request: Request) {
  const deps = getServerDeps();
  const client = clientKey(request.headers);
  const accessCode = request.headers.get("x-demo-access-code");

  // Access is checked before the body is read, so unauthorised callers can't make us parse it.
  const access = checkAccess(accessCode, client, deps.accessCode, deps.accessLimiter);
  if (access === "locked") return Response.json({ error: "too_many_attempts" }, { status: 429 });
  if (access === "denied") return Response.json({ error: "access_code_required" }, { status: 401 });

  const body = await readJsonCapped(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });

  const response = await handleChat(body.value, deps, { accessCode, client });
  return Response.json(response.body, { status: response.status });
}
