import type { CallSession } from "../agent/types";

/**
 * Where a live phone call's session lives between webhook hits.
 *
 * The browser console can post the session back with every turn; a phone call cannot,
 * because Twilio sends a CallSid and nothing else. So this is genuinely server-side
 * state, and it is the one piece of the system that needs a real store in production.
 *
 * The default implementation is a process map with a TTL. That is correct for a single
 * long-lived Node process (`npm start`, a container, Fly, Railway) and wrong for
 * serverless functions, where consecutive webhook hits may land on different instances.
 * `REDIS_URL` swaps in a shared store; the interface is three methods precisely so that
 * swap is a config change and not a refactor.
 */

export interface CallStore {
  get(callSid: string): Promise<CallSession | null>;
  set(callSid: string, session: CallSession): Promise<void>;
  delete(callSid: string): Promise<void>;
}

/** Twilio caps a call at four hours; anything older than that is certainly dead. */
const TTL_MS = 4 * 60 * 60 * 1000;

export class InMemoryCallStore implements CallStore {
  private readonly entries = new Map<string, { session: CallSession; expiresAt: number }>();

  async get(callSid: string): Promise<CallSession | null> {
    this.sweep();
    return this.entries.get(callSid)?.session ?? null;
  }

  async set(callSid: string, session: CallSession): Promise<void> {
    this.entries.set(callSid, { session, expiresAt: Date.now() + TTL_MS });
  }

  async delete(callSid: string): Promise<void> {
    this.entries.delete(callSid);
  }

  /** Cheap enough to run on read; a repair shop does not have a million live calls. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Redis-backed store over the REST API, so it works from an edge or serverless runtime
 * with no connection pool to manage. Upstash's REST protocol is the target, because it
 * is the one that survives a function that may be frozen between requests.
 */
export class RestRedisCallStore implements CallStore {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async command(...args: Array<string | number>): Promise<unknown> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Call store command failed: ${response.status}`);
    const payload = (await response.json()) as { result?: unknown };
    return payload.result;
  }

  async get(callSid: string): Promise<CallSession | null> {
    const raw = await this.command("GET", key(callSid));
    return typeof raw === "string" ? (JSON.parse(raw) as CallSession) : null;
  }

  async set(callSid: string, session: CallSession): Promise<void> {
    await this.command("SET", key(callSid), JSON.stringify(session), "PX", TTL_MS);
  }

  async delete(callSid: string): Promise<void> {
    await this.command("DEL", key(callSid));
  }
}

function key(callSid: string): string {
  return `call:${callSid}`;
}

function build(): CallStore {
  const url = process.env.REDIS_REST_URL;
  const token = process.env.REDIS_REST_TOKEN;
  return url && token ? new RestRedisCallStore(url, token) : new InMemoryCallStore();
}

export const calls: CallStore = build();
