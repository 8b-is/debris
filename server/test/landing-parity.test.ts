/**
 * Landing parity.
 *
 * The landing renders prices from its own copy of the tier table so it can be a
 * static file. That duplication is only safe because this test compares the two
 * and fails when they drift (docs/adr/0002 and 0004).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PLANS } from "../src/plans.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..", "landing", "app.js");

/** Pull the TIERS literal out of app.js and evaluate it. */
function landingTiers(): { id: string; name: string; cents: number; seats: number }[] {
  const src = readFileSync(APP, "utf8");
  const start = src.indexOf("const TIERS");
  assert.ok(start >= 0, "app.js must declare TIERS");
  const open = src.indexOf("[", start);
  const close = src.indexOf("]);", open);
  assert.ok(open >= 0 && close > open, "TIERS literal must be well formed");
  const literal = src.slice(open, close + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal})`)() as { id: string; name: string; cents: number; seats: number }[];
}

test("every landing tier exists in the server table with the same cents and seats", () => {
  const tiers = landingTiers();
  assert.equal(tiers.length, 3, "the landing shows three cards; patron is a footnote row");

  for (const tier of tiers) {
    const plan = PLANS[tier.id as keyof typeof PLANS];
    assert.ok(plan, `landing tier ${tier.id} has no server counterpart`);
    assert.equal(tier.cents, plan.cents, `${tier.id} price drifted between landing and server`);
    assert.equal(tier.seats, plan.seats, `${tier.id} seats drifted between landing and server`);
  }
});

test("landing tier features match the server table exactly", () => {
  const tiers = landingTiers() as { id: string; features?: string[] }[];
  for (const tier of tiers) {
    const plan = PLANS[tier.id as keyof typeof PLANS];
    assert.ok(plan, `landing tier ${tier.id} has no server counterpart`);
    assert.deepEqual(
      [...(tier.features ?? [])],
      [...plan.features],
      `${tier.id} features drifted between landing and server`,
    );
  }
});

test("the patron footnote price matches the server table", () => {
  const html = readFileSync(join(HERE, "..", "..", "landing", "index.html"), "utf8");
  const cents = PLANS.patron.cents;
  const whole = Math.trunc(cents / 100);
  const rest = String(Math.abs(cents % 100)).padStart(2, "0");
  assert.ok(
    html.includes(`€${whole}.${rest}`),
    `the patron row must advertise €${whole}.${rest} to match plans.ts`,
  );
});

test("no landing price is a float literal", () => {
  const src = readFileSync(APP, "utf8");
  assert.doesNotMatch(src, /cents:\s*\d+\.\d+/, "a price must never be written as a float");
});