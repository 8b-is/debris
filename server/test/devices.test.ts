import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceRegistry, hashSecret, secretMatches } from "../src/devices.ts";

test("a secret is stored only as a hash", () => {
  const reg = new DeviceRegistry();
  const issued = reg.issue("dra@test", "Living room TV");
  assert.ok(issued);
  assert.ok(issued.secret.length > 20, "the secret must have real entropy");

  const serialised = JSON.stringify(reg.all());
  assert.equal(
    serialised.includes(issued.secret),
    false,
    "the raw secret must never appear in the registry",
  );
  assert.equal(issued.device.secret_hash, hashSecret(issued.secret));
});

test("hashSecret is deterministic and not reversible", () => {
  const a = hashSecret("hunter2");
  assert.equal(a, hashSecret("hunter2"));
  assert.notEqual(a, hashSecret("hunter3"));
  assert.equal(a.length, 64);
  assert.doesNotMatch(a, /hunter2/);
});

test("a valid secret authenticates its own email only", () => {
  const reg = new DeviceRegistry();
  const { secret } = reg.issue("dra@test", "TV")!;

  assert.ok(reg.authenticate("dra@test", secret), "the right pair must resolve");
  assert.equal(reg.authenticate("someone@else.test", secret), null, "another email must not inherit the device");
});

test("a wrong secret does not authenticate", () => {
  const reg = new DeviceRegistry();
  reg.issue("dra@test", "TV");
  assert.equal(reg.authenticate("dra@test", "not-the-secret"), null);
  assert.equal(reg.authenticate("dra@test", ""), null);
});

test("secretMatches is constant-time and rejects a malformed hash", () => {
  const hash = hashSecret("abc");
  assert.equal(secretMatches("abc", hash), true);
  assert.equal(secretMatches("abd", hash), false);
  assert.equal(secretMatches("abc", "not-hex-at-all"), false);
  assert.equal(secretMatches("abc", ""), false);
});

test("a reconnecting device does not consume a second seat", () => {
  const reg = new DeviceRegistry();
  const first = reg.issue("dra@test", "TV")!;
  assert.equal(reg.count("dra@test"), 1);

  const again = reg.issue("dra@test", "TV", first.secret);
  assert.ok(again);
  assert.equal(reg.count("dra@test"), 1, "the same device must not cost a second seat");
  assert.equal(again.device.id, first.device.id);
});

test("a genuinely new device does consume a seat", () => {
  const reg = new DeviceRegistry();
  reg.issue("dra@test", "TV");
  reg.issue("dra@test", "Phone");
  assert.equal(reg.count("dra@test"), 2);
});

test("revoke removes the device and frees the seat", () => {
  const reg = new DeviceRegistry();
  const { device, secret } = reg.issue("dra@test", "TV")!;
  assert.equal(reg.revoke(device.id), true);
  assert.equal(reg.count("dra@test"), 0);
  assert.equal(reg.authenticate("dra@test", secret), null, "a revoked secret must stop working");
  assert.equal(reg.revoke("dev_nope"), false);
});

test("device ids are unique", () => {
  const reg = new DeviceRegistry();
  const ids = new Set(Array.from({ length: 50 }, () => reg.issue("dra@test", "d")!.device.id));
  assert.equal(ids.size, 50);
});

test("a name over 64 characters is truncated rather than rejected", () => {
  const reg = new DeviceRegistry();
  const { device } = reg.issue("dra@test", "x".repeat(200))!;
  assert.equal(device.name.length, 64);
});

test("a missing email issues nothing", () => {
  const reg = new DeviceRegistry();
  assert.equal(reg.issue("", "TV"), null);
  assert.equal(reg.issue("   ", "TV"), null);
});

test("an unknown email with a valid secret from elsewhere still fails", () => {
  const reg = new DeviceRegistry();
  const { secret } = reg.issue("a@test", "TV")!;
  assert.equal(reg.authenticate("b@test", secret), null);
});
test("the registry survives a restart, so a reboot does not burn a seat", async () => {
  // A registry held only in memory forgets every device on restart, and a device
  // that is no longer known asks for a new seat.
  const { mkdtempSync, rmSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "persist-"));
  const file = join(dir, "devices.json");

  const { loadDevices } = await import("../src/devices.ts");
  const first = loadDevices(file);
  const issued = first.issue("dra@test", "TV")!;
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(existsSync(file), "the registry must be written on issue");
  const onDisk = readFileSync(file, "utf8");
  assert.equal(onDisk.includes(issued.secret), false, "the secret must not be stored");

  const restarted = loadDevices(file);
  assert.equal(restarted.count("dra@test"), 1, "the device must survive a restart");
  assert.ok(restarted.authenticate("dra@test", issued.secret), "the secret must still work");
  rmSync(dir, { recursive: true, force: true });
});

test("the registry never writes to the entitlement ledger's file", async () => {
  const { mkdtempSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "noshare-"));

  // Two stores, each with its own file, must not collide.
  const { loadDevices } = await import("../src/devices.ts");
  const devices = loadDevices(join(dir, "devices.json"));
  devices.issue("dra@test", "TV");
  await new Promise((r) => setTimeout(r, 200));

  const files = readdirSync(dir);
  assert.deepEqual(files, ["devices.json"], "only the device file may be written");
  rmSync(dir, { recursive: true, force: true });
});

test("a JsonStore refuses to be constructed without its own file", async () => {
  const { JsonStore } = await import("../src/store.ts");
  assert.throws(
    () => new JsonStore<unknown[]>([], (v) => JSON.stringify(v), () => [], {}),
    /must be given its own file/,
  );
});

test("a device not seen for a long time is swept, and a recent one is not", () => {
  const reg = new DeviceRegistry();
  const stale = reg.issue("dra@test", "Old phone")!;
  const fresh = reg.issue("dra@test", "This TV")!;

  // Backdate one by rewriting the record through the registry's own state.
  const all = reg.all();
  const old = all.find((d) => d.id === stale.device.id)!;
  old.last_seen_at = new Date(Date.now() - 200 * 86_400_000).toISOString();

  const removed = reg.sweepStale(90);
  assert.deepEqual(removed, [stale.device.id]);
  assert.equal(reg.count("dra@test"), 1);
  assert.equal(reg.get(fresh.device.id)?.id, fresh.device.id, "the active device stays");
});

test("a device whose last_seen is unparseable is swept, not kept forever", () => {
  const reg = new DeviceRegistry();
  reg.issue("dra@test", "Broken");
  for (const d of reg.all()) d.last_seen_at = "never";
  assert.equal(reg.sweepStale(90).length, 1);
  assert.equal(reg.count("dra@test"), 0);
});

test("a sweep with nothing stale changes nothing", () => {
  const reg = new DeviceRegistry();
  reg.issue("dra@test", "TV");
  assert.deepEqual(reg.sweepStale(90), []);
  assert.equal(reg.count("dra@test"), 1);
});
