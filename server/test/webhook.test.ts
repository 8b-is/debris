import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { EntitlementStore } from "../src/store.ts";
import { TOLERANCE_SECONDS, dispatchEvent, handleWebhook, parseSignatureHeader, verifySignature } from "../src/webhook.ts";

const SECRET = "whsec_test_secret_do_not_use_in_production";

let dir: string;
let store: EntitlementStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "debris-hook-"));
  store = new EntitlementStore({ file: join(dir, "entitlements.json") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sign(body: string, secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function event(type: string, object: Record<string, unknown>, created = 1_760_000_000): string {
  return JSON.stringify({ id: `evt_${type}`, type, created, data: { object } });
}

test("the signature header parses into timestamp and v1 candidates", () => {
  const parsed = parseSignatureHeader("t=123,v1=aa,v1=bb");
  assert.deepEqual(parsed, { timestamp: "123", signatures: ["aa", "bb"] });
});

test("a malformed header parses to null", () => {
  assert.equal(parseSignatureHeader(null), null);
  assert.equal(parseSignatureHeader(""), null);
  assert.equal(parseSignatureHeader("v1=deadbeef"), null);
  assert.equal(parseSignatureHeader("t=123"), null);
  assert.equal(parseSignatureHeader("garbage"), null);
});

test("an unset secret rejects everything, even a correct signature", () => {
  const body = event("checkout.session.completed", { metadata: { plan: "family", email: "a@b.c" } });
  const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
  assert.equal(verifySignature(body, header, undefined), false);
  assert.equal(verifySignature(body, header, ""), false);
});

test("a wrong secret rejects", () => {
  const body = "whatever";
  const header = sign(body, "the_wrong_secret", Math.floor(Date.now() / 1000));
  assert.equal(verifySignature(body, header, SECRET), false);
});

test("a tampered body rejects", () => {
  const ts = Math.floor(Date.now() / 1000);
  const header = sign("original body", SECRET, ts);
  assert.equal(verifySignature("tampered body", header, SECRET), false);
});

test("a stale timestamp rejects", () => {
  const body = "stale";
  const ts = Math.floor(Date.now() / 1000) - (TOLERANCE_SECONDS + 1);
  const header = sign(body, SECRET, ts);
  assert.equal(verifySignature(body, header, SECRET, ts), true, "the timestamp is valid for its own clock");
  assert.equal(verifySignature(body, header, SECRET), false, "but not for the current one");
});

test("a truncated candidate does not panic and does not verify", () => {
  const body = "short";
  const ts = Math.floor(Date.now() / 1000);
  const header = `t=${ts},v1=abcd`;
  assert.equal(verifySignature(body, header, SECRET), false);
});

test("a missing webhook secret makes the handler fail closed", async () => {
  const body = event("checkout.session.completed", { metadata: { plan: "family", email: "a@b.c" } });
  const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
  const result = await handleWebhook(store, body, header, undefined);
  assert.deepEqual(result, { ok: false, error: "bad_signature" });
  assert.equal(store.get("a@b.c"), null, "nothing may be granted");
});

test("a bad signature grants nothing", async () => {
  const body = event("checkout.session.completed", { metadata: { plan: "household", email: "nobody@grant.test" } });
  const result = await handleWebhook(store, body, "t=1,v1=deadbeef", SECRET);
  assert.deepEqual(result, { ok: false, error: "bad_signature" });
  assert.equal(store.get("nobody@grant.test"), null);
});

test("checkout.session.completed grants the plan and persists it", async () => {
  const created = 1_760_000_000;
  const body = event(
    "checkout.session.completed",
    { metadata: { plan: "family", email: "Dra@Grant.test" }, customer_email: "Dra@Grant.test" },
    created,
  );
  const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
  const result = await handleWebhook(store, body, header, SECRET);
  assert.equal(result.ok, true);

  const record = store.get("dra@grant.test");
  assert.ok(record, "the grant must land");
  assert.equal(record.plan, "family");
  assert.equal(record.seats, 5);
  assert.equal(record.status, "active");
  assert.ok(record.valid_until, "a paid tier must carry an expiry");
  assert.equal(record.valid_until!.slice(0, 7), "2025-11", "one month from created");

  // A brand-new store proves the file landed, not just memory.
  const reopened = new EntitlementStore({ file: join(dir, "entitlements.json") });
  assert.equal(reopened.get("dra@grant.test")?.plan, "family");
});

test("customer.subscription.deleted downgrades to free", async () => {
  await dispatchEvent(store, {
    type: "checkout.session.completed",
    created: 1_760_000_000,
    data: { object: { metadata: { plan: "household", email: "down@grade.test" } } },
  });
  const result = await dispatchEvent(store, {
    type: "customer.subscription.deleted",
    created: 1_760_100_000,
    data: { object: { metadata: { email: "down@grade.test" } } },
  });
  assert.equal(result.ok, true);
  const record = store.get("down@grade.test");
  assert.equal(record?.plan, "free");
  assert.equal(record?.status, "free");
  assert.equal(record?.valid_until, null);
});

test("invoice.payment_failed marks the record past_due without dropping the plan", async () => {
  await dispatchEvent(store, {
    type: "checkout.session.completed",
    created: 1_760_000_000,
    data: { object: { metadata: { plan: "family", email: "late@pay.test" } } },
  });
  await dispatchEvent(store, {
    type: "invoice.payment_failed",
    created: 1_760_500_000,
    data: { object: { metadata: { email: "late@pay.test" } } },
  });
  const record = store.get("late@pay.test");
  assert.equal(record?.status, "past_due");
  assert.equal(record?.plan, "family", "a failed invoice must not silently downgrade");
});

test("an unknown event type is acknowledged as ignored", async () => {
  const result = await dispatchEvent(store, {
    type: "customer.created",
    data: { object: {} },
  });
  assert.equal(result.ok, true);
  assert.equal((result as { ignored?: boolean }).ignored, true);
});

test("an event without an email is acknowledged, not granted", async () => {
  const result = await dispatchEvent(store, {
    type: "checkout.session.completed",
    data: { object: { metadata: { plan: "family" } } },
  });
  assert.equal(result.ok, true);
  assert.equal(store.all().length, 0);
});

test("a signed but unparseable body reports bad_payload", async () => {
  const body = "{ not json";
  const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
  const result = await handleWebhook(store, body, header, SECRET);
  assert.deepEqual(result, { ok: false, error: "bad_payload" });
});