import { z } from "zod";
import {
  APPLIANCE_PHRASES,
  SAFETY_SCRIPT,
  getSymptom,
  matchAppliance,
  matchSymptom,
  type ApplianceType,
} from "../domain/catalog";
import { DEFAULT_RATE_CARD, quoteForSymptom, usd } from "../domain/pricing";
import { SLOT_LENGTH_MINUTES, describeSlot, findAvailableSlots, type Booking } from "../domain/scheduling";
import { defineTool, type AgentContext, type ConversationState, type ToolDefinition } from "./types";

/**
 * The tool surface the model is given.
 *
 * Design rules that hold for every tool here:
 *  - The model supplies *intent*, never *facts the business owns*. It names a symptom;
 *    the price comes from the rate card. It picks a slot id; the slot came from us.
 *  - Every mutating tool takes an idempotency key derived from the session, so a retried
 *    turn cannot double-book or double-notify.
 *  - Handlers never throw for expected failures. They return a structured `{ ok: false,
 *    reason }` the model can read out, because an exception on a phone call is silence.
 */

const APPLIANCE_TYPES = Object.keys(APPLIANCE_PHRASES) as [ApplianceType, ...ApplianceType[]];

const ALL_STATES: ConversationState[] = ["greeting", "identify", "triage", "quote", "schedule", "confirm", "wrap"];

function ok<T extends object>(data: T) {
  return { ok: true as const, ...data };
}
function fail(reason: string, hint?: string) {
  return { ok: false as const, reason, hint };
}

/* ------------------------------------------------------------- lookup_customer ---- */

const lookupCustomerSchema = z.object({
  phone: z.string().min(7).describe("Phone number in any format; digits are normalised."),
});

const lookupCustomer = defineTool({
  name: "lookup_customer",
  description:
    "Look up an existing customer by phone number. Call this once at the start of the call using the caller ID, " +
    "before asking the caller to repeat details we already hold.",
  schema: lookupCustomerSchema,
  jsonSchema: {
    type: "object",
    properties: { phone: { type: "string", description: "Phone number in any format." } },
    required: ["phone"],
    additionalProperties: false,
  },
  allowedStates: ["greeting", "identify", "triage"],
  mutating: false,
  async handler(args, ctx) {
    const customer = ctx.customers.findByPhone(args.phone);
    if (!customer) return ok({ found: false, phone: args.phone });

    ctx.session.slots.customerId = customer.id;
    ctx.session.slots.callerName ??= customer.name;
    ctx.session.slots.phone ??= customer.phone;
    ctx.session.slots.address ??= customer.address;
    ctx.session.slots.email ??= customer.email;

    return ok({
      found: true,
      customer: {
        id: customer.id,
        name: customer.name,
        address: customer.address,
        appliancesOnFile: customer.appliances,
        recentJobs: customer.history.slice(-3),
        notes: customer.notes,
      },
    });
  },
});

/* ------------------------------------------------------- record_caller_details ---- */

const recordDetailsSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(7).optional(),
  address: z.string().min(5).optional(),
  email: z.string().email().optional(),
});

const recordCallerDetails = defineTool({
  name: "record_caller_details",
  description:
    "Save details the caller has given you. Call it as soon as you learn each one - do not wait until the end. " +
    "Only pass fields the caller actually said; never invent an address.",
  schema: recordDetailsSchema,
  jsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Caller's name as they said it." },
      phone: { type: "string", description: "Best callback number." },
      address: { type: "string", description: "Full service address including city." },
      email: { type: "string", description: "Email for the confirmation, if offered." },
    },
    additionalProperties: false,
  },
  allowedStates: ALL_STATES,
  mutating: false,
  async handler(args, ctx) {
    const slots = ctx.session.slots;
    if (args.name) slots.callerName = args.name;
    if (args.phone) slots.phone = args.phone;
    if (args.address) slots.address = args.address;
    if (args.email) slots.email = args.email;

    // Reported as the caller-facing field name, not the internal slot name, because the
    // next thing that happens is somebody asking the caller for it.
    const missing = ([
      ["name", "callerName"],
      ["phone", "phone"],
      ["address", "address"],
    ] as const)
      .filter(([, slot]) => !slots[slot])
      .map(([label]) => label);
    return ok({ saved: args, stillMissing: missing });
  },
});

/* ------------------------------------------------------------ triage_appliance ---- */

const triageSchema = z.object({
  description: z.string().min(3).describe("The caller's description of the fault, in their words."),
  appliance: z.enum(APPLIANCE_TYPES).optional(),
  brand: z.string().optional(),
});

const triageAppliance = defineTool({
  name: "triage_appliance",
  description:
    "Match the caller's description against the service catalogue. Returns likely causes, severity, and safe " +
    "self-checks. If it returns needsClarification, ask the clarifying question it suggests - do not guess.",
  schema: triageSchema,
  jsonSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "The fault in the caller's own words." },
      appliance: { type: "string", enum: APPLIANCE_TYPES, description: "Appliance type, if known." },
      brand: { type: "string", description: "Brand, if the caller mentioned one." },
    },
    required: ["description"],
    additionalProperties: false,
  },
  allowedStates: ["greeting", "identify", "triage", "quote"],
  mutating: false,
  async handler(args, ctx) {
    const appliance = args.appliance ?? matchAppliance(args.description) ?? undefined;
    const match = matchSymptom(args.description, appliance);

    if (!match) {
      const candidates = appliance
        ? `We have a ${appliance} on file. `
        : "";
      return ok({
        needsClarification: true,
        appliance,
        clarifyingQuestion:
          `${candidates}Ask which appliance it is and what it does or does not do - for example, does it run at all, ` +
          `does it make a noise, is there water or a smell?`,
      });
    }

    const { symptom, confidence } = match;
    const slots = ctx.session.slots;
    slots.appliance = symptom.appliance;
    slots.symptomId = symptom.id;
    slots.symptomLabel = symptom.label;
    slots.severity = symptom.severity;
    slots.problemDescription = args.description;
    if (args.brand) slots.brand = args.brand;

    let warranty: { covered: boolean; until?: string } = { covered: false };
    if (slots.customerId) {
      const customer = ctx.customers.findById(slots.customerId);
      if (customer) {
        warranty = ctx.customers.warrantyCover(customer, symptom.id, ctx.now());
        slots.warrantyCovered = warranty.covered;
      }
    }

    if (symptom.safetyCritical) slots.safetyWarningGiven = true;

    return ok({
      symptomId: symptom.id,
      symptomLabel: symptom.label,
      appliance: symptom.appliance,
      severity: symptom.severity,
      confidence: Number(confidence.toFixed(2)),
      safetyCritical: symptom.safetyCritical ?? false,
      safetyScript: symptom.safetyCritical ? SAFETY_SCRIPT : undefined,
      likelyCauses: symptom.causes.slice(0, 3).map((c) => ({
        cause: c.cause,
        likelihoodPct: Math.round(c.likelihood * 100),
      })),
      selfChecks: symptom.selfChecks,
      warranty,
    });
  },
});

/* ------------------------------------------------------------------ quote_job ---- */

const quoteSchema = z.object({
  symptomId: z.string().describe("The symptomId returned by triage_appliance."),
  emergency: z.boolean().optional().describe("True only if the caller accepted same-day emergency dispatch."),
  afterHours: z.boolean().optional(),
});

const quoteJob = defineTool({
  name: "quote_job",
  description:
    "Produce the price estimate for a triaged symptom. Read out the spokenSummary field as-is - it is the wording " +
    "the business has approved. Never state a price that did not come from this tool.",
  schema: quoteSchema,
  jsonSchema: {
    type: "object",
    properties: {
      symptomId: { type: "string", description: "symptomId from triage_appliance." },
      emergency: { type: "boolean", description: "Same-day emergency dispatch accepted." },
      afterHours: { type: "boolean", description: "Evening or weekend slot." },
    },
    required: ["symptomId"],
    additionalProperties: false,
  },
  allowedStates: ["triage", "quote", "schedule"],
  mutating: false,
  async handler(args, ctx) {
    if (!getSymptom(args.symptomId)) {
      return fail(`Unknown symptomId "${args.symptomId}".`, "Call triage_appliance first and use the id it returns.");
    }

    const slots = ctx.session.slots;
    if (slots.warrantyCovered) {
      return ok({
        warrantyCovered: true,
        spokenSummary:
          "Good news - our records show this is the same fault we repaired for you recently, and it is still inside " +
          "the workmanship warranty. There is no call-out fee and no charge for the revisit.",
        totalLowUsd: 0,
        totalHighUsd: 0,
        diagnosticFeeUsd: 0,
        disclaimer: "Warranty revisit. Confirm the original job number with dispatch.",
      });
    }

    const quote = quoteForSymptom(args.symptomId, {
      emergency: args.emergency,
      afterHours: args.afterHours,
      rateCard: DEFAULT_RATE_CARD,
    });

    slots.quotedLowUsd = quote.totalLowUsd;
    slots.quotedHighUsd = quote.totalHighUsd;

    return ok({
      warrantyCovered: false,
      symptomId: quote.symptomId,
      lines: quote.lines,
      totalLowUsd: quote.totalLowUsd,
      totalHighUsd: quote.totalHighUsd,
      diagnosticFeeUsd: quote.diagnosticFeeUsd,
      recommendation: quote.recommendation,
      spokenSummary: quote.spokenSummary,
      disclaimer: quote.disclaimer,
    });
  },
});

/* ---------------------------------------------------------- check_availability ---- */

const availabilitySchema = z.object({
  appliance: z.enum(APPLIANCE_TYPES).optional(),
  preferEarliest: z.boolean().optional(),
});

const checkAvailability = defineTool({
  name: "check_availability",
  description:
    "Get real arrival windows for a qualified technician. Offer the caller at most two of these at a time, by their " +
    "label. Always pass the slotId back to book_appointment exactly as returned.",
  schema: availabilitySchema,
  jsonSchema: {
    type: "object",
    properties: {
      appliance: { type: "string", enum: APPLIANCE_TYPES, description: "Defaults to the triaged appliance." },
      preferEarliest: { type: "boolean", description: "Caller wants the soonest possible visit." },
    },
    additionalProperties: false,
  },
  allowedStates: ["triage", "quote", "schedule", "confirm"],
  mutating: false,
  async handler(args, ctx) {
    const slots = ctx.session.slots;
    const appliance = args.appliance ?? slots.appliance;
    if (!appliance) {
      return fail("No appliance established yet.", "Call triage_appliance before checking availability.");
    }

    const now = ctx.now();
    const busyWindows = await ctx.calendar.listBusy({
      calendarId: ctx.config.dispatchCalendarId,
      from: now.toISOString(),
      to: new Date(now.getTime() + 8 * 86400000).toISOString(),
    });

    // The calendar tells us an interval is busy; the scheduler needs it keyed by tech.
    // The dispatch calendar is shared, so a busy window blocks every technician on it.
    const busy = busyWindows.flatMap((w) =>
      ["tech_marcus", "tech_dana", "tech_priya"].map((technicianId) => ({ technicianId, startsAt: w.startsAt })),
    );

    const slotList = findAvailableSlots({
      appliance,
      severity: slots.severity ?? "routine",
      now,
      busy,
      timeZone: ctx.config.timeZone,
      limit: args.preferEarliest ? 2 : 4,
    });

    slots.offeredSlotIds = slotList.map((s) => s.id);

    if (slotList.length === 0) {
      return ok({
        slots: [],
        note: "Nothing available in the next week for this appliance. Offer to have dispatch call back with an opening.",
      });
    }

    return ok({
      slots: slotList.map((s) => ({
        slotId: s.id,
        label: s.label,
        technician: s.technicianName,
        sameDay: s.sameDay,
        afterHours: s.afterHours,
      })),
    });
  },
});

/* ---------------------------------------------------------------- select_slot ---- */

const selectSlotSchema = z.object({
  slotId: z.string().describe("A slotId returned by check_availability in this call."),
});

/**
 * Records which window the caller picked, separately from booking it.
 *
 * These are two different facts and they arrive at different moments: a caller says
 * "the second one" long before they have given an address. Without this tool the
 * dialogue manager would have to hold the choice in its own memory - which does not
 * survive a stateless request - or write it into the session behind the runner's back,
 * which puts an unaudited value in front of a state-machine gate.
 */
const selectSlot = defineTool({
  name: "select_slot",
  description:
    "Record the arrival window the caller has chosen. Call this the moment they pick one, before you start " +
    "collecting their details. It does not book anything.",
  schema: selectSlotSchema,
  jsonSchema: {
    type: "object",
    properties: { slotId: { type: "string", description: "Exact slotId from check_availability." } },
    required: ["slotId"],
    additionalProperties: false,
  },
  allowedStates: ["schedule", "confirm"],
  mutating: false,
  async handler(args, ctx) {
    const slots = ctx.session.slots;
    if (slots.offeredSlotIds && !slots.offeredSlotIds.includes(args.slotId)) {
      return fail(
        "That window was not one of the ones offered on this call.",
        "Call check_availability and offer the caller one of the labels it returns.",
      );
    }
    const [, startsAt] = splitSlotId(args.slotId);
    if (!startsAt) return fail("Malformed slotId.");

    slots.chosenSlotId = args.slotId;
    const missing = ([
      ["name", "callerName"],
      ["phone", "phone"],
      ["address", "address"],
    ] as const)
      .filter(([, slot]) => !slots[slot])
      .map(([label]) => label);

    return ok({ slotId: args.slotId, window: describeSlot(startsAt, ctx.config.timeZone), stillMissing: missing });
  },
});

/* ----------------------------------------------------------- book_appointment ---- */

const bookSchema = z.object({
  slotId: z.string().describe("A slotId returned by check_availability in this call."),
  name: z.string().min(1),
  phone: z.string().min(7),
  address: z.string().min(5),
  accessNotes: z.string().optional().describe("Gate codes, parking, pets, best entrance."),
});

const bookAppointment = defineTool({
  name: "book_appointment",
  description:
    "Book the visit. Only call this after the caller has explicitly agreed to a specific arrival window and you have " +
    "read their address back to them. Writes the job to the dispatch calendar and alerts the team.",
  schema: bookSchema,
  jsonSchema: {
    type: "object",
    properties: {
      slotId: { type: "string", description: "Exact slotId from check_availability." },
      name: { type: "string" },
      phone: { type: "string" },
      address: { type: "string" },
      accessNotes: { type: "string", description: "Gate codes, pets, parking." },
    },
    required: ["slotId", "name", "phone", "address"],
    additionalProperties: false,
  },
  allowedStates: ["schedule", "confirm"],
  mutating: true,
  async handler(args, ctx) {
    const slots = ctx.session.slots;

    if (slots.offeredSlotIds && !slots.offeredSlotIds.includes(args.slotId)) {
      return fail(
        "That slot was not one of the windows offered on this call.",
        "Call check_availability again and offer the caller one of the returned labels.",
      );
    }
    if (!slots.symptomId) {
      return fail("No triaged fault on this call.", "Call triage_appliance before booking.");
    }
    if (slots.bookingId) {
      return ok({ alreadyBooked: true, bookingId: slots.bookingId });
    }

    const [technicianId, startsAt] = splitSlotId(args.slotId);
    if (!technicianId || !startsAt) {
      return fail("Malformed slotId.", "Use a slotId exactly as returned by check_availability.");
    }

    const symptom = getSymptom(slots.symptomId);
    const endsAt = new Date(new Date(startsAt).getTime() + SLOT_LENGTH_MINUTES * 60000).toISOString();
    const bookingId = ctx.nextId("job");
    const technicianName = TECHNICIAN_NAMES[technicianId] ?? technicianId;

    const customer = ctx.customers.upsert({
      name: args.name,
      phone: args.phone,
      address: args.address,
      email: slots.email,
      notes: args.accessNotes,
    });
    slots.customerId = customer.id;
    slots.callerName = args.name;
    slots.phone = args.phone;
    slots.address = args.address;

    const window = describeSlot(startsAt, ctx.config.timeZone);
    const priceLine =
      slots.quotedLowUsd !== undefined && slots.quotedHighUsd !== undefined
        ? `${usd(slots.quotedLowUsd)}-${usd(slots.quotedHighUsd)} estimated`
        : "Not quoted on call";

    let calendarEventId: string | undefined;
    let calendarHtmlLink: string | undefined;
    try {
      const event = await ctx.calendar.createEvent({
        calendarId: ctx.config.dispatchCalendarId,
        summary: `${symptom?.label ?? "Appliance repair"} - ${args.name}`,
        description: [
          `Job: ${bookingId}`,
          `Technician: ${technicianName}`,
          `Fault: ${symptom?.label ?? slots.symptomId}`,
          `Caller said: ${slots.problemDescription ?? "-"}`,
          `Estimate: ${priceLine}`,
          `Phone: ${args.phone}`,
          args.accessNotes ? `Access: ${args.accessNotes}` : undefined,
          `Booked by AI voice agent, call ${ctx.session.id}`,
        ]
          .filter(Boolean)
          .join("\n"),
        location: args.address,
        startsAt,
        endsAt,
        attendeeEmails: slots.email ? [slots.email] : undefined,
        idempotencyKey: `${ctx.session.id}:${args.slotId}`,
        metadata: { bookingId, sessionId: ctx.session.id, symptomId: slots.symptomId },
      });
      calendarEventId = event.id;
      calendarHtmlLink = event.htmlLink;
    } catch (err) {
      // A calendar outage must not lose the job. Record it, alert dispatch loudly, and
      // let the caller keep their window - a human reconciles it.
      await safeNotify(ctx, {
        channel: "dispatch",
        priority: "high",
        title: "Booking taken but NOT written to calendar",
        body: `Calendar write failed for job ${bookingId}. Add it by hand before the window opens.`,
        fields: [
          { label: "Customer", value: `${args.name} - ${args.phone}` },
          { label: "Window", value: window },
          { label: "Address", value: args.address },
          { label: "Error", value: err instanceof Error ? err.message : String(err) },
        ],
        idempotencyKey: `${bookingId}:calendar-failure`,
      });
    }

    const booking: Booking = {
      id: bookingId,
      slotId: args.slotId,
      technicianId,
      technicianName,
      startsAt,
      endsAt,
      customerName: args.name,
      phone: args.phone,
      address: args.address,
      appliance: slots.appliance ?? "unknown",
      symptomId: slots.symptomId,
      symptomLabel: symptom?.label ?? slots.symptomId,
      notes: args.accessNotes ?? "",
      severity: slots.severity ?? "routine",
      createdAt: ctx.now().toISOString(),
      calendarEventId,
      calendarHtmlLink,
    };

    ctx.session.bookings.push(booking);
    slots.chosenSlotId = args.slotId;
    slots.bookingId = bookingId;

    const isEmergency = slots.severity === "emergency";
    await safeNotify(ctx, {
      channel: isEmergency ? "on_call" : "dispatch",
      priority: isEmergency ? "emergency" : "normal",
      title: isEmergency ? `EMERGENCY job booked - ${symptom?.label}` : `New job booked - ${symptom?.label}`,
      body: `${args.name} in ${args.address}. ${technicianName} assigned.`,
      fields: [
        { label: "Job", value: bookingId },
        { label: "Window", value: window },
        { label: "Phone", value: args.phone },
        { label: "Estimate", value: priceLine },
        { label: "Access", value: args.accessNotes || "none given" },
      ],
      link: calendarHtmlLink,
      idempotencyKey: `${bookingId}:booked`,
    });

    return ok({
      bookingId,
      technician: technicianName,
      window,
      startsAt,
      calendarEventId: calendarEventId ?? null,
      calendarWriteFailed: !calendarEventId,
      confirmationScript:
        `You're booked in with ${technicianName}, ${window}. ` +
        `We'll text this number when the technician is on the way.`,
    });
  },
});

/* ---------------------------------------------------- reschedule_appointment ---- */

const rescheduleSchema = z.object({
  bookingId: z.string(),
  newSlotId: z.string(),
});

const rescheduleAppointment = defineTool({
  name: "reschedule_appointment",
  description: "Move an existing booking made on this call to a different offered slot.",
  schema: rescheduleSchema,
  jsonSchema: {
    type: "object",
    properties: { bookingId: { type: "string" }, newSlotId: { type: "string" } },
    required: ["bookingId", "newSlotId"],
    additionalProperties: false,
  },
  allowedStates: ["schedule", "confirm", "wrap"],
  mutating: true,
  async handler(args, ctx) {
    const booking = ctx.session.bookings.find((b) => b.id === args.bookingId);
    if (!booking) return fail(`No booking ${args.bookingId} on this call.`);

    const [technicianId, startsAt] = splitSlotId(args.newSlotId);
    if (!technicianId || !startsAt) return fail("Malformed slotId.");

    const endsAt = new Date(new Date(startsAt).getTime() + SLOT_LENGTH_MINUTES * 60000).toISOString();
    if (booking.calendarEventId) {
      try {
        await ctx.calendar.moveEvent(booking.calendarEventId, ctx.config.dispatchCalendarId, startsAt, endsAt);
      } catch (err) {
        return fail(
          "The calendar would not accept the change.",
          err instanceof Error ? err.message : "Offer to have dispatch call back.",
        );
      }
    }

    const previous = booking.startsAt;
    booking.slotId = args.newSlotId;
    booking.technicianId = technicianId;
    booking.technicianName = TECHNICIAN_NAMES[technicianId] ?? technicianId;
    booking.startsAt = startsAt;
    booking.endsAt = endsAt;
    ctx.session.slots.chosenSlotId = args.newSlotId;

    await safeNotify(ctx, {
      channel: "dispatch",
      priority: "normal",
      title: `Job ${booking.id} rescheduled`,
      body: `Moved from ${describeSlot(previous, ctx.config.timeZone)} to ${describeSlot(startsAt, ctx.config.timeZone)}.`,
      fields: [{ label: "Customer", value: booking.customerName }],
      idempotencyKey: `${booking.id}:moved:${startsAt}`,
    });

    return ok({ bookingId: booking.id, window: describeSlot(startsAt, ctx.config.timeZone) });
  },
});

/* ---------------------------------------------------------- send_notification ---- */

const notifySchema = z.object({
  channel: z.enum(["dispatch", "on_call", "sales", "management"]),
  priority: z.enum(["low", "normal", "high", "emergency"]),
  title: z.string().min(3),
  body: z.string().min(3),
});

const sendNotification = defineTool({
  name: "send_notification",
  description:
    "Push a message to the team's messenger. Use it for anything a human needs to act on that is not already covered " +
    "by a booking - parts to order, a customer complaint, an address outside the service area.",
  schema: notifySchema,
  jsonSchema: {
    type: "object",
    properties: {
      channel: { type: "string", enum: ["dispatch", "on_call", "sales", "management"] },
      priority: { type: "string", enum: ["low", "normal", "high", "emergency"] },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["channel", "priority", "title", "body"],
    additionalProperties: false,
  },
  allowedStates: ALL_STATES,
  mutating: true,
  async handler(args, ctx) {
    const receipt = await safeNotify(ctx, {
      ...args,
      fields: [
        { label: "Caller", value: ctx.session.slots.callerName ?? "unknown" },
        { label: "Phone", value: ctx.session.slots.phone ?? ctx.session.fromNumber ?? "unknown" },
        { label: "Call", value: ctx.session.id },
      ],
      idempotencyKey: `${ctx.session.id}:${args.title}`,
    });
    return receipt ? ok({ delivered: true, messageId: receipt }) : ok({ delivered: false, queuedForRetry: true });
  },
});

/* --------------------------------------------------------------- create_ticket ---- */

const ticketSchema = z.object({
  kind: z.enum(["parts_order", "callback", "complaint", "out_of_area"]),
  summary: z.string().min(5),
});

const createTicket = defineTool({
  name: "create_ticket",
  description: "Raise a follow-up ticket for the office when the call cannot be closed out on the phone.",
  schema: ticketSchema,
  jsonSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["parts_order", "callback", "complaint", "out_of_area"] },
      summary: { type: "string" },
    },
    required: ["kind", "summary"],
    additionalProperties: false,
  },
  allowedStates: ALL_STATES,
  mutating: true,
  async handler(args, ctx) {
    const ticketId = ctx.nextId("tkt");
    await safeNotify(ctx, {
      channel: args.kind === "complaint" ? "management" : "dispatch",
      priority: args.kind === "complaint" ? "high" : "normal",
      title: `Ticket ${ticketId} - ${args.kind.replace("_", " ")}`,
      body: args.summary,
      fields: [
        { label: "Caller", value: ctx.session.slots.callerName ?? "unknown" },
        { label: "Phone", value: ctx.session.slots.phone ?? ctx.session.fromNumber ?? "unknown" },
      ],
      idempotencyKey: `${ticketId}:created`,
    });
    return ok({ ticketId, kind: args.kind });
  },
});

/* ------------------------------------------------------------ escalate_to_human ---- */

const escalateSchema = z.object({
  reason: z.string().min(3),
  urgent: z.boolean().optional(),
});

const escalateToHuman = defineTool({
  name: "escalate_to_human",
  description:
    "Hand the call to a person. Call this whenever the caller asks for a human, is upset, describes a safety " +
    "emergency, or asks something outside appliance repair. Do not try to talk them out of it.",
  schema: escalateSchema,
  jsonSchema: {
    type: "object",
    properties: { reason: { type: "string" }, urgent: { type: "boolean" } },
    required: ["reason"],
    additionalProperties: false,
  },
  allowedStates: ALL_STATES,
  mutating: true,
  async handler(args, ctx) {
    const ticketId = ctx.nextId("esc");
    ctx.session.escalation = { reason: args.reason, at: ctx.now().toISOString(), ticketId };
    ctx.session.state = "escalated";
    ctx.session.outcome = "escalated";

    await safeNotify(ctx, {
      channel: args.urgent ? "on_call" : "dispatch",
      priority: args.urgent ? "emergency" : "high",
      title: `Live transfer requested - ${ticketId}`,
      body: args.reason,
      fields: [
        { label: "Caller", value: ctx.session.slots.callerName ?? "unknown" },
        { label: "Phone", value: ctx.session.slots.phone ?? ctx.session.fromNumber ?? "unknown" },
        { label: "Appliance", value: ctx.session.slots.symptomLabel ?? "not established" },
      ],
      idempotencyKey: `${ticketId}:escalated`,
    });

    return ok({
      ticketId,
      transferScript:
        "Of course - let me put you through to someone on the team now. Please hold for just a moment.",
    });
  },
});

/* ----------------------------------------------------------------------- shared ---- */

export const TECHNICIAN_NAMES: Record<string, string> = {
  tech_marcus: "Marcus",
  tech_dana: "Dana",
  tech_priya: "Priya",
};

/** slotId is `${techId}:${ISO}`; the ISO half contains colons, so split on the first only. */
function splitSlotId(slotId: string): [string | undefined, string | undefined] {
  const idx = slotId.indexOf(":");
  if (idx <= 0) return [undefined, undefined];
  const technicianId = slotId.slice(0, idx);
  const startsAt = slotId.slice(idx + 1);
  if (!TECHNICIAN_NAMES[technicianId] || Number.isNaN(Date.parse(startsAt))) return [undefined, undefined];
  return [technicianId, startsAt];
}

/** Notifications are best-effort: a messenger outage never fails a booking. */
async function safeNotify(
  ctx: AgentContext,
  notification: Parameters<AgentContext["messaging"]["send"]>[0],
): Promise<string | null> {
  try {
    const receipt = await ctx.messaging.send(notification);
    ctx.session.notifications.push(`${notification.priority}: ${notification.title}`);
    return receipt.messageId;
  } catch {
    ctx.session.notifications.push(`FAILED ${notification.priority}: ${notification.title}`);
    return null;
  }
}

export const TOOLS: ToolDefinition[] = [
  lookupCustomer,
  recordCallerDetails,
  triageAppliance,
  quoteJob,
  checkAvailability,
  selectSlot,
  bookAppointment,
  rescheduleAppointment,
  sendNotification,
  createTicket,
  escalateToHuman,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsForState(state: ConversationState): ToolDefinition[] {
  return TOOLS.filter((t) => t.allowedStates.includes(state));
}
