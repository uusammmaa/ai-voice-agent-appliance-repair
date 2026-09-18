import {
  renderNotification,
  type DeliveryReceipt,
  type MessagingPort,
  type Notification,
  type NotificationChannel,
} from "./port";
import type { EnvLike } from "../../config";

/* ------------------------------------------------------------------ in-memory ---- */

/** Captures notifications so the demo UI and tests can assert on them. */
export class MemoryMessaging implements MessagingPort {
  readonly name = "memory";
  readonly sent: Array<Notification & { messageId: string; deliveredAt: string }> = [];
  private readonly seenKeys = new Set<string>();
  private seq = 0;

  async send(notification: Notification): Promise<DeliveryReceipt> {
    const deduplicated = this.seenKeys.has(notification.idempotencyKey);
    if (!deduplicated) {
      this.seenKeys.add(notification.idempotencyKey);
      this.sent.push({
        ...notification,
        messageId: `msg_mem_${++this.seq}`,
        deliveredAt: new Date().toISOString(),
      });
    }
    const last = this.sent[this.sent.length - 1];
    return {
      transport: this.name,
      channel: notification.channel,
      messageId: last?.messageId ?? "msg_mem_0",
      deliveredAt: last?.deliveredAt ?? new Date().toISOString(),
      deduplicated,
    };
  }

  clear(): void {
    this.sent.length = 0;
    this.seenKeys.clear();
  }
}

/* -------------------------------------------------------------------- telegram ---- */

export interface TelegramConfig {
  botToken: string;
  /** One chat per routing channel; unmapped channels fall back to `dispatch`. */
  chatIds: Partial<Record<NotificationChannel, string>> & { dispatch: string };
  fetchImpl?: typeof fetch;
}

export class TelegramMessaging implements MessagingPort {
  readonly name = "telegram";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: TelegramConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  static fromEnv(env: EnvLike = process.env): TelegramMessaging | null {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const dispatch = env.TELEGRAM_DISPATCH_CHAT_ID;
    if (!botToken || !dispatch) return null;
    return new TelegramMessaging({
      botToken,
      chatIds: {
        dispatch,
        on_call: env.TELEGRAM_ONCALL_CHAT_ID ?? dispatch,
        sales: env.TELEGRAM_SALES_CHAT_ID ?? dispatch,
        management: env.TELEGRAM_MANAGEMENT_CHAT_ID ?? dispatch,
      },
    });
  }

  async send(notification: Notification): Promise<DeliveryReceipt> {
    const chatId = this.config.chatIds[notification.channel] ?? this.config.chatIds.dispatch;
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: renderNotification(notification),
        disable_notification: notification.priority === "low",
        link_preview_options: { is_disabled: true },
      }),
    });

    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed: ${res.status} ${await safeText(res)}`);
    }
    const payload = (await res.json()) as { result?: { message_id?: number } };
    return {
      transport: this.name,
      channel: notification.channel,
      messageId: String(payload.result?.message_id ?? ""),
      deliveredAt: new Date().toISOString(),
      deduplicated: false,
    };
  }
}

/* ----------------------------------------------------------------------- slack ---- */

export interface SlackConfig {
  /** Incoming-webhook URL per routing channel. */
  webhookUrls: Partial<Record<NotificationChannel, string>> & { dispatch: string };
  fetchImpl?: typeof fetch;
}

export class SlackMessaging implements MessagingPort {
  readonly name = "slack";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SlackConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  static fromEnv(env: EnvLike = process.env): SlackMessaging | null {
    const dispatch = env.SLACK_DISPATCH_WEBHOOK_URL;
    if (!dispatch) return null;
    return new SlackMessaging({
      webhookUrls: {
        dispatch,
        on_call: env.SLACK_ONCALL_WEBHOOK_URL ?? dispatch,
        sales: env.SLACK_SALES_WEBHOOK_URL ?? dispatch,
        management: env.SLACK_MANAGEMENT_WEBHOOK_URL ?? dispatch,
      },
    });
  }

  async send(notification: Notification): Promise<DeliveryReceipt> {
    const url = this.config.webhookUrls[notification.channel] ?? this.config.webhookUrls.dispatch;
    const blocks: Array<Record<string, unknown>> = [
      { type: "header", text: { type: "plain_text", text: notification.title.slice(0, 150), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: notification.body } },
    ];
    if (notification.fields?.length) {
      blocks.push({
        type: "section",
        fields: notification.fields.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${f.label}*\n${f.value}` })),
      });
    }
    if (notification.link) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `<${notification.link}|Open in calendar>` }],
      });
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: notification.title, blocks }),
    });

    if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${await safeText(res)}`);
    return {
      transport: this.name,
      channel: notification.channel,
      messageId: notification.idempotencyKey,
      deliveredAt: new Date().toISOString(),
      deduplicated: false,
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
