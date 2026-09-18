/**
 * Log redaction.
 *
 * Call transcripts are the most useful debugging artefact a voice agent produces and the
 * most dangerous thing to keep. Everything written to logs or analytics goes through here
 * first. The live session object keeps the real values - only the persisted copy is
 * redacted.
 */

const PATTERNS: Array<{ name: string; re: RegExp; replace: (m: string) => string }> = [
  {
    name: "card",
    // 13-19 digits with optional separators: catch these before phone numbers.
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: () => "[card-redacted]",
  },
  {
    name: "email",
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replace: (m) => {
      const [local = "", domain = ""] = m.split("@");
      return `${local.slice(0, 2)}***@${domain}`;
    },
  },
  {
    name: "phone",
    re: /(\+?\d[\d\s().-]{7,}\d)/g,
    replace: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 7 ? `***-***-${digits.slice(-4)}` : m;
    },
  },
  {
    name: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => "[ssn-redacted]",
  },
];

/** Street number is kept - a technician log needs to be useful - the rest is trimmed. */
export function redactAddress(address: string): string {
  const match = address.match(/^(\d+)\s+(.*)$/);
  if (!match) return address;
  const [, number, rest] = match;
  const tail = (rest ?? "").split(",").slice(1).join(",").trim();
  return tail ? `${number} ***, ${tail}` : `${number} ***`;
}

export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

export function redactDeep<T>(value: T, addressKeys = new Set(["address", "location"])): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, addressKeys)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = addressKeys.has(k) && typeof v === "string" ? redactAddress(redact(v)) : redactDeep(v, addressKeys);
    }
    return out as T;
  }
  return value;
}
