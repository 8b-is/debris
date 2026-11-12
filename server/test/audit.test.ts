import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { audit, formatAudit } from "../src/audit.ts";
import { EntitlementStore } from "../src/store.ts";
import { dispatchEvent } from "../src/webhook.ts";

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "debris-audit-"));
  log = join(dir, "audit.ndjson");
  process.env.DEBRIS_AUDIT_LOG = log;
});

afterEach(() => {
  delete process.env.DEBRIS_AUDIT_LOG;
  rmSync(dir, { recursive: true, force: true });
});

test("formatAudit emits one JSON object per line", () => {
  const line = formatAudit({ event: "entitlement.granted", email: "a@b.c", plan: "family" });
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, "entitlement.granted");
  assert.ok(parsed.ts, "an entry must carry a timestamp");
});

test("a grant is audited with the email and plan, and no request body", async () => {
  const store = new EntitlementStore({ file: join(dir, "e.json") });
  await dispatchEvent(store, {
    id: "evt_audit_1",
    type: "checkout.session.completed",
    created: 1_760_000_000,
    data: { object: { metadata: { plan: "household", email: "audited@test" } } },
  });

  assert.ok(existsSync(log), "the audit log must be written");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.event, "entitlement.granted");
  assert.equal(entry.email, "audited@test");
  assert.equal(entry.plan, "household");
  assert.equal(entry.stripe_event, "evt_audit_1");
});

test("a revocation is audited as such", async () => {
  const store = new EntitlementStore({ file: join(dir, "e2.json") });
  await dispatchEvent(store, {
    type: "customer.subscription.deleted",
    created: 1_760_100_000,
    data: { object: { customer_email: "gone@test" } },
  });
  const entry = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(entry.event, "entitlement.revoked");
  assert.equal(entry.plan, "free");
});

test("audit never throws when the log path is unset", () => {
  delete process.env.DEBRIS_AUDIT_LOG;
  assert.doesNotThrow(() => audit({ event: "entitlement.granted", email: "x@y.z" }));
});

test("audit never throws when the log path is unwritable", () => {
  process.env.DEBRIS_AUDIT_LOG = join(dir, "nope", "deeper", "audit.ndjson");
  // /nope/deeper cannot be created as a file path component here.
  process.env.DEBRIS_AUDIT_LOG = "/dev/null/impossible.ndjson";
  assert.doesNotThrow(() => audit({ event: "entitlement.granted", email: "x@y.z" }));
});

test("an entitlement change with no email is not audited as a grant", async () => {
  const store = new EntitlementStore({ file: join(dir, "e3.json") });
  await dispatchEvent(store, {
    type: "checkout.session.completed",
    created: 1_760_000_000,
    data: { object: { metadata: { plan: "family" } } },
  });
  assert.equal(existsSync(log), false, "nothing was granted, so nothing to audit");
});
