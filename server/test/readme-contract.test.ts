/**
 * README is the contract.
 *
 * `AGENTS.md` says so, so a drift between the documented error set and the
 * strings the code can actually return is a defect, not a documentation nit.
 * This test reads both and fails when they disagree.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const README = join(ROOT, "README.md");

/** Every error string the README documents, in its table. */
function documentedErrors(): string[] {
  const md = readFileSync(README, "utf8");
  const start = md.indexOf("Every error is `{error:");
  assert.ok(start >= 0, "README must document the error set");
  const table = md.slice(start, md.indexOf("Errors are the server's own strings"));
  const found = new Set<string>();
  // Rows look like: | 400 | `unknown_plan` | ... |
  for (const m of table.matchAll(/^\|\s*\d{3}\s*\|\s*`([a-z_]+)`\s*\|/gm)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

/** Error strings the source can return, gathered from the route and helper modules. */
async function sourceErrors(): Promise<string[]> {
  const modules = ["server.ts", "webhook.ts", "stripe.ts", "store.ts"];
  const found = new Set<string>();
  for (const name of modules) {
    const src = readFileSync(join(HERE, "..", "src", name), "utf8");
    for (const m of src.matchAll(/error:\s*"([a-z_]+)"/g)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of src.matchAll(/error\s*=\s*"([a-z_]+)"/g)) {
      if (m[1]) found.add(m[1]);
    }
    // CheckoutError is thrown with its code as the first argument.
    for (const m of src.matchAll(/new CheckoutError\(\s*"([a-z_]+)"/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found].sort();
}

test("every error the code returns is documented in the README", async () => {
  const documented = documentedErrors();
  const actual = await sourceErrors();

  const undocumented = actual.filter((e) => !documented.includes(e));
  assert.deepEqual(
    undocumented,
    [],
    `the code returns errors the README does not list: ${undocumented.join(", ")}`,
  );
});

test("the README documents no error the code cannot produce", async () => {
  const documented = documentedErrors();
  const actual = await sourceErrors();

  const phantom = documented.filter((e) => !actual.includes(e));
  assert.deepEqual(
    phantom,
    [],
    `the README promises errors the code never returns: ${phantom.join(", ")}`,
  );
});

test("the documented set is exactly the strings a client may branch on", async () => {
  const documented = documentedErrors();
  // Pinned rather than merely cross-checked: an accidental deletion from both
  // sides would satisfy the two tests above.
  assert.deepEqual(documented, [
    "already_subscribed",
    "bad_json",
    "bad_payload",
    "bad_signature",
    "email_required",
    "internal",
    "not_found",
    "payload_too_large",
    "payment_required",
    "read_failed",
    "read_timeout",
    "unknown_entitlement",
    "unknown_plan",
    "upstream_failed",
  ]);
});
test("the error table is sorted by status, so a reader can scan it", () => {
  const md = readFileSync(README, "utf8");
  const start = md.indexOf("Every error is `{error:");
  const table = md.slice(start, md.indexOf("Errors are the server's own strings"));
  const statuses: number[] = [];
  for (const m of table.matchAll(/^\|\s*(\d{3})\s*\|\s*`([a-z_]+)`/gm)) {
    statuses.push(Number(m[1]));
  }
  const sorted = [...statuses].sort((a, b) => a - b);
  assert.deepEqual(
    statuses,
    sorted,
    `rows must ascend by status code, got ${statuses.join(",")}`,
  );
});

test("the error table lists each error once", () => {
  const documented = documentedErrors();
  const dupes = documented.filter((e, i) => documented.indexOf(e) !== i);
  assert.deepEqual(dupes, [], `duplicated error rows: ${dupes.join(", ")}`);
});
