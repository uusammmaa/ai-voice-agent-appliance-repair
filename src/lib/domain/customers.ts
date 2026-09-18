/**
 * Minimal CRM surface. In a real deployment this is a ServiceTitan / Housecall Pro /
 * Jobber adapter; here it is a seeded in-memory repository behind the same interface so
 * the demo, the evals and the tests all exercise the identical code path.
 */

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  email?: string;
  /** Appliances we have on file for this address, newest first. */
  appliances: Array<{ type: string; brand: string; model?: string; installedYear?: number }>;
  /** Previous jobs, used to spot repeat failures and warranty situations. */
  history: Array<{ date: string; symptomId: string; outcome: string; warrantyUntil?: string }>;
  notes?: string;
}

const SEED: Customer[] = [
  {
    id: "cus_1001",
    name: "Angela Reyes",
    phone: "+14155550142",
    address: "1820 Larkspur Lane, San Rafael, CA",
    email: "angela.reyes@example.com",
    appliances: [
      { type: "refrigerator", brand: "Whirlpool", model: "WRF535SWHZ", installedYear: 2019 },
      { type: "dishwasher", brand: "Bosch", model: "SHPM65Z55N", installedYear: 2021 },
    ],
    history: [
      { date: "2025-11-04", symptomId: "dishwasher_not_draining", outcome: "Cleared filter, no parts", warrantyUntil: "2026-02-04" },
    ],
    notes: "Gate code 4412. Dog in the yard - call on arrival.",
  },
  {
    id: "cus_1002",
    name: "Tom Whitfield",
    phone: "+14085550198",
    address: "77 Juniper Court, Sunnyvale, CA",
    appliances: [
      { type: "washer", brand: "LG", model: "WM4000HWA", installedYear: 2022 },
      { type: "dryer", brand: "LG", model: "DLEX4000W", installedYear: 2022 },
    ],
    history: [{ date: "2026-06-18", symptomId: "washer_not_draining", outcome: "Replaced drain pump", warrantyUntil: "2026-12-18" }],
  },
  {
    id: "cus_1003",
    name: "Priscilla Nkemdirim",
    phone: "+16505550177",
    address: "402 Oakridge Terrace, Redwood City, CA",
    email: "p.nkem@example.com",
    appliances: [{ type: "oven", brand: "GE", model: "JB645RKSS", installedYear: 2017 }],
    history: [],
  },
];

/** Digits only, so "(415) 555-0142" and "+1 415 555 0142" collapse to the same key. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export class CustomerRepository {
  private readonly byId = new Map<string, Customer>();

  constructor(seed: Customer[] = SEED) {
    for (const c of seed) this.byId.set(c.id, structuredClone(c));
  }

  findByPhone(phone: string): Customer | null {
    const key = normalisePhone(phone);
    if (!key) return null;
    for (const c of this.byId.values()) {
      if (normalisePhone(c.phone) === key) return structuredClone(c);
    }
    return null;
  }

  findById(id: string): Customer | null {
    const c = this.byId.get(id);
    return c ? structuredClone(c) : null;
  }

  /**
   * Upsert on normalised phone. Returning the stored record (not the input) keeps the
   * caller honest about which fields the system actually retained.
   */
  upsert(input: Omit<Customer, "id" | "appliances" | "history"> & Partial<Pick<Customer, "appliances" | "history">>): Customer {
    const existing = this.findByPhone(input.phone);
    if (existing) {
      const merged: Customer = {
        ...existing,
        name: input.name || existing.name,
        address: input.address || existing.address,
        email: input.email ?? existing.email,
        notes: input.notes ?? existing.notes,
      };
      this.byId.set(merged.id, merged);
      return structuredClone(merged);
    }
    const created: Customer = {
      id: `cus_${normalisePhone(input.phone).slice(-6) || Date.now().toString(36)}`,
      name: input.name,
      phone: input.phone,
      address: input.address,
      email: input.email,
      notes: input.notes,
      appliances: input.appliances ?? [],
      history: input.history ?? [],
    };
    this.byId.set(created.id, created);
    return structuredClone(created);
  }

  /** Is this symptom on the same appliance still inside a prior repair warranty? */
  warrantyCover(customer: Customer, symptomId: string, now: Date): { covered: boolean; until?: string } {
    const match = customer.history.find((h) => h.symptomId === symptomId && h.warrantyUntil);
    if (!match?.warrantyUntil) return { covered: false };
    return { covered: new Date(match.warrantyUntil) >= now, until: match.warrantyUntil };
  }
}

export const customers = new CustomerRepository();
