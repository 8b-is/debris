# ADR 0003 — the webhook fails closed, and Stripe sits behind one seam

**Status:** accepted
**Date:** 2026-11-12

---

## Context

Entitlements are granted by a webhook. If the webhook can be forged, the service
is free, so signature verification is not a detail — it is the whole boundary.

Two failure modes look identical from inside the handler: *the secret is not
configured* and *the signature is wrong*. Both must result in a rejection. The
tempting shortcut is to accept the event when no secret is set, on the grounds
that a fresh deploy cannot verify anything and should not be bricked. That
shortcut is a free service to anyone who can POST.

A second concern is testability. A handler that reaches for `api.stripe.com` by
name cannot be tested without a key, so it will not be tested, so the signature
path will rot.

## Decision

**Fail closed.** `STRIPE_WEBHOOK_SECRET` unset → every webhook is rejected with
`400 {error:"bad_signature"}`. There is no development bypass. A local deploy
that needs to grant an entitlement writes the JSON file directly, which is the
honest way to seed state and is already required by the store.

**Verification is real.** HMAC-SHA256 over the exact signed payload
`${t}.${rawBody}`, using the endpoint secret, compared with
`crypto.timingSafeEqual` against the `v1` candidate. The raw body is what is
verified, so no JSON re-serialisation sits between the wire and the check. The
timestamp is checked against a 300-second window so a captured request cannot be
replayed indefinitely.

**Stripe is reached through one injectable seam.** `createCheckoutSession` takes
its transport as a dependency. The test suite supplies a fake; production
supplies `fetch` and the secret. When the key is absent the seam returns a
deterministic fake URL and the server logs `stripe: unconfigured` once, rather
than throwing at import time.

**Unknown event types are acknowledged, not rejected.** `200 {received:true,
ignored:true}`. Stripe retries anything it does not get a 2xx for, and a
retry storm against a handler that will never understand the event is pure cost.

## Consequences

**Good.** The security property is structural, not conventional. There is no flag
that turns it off, so there is no flag that gets left on.

**Good.** The whole suite runs offline. Signature verification, grant, downgrade,
and persistence are all exercised without a network or a key.

**Bad.** Local development cannot receive a real Stripe event without a real
secret. That is the intended trade; seeding the store directly is the supported
path and is documented.

**Bad.** `timingSafeEqual` requires equal-length buffers, so the comparison
branches on length before it compares. The length branch leaks the candidate
length, which is not a secret. This is accepted and noted so a future reader does
not "fix" it into a panic.

**Accepted.** Stripe's own SDK would handle signature parsing and version pinning
for us. We are not using it because the parse is thirty lines, the dependency is
large, and the zero-dependency property is worth more to this service than the
SDK's convenience. If Stripe changes the header format, that is a one-file fix.

## What would change this decision

- Stripe deprecating the `Stripe-Signature` v1 scheme, which would force the SDK
  or a manual implementation of the new scheme.
- A second payment processor, which would make a common payment interface worth
  the abstraction.
- A requirement to verify events beyond signature, such as a replay ledger keyed
  by event id. That would be added inside the seam, not around it.