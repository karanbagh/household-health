import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseConnectionString } from "../src/db/connection.js";

test("Neon verifies the server identity even if pulled credentials request weaker TLS", () => {
  const result = new URL(databaseConnectionString("postgresql://hh_app:synthetic@ep-test-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true&channel_binding=require"));
  assert.equal(result.searchParams.get("sslmode"), "verify-full");
  assert.equal(result.searchParams.has("uselibpqcompat"), false);
  assert.equal(result.searchParams.get("channel_binding"), "require");
});

test("local Postgres connections continue to work without TLS", () => {
  const result = new URL(databaseConnectionString("postgresql://hh_app:synthetic@127.0.0.1:5433/household_health"));
  assert.equal(result.searchParams.has("sslmode"), false);
  assert.equal(result.port, "5433");
});
