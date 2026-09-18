import { wireFromEnv } from "@/lib/agent/session";
import { SYMPTOMS } from "@/lib/domain/catalog";
import { TOOLS } from "@/lib/agent/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Reports which adapter each port actually resolved to. A demo that quietly falls back
 * to an in-memory calendar while implying it wrote to Google is worse than no demo, so
 * the same information drives the badges in the console header.
 */
export async function GET(): Promise<Response> {
  const wiring = wireFromEnv();
  return Response.json({
    status: "ok",
    mode: wiring.mode,
    live: {
      brain: wiring.mode.brain !== "deterministic",
      calendar: wiring.mode.calendar !== "memory",
      messaging: wiring.mode.messaging !== "memory",
    },
    catalogue: { symptoms: SYMPTOMS.length, tools: TOOLS.length },
  });
}
