// Typed mirror of db/migrations/0001_init.sql. The SQL file is the source of truth for
// RLS policies, triggers and grants; keep column definitions here in sync with it.
import { pgTable, uuid, text, date, timestamp, numeric, jsonb, bigserial, integer, customType, vector } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  unitSystem: text("unit_system").$type<"us" | "metric">().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name"),
  dateOfBirth: date("date_of_birth"),
  sex: text("sex"),
  bloodType: text("blood_type"),
  eyeColor: text("eye_color"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  deletedAt: ts("deleted_at"),
});

export const allergies = pgTable("allergies", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  memberId: uuid("member_id").notNull(),
  substance: text("substance").notNull(),
  reaction: text("reaction"),
  severity: text("severity").$type<"mild" | "moderate" | "severe" | "unknown">().notNull(),
  notedOn: date("noted_on"),
  status: text("status").$type<"active" | "inactive">().notNull(),
  sourceText: text("source_text"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  deletedAt: ts("deleted_at"),
});

export const medications = pgTable("medications", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  memberId: uuid("member_id").notNull(),
  name: text("name").notNull(),
  doseValue: numeric("dose_value", { mode: "number" }),
  doseUnit: text("dose_unit"),
  route: text("route"),
  frequency: text("frequency"),
  prescriber: text("prescriber"),
  reason: text("reason"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  stopReason: text("stop_reason"),
  status: text("status").$type<"active" | "stopped">().notNull(),
  sourceText: text("source_text"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  deletedAt: ts("deleted_at"),
});

export const vitals = pgTable("vitals", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  memberId: uuid("member_id").notNull(),
  vitalType: text("vital_type").notNull(),
  loinc: text("loinc").notNull(),
  value: numeric("value", { mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  originalValue: numeric("original_value", { mode: "number" }).notNull(),
  originalUnit: text("original_unit").notNull(),
  measuredAt: ts("measured_at").notNull(),
  panelId: uuid("panel_id"),
  sourceText: text("source_text"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  deletedAt: ts("deleted_at"),
});

export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  memberId: uuid("member_id").notNull(),
  startsAt: ts("starts_at").notNull(),
  providerName: text("provider_name"),
  specialty: text("specialty"),
  location: text("location"),
  reason: text("reason"),
  status: text("status").$type<"scheduled" | "completed" | "cancelled">().notNull(),
  outcomeNotes: text("outcome_notes"),
  sourceText: text("source_text"),
  createdAt: ts("created_at").notNull().defaultNow(),
  createdBy: uuid("created_by"),
  deletedAt: ts("deleted_at"),
});

export const pendingEntries = pgTable("pending_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id").notNull(),
  memberId: uuid("member_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  sourceText: text("source_text").notNull(),
  proposals: jsonb("proposals").notNull(),
  status: text("status").$type<"pending" | "confirmed" | "discarded" | "undone">().notNull(),
  createdRecords: jsonb("created_records"),
  traceId: text("trace_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  householdId: uuid("household_id").notNull(),
  actorUserId: uuid("actor_user_id"),
  memberId: uuid("member_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: uuid("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  details: jsonb("details"),
  requestId: text("request_id"),
  traceId: text("trace_id"),
});

// Report originals and the index of reviewed content (0004 through 0006 migrations).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const reports = pgTable("reports", {
  reportType: text("report_type").$type<import("../domain/labs.js").ReportType>().notNull(),
  sections: jsonb("sections").$type<{ heading: string; text: string }[]>().notNull(),
  id: uuid("id").primaryKey().defaultRandom(), householdId: uuid("household_id").notNull(), memberId: uuid("member_id").notNull(),
  title: text("title").notNull(), reportDate: date("report_date"), labName: text("lab_name"), patientName: text("patient_name"),
  originalText: text("original_text").notNull(), fileName: text("file_name"), fileMime: text("file_mime"), fileData: bytea("file_data"), contentHash: text("content_hash").notNull(),
  results: jsonb("results").$type<import("../domain/labs.js").LabData["results"]>().notNull(), notes: text("notes").notNull(), warnings: jsonb("warnings").$type<string[]>().notNull(),
  status: text("status").$type<"draft" | "confirmed">().notNull(), revision: integer("revision").notNull(),
  createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(), createdBy: uuid("created_by"), deletedAt: ts("deleted_at"),
});
export const reportChunks = pgTable("report_chunks", {
  id: uuid("id").primaryKey().defaultRandom(), householdId: uuid("household_id").notNull(), memberId: uuid("member_id").notNull(), reportId: uuid("report_id").notNull(),
  revision: integer("revision").notNull(), chunkNo: integer("chunk_no").notNull(), content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(), embeddingModel: text("embedding_model").notNull(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(), householdId: uuid("household_id").notNull(), memberId: uuid("member_id").notNull(), userId: uuid("user_id").notNull(),
  conversationKey: text("conversation_key").notNull(), title: text("title").notNull(), turns: jsonb("turns").$type<import("../domain/chats.js").SavedTurn[]>().notNull(), createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(),
});

// Authentication tables are reachable through restricted security-definer functions.
export const authSessions = pgTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: uuid("user_id").notNull(), csrfToken: text("csrf_token").notNull(), expiresAt: ts("expires_at").notNull(), createdAt: ts("created_at").notNull(),
});
export const oauthTransactions = pgTable("oauth_transactions", {
  tokenHash: text("token_hash").primaryKey(), state: text("state").notNull(), nonce: text("nonce").notNull(), verifier: text("verifier").notNull(), expiresAt: ts("expires_at").notNull(),
});
