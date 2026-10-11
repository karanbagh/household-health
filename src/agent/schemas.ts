import { z } from "zod";
import { VITAL_INPUT_TYPES } from "../domain/vitals.js";

// Structured output for the "understand" step. Every field is present and nullable because
// OpenAI strict structured outputs require all properties; null means "the parent did not say".

const vital = z.object({
  type: z.enum(VITAL_INPUT_TYPES),
  value: z.number().describe("The number as stated. Blood pressure: systolic. Height in feet+inches: the feet."),
  value2: z.number().nullable().describe("Blood pressure: diastolic. Height in feet+inches: the inches. Otherwise null."),
  unit: z.string().nullable().describe("Unit exactly as the parent wrote it (lbs, kg, F, °C, cm, mmol/L). Use 'ft_in' for feet+inches. null if not stated. Never invent or convert."),
  measured_at_local: z.string().nullable().describe("Household-local 'YYYY-MM-DDTHH:mm' if the parent said when; null means now."),
});

const medicationStart = z.object({
  name: z.string(),
  dose_value: z.number().nullable(),
  dose_unit: z.string().nullable().describe("mg, ml, puffs, tablets…"),
  route: z.string().nullable().describe("oral, inhaled, topical…"),
  frequency: z.string().nullable().describe("e.g. 'twice daily', 'every 6 hours as needed'"),
  prescriber: z.string().nullable(),
  reason: z.string().nullable(),
  start_date: z.string().nullable().describe("YYYY-MM-DD, null if not stated"),
  end_date: z.string().nullable().describe("YYYY-MM-DD if a planned end was stated (e.g. a 10-day course)"),
});

const medicationStop = z.object({
  name: z.string().describe("The medication being stopped, as the parent named it"),
  end_date: z.string().nullable().describe("YYYY-MM-DD, null means today"),
  stop_reason: z.string().nullable(),
});

const allergy = z.object({
  substance: z.string(),
  reaction: z.string().nullable(),
  severity: z.enum(["mild", "moderate", "severe", "unknown"]),
  noted_on: z.string().nullable().describe("YYYY-MM-DD"),
});

const appointment = z.object({
  starts_at_local: z.string().nullable().describe("Household-local 'YYYY-MM-DDTHH:mm'. If only a date was given use 'YYYY-MM-DD'."),
  provider_name: z.string().nullable(),
  specialty: z.string().nullable(),
  location: z.string().nullable(),
  reason: z.string().nullable(),
});

const profile = z.object({
  full_name: z.string().nullable(),
  preferred_name: z.string().nullable(),
  date_of_birth: z.string().nullable().describe("YYYY-MM-DD"),
  sex: z.enum(["female", "male", "other", "unknown"]).nullable(),
  blood_type: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable(),
  eye_color: z.string().trim().min(1).max(100).nullable().describe("Eye color as stated, such as brown, blue, green, or hazel. null if not stated."),
});

export const ITEM_KINDS = ["vital", "medication_start", "medication_stop", "allergy", "appointment", "profile_update"] as const;

const item = z.object({
  kind: z.enum(ITEM_KINDS),
  vital: vital.nullable(),
  medication_start: medicationStart.nullable(),
  medication_stop: medicationStop.nullable(),
  allergy: allergy.nullable(),
  appointment: appointment.nullable(),
  profile_update: profile.nullable(),
});

/** Built per request so member_id can only be one of this household's member ids. */
export function understandSchema(memberIds: [string, ...string[]]) {
  return z.object({
    intent: z.enum(["entry", "question", "other"]).describe(
      "entry: the parent is recording or changing information. question: asking about recorded information. other: greetings or anything else.",
    ),
    member_id: z.enum(memberIds).nullable().describe("Which household member this is about; null if not clear from the message or conversation."),
    items: z.array(item).describe("For intent=entry: one item per fact recorded. Fill only the object matching kind; set the others to null. Empty for questions."),
    question: z.string().nullable().describe("For intent=question: the question restated so it stands alone, resolving references to the conversation."),
  });
}

export type Understanding = z.infer<ReturnType<typeof understandSchema>>;
export type ExtractedItem = z.infer<typeof item>;
