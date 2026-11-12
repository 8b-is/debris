import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { DeviceRegistry } from "../src/devices.ts";
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
    devices: new DeviceRegistry(),
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
    devices: new DeviceRegistry(),
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
    devices: new DeviceRegistry(),
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
    devices: new DeviceRegistry(),
  });
  try {
    // First request registers the device and receives its secret once.
    const first = await fetch(`${paid.url}/api/bundle?email=paid@test&device=Living+room`);
    assert.equal(first.status, 200);
    const issued = await first.json();
    assert.equal(issued.tier, "household");
    assert.equal(issued.addons.length, 6);
    assert.ok(Array.isArray(issued.forced_filters));
    assert.ok(issued.expires_at);
    assert.ok(issued.device_id, "first contact must return a device id");
    assert.ok(issued.device_secret, "first contact must return the secret");

    // The addon payload itself still carries no credential.
    const bundleWithoutDevice = { ...issued };
    delete bundleWithoutDevice.device_id;
    delete bundleWithoutDevice.device_secret;
    const raw = JSON.stringify(bundleWithoutDevice).toLowerCase();
    for (const forbidden of ["token", "credential", "api_key", "password"]) {
      assert.equal(raw.includes(forbidden), false, `bundle must not carry ${forbidden}`);
    }

    // Second request with the secret does not consume another seat.
    const second = await fetch(`${paid.url}/api/bundle?email=paid@test`, {
      headers: { authorization: `Bearer ${issued.device_secret}` },
    });
    assert.equal(second.status, 200);
    const again = await second.json();
    assert.equal(again.device_id, issued.device_id);
    assert.equal(again.device_secret, undefined, "the secret is shown once");
  } finally {
    await paid.close();
  }
});

test("a stalled request body is refused with read_timeout, not left hanging", async () => {
  const outcome = await new Promise<{ status: number; body: any; how: string }>((resolve) => {
    const req = http.request(
      `${instance.url}/api/checkout`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(body || "null"), how: "response" }),
        );
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: e.message, how: "socket-error" }));
    req.write('{"plan":"fam'); // never ended
  });

  assert.equal(outcome.how, "response", "the server must answer rather than hang the socket");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.body.error, "read_timeout");
});

test("a hung payment upstream does not hang the request forever", async () => {
  const { createCheckoutSession } = await import("../src/stripe.ts");
  const started = Date.now();
  await assert.rejects(() =>
    createCheckoutSession(
      {
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        secret: "sk_test_hang",
      },
      { plan: "family", email: "hang@test" },
    ),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `a hung upstream must be abandoned, took ${elapsed}ms`);
});

test("an already-active customer cannot start a second checkout", async () => {
  const store = new EntitlementStore({ file: join(dir, "double.json") });
  await store.put({
    email: "active@buy.test",
    plan: "household",
    seats: 12,
    status: "active",
    valid_until: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const double = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
    devices: new DeviceRegistry(),
  });
  try {
    const res = await fetch(`${double.url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "household", email: "active@buy.test" }),
    });
    assert.equal(res.status, 409, "a second subscription must not be creatable");
    assert.deepEqual(await res.json(), { error: "already_subscribed" });
  } finally {
    await double.close();
  }
});

test("a past_due customer can still check out again", async () => {
  const store = new EntitlementStore({ file: join(dir, "pastdue.json") });
  await store.put({
    email: "late@buy.test",
    plan: "family",
    seats: 5,
    status: "past_due",
    valid_until: null,
  });
  const retry = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
    devices: new DeviceRegistry(),
  });
  try {
    const res = await fetch(`${retry.url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "family", email: "late@buy.test" }),
    });
    assert.equal(res.status, 200, "a lapsed customer must be able to pay again");
  } finally {
    await retry.close();
  }
});

test("an expired customer cannot pull a bundle, and can still pay again", async () => {
  const store = new EntitlementStore({ file: join(dir, "expired.json") });
  await store.put({
    email: "lapsed@buy.test",
    plan: "household",
    seats: 12,
    status: "active",
    valid_until: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const inst = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk_test_route" },
    devices: new DeviceRegistry(),
  });
  try {
    const bundle = await fetch(`${inst.url}/api/bundle?email=lapsed@buy.test`);
    assert.equal(bundle.status, 402, "an expired record must not be served");
    assert.deepEqual(await bundle.json(), { error: "payment_required" });

    const checkout = await fetch(`${inst.url}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "household", email: "lapsed@buy.test" }),
    });
    assert.equal(checkout.status, 200, "an expired customer must be able to renew");
  } finally {
    await inst.close();
  }
});

test("a device secret from one email does not work for another", async () => {
  const store = new EntitlementStore({ file: join(dir, "cross.json") });
  for (const [email, plan] of [["a@x.test", "household"], ["b@x.test", "family"]] as const) {
    await store.put({ email, plan, seats: 12, status: "active", valid_until: null });
  }
  const inst = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: new DeviceRegistry(),
  });
  try {
    const first = await fetch(`${inst.url}/api/bundle?email=a@x.test&device=TV`);
    const { device_secret } = await first.json();

    const cross = await fetch(`${inst.url}/api/bundle?email=b@x.test`, {
      headers: { authorization: `Bearer ${device_secret}` },
    });
    assert.equal(cross.status, 401, "one device's secret must not serve another email");
    assert.deepEqual(await cross.json(), { error: "invalid_device_secret" });
  } finally {
    await inst.close();
  }
});

test("a full house refuses a new device with seat_limit_reached", async () => {
  const store = new EntitlementStore({ file: join(dir, "seats.json") });
  await store.put({ email: "cap@test", plan: "free", seats: 1, status: "free", valid_until: null });
  // Give them one seat by making the plan household with 1 seat via the store.
  await store.put({ email: "cap@test", plan: "family", seats: 1, status: "active", valid_until: null });
  const inst = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: new DeviceRegistry(),
  });
  try {
    const first = await fetch(`${inst.url}/api/bundle?email=cap@test&device=TV`);
    assert.equal(first.status, 200);

    const second = await fetch(`${inst.url}/api/bundle?email=cap@test&device=Phone`);
    assert.equal(second.status, 403, "the second device must not fit");
    assert.deepEqual(await second.json(), { error: "seat_limit_reached" });
  } finally {
    await inst.close();
  }
});

test("a device can free its own seat, and only its own", async () => {
  const store = new EntitlementStore({ file: join(dir, "revoke.json") });
  await store.put({ email: "cap@test", plan: "household", seats: 2, status: "active", valid_until: null });
  const reg = new DeviceRegistry();
  const inst = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: reg,
  });
  try {
    const first = await fetch(`${inst.url}/api/bundle?email=cap@test&device=TV`);
    const { device_id, device_secret } = await first.json();
    const second = await fetch(`${inst.url}/api/bundle?email=cap@test&device=Phone`);
    assert.equal(second.status, 200);
    assert.equal(second.status, 200, "two seats fit");

    // A third does not.
    const third = await fetch(`${inst.url}/api/bundle?email=cap@test&device=Tablet`);
    assert.equal(third.status, 403);

    // Revoke the first: a wrong secret is refused, the right one frees the seat.
    const wrong = await fetch(`${inst.url}/api/devices?id=${device_id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer not-the-secret" },
    });
    assert.equal(wrong.status, 404);

    const ok = await fetch(`${inst.url}/api/devices?id=${device_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${device_secret}` },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { revoked: true, id: device_id });

    // The seat is free now.
    const fourth = await fetch(`${inst.url}/api/bundle?email=cap@test&device=Tablet`);
    assert.equal(fourth.status, 200, "the freed seat must be usable");
  } finally {
    await inst.close();
  }
});

test("a revoke without an id or secret is refused", async () => {
  const inst = await startServer(0, {
    store: new EntitlementStore({ file: join(dir, "rev1.json") }),
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: new DeviceRegistry(),
  });
  try {
    const res = await fetch(`${inst.url}/api/devices`, { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "device_required" });
  } finally {
    await inst.close();
  }
});

test("two simultaneous checkouts create only one session", async () => {
  const inst = await startServer(0, {
    store: new EntitlementStore({ file: join(dir, "race.json") }),
    stripe: {
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { ok: true, status: 200, json: async () => ({ id: "cs_race", url: "https://x.test/c" }) };
      },
      secret: "sk",
    },
    devices: new DeviceRegistry(),
  });
  try {
    const body = JSON.stringify({ plan: "family", email: "race@test" });
    const [a, b] = await Promise.all([
      fetch(`${inst.url}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body }),
      fetch(`${inst.url}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], "one session, one refusal");
  } finally {
    await inst.close();
  }
});

test("an operator can list which devices hold seats", async () => {
  const store = new EntitlementStore({ file: join(dir, "list.json") });
  await store.put({ email: "cap@test", plan: "household", seats: 12, status: "active", valid_until: null });
  const inst = await startServer(0, {
    store,
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: new DeviceRegistry(),
  });
  try {
    await fetch(`${inst.url}/api/bundle?email=cap@test&device=Living+room`);
    await fetch(`${inst.url}/api/bundle?email=cap@test&device=Kitchen`);

    const res = await fetch(`${inst.url}/api/devices?email=cap@test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.used, 2);
    assert.equal(body.seats, 12);
    assert.deepEqual(body.devices.map((d: any) => d.name).sort(), ["Kitchen", "Living room"]);
    assert.ok(body.devices.every((d: any) => !("secret_hash" in d)), "the list must not carry hashes");
  } finally {
    await inst.close();
  }
});

test("a device list for an unknown email is 404, and without an email is 400", async () => {
  const inst = await startServer(0, {
    store: new EntitlementStore({ file: join(dir, "list2.json") }),
    stripe: { fetch: fakeStripeFetch, secret: "sk" },
    devices: new DeviceRegistry(),
  });
  try {
    const none = await fetch(`${inst.url}/api/devices`);
    assert.equal(none.status, 400);
    assert.deepEqual(await none.json(), { error: "email_required" });

    const unknown = await fetch(`${inst.url}/api/devices?email=nobody@x.test`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "unknown_entitlement" });
  } finally {
    await inst.close();
  }
});
