import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVital, formatDelta, formatVital } from "../src/domain/vitals.js";
import { localToUtc, todayIn } from "../src/lib/time.js";

test("weight in lbs converts to kg and keeps what was entered", () => {
  const r = normalizeVital({ type: "weight", value: 71.4, value2: null, unit: "lbs" }, "us");
  assert.deepEqual(r.issues, []);
  assert.equal(r.rows[0]!.unit, "kg");
  assert.equal(r.rows[0]!.value, 32.386);
  assert.equal(r.rows[0]!.originalValue, 71.4);
  assert.equal(r.rows[0]!.originalUnit, "lb");
  assert.match(r.display, /71\.4 lb \(32\.39 kg\)/);
});

test("temperature without a unit is inferred only when the number is unambiguous", () => {
  const f = normalizeVital({ type: "temperature", value: 101.2, value2: null, unit: null }, "metric");
  assert.equal(f.rows[0]!.unit, "Cel");
  assert.equal(f.rows[0]!.value, 38.44);
  assert.equal(f.assumptions.length, 1);
  const c = normalizeVital({ type: "temperature", value: 38.5, value2: null, unit: null }, "us");
  assert.equal(c.rows[0]!.value, 38.5);
});

test("missing weight unit uses household default and says so", () => {
  const r = normalizeVital({ type: "weight", value: 70, value2: null, unit: null }, "us");
  assert.match(r.assumptions[0]!, /household default/);
  assert.equal(r.rows[0]!.originalUnit, "lb");
});

test("implausible values and unknown units block the entry", () => {
  assert.equal(normalizeVital({ type: "weight", value: 700, value2: null, unit: "kg" }, "us").issues.length, 1);
  assert.equal(normalizeVital({ type: "weight", value: 30, value2: null, unit: "stone-ish" }, "us").issues.length, 1);
});

test("blood pressure needs both numbers and becomes two LOINC rows", () => {
  assert.equal(normalizeVital({ type: "blood_pressure", value: 110, value2: null, unit: null }, "us").issues.length, 1);
  const r = normalizeVital({ type: "blood_pressure", value: 110, value2: 70, unit: null }, "us");
  assert.deepEqual(r.rows.map((x) => x.loinc), ["8480-6", "8462-4"]);
});

test("height in feet and inches", () => {
  const r = normalizeVital({ type: "height", value: 4, value2: 2, unit: "ft_in" }, "us");
  assert.equal(r.rows[0]!.value, 127);
  assert.equal(r.rows[0]!.originalValue, 50);
});

test("temperature deltas use scale only", () => {
  assert.equal(formatDelta("temperature", 1, "us"), "+1.8 °F");
  assert.equal(formatDelta("weight", -0.45359237, "us"), "-1 lb");
  assert.equal(formatVital("temperature", 37, "us"), "98.6 °F (37 °C)");
});

test("household-local times convert to UTC across DST", () => {
  assert.equal(localToUtc("2026-07-01T08:00", "America/New_York")!.toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(localToUtc("2026-12-01T08:00", "America/New_York")!.toISOString(), "2026-12-01T13:00:00.000Z");
  assert.equal(localToUtc("2026-02-30", "America/New_York"), null);
  assert.equal(localToUtc("next tuesday", "America/New_York"), null);
  assert.equal(todayIn("Asia/Kolkata", new Date("2026-10-11T20:00:00Z")), "2026-10-12");
});
