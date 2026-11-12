# AGENTS.md — `8b-is-debris`

A cache broker and an entitlement ledger. It holds a debrid credential, a curated
addon manifest, and a list of who has paid. It does not hold media, relay bytes, or
run a proxy data path.

Zero runtime dependencies. Node 26 runs the TypeScript sources directly through
type stripping — there is no build step, no bundler, and no `node_modules`.

```bash
cd ~/workspace/peterlodri-sec/8b-is-debris
scripts/verify.sh            # syntax check every source, then the whole suite
node --test server/test/     # 127 tests, offline, no network
node server/src/server.ts    # serves on PORT, default 8787
```

## Rules

- **Money is integer cents.** A price is `490`, never `4.90`. The only place a
  currency symbol exists is `formatPrice` in `landing/app.js`, and the only place a
  price is declared is `server/src/plans.ts`. A float near money is a bug even when
  the tests pass. See `docs/adr/0002`.
- **The webhook fails closed.** No secret, no entry. There is no development bypass
  and there must never be one; a service that accepts unsigned events is a free
  service. Seed state by writing `server/data/entitlements.json` directly. See
  `docs/adr/0003`.
- **Stripe sits behind one seam.** `createCheckoutSession` takes its transport as a
  dependency. Do not import `fetch` at the call site, and do not add the Stripe SDK:
  the zero-dependency property is worth more than the convenience.
- **Errors are the API's own strings.** The full set is the table in
  `README.md` §"the API". The landing renders them verbatim. Do not invent friendlier
  copy in the client, and do not rename or add an error string without updating the
  README table and `server/test/readme-contract.test.ts`, which fails on drift in
  either direction.
- **The price table exists twice on purpose.** `landing/app.js` holds a copy so the
  page can be a static file with no loading state.
  `server/test/landing-parity.test.ts` compares the two and fails on drift. If you
  change a price, change both and keep that test green — without it the duplication
  is a defect, not a decision.
- **The landing makes no request except `POST /api/checkout`.** No CDN, no external
  font, no analytics, no tag manager. `app.js` is a classic deferred script, not an
  ES module, because a module is blocked over `file://` and the page must open off
  the filesystem.
- **Name only what is checked.** `README.md` is the contract. If it says something is
  absent — the proxy data path, media storage, a database, an agent surface — it
  stays absent until it has acceptance tests of its own.
- **No media bytes, ever.** This is the service's whole legal posture. Do not add a
  transcode path, a relay, or a cache of anything larger than a configuration
  document.
- **`cached_only` and `forced_filters` are requests, not enforcement.** The server
  cannot make a third-party player honour a filter. The docs say "asks for" and
  "prefers"; do not upgrade that to "forces" without a component in this repo that
  actually filters, and do not imply the service can police a device it does not run on.
- **`/api/bundle` is the only route with a limit, because it is the only one a stranger
  can make expensive.** A sha256 per request and an fsync per new device is work an
  anonymous caller should not be able to schedule. The bucket is keyed by remote
  address, so a proxy must forward it or every request shares one bucket.
- **A new device needs the family enrolment code.** An email is not proof of belonging:
  without this anyone who knows one could fill every seat with junk and lock the
  family's own television out. The code is printed once on the first subscription
  grant, stored hashed, and compared case-insensitively.
- **A field added to `Entitlement` must be carried in `store.put`.** It builds the
  record explicitly rather than spreading, so a new field is silently dropped until
  someone adds it. That exact bug locked every device out of a paid account.
- **Ending a subscription releases that family's devices, and only that family's.** A
  cancelled subscription that kept its devices left a resubscribing family with seats
  they could not identify. `releaseAllForEmail` is called from the webhook, and the
  enrolment code is deliberately kept so the same code still works.
- **A stale device is swept on request, never on a read.** `last_seen_at` is recorded so
  seats can be reclaimed, and `sweepStale` only runs from the explicit sweep route. A
  family away for a month must not come home deregistered.
- **A device has one secret, stored hashed.** `devices.ts` keeps `sha256(secret)` and
  never the secret. A registry file must not be enough to impersonate a device, which
  is the reason a token exists instead of trusting an email.
- **A reconnecting device must not cost a seat.** `issue()` returns the known device
  when the presented secret matches, and only registers a new one otherwise. A TV that
  reconnects after a reboot is the same TV.
- **`GET /api/entitlement` requires a device secret and returns no secrets.** It used to
  be open and returned the raw record, which after the enrolment work carried
  `enrolment_hash` — a password-equivalent readable by anyone who knew an email. Every
  response from that route is a whitelist; do not spread a record into it.
- **A device is not a key to the whole ledger.** `authenticate` binds a secret to one
  email, so a device on one subscription cannot read another's status.
- **A bundle never carries the credential.** `createBundle` has no token field, and
  `manifest.test.ts` asserts the serialised bundle contains no `token`, `credential`,
  `secret`, `api_key`, or `password`. Do not add one "for convenience"; the credential
  broker is the piece that stores it server-side, and it is not built yet.

## Layout

```
server/src/consts.ts      body cap, port, webhook tolerance, ledger mode, version
server/src/plans.ts       the tier table — the only place a price is declared
server/src/manifest.ts    the addon catalogue and the device bundle
server/src/store.ts       entitlement ledger, atomic tmp+rename writes
server/src/stripe.ts      the checkout seam, injectable transport
server/src/webhook.ts     HMAC-SHA256 verification and event dispatch
server/src/server.ts      the five routes
server/src/audit.ts       one-line audit trail for every entitlement change
server/src/devices.ts     the device registry: hashed secrets, seats, persistence
server/src/ratelimit.ts   per-caller token bucket for the expensive route
server/test/              127 offline tests, including landing, README, audit, and device parity
landing/                  static page: index.html, landing.css, tokens.css, app.js
docs/adr/                 the five decisions, each with what would change it
docs/ELI5.md              what it is, for a ten-year-old
plans/SPEC.md             the build contract
```

## Verifying a change

`scripts/verify.sh` is the whole gate. If it exits 0 the change is safe to commit.
A change that only edits the landing still needs the parity test, which is why the
script runs the full suite rather than a subset.

## Licence

AGPL-3.0-only, matching the workspace it lives in. `LICENSE` is the verbatim text.