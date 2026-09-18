import { buildRuntime, problem } from "@/lib/api/runtime";
import { startRequestSchema, type StartResponse } from "@/lib/api/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/call - open a call and return the agent's greeting. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = startRequestSchema.safeParse(body);
  if (!parsed.success) {
    return problem(400, "Invalid request", parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { runner, mode } = buildRuntime();
  if (parsed.data.fromNumber) runner.setFromNumber(parsed.data.fromNumber);

  const say = await runner.open();
  const payload: StartResponse = { session: runner.session, say, mode };
  return Response.json(payload);
}
