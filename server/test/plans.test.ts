import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS, PLAN_LIST, getPlan } from "../src/plans.ts";

test("every tier is priced in integer cents", () => {
  for (const plan of PLAN_LIST) {
    assert.equal(Number.isInteger(plan.cents), true, `${plan.id} cents must be an integer`);
    assert.equal(Number.isInteger(plan.seats), true, `${plan.id} seats must be an integer`);
    assert.ok(plan.cents >= 0, `${plan.id} must not be negative`);
    assert.ok(plan.seats >= 1, `${plan.id} must allow at least one seat`);
  }
});

test("the four tiers are exactly free, family, household, patron", () => {
  assert.deepEqual(
    PLAN_LIST.map((p) => p.id),
    ["free", "family", "household", "patron"],
  );
});

test("the advertised prices are the ones the family was quoted", () => {
  assert.equal(PLANS.free.cents, 0);
  assert.equal(PLANS.family.cents, 490);
  assert.equal(PLANS.household.cents, 990);
  assert.equal(PLANS.patron.cents, 1900);
});

test("unknown plan ids return null, never undefined", () => {
  assert.equal(getPlan("enterprise"), null);
  assert.equal(getPlan(""), null);
  assert.equal(getPlan(undefined), null);
  assert.equal(getPlan(490), null);
  // A prototype key must not resolve to a plan.
  assert.equal(getPlan("toString"), null);
  assert.equal(getPlan("__proto__"), null);
});

test("the plans table is frozen", () => {
  assert.equal(Object.isFrozen(PLANS), true);
  assert.equal(Object.isFrozen(PLAN_LIST), true);
});

test("tiers are ordered by price ascending", () => {
  for (let i = 1; i < PLAN_LIST.length; i += 1) {
    assert.ok(
      (PLAN_LIST[i - 1]?.cents ?? 0) <= (PLAN_LIST[i]?.cents ?? 0),
      "PLAN_LIST must be ascending by cents",
    );
  }
});