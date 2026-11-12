# ADR 0004 — the landing page is static, and stands alone

**Status:** accepted
**Date:** 2026-11-12

---

## Context

The landing page has one job: explain the service and take an email address in
exchange for a checkout URL. It is read by a family on phones, tablets and TVs,
much of it on connections that are fine but not fast, and it must be cheap to
move.

The obvious home is a route inside the existing 8b.is SvelteKit site. That buys
shared components and one deploy. It also buys a build step, a Node process, a
framework upgrade treadmill, and a coupling that means the pricing page cannot be
shipped without the whole site shipping.

The page must also wear the constellation ink. DESIGN.md is the source of truth
and lives in a different repository, so an `@import` across repos would either
break or silently pin the landing to another project's file layout.

## Decision

**Static files, no build step.** `index.html`, `tokens.css`, `app.js`. Openable
from the filesystem, deployable to any object store, cacheable forever.

**The design tokens are copied, not imported.** `tokens.css` carries the palette,
type, space and motion values from 8b-is DESIGN.md as CSS custom properties. The
provenance is stated in a comment at the top of the file naming DESIGN.md as the
source. If the constellation palette changes, the landing changes with it by hand
— a deliberate, small duplication in exchange for zero runtime coupling.

**The only network call is `POST /api/checkout`.** No CDN, no external font, no
analytics, no tag manager. The page must work with the network tab otherwise
empty, because a page that phones home to five vendors before it renders is not a
page the family should be asked to trust with an email address.

**Email is collected once, in one field, and shared by every tier button.** The
alternative — an email field per card — triples the failure surface and makes the
form unusable on a phone.

**The error copy is the server's.** A 400 renders `error` verbatim. The client
does not invent friendlier wording for `email_required`, because a client that
paraphrases server errors is a client that will eventually paraphrase them wrong.

## Consequences

**Good.** The deploy is a file copy. The page renders before any script runs. The
privacy story is short enough to state in one sentence and true.

**Good.** Because the tiers are rendered from a local copy of the table, the page
has no loading state and no spinner — the price is in the HTML.

**Bad.** The price table exists twice: once in `plans.ts`, once in `app.js`. A
silent divergence would show a price the server does not honour. The mitigation is
a comparison test in the server lane, and it is part of the definition of done.
Without that test this decision is worse than the framework it replaces.

**Bad.** No server-side rendering, so the tier comparison is not in the initial
HTML as structured data and the page is a little less legible to a crawler. Accepted:
the audience is a family with a bookmark, not a search engine.

**Bad.** Copying the tokens means the landing can drift from the constellation
palette without anything failing. Accepted, and mitigated only by the provenance
comment. This is the cheapest available option and the drift is cosmetic.

## What would change this decision

- A second landing page with the same chrome, which would make a shared component
  worth the build step.
- A requirement to personalise the page per signed-in user, which static files
  cannot do.
- A requirement to A/B test pricing, which would need a build or an edge worker —
  at which point the worker, not SvelteKit, is the right home.