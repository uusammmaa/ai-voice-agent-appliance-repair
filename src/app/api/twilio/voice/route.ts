import { buildRuntime } from "@/lib/api/runtime";
import { gatherTwiml, hangupTwiml, transferTwiml, verifyTwilioSignature } from "@/lib/telephony/twiml";
import { calls } from "@/lib/telephony/call-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Twilio speech webhook.
 *
 * Twilio posts the recognised speech here and expects TwiML back. The same URL handles
 * both the first hit (no SpeechResult, so we greet) and every subsequent turn, which
 * keeps the Twilio console configuration to a single field.
 *
 * Unlike the browser console, the session cannot ride along in the request - Twilio
 * sends only a CallSid - so it is looked up server-side. See call-store.ts for what that
 * means in production.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) params[key] = String(value);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    const url = process.env.PUBLIC_BASE_URL
      ? `${process.env.PUBLIC_BASE_URL}/api/twilio/voice`
      : request.url;
    if (!verifyTwilioSignature(authToken, request.headers.get("x-twilio-signature"), url, params)) {
      // Anyone who finds this URL could otherwise book jobs and page the on-call team.
      return new Response("Invalid signature", { status: 403 });
    }
  }

  const callSid = params.CallSid ?? "unknown";
  const speech = (params.SpeechResult ?? "").trim();
  const confidence = params.Confidence ? Number(params.Confidence) : undefined;
  const actionUrl = `${process.env.PUBLIC_BASE_URL ?? ""}/api/twilio/voice`;

  const existing = await calls.get(callSid);
  const { runner } = buildRuntime(existing ?? undefined);

  let say: string;
  let ended = false;

  if (!existing) {
    if (params.From) runner.setFromNumber(params.From);
    say = await runner.open();
  } else if (!speech) {
    // actionOnEmptyResult means silence lands here too. Prompt once, then let go.
    const silentTurns = runner.session.transcript.filter((u) => u.text.includes("still there")).length;
    if (silentTurns >= 1) {
      await calls.delete(callSid);
      return xml(hangupTwiml("I'll let you go - call us back any time. Thanks."));
    }
    say = "Are you still there?";
    runner.session.transcript.push({
      id: `utt_silence_${runner.session.transcript.length}`,
      speaker: "agent",
      text: say,
      at: new Date().toISOString(),
      turn: runner.session.metrics.turns,
    });
  } else {
    const result = await runner.turn(speech, confidence === undefined ? {} : { confidence });
    say = result.say;
    ended = result.ended;
  }

  await calls.set(callSid, runner.session);

  if (runner.session.state === "escalated") {
    await calls.delete(callSid);
    const fallback = process.env.TRANSFER_TO_NUMBER;
    return xml(
      fallback
        ? transferTwiml(say, fallback)
        : hangupTwiml(`${say} Someone will call you straight back on this number.`),
    );
  }

  if (ended || runner.session.state === "ended") {
    await calls.delete(callSid);
    return xml(hangupTwiml(say));
  }

  return xml(gatherTwiml({ actionUrl, say }));
}

function xml(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });
}
