import { describe, expect, it, vi } from "vitest";
import { MemoryCalendar } from "@/lib/integrations/calendar/memory";
import { FanOutMessaging, renderNotification, type MessagingPort, type Notification } from "@/lib/integrations/messaging/port";
import { MemoryMessaging, SlackMessaging, TelegramMessaging } from "@/lib/integrations/messaging/transports";

const notification: Notification = {
  channel: "dispatch",
  priority: "high",
  title: "New job booked",
  body: "Angela Reyes in San Rafael.",
  fields: [{ label: "Job", value: "job_0001" }],
  idempotencyKey: "job_0001:booked",
  link: "https://calendar.google.com/x",
};

describe("memory calendar", () => {
  const input = {
    calendarId: "dispatch@example.com",
    summary: "Fridge repair",
    description: "",
    startsAt: "2026-09-22T15:00:00.000Z",
    endsAt: "2026-09-22T17:00:00.000Z",
    idempotencyKey: "call_1:slot_1",
  };

  it("returns the same event for a repeated idempotency key", async () => {
    const calendar = new MemoryCalendar();
    const first = await calendar.createEvent(input);
    const second = await calendar.createEvent(input);

    expect(second.id).toBe(first.id);
    expect(calendar.all()).toHaveLength(1);
  });

  it("reports only overlapping confirmed events as busy", async () => {
    const calendar = new MemoryCalendar();
    await calendar.createEvent(input);

    const overlapping = await calendar.listBusy({
      calendarId: input.calendarId,
      from: "2026-09-22T16:00:00.000Z",
      to: "2026-09-22T18:00:00.000Z",
    });
    expect(overlapping).toHaveLength(1);

    const after = await calendar.listBusy({
      calendarId: input.calendarId,
      from: "2026-09-22T17:00:00.000Z",
      to: "2026-09-22T19:00:00.000Z",
    });
    expect(after).toHaveLength(0);
  });

  it("stops reporting a cancelled event as busy", async () => {
    const calendar = new MemoryCalendar();
    const event = await calendar.createEvent(input);
    await calendar.cancelEvent(event.id, input.calendarId);

    const busy = await calendar.listBusy({ calendarId: input.calendarId, from: input.startsAt, to: input.endsAt });
    expect(busy).toHaveLength(0);
  });

  it("scopes events to their calendar", async () => {
    const calendar = new MemoryCalendar();
    await calendar.createEvent(input);
    const busy = await calendar.listBusy({ calendarId: "someone-else@example.com", from: input.startsAt, to: input.endsAt });
    expect(busy).toHaveLength(0);
  });
});

describe("notification rendering", () => {
  it("produces plain text with the priority marker and every field", () => {
    const text = renderNotification(notification);
    expect(text).toContain("New job booked");
    expect(text).toContain("Job: job_0001");
    expect(text).toContain("https://calendar.google.com/x");
    expect(text).not.toContain("<");
  });
});

describe("telegram transport", () => {
  it("posts to the chat mapped to the notification's channel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }),
    );
    const telegram = new TelegramMessaging({
      botToken: "bot-token",
      chatIds: { dispatch: "-100dispatch", on_call: "-100oncall" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const receipt = await telegram.send({ ...notification, channel: "on_call" });

    expect(receipt.messageId).toBe("77");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/botbot-token/sendMessage");
    expect(JSON.parse((init as RequestInit).body as string).chat_id).toBe("-100oncall");
  });

  it("falls back to the dispatch chat for an unmapped channel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    const telegram = new TelegramMessaging({
      botToken: "t",
      chatIds: { dispatch: "-100dispatch" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await telegram.send({ ...notification, channel: "management" });
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string).chat_id).toBe("-100dispatch");
  });

  it("throws with the upstream status when Telegram rejects the send", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("chat not found", { status: 400 }));
    const telegram = new TelegramMessaging({
      botToken: "t",
      chatIds: { dispatch: "-1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(telegram.send(notification)).rejects.toThrow(/400 chat not found/);
  });

  it("builds nothing from the environment when the token is absent", () => {
    expect(TelegramMessaging.fromEnv({})).toBeNull();
    expect(TelegramMessaging.fromEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_DISPATCH_CHAT_ID: "-1" })).not.toBeNull();
  });
});

describe("slack transport", () => {
  it("sends block kit with a header, body and fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const slack = new SlackMessaging({
      webhookUrls: { dispatch: "https://hooks.slack.test/dispatch" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await slack.send(notification);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);

    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks.some((b: { type: string }) => b.type === "section")).toBe(true);
    expect(body.text).toBe("New job booked");
  });
});

describe("fan-out messaging", () => {
  const working: MessagingPort = {
    name: "working",
    send: async (n) => ({
      transport: "working",
      channel: n.channel,
      messageId: "ok",
      deliveredAt: new Date().toISOString(),
      deduplicated: false,
    }),
  };
  const broken: MessagingPort = {
    name: "broken",
    send: async () => {
      throw new Error("down");
    },
  };

  it("succeeds when at least one transport delivers, and records the failure", async () => {
    const fanout = new FanOutMessaging([broken, working]);
    const receipt = await fanout.send(notification);

    expect(receipt.messageId).toBe("ok");
    expect(fanout.failures).toEqual([{ transport: "broken", error: "down" }]);
  });

  it("throws only when every transport fails", async () => {
    const fanout = new FanOutMessaging([broken, broken]);
    await expect(fanout.send(notification)).rejects.toThrow(/All messaging transports failed/);
  });
});

describe("memory messaging", () => {
  it("deduplicates on the idempotency key", async () => {
    const messaging = new MemoryMessaging();
    await messaging.send(notification);
    const second = await messaging.send(notification);

    expect(second.deduplicated).toBe(true);
    expect(messaging.sent).toHaveLength(1);
  });
});
