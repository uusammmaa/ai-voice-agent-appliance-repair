import { buildRuntime, problem } from "@/lib/api/runtime";
import { turnRequestSchema, type TurnResponse } from "@/lib/api/contract";
import type { CallSession } from "@/lib/agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long enough for a slow model turn, short enough that a hung call still returns. */
export const maxDuration = 30;

/** POST /api/turn - one caller utterance in, one agent utterance out. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "Body must be JSON");
  }

  const parsed = turnRequestSchema.safeParse(body);
  if (!parsed.success) {
    return problem(400, "Invalid request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  // The schema guarantees the shape; the runner owns the semantics from here.
  const session = parsed.data.session as unknown as CallSession;
  if (session.state === "ended") {
    return problem(409, "That call has already ended", "Start a new call to continue.");
  }

  const { runner, mode } = buildRuntime(session);

  try {
    const result = await runner.turn(
      parsed.data.text,
      parsed.data.confidence === undefined ? {} : { confidence: parsed.data.confidence },
    );
    const payload: TurnResponse = {
      session: result.session,
      say: result.say,
      latencyMs: result.latencyMs,
      ended: result.ended,
      mode,
    };
    return Response.json(payload);
  } catch (err) {
    // The runner already handles brain and tool failures; reaching here means something
    // genuinely unexpected, so say so plainly rather than returning a half-session.
    return problem(500, "The call could not be advanced", err instanceof Error ? err.message : undefined);
  }
}
