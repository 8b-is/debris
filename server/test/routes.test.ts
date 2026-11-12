import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { EntitlementStore } from "../src/store.ts";
import { startServer, type DebrisServer } from "../src/server.ts";

const SECRET = "whsec_route_test_secret";

let dir: string;
let instance: DebrisServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "debris-route-"));
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const store = new EntitlementStore({ file: join(dir, "entitlements.json") });
  instance = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
  });
});

afterEach(async () => {
  await instance.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A transport that records what it was asked to do. */
async function fakeStripeFetch(
  _url: string,
  init: { body: string },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "cs_test_123",
      url: `https://checkout.stripe.test/c/cs_test_123?plan=${new URLSearchParams(init.body).get("client_reference_id")}`,
    }),
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const res = await fetch(`${instance.url}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, body: parsed, headers: out };
}

test("healthz reports the shape the landing and the fleet probe expect", async () => {
  const res = await call("GET", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.version, "string");
  assert.equal(typeof res.body.uptime_s, "number");
});

test("healthz is served as json and is not cached", async () => {
  const res = await call("GET", "/healthz");
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("plans lists the four tiers with integer cents", async () => {
  const res = await call("GET", "/api/plans");
  assert.equal(res.status, 200);
  assert.equal(res.body.plans.length, 4);
  for (const plan of res.body.plans) {
    assert.equal(Number.isInteger(plan.cents), true);
    assert.equal(typeof plan.name, "string");
    assert.ok(Array.isArray(plan.features));
  }
});

test("checkout with an unknown plan is 400 unknown_plan", async () => {
  const res = await call("POST", "/api/checkout", { plan: "enterprise", email: "a@b.c" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unknown_plan");
});

test("checkout without an email is 400 email_required", async () => {
  const res = await call("POST", "/api/checkout", { plan: "family", email: "" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "email_required");
});

test("checkout with no body at all is 400 unknown_plan", async () => {
  // Plan is validated before email, so an absent plan reports first. Both are
  // client errors; the order is deliberate and pinned here.
  const res = await call("POST", "/api/checkout", {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unknown_plan");
});

test("checkout returns a url and a session id", async () => {
  const res = await call("POST", "/api/checkout", { plan: "household", email: "Dra@Route.test" });
  assert.equal(res.status, 200);
  assert.equal(res.body.session_id, "cs_test_123");
  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.test\//);
});

test("checkout is served with no-store so a price never goes stale in a cache", async () => {
  const res = await call("POST", "/api/checkout", { plan: "family", email: "cache@test" });
  assert.equal(res.headers["cache-control"], "no-store");
});

test("a webhook with no secret configured is rejected, not accepted", async () => {
  const body = JSON.stringify({
    type: "checkout.session.completed",
    created: 1_760_000_000,
    data: { object: { metadata: { plan: "family", email: "hijack@test" } } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", SECRET).update(`${ts}.${body}`, "utf8").digest("hex");
  const res = await call("POST", "/api/webhook", body, {
    "stripe-signature": `t=${ts},v1=${digest}`,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "bad_signature");
});

test("a webhook with a bad signature is 400 bad_signature", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const instance2 = await startServer(0, {
    store: new EntitlementStore({ file: join(dir, "sig.json") }),
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
  });
  try {
    const res = await fetch(`${instance2.url}/api/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: "{}",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad_signature" });
  } finally {
    await instance2.close();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("a correctly signed checkout grant persists and is readable", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const store = new EntitlementStore({ file: join(dir, "grant.json") });
  const signed = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
  });
  try {
    const created = 1_760_000_000;
    const body = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      created,
      data: { object: { metadata: { plan: "household", email: "Grantee@Test" } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", SECRET).update(`${ts}.${body}`, "utf8").digest("hex");
    const res = await fetch(`${signed.url}/api/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${digest}` },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });

    const ent = await fetch(`${signed.url}/api/entitlement?email=grantee@test`);
    assert.equal(ent.status, 200);
    const record = await ent.json();
    assert.equal(record.plan, "household");
    assert.equal(record.status, "active");
    assert.equal(record.seats, 12);
  } finally {
    await signed.close();
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("entitlement for an unknown email is 404 unknown_entitlement", async () => {
  const res = await call("GET", "/api/entitlement?email=nobody@nowhere.test");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "unknown_entitlement");
});

test("an unknown route is 404 not_found", async () => {
  const res = await call("GET", "/api/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_found");
});

test("a malformed json body is 400 bad_json", async () => {
  const res = await call("POST", "/api/checkout", "{ not json");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "bad_json");
});

test("bundle for an unknown email is 404 unknown_entitlement", async () => {
  const res = await call("GET", "/api/bundle?email=nobody@bundle.test");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "unknown_entitlement");
});

test("bundle for an unpaid record is 402 payment_required", async () => {
  // Seed a past_due record through the store, then ask for its bundle.
  const store = new EntitlementStore({ file: join(dir, "unpaid.json") });
  await store.put({
    email: "unpaid@test",
    plan: "family",
    seats: 5,
    status: "past_due",
    valid_until: null,
  });
  const unpaid = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
  });
  try {
    const res = await fetch(`${unpaid.url}/api/bundle?email=unpaid@test`);
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { error: "payment_required" });
  } finally {
    await unpaid.close();
  }
});

test("a paid record gets a bundle with addons and no credential", async () => {
  const store = new EntitlementStore({ file: join(dir, "paid.json") });
  await store.put({
    email: "paid@test",
    plan: "household",
    seats: 12,
    status: "active",
    valid_until: null,
  });
  const paid = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
  });
  try {
    const res = await fetch(`${paid.url}/api/bundle?email=paid@test`);
    assert.equal(res.status, 200);
    const bundle = await res.json();
    assert.equal(bundle.tier, "household");
    assert.equal(bundle.addons.length, 6);
    assert.ok(Array.isArray(bundle.forced_filters));
    assert.ok(bundle.expires_at);
    const raw = JSON.stringify(bundle).toLowerCase();
    for (const forbidden of ["token", "credential", "secret", "api_key"]) {
      assert.equal(raw.includes(forbidden), false, `bundle must not carry ${forbidden}`);
    }
  } finally {
    await paid.close();
  }
});
