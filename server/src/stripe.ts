/**
 * The Stripe seam.
 *
 * One injectable transport so the suite runs with no live key and no network
 * (docs/adr/0003-webhook-fails-closed-and-stripe-behind-one-seam.md). When
 * STRIPE_SECRET_KEY is absent we return a deterministic fake and report
 * configured:false rather than throwing at import time.
 */

import { UPSTREAM_TIMEOUT_MS } from "./consts.ts";
import { getPlan, type PlanId } from "./plans.ts";

export interface CheckoutRequest {
  plan: unknown;
  email: string;
}

export interface CheckoutResult {
  url: string;
  session_id: string;
  configured: boolean;
}

/** Anything that can POST a form-encoded body and return JSON. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface StripeDeps {
  fetch: FetchLike;
  secret: string | undefined;
  /** Override in tests. */
  now?: () => number;
}

const API = "https://api.stripe.com/v1/checkout/sessions";

/**
 * A client-facing checkout failure.
 *
 * Node's strip-only TypeScript mode rejects parameter properties, so the field
 * is declared and assigned explicitly rather than via a constructor shorthand.
 */
export class CheckoutError extends Error {
  readonly code: "unknown_plan" | "email_required";

  constructor(code: "unknown_plan" | "email_required", message?: string) {
    super(message ?? code);
    this.name = "CheckoutError";
    this.code = code;
  }
}

/**
 * Create a checkout session.
 *
 * Throws CheckoutError for the two client errors the API surfaces verbatim.
 * Never throws for missing configuration — that is a supported state.
 */
export async function createCheckoutSession(
  deps: StripeDeps,
  req: CheckoutRequest,
): Promise<CheckoutResult> {
  const plan = getPlan(req.plan);
  if (!plan) {
    throw new CheckoutError("unknown_plan", "unknown_plan");
  }

  const email = typeof req.email === "string" ? req.email.trim() : "";
  if (!email) {
    throw new CheckoutError("email_required", "email_required");
  }

  if (!deps.secret) {
    return {
      url: `https://checkout.stripe.test/fake/${plan.id}`,
      session_id: "cs_test_unconfigured",
      configured: false,
    };
  }

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("customer_email", email);
  form.set("client_reference_id", plan.id);
  form.set("success_url", "https://8b.is/debris/?checkout=ok");
  form.set("cancel_url", "https://8b.is/debris/?checkout=cancelled");
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price]", priceIdFor(plan.id, deps));
  form.set("subscription_data[metadata][plan]", plan.id);
  form.set("metadata[plan]", plan.id);
  form.set("metadata[email]", email);

  const res = await deps.fetch(API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    // Without a deadline a hung Stripe pins the request forever, and every
    // checkout socket in the process with it.
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`stripe: checkout session failed with status ${res.status}`);
  }

  const body = (await res.json()) as { id?: unknown; url?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!id || !url) {
    throw new Error("stripe: checkout session response missing id or url");
  }

  return { url, session_id: id, configured: true };
}

/**
 * Stripe price ids are configured per tier so the amount lives in Stripe too,
 * where the invoice is produced. Absent env → a clearly invalid placeholder,
 * which surfaces as a Stripe error rather than a silently wrong price.
 */
function priceIdFor(plan: PlanId, deps: StripeDeps): string {
  const fromEnv = (deps as { prices?: Record<string, string> }).prices?.[plan];
  if (fromEnv) return fromEnv;
  const env = process.env[`STRIPE_PRICE_${plan.toUpperCase()}`];
  return env ?? `price_unconfigured_${plan}`;
}