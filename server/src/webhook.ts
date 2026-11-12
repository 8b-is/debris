/**
 * Webhook verification and event dispatch.
 *
 * The verification is real: HMAC-SHA256 over the exact signed payload
 * `${t}.${rawBody}`, compared with crypto.timingSafeEqual. The raw body is what
 * is verified, so nothing re-serialises JSON between the wire and the check.
 *
 * This module fails closed. If STRIPE_WEBHOOK_SECRET is unset, every webhook is
 * rejected. There is no development bypass, by design
 * (docs/adr/0003-webhook-fails-closed-and-stripe-behind-one-seam.md).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { MS_PER_SECOND, WEBHOOK_TOLERANCE_SECONDS } from "./consts.ts";
import { getPlan } from "./plans.ts";
import {
  freeEntitlement,
  oneMonthAfter,
  type EntitlementStore,
} from "./store.ts";

/**
 * The tolerance, re-exported under the shorter name the tests use.
 *
 * One value, one definition: this is an alias, not a second constant.
 */
export const TOLERANCE_SECONDS = WEBHOOK_TOLERANCE_SECONDS;

export type WebhookResult =
  | { ok: true; received: true; ignored?: true; event: string }
  | { ok: false; error: string };

interface ParsedHeader {
  timestamp: string;
  signatures: string[];
}

/** Parse `t=...,v1=...,v1=...` into its parts. Null when malformed. */
export function parseSignatureHeader(header: string | null): ParsedHeader | null {
  if (!header) return null;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Constant-time verification.
 *
 * Returns true only when the header is present and well formed, the timestamp is
 * inside the tolerance window, the secret is configured, and some v1 candidate
 * matches. Never returns true on an unset secret.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / MS_PER_SECOND),
): boolean {
  if (!secret) return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const ts = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`, "utf8")
    .digest();

  // Length branches first: timingSafeEqual requires equal lengths. The length
  // is not a secret, so this is not a leak (see ADR 0003).
  for (const candidate of parsed.signatures) {
    let got: Buffer;
    try {
      got = Buffer.from(candidate, "hex");
    } catch {
      continue;
    }
    if (got.length !== expected.length) continue;
    if (timingSafeEqual(got, expected)) return true;
  }
  return false;
}

interface StripeObject {
  id?: string;
  customer?: string;
  customer_email?: string;
  subscription?: string;
  status?: string;
  currency?: string;
  amount_total?: number;
  metadata?: Record<string, string>;
}

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: StripeObject };
}

function emailOf(obj: StripeObject): string {
  const meta = obj.metadata?.email;
  if (typeof meta === "string" && meta.trim()) return meta.trim().toLowerCase();
  if (typeof obj.customer_email === "string" && obj.customer_email.trim()) {
    return obj.customer_email.trim().toLowerCase();
  }
  return "";
}

/**
 * Apply one verified event to the ledger.
 *
 * Returns ignored:true for event types we do not act on, so Stripe is
 * acknowledged rather than retried forever.
 */
export async function dispatchEvent(
  store: EntitlementStore,
  event: StripeEvent,
  nowSeconds: number = Math.floor(Date.now() / MS_PER_SECOND),
): Promise<WebhookResult> {
  const type = typeof event.type === "string" ? event.type : "";
  const created = typeof event.created === "number" ? event.created : nowSeconds;
  const obj = event.data?.object ?? {};

  switch (type) {
    case "checkout.session.completed": {
      const plan = getPlan(obj.metadata?.plan ?? obj.metadata?.["plan"]);
      const email = emailOf(obj);
      if (!email) return { ok: true, received: true, ignored: true, event: type };
      if (!plan || plan.id === "free") {
        await store.put(freeEntitlement(email));
        return { ok: true, received: true, event: type };
      }
      await store.put({
        email,
        plan: plan.id,
        seats: plan.seats,
        status: "active",
        valid_until: oneMonthAfter(created),
      });
      return { ok: true, received: true, event: type };
    }

    case "customer.subscription.updated": {
      const email = emailOf(obj);
      if (!email) return { ok: true, received: true, ignored: true, event: type };
      const plan = getPlan(obj.metadata?.plan);
      if (!plan || plan.id === "free") {
        await store.put(freeEntitlement(email));
        return { ok: true, received: true, event: type };
      }
      await store.put({
        email,
        plan: plan.id,
        seats: plan.seats,
        status: obj.status === "past_due" ? "past_due" : "active",
        valid_until: obj.status === "canceled" ? null : oneMonthAfter(created),
      });
      return { ok: true, received: true, event: type };
    }

    case "customer.subscription.deleted": {
      const email = emailOf(obj);
      if (!email) return { ok: true, received: true, ignored: true, event: type };
      await store.put(freeEntitlement(email));
      return { ok: true, received: true, event: type };
    }

    case "invoice.payment_failed": {
      const email = emailOf(obj);
      if (!email) return { ok: true, received: true, ignored: true, event: type };
      const existing = store.get(email);
      await store.put({
        email,
        plan: existing?.plan ?? "free",
        seats: existing?.seats ?? 1,
        status: "past_due",
        valid_until: existing?.valid_until ?? null,
      });
      return { ok: true, received: true, event: type };
    }

    default:
      return { ok: true, received: true, ignored: true, event: type };
  }
}

/** Verify then dispatch. The only entry point the HTTP layer calls. */
export async function handleWebhook(
  store: EntitlementStore,
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / MS_PER_SECOND),
): Promise<WebhookResult> {
  if (!verifySignature(rawBody, header, secret, nowSeconds)) {
    return { ok: false, error: "bad_signature" };
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { ok: false, error: "bad_payload" };
  }

  return dispatchEvent(store, event, nowSeconds);
}