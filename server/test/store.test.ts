import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  EntitlementStore,
  freeEntitlement,
  normalizeEmail,
  oneMonthAfter,
} from "../src/store.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "debris-store-"));
  file = join(dir, "nested", "entitlements.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a missing file reads as an empty ledger", () => {
  const store = new EntitlementStore({ file });
  assert.deepEqual(store.all(), []);
  assert.equal(store.get("a@b.c"), null);
});

test("a write creates the directory and the file", async () => {
  const store = new EntitlementStore({ file });
  await store.put({
    email: "Dra@Example.com",
    plan: "family",
    seats: 5,
    status: "active",
    valid_until: oneMonthAfter(1_760_000_000),
  });

  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(raw["dra@example.com"], "email must be normalised to lower case");
  assert.equal(raw["dra@example.com"].plan, "family");
});

test("a fresh store sees what an earlier store wrote", async () => {
  await new EntitlementStore({ file }).put(freeEntitlement("second@read.test"));
  const reopened = new EntitlementStore({ file });
  assert.equal(reopened.get("second@read.test")?.plan, "free");
});

test("concurrent writes do not interleave", async () => {
  const store = new EntitlementStore({ file });
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      store.put({
        email: `user${i}@race.test`,
        plan: "free",
        seats: 1,
        status: "free",
        valid_until: null,
      }),
    ),
  );
  assert.equal(store.all().length, 24);
  assert.equal(new EntitlementStore({ file }).all().length, 24);
});

test("a failed write does not poison the queue", async () => {
  const store = new EntitlementStore({ file });
  await assert.rejects(() => store.put({ ...freeEntitlement("bad@write.test"), email: "" }));

  await store.put(freeEntitlement("after@failure.test"));
  assert.equal(store.get("after@failure.test")?.plan, "free");
});

test("a corrupt ledger starts empty and leaves the file untouched", () => {
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(file, "{ not json", "utf8");
  const store = new EntitlementStore({ file });
  assert.deepEqual(store.all(), []);
  assert.equal(readFileSync(file, "utf8"), "{ not json", "the corrupt file must be left for inspection");
});

test("emails normalise by trimming and lower-casing", () => {
  assert.equal(normalizeEmail("  Dra@Example.COM "), "dra@example.com");
  assert.equal(normalizeEmail(""), "");
  assert.equal(normalizeEmail(null), "");
  assert.equal(normalizeEmail(42), "");
});

test("oneMonthAfter advances by a calendar month", () => {
  const jan15 = oneMonthAfter(Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000));
  assert.equal(jan15.slice(0, 7), "2026-02");
  const dec15 = oneMonthAfter(Math.floor(Date.UTC(2026, 11, 15, 0, 0, 0) / 1000));
  assert.equal(dec15.slice(0, 7), "2027-01", "a year rollover must land in January");
});

test("oneMonthAfter clamps a month-end instead of rolling into the next month", () => {
  // 31 January + one month: there is no 31 February, so it must clamp to the 28th.
  const jan31 = oneMonthAfter(Math.floor(Date.UTC(2026, 0, 31, 12, 0, 0) / 1000));
  assert.equal(jan31.slice(0, 10), "2026-02-28");

  // 31 August + one month clamps to 30 September.
  const aug31 = oneMonthAfter(Math.floor(Date.UTC(2026, 7, 31, 12, 0, 0) / 1000));
  assert.equal(aug31.slice(0, 10), "2026-09-30");

  // 31 December rolls the year and clamps to 31 January, which exists.
  const dec31 = oneMonthAfter(Math.floor(Date.UTC(2026, 11, 31, 12, 0, 0) / 1000));
  assert.equal(dec31.slice(0, 10), "2027-01-31");
});

test("free entitlements carry the free seat count and no expiry", () => {
  const record = freeEntitlement("Free@Tier.test");
  assert.equal(record.plan, "free");
  assert.equal(record.seats, 1);
  assert.equal(record.status, "free");
  assert.equal(record.valid_until, null);
});