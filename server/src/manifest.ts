/**
 * The addon manifest and the device bundle.
 *
 * The manifest is data, not a release (docs/adr/0001). The bundle is what a device
 * receives: the manifest it may use, and never the debrid credential.
 */

import { getPlan, type PlanId } from "./plans.ts";

export type AddonId =
  | "torrentio"
  | "comet"
  | "mediafusion"
  | "jackettio"
  | "opensubtitles"
  | "youtube";

export interface Addon {
  id: AddonId;
  name: string;
  /** Cache-only. A non-cached stream is filtered out before a device sees it. */
  cached_only: boolean;
  /** The minimum tier that includes this addon. */
  min_tier: PlanId;
}

/**
 * The whole catalogue. Order is deliberate: the order a client should install in.
 *
 * `cached_only` is the rule that keeps peer traffic off family devices. It is not
 * advisory — a client that ignores it is not a supported client.
 */
export const MANIFEST: readonly Addon[] = Object.freeze([
  Object.freeze({ id: "torrentio", name: "Torrentio", cached_only: true, min_tier: "family" }),
  Object.freeze({ id: "comet", name: "Comet", cached_only: true, min_tier: "family" }),
  Object.freeze({ id: "mediafusion", name: "MediaFusion", cached_only: true, min_tier: "family" }),
  Object.freeze({ id: "jackettio", name: "Jackettio", cached_only: true, min_tier: "family" }),
  Object.freeze({
    id: "opensubtitles",
    name: "OpenSubtitles v3",
    cached_only: false,
    min_tier: "family",
  }),
  Object.freeze({ id: "youtube", name: "YouTube", cached_only: false, min_tier: "household" }),
]);

/** Subtitle languages a paid tier is allowed to request. */
export const SUBTITLE_LANGUAGES = Object.freeze(["hu", "en"] as const);

/** Filter tokens every cached stream must carry to be shown. */
export const FORCED_FILTERS = Object.freeze(["8B+", "RD+"] as const);

const TIER_ORDER: readonly PlanId[] = Object.freeze(["free", "family", "household", "patron"]);

/** True when `tier` is at least `floor` in the pricing order. */
function tierAtLeast(tier: PlanId, floor: PlanId): boolean {
  const a = TIER_ORDER.indexOf(tier);
  const b = TIER_ORDER.indexOf(floor);
  if (a < 0 || b < 0) return false;
  return a >= b;
}

/** The addons a tier may use. */
export function addonsFor(tier: PlanId): Addon[] {
  if (tier === "free") return [];
  return MANIFEST.filter((a) => tierAtLeast(tier, a.min_tier));
}

export interface Bundle {
  /** Never the credential. This is the whole point of the broker. */
  tier: PlanId;
  seats: number;
  addons: { id: AddonId; name: string; cached_only: boolean }[];
  subtitle_languages: readonly string[];
  forced_filters: readonly string[];
  /** ISO 8601. How long this bundle is good for. */
  expires_at: string;
}

export interface BundleRequest {
  plan: unknown;
  email: string;
  now?: number;
}

/**
 * Build a device configuration bundle.
 *
 * Returns null for an unknown or unpaid tier: a free caller gets nothing, because
 * the free tier has no addons to configure. The credential is never a field here,
 * so it cannot be serialised by accident.
 */
export function createBundle(req: BundleRequest): Bundle | null {
  const plan = getPlan(req.plan);
  if (!plan || plan.id === "free") return null;

  const now = req.now ?? Math.floor(Date.now() / 1000);
  const expires = new Date((now + 3600) * 1000).toISOString();

  return {
    tier: plan.id,
    seats: plan.seats,
    addons: addonsFor(plan.id).map((a) => ({
      id: a.id,
      name: a.name,
      cached_only: a.cached_only,
    })),
    subtitle_languages: [...SUBTITLE_LANGUAGES],
    forced_filters: [...FORCED_FILTERS],
    expires_at: expires,
  };
}