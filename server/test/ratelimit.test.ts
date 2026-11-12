import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimiter } from "../src/ratelimit.ts";

test("a caller may burst, then is refused", () => {
  const limiter = new RateLimiter({ capacity: 5, windowMs: 1000 });
  const now = 1_000_000;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.allow("1.2.3.4", now), true, `request ${i} should pass`);
  }
  assert.equal(limiter.allow("1.2.3.4", now), false, "the sixth must be refused");
});

test("a quiet caller recovers", () => {
  const limiter = new RateLimiter({ capacity: 2, windowMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(limiter.allow("a", t0), true);
  assert.equal(limiter.allow("a", t0), true);
  assert.equal(limiter.allow("a", t0), false);
  // A full window later, the bucket is full again.
  assert.equal(limiter.allow("a", t0 + 1000), true);
  assert.equal(limiter.allow("a", t0 + 1000), true);
});

test("one caller cannot exhaust another's allowance", () => {
  const limiter = new RateLimiter({ capacity: 1, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(limiter.allow("good", now), true);
  assert.equal(limiter.allow("bad", now), true, "a different address has its own bucket");
  assert.equal(limiter.allow("good", now), false);
  assert.equal(limiter.allow("bad", now), false);
});

test("an empty key never blocks, since there is no one to blame", () => {
  const limiter = new RateLimiter({ capacity: 1, windowMs: 1000 });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(limiter.allow("", i * 1000), true);
  }
});

test("sweep drops idle buckets", () => {
  const limiter = new RateLimiter({ capacity: 1, windowMs: 1000 });
  limiter.allow("idle", 0);
  limiter.allow("busy", 0);
  const dropped = limiter.sweep(700_000, 600_000);
  assert.equal(dropped, 2);
  assert.equal(limiter.size, 0);
});
