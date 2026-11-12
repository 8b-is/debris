# ADR 0002 — money is integer cents, and the price table is data

**Status:** accepted
**Date:** 2026-11-12

---

## Context

Four tiers, monthly billing, one currency (EUR). The obvious implementation is a
float column and a `€4.90` literal.

Two problems. First, `4.90` is not representable in binary floating point, so any
arithmetic on it — proration, a partial month, a discount — drifts by fractions of
a cent, and those fractions surface later as invoices that do not reconcile.
Second, a price written at a call site is a price nobody can change without a
deploy, and the family will want to change a price.

## Decision

**Money is an integer number of cents.** Everywhere. The tier table is the only
place a number appears, and it appears as `490`, `990`, `1900`, `0`.

**The tier table is data, not code.** It lives in `server/src/plans.ts` as a
frozen record with `id`, `name`, `cents`, `seats`, and `features`, and it is
served verbatim by `GET /api/plans`. The landing page fetches nothing — it
renders the same values from its own copy, and the two are compared by a test in
the server lane so a silent divergence fails a build rather than a customer's
invoice.

**Rendering is a separate concern.** A formatter turns `490` into `€4.90` at the
edge. No layer above the table ever sees a float.

## Consequences

**Good.** Reconciliation is exact. A proration is `(days_a * cents) / days_in_month`
in integers, and the remainder is a known, testable quantity rather than a
surprise.

**Good.** Changing a price is one row. Changing a tier's shape — adding a seat,
adding a feature — is one row.

**Bad.** Every consumer must remember the value is cents. A stray `€` formatter
applied twice produces `€490.00`. The mitigation is that the formatter is the only
place the currency symbol exists, and it is not exported from the plans module.

**Bad.** The landing page and the server hold two copies of the table. The test
that compares them is the mitigation; without it this decision is worse than the
float it replaces. That test is part of the definition of done, not a nice to
have.

## What would change this decision

- Multi-currency billing. Then the table needs a currency dimension and the
  integer invariant stays but the table shape does not.
- Usage-based billing, where a per-unit price is multiplied by a large count. The
  integer stays correct but the multiplication needs an explicit overflow policy.