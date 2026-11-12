/**
 * The tier table. The only place a price lives.
 *
 * Money is an integer number of cents. No float ever touches a price
 * (docs/adr/0002-integer-cents-and-a-data-price-table.md). Rendering the
 * currency symbol is the edge's job, not this module's.
 */

export type PlanId = "free" | "family" | "household" | "patron";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Monthly price in integer cents. */
  readonly cents: number;
  /** Device seats this tier may attach. */
  readonly seats: number;
  readonly features: readonly string[];
}

const FAMILY_FEATURES = [
  "configuration bundle",
  "cached-only streams",
  "HU+EN subtitles",
] as const;

const HOUSEHOLD_FEATURES = [
  "everything in family",
  "YouTube addon",
  "12 seats",
] as const;

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  free: Object.freeze({
    id: "free",
    name: "Free",
    cents: 0,
    seats: 1,
    features: Object.freeze(["no configuration bundle", "no subtitles"]),
  }),
  family: Object.freeze({
    id: "family",
    name: "Family",
    cents: 490,
    seats: 5,
    features: Object.freeze(FAMILY_FEATURES),
  }),
  household: Object.freeze({
    id: "household",
    name: "Household",
    cents: 990,
    seats: 12,
    features: Object.freeze(HOUSEHOLD_FEATURES),
  }),
  patron: Object.freeze({
    id: "patron",
    name: "Patron",
    cents: 1900,
    seats: 24,
    features: Object.freeze([...HOUSEHOLD_FEATURES, "24 seats"]),
  }),
});

/** Every tier, ordered cheapest first. */
export const PLAN_LIST: readonly Plan[] = Object.freeze([
  PLANS.free,
  PLANS.family,
  PLANS.household,
  PLANS.patron,
]);

/** Look a tier up by id. Unknown ids return null, never undefined. */
export function getPlan(id: unknown): Plan | null {
  if (typeof id !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(PLANS, id)) return null;
  return PLANS[id as PlanId] ?? null;
}