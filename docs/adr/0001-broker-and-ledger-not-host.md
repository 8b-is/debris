# ADR 0001 — debris is a broker and a ledger, never a host

**Status:** accepted
**Date:** 2026-11-12
**Deciders:** Péter Lódri (architecture), with the family as the demanding customer

---

## Context

The family wants one remote, one catalogue, no ads, and no per-device setup. The
existing constellation has the pieces: Stremio as the client, a handful of addons
(Torrentio, Comet, MediaFusion, Jackettio, OpenSubtitles v3), a single debrid
account (Real-Debrid or TorBox), and a set of devices spanning macOS, Windows,
Linux, Android, Android TV, iOS, tvOS, Tizen and webOS.

Two approaches were on the table.

**Build the media service.** Host the catalogue, transcode, serve bytes. This is
what every commercial service does, and it is the one thing this machine must not
do. It means storing other people's media, which is a legal posture the family
does not need, and it means a transcode farm, which is a running cost with no
ceiling.

**Configure the client.** Keep the bytes where they already are — on the debrid
provider's cache — and make the *configuration* the product. The family's actual
pain is not bandwidth, it is that nine devices each hold a slightly different
setup and nobody knows which one is current.

We take the second.

## Decision

debris holds exactly three things and nothing else.

1. **A credential broker.** The debrid token lives server-side. Clients receive
   short-lived configuration bundles, never the token itself. The token can be
   rotated once, centrally, without touching nine devices.
2. **A curated addon manifest.** Which addons are permitted, which filters are
   forced, which catalogues are pinned. The manifest is the product: it is the
   thing a family actually argues about.
3. **An entitlement ledger.** Who has paid, at what tier, and how many device
   seats that buys.

debris does not store media, does not transcode, does not relay bytes, and does
not run a proxy data path. It is a configuration service with a payment gate.

## Consequences

**Good.** The legal surface is small and legible: we broker credentials and sell
configuration, both of which are ordinary software businesses. The running cost
is a process, not a farm. The cache stays the debrid provider's problem, and they
are much better at it than we would be.

**Good.** Because the manifest is data, a new addon is a config change, not a
release. Because entitlements are data, a tier change is a row, not a deploy.

**Bad.** We are dependent on a third party for the actual bytes. If the debrid
provider degrades, the family's experience degrades and there is nothing in this
repo to fix. That is a real dependency and it is named here rather than hidden.

**Bad.** We cannot fix a stream that will not start. The support surface is
"which addon, which device, which filter", and half the answers will be "the
provider is having a bad day".

**Accepted.** Both of the above. The alternative — owning the bytes — costs more
than it saves and puts the family in a posture nobody wants.

## What would change this decision

- A debrid provider withdrawing API access for configuration-broker use. Then the
  broker becomes the product and we would need to renegotiate or replace it.
- A family device that cannot reach the provider's cache directly, which would
  force a relay and reopen the question of who pays for egress.
- A legal change that makes brokering credentials on behalf of a household a
  different category of activity than the one assumed here.