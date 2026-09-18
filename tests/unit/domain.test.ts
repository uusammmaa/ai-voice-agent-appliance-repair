import { describe, expect, it } from "vitest";
import { SYMPTOMS, matchAppliance, matchSymptom, normaliseUtterance } from "@/lib/domain/catalog";
import { DEFAULT_RATE_CARD, quoteForSymptom } from "@/lib/domain/pricing";
import {
  SLOT_LENGTH_MINUTES,
  TECHNICIANS,
  describeSlot,
  findAvailableSlots,
  localWallClockToUtc,
} from "@/lib/domain/scheduling";
import { CustomerRepository, normalisePhone } from "@/lib/domain/customers";

describe("catalogue", () => {
  it("folds contractions and negations into a single form", () => {
    expect(normaliseUtterance("it won't get hot")).toBe("it not get hot");
    expect(normaliseUtterance("it doesn't get hot")).toBe("it not get hot");
    expect(normaliseUtterance("it isn't getting hot")).toBe("it not getting hot");
  });

  it.each([
    ["my fridge is not cooling", "fridge_not_cooling"],
    ["the washing machine won't drain", "washer_not_draining"],
    ["dryer runs but the clothes are still wet", "dryer_no_heat"],
    ["there's a burning smell from the dryer", "dryer_burning_smell"],
    ["dishwasher is leaving a film on the glasses", "dishwasher_not_cleaning"],
    ["the oven doesn't get hot any more", "oven_not_heating"],
    ["the burner on my cooktop isn't working", "cooktop_burner_dead"],
    ["microwave runs but doesn't heat", "microwave_no_heat"],
    ["the garbage disposal is just humming", "disposal_jammed"],
  ])("maps %j onto %s", (utterance, expected) => {
    expect(matchSymptom(utterance)?.symptom.id).toBe(expected);
  });

  it("refuses to guess when the appliance is ambiguous", () => {
    // "not draining" alone fits both the washer and the dishwasher.
    expect(matchSymptom("it's not draining")).toBeNull();
    expect(matchSymptom("something is wrong with one of my appliances")).toBeNull();
  });

  it("matches a gas smell even when no appliance is named", () => {
    const match = matchSymptom("I can smell gas in the kitchen");
    expect(match?.symptom.id).toBe("oven_gas_smell");
    expect(match?.symptom.safetyCritical).toBe(true);
  });

  it("prefers the longest appliance phrase", () => {
    expect(matchAppliance("my washing machine broke")).toBe("washer");
    expect(matchAppliance("the garbage disposal is stuck")).toBe("garbage_disposal");
  });

  it("keeps every symptom's cause likelihoods roughly normalised", () => {
    for (const symptom of SYMPTOMS) {
      const total = symptom.causes.reduce((sum, c) => sum + c.likelihood, 0);
      expect(total, `${symptom.id} likelihoods sum to ${total}`).toBeGreaterThan(0.94);
      expect(total, `${symptom.id} likelihoods sum to ${total}`).toBeLessThan(1.06);
    }
  });
});

describe("pricing", () => {
  it("always includes the diagnostic fee and never quotes below it", () => {
    for (const symptom of SYMPTOMS) {
      const quote = quoteForSymptom(symptom.id);
      expect(quote.totalLowUsd).toBeGreaterThanOrEqual(DEFAULT_RATE_CARD.diagnosticFeeUsd);
      expect(quote.totalHighUsd).toBeGreaterThanOrEqual(quote.totalLowUsd);
    }
  });

  it("applies the emergency and after-hours surcharges additively", () => {
    const base = quoteForSymptom("washer_not_draining");
    const emergency = quoteForSymptom("washer_not_draining", { emergency: true });
    const both = quoteForSymptom("washer_not_draining", { emergency: true, afterHours: true });

    const expectedDelta = DEFAULT_RATE_CARD.emergencySurchargeUsd * (1 + DEFAULT_RATE_CARD.taxRate);
    expect(emergency.totalLowUsd - base.totalLowUsd).toBeCloseTo(expectedDelta, 1);
    expect(both.totalLowUsd).toBeGreaterThan(emergency.totalLowUsd);
  });

  it("recommends replacement when the repair approaches the replacement cost", () => {
    // A microwave magnetron is the classic not-worth-fixing job.
    expect(quoteForSymptom("microwave_no_heat").recommendation).toBe("consider_replacement");
    expect(quoteForSymptom("fridge_leaking").recommendation).toBe("repair");
  });

  it("produces a spoken summary with no markdown and no placeholders", () => {
    const quote = quoteForSymptom("oven_not_heating");
    expect(quote.spokenSummary).not.toMatch(/[*_`{}]/);
    expect(quote.spokenSummary).toContain("$");
  });

  it("rejects an unknown symptom rather than inventing a price", () => {
    expect(() => quoteForSymptom("not_a_real_symptom")).toThrow(/Unknown symptom/);
  });
});

describe("scheduling", () => {
  const monday9am = new Date("2026-09-21T16:00:00.000Z");

  it("converts local wall-clock time to UTC across a DST boundary", () => {
    // US Pacific leaves DST on 2026-11-01. 9am local is 16:00Z before, 17:00Z after.
    const before = localWallClockToUtc(2026, 10, 25, 9);
    const after = localWallClockToUtc(2026, 11, 8, 9);
    expect(before.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    expect(after.toISOString()).toBe("2026-11-08T17:00:00.000Z");
  });

  it("describes a slot in the branch timezone, not UTC", () => {
    expect(describeSlot("2026-09-21T20:00:00.000Z")).toBe("Monday September 21, between 1pm and 3pm");
  });

  it("respects the two-hour dispatch lead time for routine jobs", () => {
    const slots = findAvailableSlots({ appliance: "washer", severity: "routine", now: monday9am, busy: [] });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(monday9am.getTime() + 2 * 3600_000);
    }
  });

  it("does not offer after-hours windows for routine jobs, but does for emergencies", () => {
    const routine = findAvailableSlots({ appliance: "dryer", severity: "routine", now: monday9am, busy: [], limit: 10 });
    expect(routine.some((s) => s.afterHours)).toBe(false);

    const emergency = findAvailableSlots({ appliance: "dryer", severity: "emergency", now: monday9am, busy: [], limit: 10 });
    expect(emergency.some((s) => s.afterHours)).toBe(true);
    // Emergencies also get a shorter lead time.
    expect(new Date(emergency[0]!.startsAt).getTime()).toBeLessThan(monday9am.getTime() + 2 * 3600_000 + 1);
  });

  it("only offers technicians certified for the appliance", () => {
    const slots = findAvailableSlots({ appliance: "oven", severity: "routine", now: monday9am, busy: [], limit: 10 });
    const qualified = TECHNICIANS.filter((t) => t.skills.includes("oven")).map((t) => t.id);
    for (const slot of slots) expect(qualified).toContain(slot.technicianId);
  });

  it("excludes windows that are already busy", () => {
    const first = findAvailableSlots({ appliance: "washer", severity: "routine", now: monday9am, busy: [] });
    const blocked = first[0]!;
    const busy = TECHNICIANS.map((t) => ({ technicianId: t.id, startsAt: blocked.startsAt }));

    const after = findAvailableSlots({ appliance: "washer", severity: "routine", now: monday9am, busy });
    expect(after.map((s) => s.startsAt)).not.toContain(blocked.startsAt);
  });

  it("never returns two windows with the same start time", () => {
    const slots = findAvailableSlots({ appliance: "dishwasher", severity: "routine", now: monday9am, busy: [], limit: 20 });
    expect(new Set(slots.map((s) => s.startsAt)).size).toBe(slots.length);
  });

  it("gives every slot the configured duration", () => {
    const slots = findAvailableSlots({ appliance: "washer", severity: "routine", now: monday9am, busy: [] });
    for (const slot of slots) {
      const minutes = (new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()) / 60000;
      expect(minutes).toBe(SLOT_LENGTH_MINUTES);
    }
  });
});

describe("customer repository", () => {
  it("normalises phone numbers to a comparable key", () => {
    expect(normalisePhone("+1 (415) 555-0142")).toBe("4155550142");
    expect(normalisePhone("415.555.0142")).toBe("4155550142");
  });

  it("finds a seeded customer by any phone format", () => {
    const repo = new CustomerRepository();
    expect(repo.findByPhone("(415) 555-0142")?.name).toBe("Angela Reyes");
    expect(repo.findByPhone("+14155550142")?.id).toBe("cus_1001");
  });

  it("upserts on the normalised phone rather than creating a duplicate", () => {
    const repo = new CustomerRepository();
    const updated = repo.upsert({ name: "Angela R", phone: "415-555-0142", address: "New address" });
    expect(updated.id).toBe("cus_1001");
    expect(updated.address).toBe("New address");
    // History is preserved across the upsert.
    expect(updated.history.length).toBeGreaterThan(0);
  });

  it("does not leak internal state through returned records", () => {
    const repo = new CustomerRepository();
    const customer = repo.findByPhone("+14155550142")!;
    customer.name = "mutated";
    expect(repo.findByPhone("+14155550142")?.name).toBe("Angela Reyes");
  });

  it("reports warranty cover only while the warranty is live", () => {
    const repo = new CustomerRepository();
    const tom = repo.findByPhone("+14085550198")!;
    expect(repo.warrantyCover(tom, "washer_not_draining", new Date("2026-09-21")).covered).toBe(true);
    expect(repo.warrantyCover(tom, "washer_not_draining", new Date("2027-01-01")).covered).toBe(false);
    expect(repo.warrantyCover(tom, "dryer_no_heat", new Date("2026-09-21")).covered).toBe(false);
  });
});
