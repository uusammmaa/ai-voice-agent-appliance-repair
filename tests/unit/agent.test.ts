import { describe, expect, it, vi } from "vitest";
import { CallRunner } from "@/lib/agent/session";
import { DeterministicBrain } from "@/lib/agent/brains/deterministic";
import { MemoryCalendar } from "@/lib/integrations/calendar/memory";
import { MemoryMessaging } from "@/lib/integrations/messaging/transports";
import { CustomerRepository } from "@/lib/domain/customers";
import { canTransition, inferState, nextLegalStep } from "@/lib/agent/state-machine";
import { TOOLS, toolsForState } from "@/lib/agent/tools";
import { redact, redactAddress, redactDeep } from "@/lib/agent/redact";
import type { Brain, BrainResponse, CallSlots } from "@/lib/agent/types";

const NOW = new Date("2026-09-21T16:00:00.000Z");

function makeRunner(brain: Brain = new DeterministicBrain(), overrides: Partial<ConstructorParameters<typeof CallRunner>[0]> = {}) {
  const calendar = new MemoryCalendar();
  const messaging = new MemoryMessaging();
  let ids = 0;
  const runner = new CallRunner(
    {
      brain,
      calendar,
      messaging,
      customers: new CustomerRepository(),
      now: () => NOW,
      idFactory: (prefix) => `${prefix}_${++ids}`,
      ...overrides,
    },
    "call_test",
  );
  return { runner, calendar, messaging };
}

/** A brain that replays a fixed script, so the runner can be tested in isolation. */
class ScriptedBrain implements Brain {
  readonly name = "scripted";
  private index = 0;
  constructor(private readonly script: BrainResponse[]) {}
  async respond(): Promise<BrainResponse> {
    const next = this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    return next ?? { say: "", toolCalls: [] };
  }
}

describe("state machine", () => {
  it("refuses transitions that are not on the graph", () => {
    expect(canTransition("greeting", "confirm", {}).allowed).toBe(false);
    expect(canTransition("identify", "triage", {}).allowed).toBe(true);
  });

  it("refuses to confirm a booking without a name, number and address", () => {
    const partial: CallSlots = { chosenSlotId: "tech_dana:2026-09-22T15:00:00.000Z", callerName: "Sam" };
    const result = canTransition("schedule", "confirm", partial);
    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["phone", "address"]);
  });

  it("allows confirm once every required slot is filled", () => {
    const full: CallSlots = {
      chosenSlotId: "tech_dana:2026-09-22T15:00:00.000Z",
      callerName: "Sam",
      phone: "+14155550100",
      address: "1 Main Street, Oakland",
      symptomId: "washer_not_draining",
    };
    expect(canTransition("schedule", "confirm", full).allowed).toBe(true);
  });

  it("walks one legal hop toward a state that is not directly reachable", () => {
    // identify -> quote is not an edge, but identify -> triage -> quote is a path.
    const slots: CallSlots = { symptomId: "oven_not_heating" };
    expect(canTransition("identify", "quote", slots).allowed).toBe(false);
    expect(nextLegalStep("identify", "quote", slots)).toBe("triage");
  });

  it("returns null when no legal path exists at all", () => {
    expect(nextLegalStep("ended", "schedule", {})).toBeNull();
  });

  it("infers the state the call has actually reached", () => {
    expect(inferState("greeting", {})).toBe("identify");
    expect(inferState("identify", { symptomId: "oven_not_heating" })).toBe("quote");
    expect(inferState("quote", { symptomId: "x", chosenSlotId: "y" })).toBe("confirm");
    expect(inferState("confirm", { bookingId: "job_1" })).toBe("wrap");
  });
});

describe("tool gating", () => {
  it("never exposes booking before the scheduling stage", () => {
    for (const state of ["greeting", "identify", "triage"] as const) {
      expect(toolsForState(state).map((t) => t.name)).not.toContain("book_appointment");
    }
    expect(toolsForState("schedule").map((t) => t.name)).toContain("book_appointment");
  });

  it("exposes the escape hatch in every conversational state", () => {
    for (const state of ["greeting", "identify", "triage", "quote", "schedule", "confirm", "wrap"] as const) {
      expect(toolsForState(state).map((t) => t.name)).toContain("escalate_to_human");
    }
  });

  it("declares a JSON schema for every tool that matches its zod schema's required keys", () => {
    for (const tool of TOOLS) {
      const json = tool.jsonSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
      expect(json.type, tool.name).toBe("object");
      for (const key of json.required ?? []) {
        expect(Object.keys(json.properties), `${tool.name}.${key}`).toContain(key);
      }
      // Anything that changes the outside world must be marked as such.
      if (["book_appointment", "reschedule_appointment", "send_notification", "create_ticket", "escalate_to_human"].includes(tool.name)) {
        expect(tool.mutating, tool.name).toBe(true);
      }
    }
  });
});

describe("turn runner", () => {
  it("rejects a tool call the current state does not permit", async () => {
    const brain = new ScriptedBrain([
      { say: "Booking that now.", toolCalls: [{ id: "t1", name: "book_appointment", args: {} }] },
    ]);
    const { runner } = makeRunner(brain);
    runner.open();
    const result = await runner.turn("hello");

    expect(result.toolCalls[0]?.error?.message).toMatch(/not available during identify/);
    expect(runner.session.bookings).toHaveLength(0);
  });

  it("rejects malformed tool arguments without throwing", async () => {
    const brain = new ScriptedBrain([
      { say: "Looking you up.", toolCalls: [{ id: "t1", name: "lookup_customer", args: { phone: 42 } }] },
    ]);
    const { runner } = makeRunner(brain);
    runner.open();
    const result = await runner.turn("hi");

    expect(result.toolCalls[0]?.error?.message).toMatch(/Invalid arguments/);
    expect(runner.session.slots.customerId).toBeUndefined();
  });

  it("gives a failed tool call one retry, then stops repeating it", async () => {
    // ScriptedBrain replays its last entry forever - a brain that never corrects itself.
    const brain = new ScriptedBrain([
      { say: "Looking you up.", toolCalls: [{ id: "t1", name: "lookup_customer", args: { phone: 42 } }] },
    ]);
    const { runner } = makeRunner(brain, { config: { maxToolRoundsPerTurn: 5 } });
    runner.open();
    const result = await runner.turn("hi");

    expect(result.toolCalls).toHaveLength(2);
    expect(runner.session.metrics.failedToolCalls).toBe(2);
  });

  it("asks the caller to repeat a low-confidence turn instead of acting on it", async () => {
    const { runner } = makeRunner();
    runner.open();
    const result = await runner.turn("mumble crackle", { confidence: 0.1 });

    expect(result.say).toMatch(/say that once more/i);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("hands the call to a human when the brain throws", async () => {
    const brain: Brain = {
      name: "broken",
      respond: vi.fn().mockRejectedValue(new Error("upstream 503")),
    };
    const { runner, messaging } = makeRunner(brain);
    runner.open();
    const result = await runner.turn("my fridge is broken");

    expect(runner.session.state).toBe("escalated");
    expect(result.say).toMatch(/team on the line/i);
    expect(runner.session.escalation?.reason).toMatch(/could not complete/i);
    await vi.waitFor(() => expect(messaging.sent.some((n) => n.title.includes("handed off"))).toBe(true));
  });

  it("stops the turn after the configured number of tool rounds", async () => {
    // A brain that asks for the same tool forever must not loop forever.
    const brain: Brain = {
      name: "looping",
      respond: async () => ({
        say: "one moment",
        toolCalls: [{ id: `t${Math.random()}`, name: "record_caller_details", args: { name: "Loop" } }],
      }),
    };
    const { runner } = makeRunner(brain, { config: { maxToolRoundsPerTurn: 2 } });
    runner.open();
    const result = await runner.turn("hello");

    expect(result.toolCalls).toHaveLength(2);
  });

  it("escalates a call that stops making progress", async () => {
    const brain = new ScriptedBrain([{ say: "Sorry, could you repeat that?", toolCalls: [] }]);
    const { runner } = makeRunner(brain);
    runner.open();
    await runner.turn("hello");
    await runner.turn("hello");
    await runner.turn("hello");

    expect(runner.session.state).toBe("escalated");
    expect(runner.session.escalation?.reason).toMatch(/stopped making progress/i);
  });

  it("never speaks an empty turn", async () => {
    const brain = new ScriptedBrain([{ say: "", toolCalls: [] }]);
    const { runner } = makeRunner(brain);
    runner.open();
    const result = await runner.turn("hello");
    expect(result.say.length).toBeGreaterThan(0);
  });
});

describe("booking safety", () => {
  it("refuses a slot that was never offered on this call", async () => {
    const brain = new ScriptedBrain([
      {
        say: "Booking.",
        toolCalls: [
          {
            id: "t1",
            name: "book_appointment",
            args: {
              slotId: "tech_dana:2026-09-22T15:00:00.000Z",
              name: "Mallory",
              phone: "+14155550100",
              address: "1 Main Street, Oakland",
            },
          },
        ],
      },
    ]);
    const { runner } = makeRunner(brain);
    runner.open();
    runner.session.state = "schedule";
    runner.session.slots = { symptomId: "washer_not_draining", offeredSlotIds: ["tech_dana:2026-09-23T15:00:00.000Z"] };

    const result = await runner.turn("book it");
    expect((result.toolCalls[0]?.result as { ok: boolean }).ok).toBe(false);
    expect(runner.session.bookings).toHaveLength(0);
  });

  it("keeps the booking and alerts dispatch when the calendar write fails", async () => {
    const calendar = new MemoryCalendar();
    vi.spyOn(calendar, "createEvent").mockRejectedValue(new Error("Google 503"));

    const slotId = "tech_dana:2026-09-22T15:00:00.000Z";
    const brain = new ScriptedBrain([
      {
        say: "Booking.",
        toolCalls: [
          {
            id: "t1",
            name: "book_appointment",
            args: { slotId, name: "Mallory", phone: "+14155550100", address: "1 Main Street, Oakland" },
          },
        ],
      },
    ]);
    const messaging = new MemoryMessaging();
    const runner = new CallRunner(
      { brain, calendar, messaging, customers: new CustomerRepository(), now: () => NOW, idFactory: (p) => `${p}_1` },
      "call_cal_fail",
    );
    runner.open();
    runner.session.state = "schedule";
    runner.session.slots = { symptomId: "washer_not_draining", offeredSlotIds: [slotId] };

    const result = await runner.turn("book it");
    const payload = result.toolCalls[0]?.result as { ok: boolean; calendarWriteFailed: boolean };

    expect(payload.ok).toBe(true);
    expect(payload.calendarWriteFailed).toBe(true);
    expect(runner.session.bookings).toHaveLength(1);
    expect(messaging.sent.some((n) => n.title.includes("NOT written to calendar"))).toBe(true);
  });

  it("is idempotent: booking the same slot twice yields one job", async () => {
    const slotId = "tech_dana:2026-09-22T15:00:00.000Z";
    const args = { slotId, name: "Mallory", phone: "+14155550100", address: "1 Main Street, Oakland" };
    const brain = new ScriptedBrain([
      { say: "Booking.", toolCalls: [{ id: "t1", name: "book_appointment", args }] },
      { say: "Booking again.", toolCalls: [{ id: "t2", name: "book_appointment", args }] },
    ]);
    const { runner, calendar } = makeRunner(brain);
    runner.open();
    runner.session.state = "schedule";
    runner.session.slots = { symptomId: "washer_not_draining", offeredSlotIds: [slotId] };

    await runner.turn("book it");
    runner.session.state = "schedule";
    await runner.turn("book it again");

    expect(runner.session.bookings).toHaveLength(1);
    expect(calendar.all()).toHaveLength(1);
  });
});

describe("redaction", () => {
  it("masks phone numbers, emails and card-length digit runs", () => {
    expect(redact("call me on 415-555-0142")).toBe("call me on ***-***-0142");
    expect(redact("angela.reyes@example.com")).toBe("an***@example.com");
    expect(redact("4111 1111 1111 1111")).toBe("[card-redacted]");
  });

  it("keeps the street number but drops the street name", () => {
    expect(redactAddress("1820 Larkspur Lane, San Rafael, CA")).toBe("1820 ***, San Rafael, CA");
  });

  it("walks nested structures and treats address keys specially", () => {
    const redacted = redactDeep({
      booking: { address: "1820 Larkspur Lane, San Rafael, CA", phone: "+1 415 555 0142" },
      notes: ["reach me at angela.reyes@example.com"],
    });
    expect(JSON.stringify(redacted)).not.toContain("Larkspur");
    expect(JSON.stringify(redacted)).not.toContain("5550142");
    expect(JSON.stringify(redacted)).not.toContain("angela.reyes@");
  });

  it("redacts the persisted session without touching the live one", async () => {
    const { runner } = makeRunner();
    runner.setFromNumber("+14155550142");
    runner.open();
    await runner.turn("my fridge is not cooling");

    expect(runner.redactedSession().fromNumber).toBe("***-***-0142");
    expect(runner.session.fromNumber).toBe("+14155550142");
  });
});
