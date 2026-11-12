# ADR 0005 — the entitlement and bundle routes are unauthenticated, on purpose, for now

**Status:** accepted with a named expiry
**Date:** 2026-11-12

---

## Context

`GET /api/entitlement?email=` returns a record: plan, seats, status, expiry.
`GET /api/bundle?email=` returns a device's configuration bundle.

Neither has any authentication. Anyone who knows a family member's email address
can read their plan and status, and can request a configuration bundle in their
name.

This is a real exposure. It is small — the ledger holds an email, a tier, and a
date, and a bundle holds no credential — but "small" is not "none", and the
service's own README makes a point of not tracking people.

Three options were on the table.

**Build device tokens now.** A per-device secret issued at first use, sent as a
header, verified against the ledger. This is the right answer for a deployed
service. It is also a new table, a new issuance flow, a rotation story, and a
client change across nine devices, and none of it can be tested against a real
device from here.

**Put the routes behind the reverse proxy's auth.** Reasonable in production,
but it makes the API's security depend on a deployment detail that is not in this
repo, and the repo is meant to be readable on its own.

**Ship unauthenticated and say so.** What this does.

## Decision

The routes ship unauthenticated, and every document that describes them says so in
the same breath.

The compensating controls are that the ledger holds no credential, a bundle holds no
credential (`manifest.test.ts` asserts the serialised bundle contains no `token`,
`credential`, `secret`, `api_key`, or `password`), and the service is not deployed
anywhere. There is nothing to reach.

This is accepted **only** while the last of those is true.

## Consequences

**Good.** The API is testable end to end with no auth fixture, and the repo stays
small enough to read in an afternoon.

**Bad.** If this is deployed as-is, any family member's plan is readable by anyone
who can guess an email address. That is an enumeration oracle: the 404 on an unknown
email confirms a guess.

**Bad.** The code does not contain the fix, so the gap will not close by itself. The
next person to deploy has to notice this file.

## Expiry

This ADR expires the moment the service is deployed to anything other than localhost.
Before that happens, device tokens land: a per-device secret issued on first bundle
request, stored in the ledger, sent as `Authorization: Bearer <device>`, and rotated by
re-issuing. The routes then require it, and this ADR is replaced by the one that
describes how it works.

Until then, **do not deploy this**. The README's status section says the same thing in
plainer words.