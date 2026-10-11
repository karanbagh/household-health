// Vital signs: LOINC codes, canonical UCUM units, unit aliases, conversions and plausibility ranges.
// Every stored vital has an explicit canonical unit plus the exact value and unit the parent entered.

export const VITAL_INPUT_TYPES = [
  "weight", "height", "temperature", "heart_rate", "respiratory_rate",
  "spo2", "blood_pressure", "blood_glucose", "head_circumference",
] as const;
export type VitalInputType = (typeof VITAL_INPUT_TYPES)[number];

export const VITAL_STORED_TYPES = [
  "weight", "height", "temperature", "heart_rate", "respiratory_rate",
  "spo2", "bp_systolic", "bp_diastolic", "blood_glucose", "head_circumference",
] as const;
export type VitalStoredType = (typeof VITAL_STORED_TYPES)[number];

interface UnitDef { label: string; toCanonical: (v: number) => number; fromCanonical: (v: number) => number }
interface VitalDef {
  name: string;
  loinc: string;
  canonical: string;            // UCUM code stored in vitals.unit
  canonicalLabel: string;
  decimals: number;
  range: [number, number];      // plausible, in canonical units (covers newborns to adults)
  units: Record<string, UnitDef>;
  aliases: Record<string, string>;
  usUnit: string;               // unit key shown first for 'us' households
  metricUnit: string;
  /** Infer the unit from the number alone when that is unambiguous (e.g. 101.2 is °F). */
  infer?: (v: number) => string | null;
}

const unit = (label: string, factor = 1, offset = 0): UnitDef => ({
  label,
  toCanonical: (v) => v * factor + offset,
  fromCanonical: (v) => (v - offset) / factor,
});

export const VITALS: Record<VitalStoredType, VitalDef> = {
  weight: {
    name: "Weight", loinc: "29463-7", canonical: "kg", canonicalLabel: "kg", decimals: 2, range: [0.3, 350],
    units: { kg: unit("kg"), lb: unit("lb", 0.45359237), g: unit("g", 0.001) },
    aliases: { kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
               lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", "[lb_av]": "lb", g: "g", gram: "g", grams: "g" },
    usUnit: "lb", metricUnit: "kg",
  },
  height: {
    name: "Height", loinc: "8302-2", canonical: "cm", canonicalLabel: "cm", decimals: 1, range: [30, 250],
    units: { cm: unit("cm"), m: unit("m", 100), in: unit("in", 2.54) },
    aliases: { cm: "cm", cms: "cm", centimeter: "cm", centimeters: "cm", m: "m", meter: "m", meters: "m",
               in: "in", inch: "in", inches: "in", '"': "in", "[in_i]": "in" },
    usUnit: "in", metricUnit: "cm",
  },
  head_circumference: {
    name: "Head circumference", loinc: "9843-4", canonical: "cm", canonicalLabel: "cm", decimals: 1, range: [20, 70],
    units: { cm: unit("cm"), in: unit("in", 2.54) },
    aliases: { cm: "cm", cms: "cm", centimeters: "cm", in: "in", inch: "in", inches: "in" },
    usUnit: "in", metricUnit: "cm",
  },
  temperature: {
    name: "Temperature", loinc: "8310-5", canonical: "Cel", canonicalLabel: "°C", decimals: 1, range: [30, 45],
    units: { c: unit("°C"), f: { label: "°F", toCanonical: (v) => (v - 32) * 5 / 9, fromCanonical: (v) => v * 9 / 5 + 32 } },
    aliases: { c: "c", "°c": "c", celsius: "c", cel: "c", degc: "c", centigrade: "c",
               f: "f", "°f": "f", fahrenheit: "f", degf: "f", "[degf]": "f" },
    usUnit: "f", metricUnit: "c",
    infer: (v) => (v >= 86 && v <= 113 ? "f" : v >= 30 && v <= 45 ? "c" : null),
  },
  heart_rate: {
    name: "Heart rate", loinc: "8867-4", canonical: "/min", canonicalLabel: "bpm", decimals: 0, range: [20, 260],
    units: { bpm: unit("bpm") },
    aliases: { bpm: "bpm", "/min": "bpm", "beats/min": "bpm", "beats per minute": "bpm", "{beats}/min": "bpm" },
    usUnit: "bpm", metricUnit: "bpm", infer: () => "bpm",
  },
  respiratory_rate: {
    name: "Respiratory rate", loinc: "9279-1", canonical: "/min", canonicalLabel: "breaths/min", decimals: 0, range: [4, 100],
    units: { "breaths/min": unit("breaths/min") },
    aliases: { "breaths/min": "breaths/min", "/min": "breaths/min", "breaths per minute": "breaths/min", bpm: "breaths/min", rpm: "breaths/min" },
    usUnit: "breaths/min", metricUnit: "breaths/min", infer: () => "breaths/min",
  },
  spo2: {
    name: "Oxygen saturation", loinc: "59408-5", canonical: "%", canonicalLabel: "%", decimals: 0, range: [50, 100],
    units: { "%": unit("%") },
    aliases: { "%": "%", percent: "%", pct: "%" },
    usUnit: "%", metricUnit: "%", infer: () => "%",
  },
  bp_systolic: {
    name: "Systolic blood pressure", loinc: "8480-6", canonical: "mm[Hg]", canonicalLabel: "mmHg", decimals: 0, range: [40, 280],
    units: { mmhg: unit("mmHg") },
    aliases: { mmhg: "mmhg", "mm hg": "mmhg", "mm[hg]": "mmhg" },
    usUnit: "mmhg", metricUnit: "mmhg", infer: () => "mmhg",
  },
  bp_diastolic: {
    name: "Diastolic blood pressure", loinc: "8462-4", canonical: "mm[Hg]", canonicalLabel: "mmHg", decimals: 0, range: [20, 180],
    units: { mmhg: unit("mmHg") },
    aliases: { mmhg: "mmhg", "mm hg": "mmhg", "mm[hg]": "mmhg" },
    usUnit: "mmhg", metricUnit: "mmhg", infer: () => "mmhg",
  },
  blood_glucose: {
    name: "Blood glucose", loinc: "2339-0", canonical: "mg/dL", canonicalLabel: "mg/dL", decimals: 0, range: [10, 1200],
    units: { "mg/dl": unit("mg/dL"), "mmol/l": unit("mmol/L", 18.016) },
    aliases: { "mg/dl": "mg/dl", mgdl: "mg/dl", "mmol/l": "mmol/l", mmol: "mmol/l" },
    usUnit: "mg/dl", metricUnit: "mmol/l",
  },
};

function cleanUnit(u: string): string {
  return u.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export interface VitalInput {
  type: VitalInputType;
  value: number;
  value2: number | null;   // diastolic for blood_pressure; inches for height given as feet + inches
  unit: string | null;     // as the parent wrote it: "lbs", "F", "ft_in", null if not said
}

export interface NormalizedVital {
  vitalType: VitalStoredType;
  loinc: string;
  value: number;
  unit: string;
  originalValue: number;
  originalUnit: string;
}

export interface VitalResult {
  rows: NormalizedVital[];
  display: string;         // "Weight 32.4 kg (71.4 lb)"
  assumptions: string[];   // shown on the confirm card, e.g. "Unit not given; used lb (household default)"
  issues: string[];        // blocking questions back to the parent
}

/** Normalize one parsed vital. Never guesses silently: every assumption is surfaced for confirmation. */
export function normalizeVital(input: VitalInput, unitSystem: "us" | "metric"): VitalResult {
  const assumptions: string[] = [];
  const issues: string[] = [];

  if (input.type === "blood_pressure") {
    const sys = input.value, dia = input.value2;
    if (dia == null) return { rows: [], display: "", assumptions, issues: [`Blood pressure ${sys}: what was the bottom number (diastolic)?`] };
    const s = checkRange("bp_systolic", sys), d = checkRange("bp_diastolic", dia);
    if (s) issues.push(s);
    if (d) issues.push(d);
    if (sys <= dia) issues.push(`Blood pressure ${sys}/${dia}: the top number is usually higher than the bottom. Can you check it?`);
    const mk = (t: "bp_systolic" | "bp_diastolic", v: number): NormalizedVital =>
      ({ vitalType: t, loinc: VITALS[t].loinc, value: v, unit: "mm[Hg]", originalValue: v, originalUnit: "mmHg" });
    return { rows: [mk("bp_systolic", sys), mk("bp_diastolic", dia)], display: `Blood pressure ${sys}/${dia} mmHg`, assumptions, issues };
  }

  const type = input.type as VitalStoredType;
  const def = VITALS[type];

  // Height given as feet + inches
  let value = input.value;
  let unitKey: string | null = null;
  const raw = input.unit ? cleanUnit(input.unit) : null;
  if (type === "height" && raw && ["ft_in", "ft", "feet", "foot", "'"].includes(raw)) {
    value = input.value * 12 + (input.value2 ?? 0);
    unitKey = "in";
  } else if (raw) {
    unitKey = def.aliases[raw] ?? null;
    if (!unitKey) {
      issues.push(`${def.name} ${input.value} ${input.unit}: I don't recognize that unit. Which unit was it (${Object.values(def.units).map((u) => u.label).join(" or ")})?`);
      return { rows: [], display: "", assumptions, issues };
    }
  } else {
    const inferred = def.infer?.(input.value) ?? null;
    if (inferred) {
      unitKey = inferred;
      if (Object.keys(def.units).length > 1) assumptions.push(`Unit not given; ${input.value} only makes sense in ${def.units[inferred]!.label}`);
    } else {
      unitKey = unitSystem === "us" ? def.usUnit : def.metricUnit;
      assumptions.push(`Unit not given; used ${def.units[unitKey]!.label} (household default)`);
    }
  }

  const u = def.units[unitKey]!;
  const canonical = round(u.toCanonical(value), def.decimals + 1);
  const rangeIssue = checkRange(type, canonical, `${value} ${u.label}`);
  if (rangeIssue) issues.push(rangeIssue);

  return {
    rows: [{ vitalType: type, loinc: def.loinc, value: canonical, unit: def.canonical, originalValue: value, originalUnit: u.label }],
    display: `${def.name} ${formatVital(type, canonical, unitSystem, unitKey)}`,
    assumptions,
    issues,
  };
}

function checkRange(type: VitalStoredType, canonical: number, shown?: string): string | null {
  const def = VITALS[type];
  const [lo, hi] = def.range;
  if (canonical < lo || canonical > hi) {
    return `${def.name} ${shown ?? canonical}: that's outside the range I'd expect. Can you check the number and unit?`;
  }
  return null;
}

/** "32.4 kg (71.4 lb)": the entered/preferred unit first, the other system in brackets. */
export function formatVital(type: VitalStoredType, canonical: number, unitSystem: "us" | "metric", firstUnitKey?: string): string {
  const def = VITALS[type];
  const firstKey = firstUnitKey ?? (unitSystem === "us" ? def.usUnit : def.metricUnit);
  const otherKey = firstKey === def.usUnit ? def.metricUnit : def.usUnit;
  const fmt = (key: string) => {
    const u = def.units[key]!;
    const d = key === "lb" || key === "f" || key === "in" ? 1 : def.decimals;
    return `${round(u.fromCanonical(canonical), d)} ${u.label}`;
  };
  return otherKey && otherKey !== firstKey && def.units[otherKey] ? `${fmt(firstKey)} (${fmt(otherKey)})` : fmt(firstKey);
}

/** A change between two readings, e.g. "+1.8 lb". Uses only the scale factor, so °C→°F deltas are correct. */
export function formatDelta(type: VitalStoredType, deltaCanonical: number, unitSystem: "us" | "metric"): string {
  const def = VITALS[type];
  const key = unitSystem === "us" ? def.usUnit : def.metricUnit;
  const u = def.units[key]!;
  const d = u.fromCanonical(deltaCanonical) - u.fromCanonical(0);
  const decimals = key === "lb" || key === "f" || key === "in" ? 1 : def.decimals;
  return `${d >= 0 ? "+" : "-"}${round(Math.abs(d), decimals)} ${u.label}`;
}
