import { getSymptom, type LikelyCause, type Symptom } from "./catalog";

/**
 * Pricing is pure arithmetic over the catalogue and the rate card. The model never
 * produces a price; it only names a `symptomId`, and this module turns that into a
 * quote the business is willing to stand behind.
 */

export interface RateCard {
  /** Non-refundable call-out, credited against the repair if the customer proceeds. */
  diagnosticFeeUsd: number;
  /** Billed per hour, rounded up to the nearest 15 minutes. */
  labourRateUsdPerHour: number;
  /** Surcharge for same-day emergency dispatch. */
  emergencySurchargeUsd: number;
  /** Surcharge for evening and weekend slots. */
  afterHoursSurchargeUsd: number;
  /** Markup applied to parts, as a multiplier. */
  partsMarkup: number;
  /** Repairs quoted above this fraction of replacement cost get a replace recommendation. */
  replaceThreshold: number;
  taxRate: number;
}

export const DEFAULT_RATE_CARD: RateCard = {
  diagnosticFeeUsd: 89,
  labourRateUsdPerHour: 135,
  emergencySurchargeUsd: 75,
  afterHoursSurchargeUsd: 45,
  partsMarkup: 1.35,
  replaceThreshold: 0.5,
  taxRate: 0.0875,
};

/** Typical replacement cost, used only for the repair-or-replace recommendation. */
export const REPLACEMENT_COST_USD: Record<string, number> = {
  refrigerator: 1400,
  washer: 850,
  dryer: 780,
  dishwasher: 720,
  oven: 1100,
  cooktop: 900,
  microwave: 320,
  garbage_disposal: 260,
};

export interface QuoteLine {
  label: string;
  lowUsd: number;
  highUsd: number;
}

export interface Quote {
  symptomId: string;
  symptomLabel: string;
  appliance: string;
  severity: Symptom["severity"];
  lines: QuoteLine[];
  subtotalLowUsd: number;
  subtotalHighUsd: number;
  taxLowUsd: number;
  taxHighUsd: number;
  totalLowUsd: number;
  totalHighUsd: number;
  diagnosticFeeUsd: number;
  likelyCauses: LikelyCause[];
  recommendation: "repair" | "consider_replacement";
  /** One-paragraph explanation the agent can read out verbatim. */
  spokenSummary: string;
  disclaimer: string;
}

export interface QuoteOptions {
  emergency?: boolean;
  afterHours?: boolean;
  rateCard?: RateCard;
}

function roundToQuarterHour(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function usd(n: number): string {
  return `$${n.toFixed(0)}`;
}

/**
 * Build a quote range from the two most likely causes for the symptom: the low end is
 * the cheapest plausible outcome, the high end the most expensive of the shortlist.
 * Quoting the full tail would produce a range so wide it is useless on a phone call.
 */
export function quoteForSymptom(symptomId: string, options: QuoteOptions = {}): Quote {
  const symptom = getSymptom(symptomId);
  if (!symptom) throw new Error(`Unknown symptom: ${symptomId}`);

  const rate = options.rateCard ?? DEFAULT_RATE_CARD;
  const shortlist = [...symptom.causes].sort((a, b) => b.likelihood - a.likelihood).slice(0, 3);

  const partsLow = Math.min(...shortlist.map((c) => c.partsUsd[0])) * rate.partsMarkup;
  const partsHigh = Math.max(...shortlist.map((c) => c.partsUsd[1])) * rate.partsMarkup;

  const labourLow = (roundToQuarterHour(Math.min(...shortlist.map((c) => c.labourMinutes))) / 60) * rate.labourRateUsdPerHour;
  const labourHigh = (roundToQuarterHour(Math.max(...shortlist.map((c) => c.labourMinutes))) / 60) * rate.labourRateUsdPerHour;

  const lines: QuoteLine[] = [
    { label: "Diagnostic call-out (credited against the repair)", lowUsd: rate.diagnosticFeeUsd, highUsd: rate.diagnosticFeeUsd },
    { label: "Parts", lowUsd: money(partsLow), highUsd: money(partsHigh) },
    { label: "Labour", lowUsd: money(labourLow), highUsd: money(labourHigh) },
  ];

  if (options.emergency) {
    lines.push({ label: "Same-day emergency dispatch", lowUsd: rate.emergencySurchargeUsd, highUsd: rate.emergencySurchargeUsd });
  }
  if (options.afterHours) {
    lines.push({ label: "Evening / weekend slot", lowUsd: rate.afterHoursSurchargeUsd, highUsd: rate.afterHoursSurchargeUsd });
  }

  const subtotalLow = money(lines.reduce((sum, l) => sum + l.lowUsd, 0));
  const subtotalHigh = money(lines.reduce((sum, l) => sum + l.highUsd, 0));
  const taxLow = money(subtotalLow * rate.taxRate);
  const taxHigh = money(subtotalHigh * rate.taxRate);
  const totalLow = money(subtotalLow + taxLow);
  const totalHigh = money(subtotalHigh + taxHigh);

  const replacement = REPLACEMENT_COST_USD[symptom.appliance] ?? Infinity;
  const recommendation: Quote["recommendation"] =
    totalHigh > replacement * rate.replaceThreshold ? "consider_replacement" : "repair";

  const topCause = shortlist[0];
  const spokenSummary = [
    `For ${symptom.label.toLowerCase()}, the most common cause we see is ${topCause ? topCause.cause.toLowerCase() : "a component failure"}.`,
    `All in, you're looking at somewhere between ${usd(totalLow)} and ${usd(totalHigh)} including tax,`,
    `and that already includes the ${usd(rate.diagnosticFeeUsd)} call-out, which we credit against the repair if you go ahead.`,
    recommendation === "consider_replacement"
      ? `I should be straight with you though - at the top of that range it's getting close to what a replacement costs, so the technician will talk you through both options before doing any work.`
      : `The technician confirms the exact figure on site and you approve it before any work starts.`,
  ].join(" ");

  return {
    symptomId: symptom.id,
    symptomLabel: symptom.label,
    appliance: symptom.appliance,
    severity: symptom.severity,
    lines,
    subtotalLowUsd: subtotalLow,
    subtotalHighUsd: subtotalHigh,
    taxLowUsd: taxLow,
    taxHighUsd: taxHigh,
    totalLowUsd: totalLow,
    totalHighUsd: totalHigh,
    diagnosticFeeUsd: rate.diagnosticFeeUsd,
    likelyCauses: shortlist,
    recommendation,
    spokenSummary,
    disclaimer:
      "Estimate only. The technician confirms the final price on site and no work begins without your approval.",
  };
}
