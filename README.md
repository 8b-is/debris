# 8b.is — debris

**A cache broker and an entitlement ledger for one family's streaming setup.**
Not a media host. Not a proxy. Configuration as the product.

```
debris
  ├── keeps the entitlement ledger           (who paid, how many seats)
  ├── curates the addon manifest             (data, not releases)
  └── brokers a configuration bundle         (per device, expiring, no credential)
```

The debrid credential itself is not stored by this service yet. That is the one
piece of the design still ahead of the code, and it is named here rather than
implied by the diagram.

---

## why this exists

The family has nine devices and one streaming setup. Every device holds a slightly
different version of that setup: a different subset of addons, different filters,
different subtitle languages, and nobody knows which one is current. The bytes are
not the problem — a debrid cache already has them. The problem is that
configuration is stored in nine places and edited in none of them.

debris moves the configuration to one place and makes the *manifest* the artifact.
The cache stays the debrid provider's job, because they are better at it than we
would be and it is not a cost this family should carry.

The honest trade: we depend on a third party for the bytes and cannot fix a stream
that will not start. That dependency is named in
[ADR 0001](docs/adr/0001-broker-and-ledger-not-host.md), not hidden.

---

## the tiers

| tier | EUR / month | seats | what it adds |
|---|---|---|---|
| `free` | 0 | 1 | no configuration bundle, no subtitles |
| `family` | 490 | 5 | configuration bundle, cached-only streams, HU+EN subtitles |
| `household` | 990 | 12 | everything in family, YouTube addon |
| `patron` | 1900 | 24 | household, 24 seats |

Prices are integer cents in the table (`plans/SPEC.md` is the contract) and are
rendered once, at the edge. `490` is `€4.90`. There is no float anywhere near a
price — [ADR 0002](docs/adr/0002-integer-cents-and-a-data-price-table.md) explains
why that matters when an invoice has to reconcile.

Billed monthly, cancel any time. Every figure is a list price for one month, not
an annualised saving.

---

## how it works

1. **One debrid account.** The family holds a Real-Debrid or TorBox account. When
   the credential broker lands, the token goes into debris once, server-side, and
   never reaches a device. Until then the token stays in the client, which is the
   arrangement this service exists to replace.
2. **One manifest.** The allowed addons, the forced filters (`[8B+]` / `[RD+]`
   cached-only, so no P2P traffic ever reaches a family device), the pinned
   catalogues, the subtitle languages. Edited in one place, applied everywhere.
3. **One bundle per device.** A device asks `/api/bundle` with its email, receives
   a configuration bundle that expires in an hour, and is done. Nine devices, one
   manifest, no per-device fiddling.

Supported clients: Stremio on macOS, Windows, Linux, Android, Android TV, iOS
(PWA), tvOS, Tizen and webOS.

---

## what debris never does

This is the part worth reading twice.

- **No media hosting.** Not a byte of media is stored here.
- **No P2P.** The manifest forces cached-only streams, so no family device is ever
  a peer.
- **No ads.** There is nothing to advertise against; we are not in the attention
  business.
- **No tracking.** The landing page makes no network request other than the
  checkout POST, and the server logs no request bodies.
- **No account required to read the docs.** The manifest and the ADRs are public.

---

## running it

Zero runtime dependencies. Node 26 runs the TypeScript sources directly.

```bash
scripts/verify.sh                 # syntax check every source, then the whole suite
node --test server/test/          # just the suite, offline
node server/src/server.ts         # serves on PORT, default 8787
```

Configuration is environment only: `PORT`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_<TIER>`.

**Stripe unconfigured is a supported state.** The checkout seam returns a
deterministic fake URL and the server logs `stripe: unconfigured` once. The webhook
does the opposite: with no secret it rejects every event, because a free service
is worse than a broken one —
[ADR 0003](docs/adr/0003-webhook-fails-closed-and-stripe-behind-one-seam.md).

**The webhook fails closed.** No development bypass, by design. To seed an
entitlement locally, write `server/data/entitlements.json` directly; the store
validates and persists it atomically.

---

## the landing

`landing/index.html`, `landing/landing.css`, `landing/tokens.css`,
`landing/app.js`. Static, no build, no CDN, no external font, and no ES module —
`app.js` is a classic deferred script because a `type="module"` script is blocked
over `file://`, which would break the "open it off the filesystem" promise. Open
`index.html` directly, or serve the directory.

It wears the constellation ink — near-black canvas `#05060a`, mint `#62e6c9`, gold
`#e8b05c`, violet `#b48bff`, cyan `#00f0ff`. The tokens are copied from the 8b.is
design system and the provenance is stated at the top of `tokens.css`; they are not
imported across repos, so this page stands alone
([ADR 0004](docs/adr/0004-static-landing-that-stands-alone.md)).

The tier comparison is rendered from a local copy of the price table. A test in the
server lane compares that copy against `plans.ts` and fails if they diverge, which
is the whole reason the duplication is safe.

---

## the API

```
GET  /healthz                      200 {ok, version, uptime_s}
GET  /api/plans                    200 {plans:[{id,name,cents,seats,features}]}
GET  /api/bundle?email=            200 {tier,seats,addons,subtitle_languages,forced_filters,expires_at}
POST /api/checkout   {plan, email} 200 {url, session_id}
POST /api/webhook                  Stripe events, HMAC-SHA256 verified
GET  /api/entitlement?email=       200 {email, plan, seats, status, valid_until}
```

Every error is `{error: "<string>"}`. The complete set — a client may branch on
these and on nothing else:

| status | error | when |
|---|---|---|
| 400 | `unknown_plan` | `plan` is not one of the four tiers |
| 400 | `email_required` | `email` is missing or blank (checked after the plan) |
| 400 | `bad_json` | the body is not a JSON object |
| 400 | `bad_signature` | webhook secret unset, header malformed, timestamp stale, or HMAC mismatch |
| 400 | `bad_payload` | signature valid but the body is not JSON |
| 400 | `payload_too_large` | body over 64 KiB |
| 400 | `read_failed` | the request body errored mid-read |
| 400 | `read_timeout` | the body did not arrive within 10 s |
| 402 | `payment_required` | bundle asked for a record that is free, lapsed, or past due |
| 404 | `not_found` | unknown route |
| 404 | `unknown_entitlement` | no ledger entry for that email |
| 409 | `already_subscribed` | checkout asked for an email whose subscription is active |
| 500 | `internal` | anything unhandled |
| 502 | `upstream_failed` | Stripe returned a non-2xx |

Errors are the server's own strings and are rendered verbatim by the client. A
client that paraphrases a server error will eventually paraphrase it wrong.

---

## continuous integration

`.github/workflows/ci.yml` runs two jobs on every push and pull request: syntax plus
the full test suite, and a landing check that fails if the page gains an external
`src`, `href`, `url()`, `@import`, or `fetch()`. The second job is the enforcement
behind the privacy claim above — without it, "makes no request it does not need" is
a sentence, not a property.

## what is deliberately absent

- **The proxy data path.** debris brokers credentials and configuration; it does
  not relay bytes. That is a documented seam, not shipped code.
- **Media storage and transcoding.** Neither is in scope, and neither will be.
- **A database.** Entitlements are a JSON file with atomic writes. That is the
  correct size of solution for a family.
- **A VM, an LSP, an MCP surface.** There is no language here and no agent surface;
  adding one would be inventing work.

---

## layout

```
AGENTS.md                     the rules, for agents and for reviewers
plans/SPEC.md                 the build contract both lanes implement against
docs/ELI5.md                  what it is, for a ten-year-old
docs/adr/0001..0004           broker-not-host, integer cents, fail-closed webhook,
                             static standalone landing
scripts/verify.sh             syntax check + full suite
server/src/consts.ts          the canonical constants: body cap, port, tolerance, mode
server/src/plans.ts           the tier table — the only place a price lives
server/src/store.ts           entitlement ledger, atomic writes
server/src/stripe.ts          the checkout seam, injectable transport
server/src/webhook.ts         HMAC verification and event dispatch
server/src/server.ts          the five routes
server/test/                  offline end-to-end route tests
landing/index.html            the page
landing/landing.css           layout and components; defines no colour of its own
landing/tokens.css            constellation ink, copied with provenance
landing/app.js                tier CTAs and error rendering
```

---

## status

The ADRs are accepted. The landing and the server are built to
[`plans/SPEC.md`](plans/SPEC.md).

What is built: the entitlement ledger, the tier table, the addon manifest, the
configuration bundle (`GET /api/bundle`), Stripe checkout behind one seam, and
HMAC-verified webhooks that fail closed, and an audit line for every
entitlement change. 87 tests, offline.

**The entitlement and bundle routes have no authentication.** Anyone who knows a
family member's email can read their plan and request a bundle in their name. The
ledger holds no credential and a bundle carries none, but this is still an
enumeration oracle, and it is why the service is not deployed anywhere. The reasoning
and the expiry condition are in
[ADR 0005](docs/adr/0005-unauthenticated-until-deployed.md).

What is not built: **the credential broker** — nothing in this service stores a
debrid token yet. The bundle is the shape it will hand out, and the bundle
deliberately has no token field, so the day the credential store lands it cannot
leak through the bundle by accident. Also not here: a real Stripe account, a real
debrid token, and a deployed instance. Those are operator steps, not code.

The three things this service will be judged on, in order: **the webhook does not
fail open**, **a price is never a float**, and **the landing makes no request it
does not need**.

---

*8b.is · debris · fine touch from within · AGPL-3.0-only*