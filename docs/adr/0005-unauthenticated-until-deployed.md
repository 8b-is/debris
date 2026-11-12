# ADR 0005 — the entitlement and bundle routes are unauthenticated, on purpose, for now

**Status:** partly superseded — device tokens landed; `/api/entitlement` is still open
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

## The second thing device tokens have to fix: seats

`seats` is stored, served, and advertised on the pricing page. Nothing counts devices
against it, and nothing can: there is no device identity anywhere in the service. A
household customer could attach forty devices and the API would answer every one.

This is not a separate bug from the missing authentication — it is the same missing
piece. Device tokens are the thing that would make seats enforceable: issue one per
device, count the live ones, refuse the one past the limit. Until they exist, the seat
number on the pricing page is a promise the code cannot keep, and it is documented as
such rather than left to be discovered.

## What landed

Device tokens are in. A device registers on its first bundle request, receives one
secret, and presents it as `Authorization: Bearer <device>` afterwards. Secrets are
stored as `sha256` and never in the clear. The registry persists to its own file, so a
restart does not burn a seat per device.

That closes the seat-enforcement gap named above: a household cap of twelve is refused
at thirteen, and a reconnecting device does not consume a second seat.

## What did not land

`GET /api/entitlement` is still unauthenticated. It takes an email and returns a plan,
a seat count, a status, and an expiry, and nothing checks who is asking. Device tokens
do not help here, because a device is not a person: the caller of this route is the
family member, not the television.

The remaining options are a session cookie after checkout, or a signed short-lived
link mailed to the address on the subscription. Neither is built.

## Expiry

This ADR expires the moment the service is deployed to anything other than localhost.
Until then, **do not deploy this**. The README's status section says the same thing in
plainer words.