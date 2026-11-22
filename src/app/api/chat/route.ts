import { handleChat } from "@/server/chat";
import { getServerDeps } from "@/server/deps";

// Upper bound for the platform; the agent run itself stops at 50 s and fails cleanly.
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const response = await handleChat(body, getServerDeps(), {
    accessCode: request.headers.get("x-demo-access-code"),
  });
  return Response.json(response.body, { status: response.status });
}
