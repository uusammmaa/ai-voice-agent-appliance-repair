/**
 * TwiML generation and Twilio webhook verification.
 *
 * Two ways to take a real call, and the choice is a latency/complexity trade-off:
 *
 *  1. `<Gather input="speech">` — Twilio does ASR, posts the transcript to a webhook,
 *     we reply with `<Say>`. Ten lines of integration, no socket to keep alive, works on
 *     any serverless host. The cost is turn latency: Twilio waits for a speech endpoint
 *     before it posts, so ~1.5-2.5s per turn and no barge-in.
 *
 *  2. `<Connect><Stream>` — a bidirectional WebSocket of 8 kHz mu-law frames. Sub-second
 *     turns and real barge-in, because we control the endpointing. The cost is that it
 *     needs a long-lived process, so not Vercel functions.
 *
 * This file implements (1) end to end because it is what a small shop should actually
 * run, and documents (2) in docs/TELEPHONY.md. The agent core is identical either way -
 * only the transport changes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface GatherOptions {
  /** Absolute URL Twilio posts the recognised speech to. */
  actionUrl: string;
  /** Spoken before listening. Already plain text - the agent never emits markup. */
  say: string;
  /** Twilio voice name. The Polly Neural voices are worth the extra cost on a sales line. */
  voice?: string;
  language?: string;
  /** Seconds of silence that ends the caller's turn. */
  speechTimeout?: number;
}

/** XML text nodes must not carry raw markup, and a caller name could contain an ampersand. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function gatherTwiml(options: GatherOptions): string {
  const voice = options.voice ?? "Polly.Joanna-Neural";
  const language = options.language ?? "en-US";
  const speechTimeout = options.speechTimeout ?? 2;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Gather input="speech" action="${escapeXml(options.actionUrl)}" method="POST"` +
      ` speechTimeout="${speechTimeout}" language="${language}" speechModel="phone_call" enhanced="true"` +
      ` actionOnEmptyResult="true">`,
    `    <Say voice="${voice}">${escapeXml(options.say)}</Say>`,
    "  </Gather>",
    "</Response>",
  ].join("\n");
}

export function hangupTwiml(say: string, voice = "Polly.Joanna-Neural"): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}">${escapeXml(say)}</Say>`,
    "  <Hangup/>",
    "</Response>",
  ].join("\n");
}

/** Warm transfer to a human. The caller keeps the line while the phone rings. */
export function transferTwiml(say: string, dialNumber: string, voice = "Polly.Joanna-Neural"): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="${voice}">${escapeXml(say)}</Say>`,
    `  <Dial timeout="25" answerOnBridge="true">${escapeXml(dialNumber)}</Dial>`,
    `  <Say voice="${voice}">Sorry, nobody picked up. Someone will call you straight back.</Say>`,
    "  <Hangup/>",
    "</Response>",
  ].join("\n");
}

/**
 * Twilio request signature check.
 *
 * Without this anyone who finds the webhook URL can drive the agent, book jobs on the
 * dispatch calendar and spam the team's Telegram. The signature is HMAC-SHA1 over the
 * full URL concatenated with every POST parameter sorted by key.
 */
export function verifyTwilioSignature(
  authToken: string,
  signatureHeader: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signatureHeader) return false;

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
  const given = Buffer.from(signatureHeader, "utf8");
  const mine = Buffer.from(expected, "utf8");

  // Length must match before timingSafeEqual, and it throws otherwise.
  if (given.length !== mine.length) return false;
  return timingSafeEqual(given, mine);
}
