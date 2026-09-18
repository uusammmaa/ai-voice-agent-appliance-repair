/**
 * Structured appliance knowledge base.
 *
 * Triage and quoting read from this catalogue rather than asking the model to invent
 * causes or prices. The model's job is to map free speech onto a `symptomId`; every
 * number the caller hears afterwards comes from here and is therefore auditable.
 */

export type ApplianceType =
  | "refrigerator"
  | "washer"
  | "dryer"
  | "dishwasher"
  | "oven"
  | "cooktop"
  | "microwave"
  | "garbage_disposal";

export type Severity = "routine" | "urgent" | "emergency";

export interface LikelyCause {
  /** What we think is wrong, in words a homeowner understands. */
  cause: string;
  /** Rough share of calls with this symptom that turn out to be this cause. */
  likelihood: number;
  /** Parts cost range in USD, before labour. */
  partsUsd: [number, number];
  /** Technician minutes on site, used to derive the labour estimate. */
  labourMinutes: number;
}

export interface Symptom {
  id: string;
  appliance: ApplianceType;
  /**
   * Distinctive fragments of a *normalised* caller utterance that point at this symptom.
   * Normalisation folds contractions and negations, so the stem "not drain" also covers
   * "isn't draining", "won't drain" and "doesn't drain".
   */
  signals: string[];
  label: string;
  severity: Severity;
  causes: LikelyCause[];
  /** Safe, useful things the caller can try before a technician is dispatched. */
  selfChecks: string[];
  /** If true the agent must give the safety warning and offer same-day dispatch. */
  safetyCritical?: boolean;
}

export const SAFETY_SCRIPT =
  "Before anything else - if you can smell gas, leave the property now and call your gas " +
  "emergency line. If you see smoke or scorching, switch the appliance off at the wall and " +
  "do not use it again until a technician has checked it.";

export const SYMPTOMS: readonly Symptom[] = [
  {
    id: "fridge_not_cooling",
    appliance: "refrigerator",
    label: "Refrigerator not cooling",
    severity: "urgent",
    signals: ["not cool", "not cold", "not get cold", "warm", "food spoil", "stopped cool", "not freez", "not chill"],
    causes: [
      { cause: "Dirty or blocked condenser coils", likelihood: 0.34, partsUsd: [0, 0], labourMinutes: 45 },
      { cause: "Failed evaporator fan motor", likelihood: 0.28, partsUsd: [60, 140], labourMinutes: 60 },
      { cause: "Faulty start relay or compressor overload", likelihood: 0.22, partsUsd: [35, 110], labourMinutes: 60 },
      { cause: "Sealed-system refrigerant leak", likelihood: 0.16, partsUsd: [180, 420], labourMinutes: 150 },
    ],
    selfChecks: [
      "Check the thermostat dial hasn't been knocked to a warmer setting.",
      "Make sure the vents inside aren't blocked by packed food.",
      "Listen for the compressor - a low hum at the back means it is at least trying.",
    ],
  },
  {
    id: "fridge_leaking",
    appliance: "refrigerator",
    label: "Refrigerator leaking water",
    severity: "routine",
    signals: ["leak", "water under", "puddle", "water on the floor", "dripping"],
    causes: [
      { cause: "Blocked defrost drain", likelihood: 0.52, partsUsd: [0, 25], labourMinutes: 45 },
      { cause: "Cracked or disconnected water line", likelihood: 0.27, partsUsd: [20, 60], labourMinutes: 45 },
      { cause: "Failed water inlet valve", likelihood: 0.21, partsUsd: [55, 130], labourMinutes: 60 },
    ],
    selfChecks: [
      "Pull the fridge out and check whether the water is coming from the back or the front.",
      "Empty the drip tray underneath if your model has one.",
    ],
  },
  {
    id: "washer_not_draining",
    appliance: "washer",
    label: "Washing machine will not drain",
    severity: "urgent",
    signals: ["not drain", "water in the drum", "standing water", "water sitting", "not spin", "full of water", "clothes are soak", "soaking wet"],
    causes: [
      { cause: "Blocked drain pump filter", likelihood: 0.41, partsUsd: [0, 20], labourMinutes: 45 },
      { cause: "Failed drain pump", likelihood: 0.33, partsUsd: [70, 160], labourMinutes: 75 },
      { cause: "Kinked or clogged drain hose", likelihood: 0.15, partsUsd: [15, 45], labourMinutes: 30 },
      { cause: "Faulty pressure switch or control board", likelihood: 0.11, partsUsd: [90, 260], labourMinutes: 90 },
    ],
    selfChecks: [
      "Run a spin-only cycle and see whether the pump makes any noise at all.",
      "If you can reach it safely, check the filter flap at the bottom front for coins or lint.",
    ],
  },
  {
    id: "washer_leaking",
    appliance: "washer",
    label: "Washing machine leaking",
    severity: "urgent",
    signals: ["leak", "flood", "water coming out", "water everywhere"],
    causes: [
      { cause: "Perished door seal / boot", likelihood: 0.38, partsUsd: [60, 150], labourMinutes: 90 },
      { cause: "Loose or split hose connection", likelihood: 0.32, partsUsd: [10, 40], labourMinutes: 45 },
      { cause: "Cracked detergent dispenser housing", likelihood: 0.18, partsUsd: [40, 95], labourMinutes: 60 },
      { cause: "Failed tub seal or bearing", likelihood: 0.12, partsUsd: [120, 300], labourMinutes: 180 },
    ],
    selfChecks: [
      "Turn the water supply valves off behind the machine to stop it getting worse.",
      "Note whether the leak happens on fill, on wash, or on spin - it tells us a lot.",
    ],
  },
  {
    id: "dryer_no_heat",
    appliance: "dryer",
    label: "Dryer runs but produces no heat",
    severity: "routine",
    signals: ["not heat", "no heat", "not dry", "still wet", "not get hot", "blowing cold"],
    causes: [
      { cause: "Blown thermal fuse from restricted venting", likelihood: 0.39, partsUsd: [15, 40], labourMinutes: 60 },
      { cause: "Failed heating element", likelihood: 0.31, partsUsd: [55, 150], labourMinutes: 75 },
      { cause: "Faulty cycling thermostat", likelihood: 0.18, partsUsd: [25, 70], labourMinutes: 60 },
      { cause: "Gas valve coil failure (gas models)", likelihood: 0.12, partsUsd: [60, 140], labourMinutes: 75 },
    ],
    selfChecks: [
      "Check the lint trap and the outside vent flap - restricted airflow causes most of these.",
      "If it is a gas dryer, confirm other gas appliances in the house are working.",
    ],
  },
  {
    id: "dryer_burning_smell",
    appliance: "dryer",
    label: "Burning smell from dryer",
    severity: "emergency",
    safetyCritical: true,
    signals: ["burning", "smell burn", "smok", "scorch", "fire", "hot smell"],
    causes: [
      { cause: "Lint accumulation against the heating element", likelihood: 0.47, partsUsd: [0, 40], labourMinutes: 90 },
      { cause: "Seized drum bearing or idler pulley", likelihood: 0.3, partsUsd: [40, 120], labourMinutes: 120 },
      { cause: "Failing drive motor", likelihood: 0.23, partsUsd: [110, 260], labourMinutes: 120 },
    ],
    selfChecks: [
      "Stop using the dryer immediately and unplug it.",
      "Do not run it again, even briefly, until it has been inspected.",
    ],
  },
  {
    id: "dishwasher_not_cleaning",
    appliance: "dishwasher",
    label: "Dishwasher not cleaning properly",
    severity: "routine",
    signals: ["not clean", "still dirty", "not wash", "film", "residue", "spots", "cloudy", "gritty"],
    causes: [
      { cause: "Blocked spray arms or filter", likelihood: 0.46, partsUsd: [0, 30], labourMinutes: 45 },
      { cause: "Failed wash pump or impeller", likelihood: 0.27, partsUsd: [80, 210], labourMinutes: 90 },
      { cause: "Low water fill from a faulty inlet valve", likelihood: 0.27, partsUsd: [50, 120], labourMinutes: 60 },
    ],
    selfChecks: [
      "Pull the bottom filter out and rinse it - it is usually the whole problem.",
      "Spin the spray arms by hand to check nothing is jamming them.",
    ],
  },
  {
    id: "dishwasher_not_draining",
    appliance: "dishwasher",
    label: "Dishwasher not draining",
    severity: "routine",
    signals: ["not drain", "water in the bottom", "standing water", "water left"],
    causes: [
      { cause: "Clogged filter or drain hose", likelihood: 0.5, partsUsd: [0, 35], labourMinutes: 45 },
      { cause: "Failed drain pump", likelihood: 0.31, partsUsd: [70, 165], labourMinutes: 75 },
      { cause: "Blocked air gap or disposal knockout plug", likelihood: 0.19, partsUsd: [0, 25], labourMinutes: 30 },
    ],
    selfChecks: ["Check the sink air gap on the countertop if you have one."],
  },
  {
    id: "oven_not_heating",
    appliance: "oven",
    label: "Oven not reaching temperature",
    severity: "routine",
    signals: ["not heat", "no heat", "not get hot", "not reach temp", "not work", "stays cold", "not come up to temp"],
    causes: [
      { cause: "Failed bake element", likelihood: 0.37, partsUsd: [40, 110], labourMinutes: 60 },
      { cause: "Faulty oven temperature sensor", likelihood: 0.29, partsUsd: [30, 80], labourMinutes: 60 },
      { cause: "Weak igniter (gas ovens)", likelihood: 0.22, partsUsd: [45, 120], labourMinutes: 75 },
      { cause: "Failed control board / relay", likelihood: 0.12, partsUsd: [130, 320], labourMinutes: 90 },
    ],
    selfChecks: ["Check the oven is not stuck in a delayed-start or sabbath mode."],
  },
  {
    id: "oven_gas_smell",
    appliance: "oven",
    label: "Gas smell near the oven or cooktop",
    severity: "emergency",
    safetyCritical: true,
    signals: ["smell gas", "gas smell", "smell of gas", "gas leak", "smells gas"],
    causes: [
      { cause: "Loose supply fitting or failed valve seal", likelihood: 0.6, partsUsd: [20, 120], labourMinutes: 90 },
      { cause: "Cracked burner orifice or supply line", likelihood: 0.4, partsUsd: [40, 180], labourMinutes: 120 },
    ],
    selfChecks: [
      "Leave the property and call your gas emergency line before anything else.",
      "Do not switch anything electrical on or off on your way out.",
    ],
  },
  {
    id: "cooktop_burner_dead",
    appliance: "cooktop",
    label: "Cooktop burner or element dead",
    severity: "routine",
    signals: ["not work", "not light", "dead", "not ignit", "no flame", "not turn on", "not come on"],
    causes: [
      { cause: "Failed surface element or induction coil", likelihood: 0.42, partsUsd: [45, 190], labourMinutes: 60 },
      { cause: "Burnt element receptacle or wiring", likelihood: 0.33, partsUsd: [20, 60], labourMinutes: 60 },
      { cause: "Faulty switch or touch control board", likelihood: 0.25, partsUsd: [70, 240], labourMinutes: 75 },
    ],
    selfChecks: ["On a gas hob, lift the cap and check the slots are not clogged."],
  },
  {
    id: "microwave_no_heat",
    appliance: "microwave",
    label: "Microwave runs but does not heat",
    severity: "routine",
    signals: ["not heat", "no heat", "not get hot", "not warm", "not work", "runs but"],
    causes: [
      { cause: "Failed magnetron", likelihood: 0.44, partsUsd: [80, 190], labourMinutes: 75 },
      { cause: "Blown high-voltage diode or capacitor", likelihood: 0.34, partsUsd: [25, 90], labourMinutes: 60 },
      { cause: "Faulty door interlock switch", likelihood: 0.22, partsUsd: [20, 60], labourMinutes: 45 },
    ],
    selfChecks: ["Unplug it and leave it unplugged - the capacitor holds a dangerous charge."],
  },
  {
    id: "disposal_jammed",
    appliance: "garbage_disposal",
    label: "Garbage disposal jammed or humming",
    severity: "routine",
    signals: ["jam", "hum", "stuck", "not work", "not turn", "seized"],
    causes: [
      { cause: "Foreign object jamming the impeller", likelihood: 0.63, partsUsd: [0, 0], labourMinutes: 30 },
      { cause: "Seized motor", likelihood: 0.24, partsUsd: [90, 220], labourMinutes: 60 },
      { cause: "Tripped internal overload or failed switch", likelihood: 0.13, partsUsd: [0, 40], labourMinutes: 30 },
    ],
    selfChecks: [
      "Switch it off at the wall, then press the red reset button underneath.",
      "Never put your hand into the chamber, even with the power off.",
    ],
  },
];

const BY_ID = new Map(SYMPTOMS.map((s) => [s.id, s]));

export function getSymptom(id: string): Symptom | undefined {
  return BY_ID.get(id);
}

export function symptomsFor(appliance: ApplianceType): Symptom[] {
  return SYMPTOMS.filter((s) => s.appliance === appliance);
}

export const APPLIANCE_PHRASES: Record<ApplianceType, string[]> = {
  refrigerator: ["fridge", "refrigerator", "freezer", "ice maker"],
  washer: ["washer", "washing machine", "laundry machine"],
  dryer: ["dryer", "tumble dryer"],
  dishwasher: ["dishwasher", "dish washer"],
  oven: ["oven", "range", "stove"],
  cooktop: ["cooktop", "hob", "burner", "induction"],
  microwave: ["microwave"],
  garbage_disposal: ["disposal", "garbage disposal", "waste disposal", "insinkerator"],
};

const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bwon'?t\b/g, "will not"],
  [/\bcan'?t\b/g, "can not"],
  [/\bshan'?t\b/g, "shall not"],
  [/\bain'?t\b/g, "is not"],
  [/(\w)n'?t\b/g, "$1 not"],
  [/\bit'?s\b/g, "it is"],
  [/\bthere'?s\b/g, "there is"],
  [/\bthat'?s\b/g, "that is"],
];

/** Every way English negates a verb collapses to a bare "not". */
const NEGATIONS = /\b(?:will|does|do|did|is|are|was|were|has|have|had|can|could|would|should)\s+not\b/g;

/**
 * Fold a caller utterance into the form the catalogue signals are written in.
 *
 * "it won't get hot", "it doesn't get hot" and "it isn't getting hot" all become
 * "it not get hot", which a single signal then covers. Keeping this transformation in
 * one place is what stops the catalogue turning into a phrasebook.
 */
export function normaliseUtterance(utterance: string): string {
  let text = utterance.toLowerCase();
  for (const [pattern, replacement] of CONTRACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(NEGATIONS, "not");
  text = text.replace(/\bno\s+(?=heat|flame|power|water)/g, "no ");
  text = text.replace(/\bnot\s+(?:really|even|actually|properly|any\s*more)\b/g, "not");
  return text.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Best-effort mapping of a caller utterance onto a catalogue symptom.
 *
 * Deliberately conservative. Without an appliance to scope the search, a bare signal
 * like "not draining" is ambiguous between the washer and the dishwasher, so the match
 * is rejected and the agent asks which appliance it is. Guessing here costs a truck roll.
 */
export function matchSymptom(
  utterance: string,
  applianceHint?: ApplianceType,
): { symptom: Symptom; confidence: number } | null {
  const text = normaliseUtterance(utterance);
  const appliance = applianceHint ?? matchAppliance(utterance) ?? undefined;
  let best: { symptom: Symptom; confidence: number } | null = null;

  for (const symptom of SYMPTOMS) {
    const applianceMatches = appliance === symptom.appliance;
    // Safety-critical faults are matched across appliances: someone shouting about a
    // gas smell should not have to name the appliance first.
    if (!applianceMatches && !symptom.safetyCritical) continue;

    const matched = symptom.signals.filter((signal) => text.includes(signal));
    if (matched.length === 0) continue;

    const longest = Math.max(...matched.map((m) => m.length));
    let score = 0.45 + Math.min(longest, 24) / 60 + (matched.length - 1) * 0.05;
    if (applianceMatches) score += 0.25;
    if (symptom.safetyCritical) score += 0.15;

    const confidence = Math.min(0.99, score);
    if (!best || confidence > best.confidence) best = { symptom, confidence };
  }

  return best && best.confidence >= 0.7 ? best : null;
}

export function matchAppliance(utterance: string): ApplianceType | null {
  const text = utterance.toLowerCase();
  let best: { appliance: ApplianceType; len: number } | null = null;
  for (const [appliance, phrases] of Object.entries(APPLIANCE_PHRASES) as [ApplianceType, string[]][]) {
    for (const phrase of phrases) {
      if (text.includes(phrase) && (!best || phrase.length > best.len)) {
        best = { appliance, len: phrase.length };
      }
    }
  }
  return best?.appliance ?? null;
}
