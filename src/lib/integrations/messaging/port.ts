/**
 * Messenger port - Telegram, Slack, or anything else the shop already lives in.
 *
 * Notifications are fire-and-forget from the caller's point of view: a failed Telegram
 * push must never abort a booking that has already been written to the calendar. The
 * agent therefore treats every send as best-effort and records the failure on the call
 * record instead of surfacing it to the caller.
 */

export type NotificationChannel = "dispatch" | "on_call" | "sales" | "management";

export type NotificationPriority = "low" | "normal" | "high" | "emergency";

export interface Notification {
  channel: NotificationChannel;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** Rendered as a compact key/value block by adapters that support it. */
  fields?: Array<{ label: string; value: string }>;
  /** Deduplicates retries at the transport level. */
  idempotencyKey: string;
  link?: string;
}

export interface DeliveryReceipt {
  transport: string;
  channel: NotificationChannel;
  messageId: string;
  deliveredAt: string;
  deduplicated: boolean;
}

export interface MessagingPort {
  readonly name: string;
  send(notification: Notification): Promise<DeliveryReceipt>;
}

/** Plain-text rendering shared by every transport, so alerts read the same everywhere. */
export function renderNotification(n: Notification): string {
  const icon = { low: "•", normal: "🔔", high: "⚠️", emergency: "🚨" }[n.priority];
  const lines = [`${icon} ${n.title}`, "", n.body];
  if (n.fields?.length) {
    lines.push("");
    for (const f of n.fields) lines.push(`${f.label}: ${f.value}`);
  }
  if (n.link) lines.push("", n.link);
  return lines.join("\n");
}

/** Sends to several transports and never throws; partial failure is normal and logged. */
export class FanOutMessaging implements MessagingPort {
  readonly name = "fanout";
  readonly failures: Array<{ transport: string; error: string }> = [];

  constructor(private readonly transports: MessagingPort[]) {}

  async send(notification: Notification): Promise<DeliveryReceipt> {
    const results = await Promise.allSettled(this.transports.map((t) => t.send(notification)));
    const ok = results.find((r): r is PromiseFulfilledResult<DeliveryReceipt> => r.status === "fulfilled");

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        this.failures.push({
          transport: this.transports[i]?.name ?? "unknown",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });

    if (ok) return { ...ok.value, transport: this.name };
    throw new Error(`All messaging transports failed: ${this.failures.map((f) => f.transport).join(", ")}`);
  }
}
