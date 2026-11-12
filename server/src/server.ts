/**
 * The five routes.
 *
 * Plain node:http. No framework, no runtime dependency. Correct status codes,
 * and error strings that are the API's own — the landing renders them verbatim
 * rather than paraphrasing (docs/adr/0004-static-landing-that-stands-alone.md).
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { audit } from "./audit.ts";
import {
  BODY_TIMEOUT_MS,
  DEFAULT_PORT,
  BUNDLE_RATE_BURST,
  BUNDLE_RATE_PER_SECOND,
  DEVICE_STALE_DAYS,
  MAX_BODY_BYTES,
  SHUTDOWN_GRACE_MS,
  VERSION,
} from "./consts.ts";
import { DeviceRegistry, loadDevices, secretMatches } from "./devices.ts";
import { RateLimiter } from "./ratelimit.ts";
import { createBundle } from "./manifest.ts";
import { PLAN_LIST } from "./plans.ts";
import { EntitlementStore, isActiveNow, normalizeEmail } from "./store.ts";
import { CheckoutError, createCheckoutSession, type StripeDeps } from "./stripe.ts";
import { handleWebhook } from "./webhook.ts";

export interface ServerDeps {
  store?: EntitlementStore;
  stripe?: StripeDeps;
  devices?: DeviceRegistry;
  limiter?: RateLimiter;
}

/**
 * Emails with a checkout in flight.
 *
 * The active-subscription check and the Stripe call are not atomic, so two taps
 * in the same second both pass the check and both create a session. Keying on the
 * email serialises them without a lock file.
 */
const inFlightCheckout = new Map<string, boolean>();

export interface DebrisServer {
  server: Server;
  url: string;
  store: EntitlementStore;
  devices: DeviceRegistry;
  close: () => Promise<void>;
}

/** The caller's identity for rate limiting: the forwarded address, or the socket. */
function callerKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Extract a Bearer token from an Authorization header, or null. */
function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/** Read the whole request body, refusing anything over the cap. */
function readBody(
  req: IncomingMessage,
  onTimeout?: () => void,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (value: { ok: true; text: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // A client that opens a body and never sends it would otherwise hold the
    // socket forever, one slow request at a time. Destroying the request first
    // would kill the socket before the 400 can be written, so the handler is
    // told to answer and closes afterwards.
    const timer = setTimeout(() => {
      finish({ ok: false, error: "read_timeout" });
      onTimeout?.();
    }, BODY_TIMEOUT_MS);
    timer.unref?.();

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: "payload_too_large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ ok: false, error: "read_failed" }));
  });
}

function readJsonBody(
  req: IncomingMessage,
  onTimeout?: () => void,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  return readBody(req, onTimeout).then((result) => {
    if (!result.ok) return result;
    if (!result.text.trim()) return { ok: true as const, value: {} };
    try {
      const parsed: unknown = JSON.parse(result.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false as const, error: "bad_json" };
      }
      return { ok: true as const, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false as const, error: "bad_json" };
    }
  });
}

export function createDebrisServer(deps: ServerDeps = {}): DebrisServer {
  const store = deps.store ?? new EntitlementStore();
  const devices = deps.devices ?? loadDevices();
  const limiter =
    deps.limiter ??
    new RateLimiter({ capacity: BUNDLE_RATE_BURST, windowMs: 1000 / BUNDLE_RATE_PER_SECOND });
  const stripe: StripeDeps = deps.stripe ?? {
    fetch: fetch as unknown as StripeDeps["fetch"],
    secret: process.env.STRIPE_SECRET_KEY,
  };

  let stripeWarned = false;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (method === "GET" && url.pathname === "/healthz") {
        json(res, 200, {
          ok: true,
          version: VERSION,
          uptime_s: Math.round(process.uptime()),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/plans") {
        json(res, 200, { plans: PLAN_LIST });
        return;
      }

      // The broker. A device asks for its configuration bundle; the credential is
      // never a field in the response, so it cannot be serialised by accident.
      if (method === "GET" && url.pathname === "/api/bundle") {
        // Every request here hashes, and a first-time device also writes to disk.
        // Without a limit a caller chooses how much work the service does.
        const caller = callerKey(req);
        if (!limiter.allow(caller)) {
          json(res, 429, { error: "rate_limited" });
          return;
        }
        const email = normalizeEmail(url.searchParams.get("email"));
        const record = email ? store.get(email) : null;
        if (!record) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        if (!isActiveNow(record)) {
          json(res, 402, { error: "payment_required" });
          return;
        }
        const bundle = createBundle({ plan: record.plan, email: record.email });
        if (!bundle) {
          // A free record exists in the ledger but has no addons to configure.
          json(res, 402, { error: "payment_required" });
          return;
        }

        // The credential is the device secret: the first caller registers the
        // device and receives the secret once, and every later caller must
        // present it. Without that, the seat limit is a number on a pricing page
        // that nothing counts (docs/adr/0005).
        const presented = bearerToken(req.headers.authorization);
        const known = presented ? devices.authenticate(record.email, presented) : null;

        if (!known) {
          if (presented) {
            // A secret was offered and rejected. That is an attempt to use
            // someone else's device, not a first registration.
            json(res, 401, { error: "invalid_device_secret" });
            return;
          }

          // A first-time device has no secret, so it must prove it belongs to the
          // family. Without this, anyone who knows an email can fill every seat
          // with junk and lock the family's own television out.
          const code = (url.searchParams.get("enrolment") ?? "").trim().toUpperCase();
          if (!record.enrolment_hash) {
            json(res, 403, { error: "enrolment_required" });
            return;
          }
          if (!code || !secretMatches(code, record.enrolment_hash)) {
            json(res, 403, { error: "enrolment_required" });
            return;
          }

          if (devices.count(record.email) >= record.seats) {
            json(res, 403, { error: "seat_limit_reached" });
            return;
          }
          const name = url.searchParams.get("device") ?? "unnamed device";
          const issued = devices.issue(record.email, name);
          if (!issued) {
            json(res, 500, { error: "internal" });
            return;
          }
          audit({
            event: "device.registered",
            email: record.email,
            plan: record.plan,
            device: issued.device.id,
            name: issued.device.name,
          });
          json(res, 200, { ...bundle, device_id: issued.device.id, device_secret: issued.secret });
          return;
        }

        json(res, 200, { ...bundle, device_id: known.id });
        return;
      }

      if (method === "POST" && url.pathname === "/api/checkout") {
        let timedOut = false;
        const body = await readJsonBody(req, () => {
          timedOut = true;
        });
        if (timedOut) res.on("finish", () => req.destroy());
        if (!body.ok) {
          json(res, 400, { error: body.error });
          return;
        }
        const email = typeof body.value.email === "string" ? body.value.email : "";

        // A customer who is already active must not be sent to a second checkout:
        // that is a second subscription and a second charge. A past_due record is
        // allowed through, because that is exactly who needs to pay again.
        const existing = normalizeEmail(email) ? store.get(normalizeEmail(email)) : null;
        if (existing && isActiveNow(existing)) {
          json(res, 409, { error: "already_subscribed" });
          return;
        }

        // Two taps in the same second both pass the check above and both reach
        // Stripe. Serialising per email turns that into one session and one 409.
        const pending = inFlightCheckout.get(normalizeEmail(email));
        if (pending) {
          json(res, 409, { error: "already_subscribed" });
          return;
        }

        inFlightCheckout.set(normalizeEmail(email), true);
        try {
          const result = await createCheckoutSession(stripe, {
            plan: body.value.plan,
            email,
          });
          if (!stripeWarned && !result.configured) {
            stripeWarned = true;
            console.log("stripe: unconfigured");
          }
          json(res, 200, { url: result.url, session_id: result.session_id });
        } catch (err) {
          if (err instanceof CheckoutError) {
            json(res, 400, { error: err.code });
            return;
          }
          console.error("checkout: error", err);
          json(res, 502, { error: "upstream_failed" });
        } finally {
          inFlightCheckout.delete(normalizeEmail(email));
        }
        return;
      }

      if (method === "POST" && url.pathname === "/api/webhook") {
        // Raw body, never re-serialised: the signature is over the bytes.
        const body = await readBody(req);
        if (!body.ok) {
          json(res, 400, { error: body.error });
          return;
        }
        const result = await handleWebhook(
          store,
          body.text,
          req.headers["stripe-signature"] as string | undefined ?? null,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
        if (!result.ok) {
          json(res, 400, { error: result.error });
          return;
        }
        json(res, 200, result.ignored ? { received: true, ignored: true } : { received: true });
        return;
      }

      // The status of one subscription, for whoever holds a device on it.
      //
      // This used to be open and returned the whole record, which after the
      // enrolment work included enrolment_hash: a password-equivalent, readable by
      // anyone who knew an email, and enough to register devices on the account.
      // It now requires a device secret and returns only what a device needs.
      if (method === "GET" && url.pathname === "/api/entitlement") {
        const email = normalizeEmail(url.searchParams.get("email"));
        const record = email ? store.get(email) : null;
        if (!record) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        const presented = bearerToken(req.headers.authorization);
        if (!presented) {
          json(res, 401, { error: "device_secret_required" });
          return;
        }
        const device = devices.authenticate(record.email, presented);
        if (!device) {
          json(res, 401, { error: "invalid_device_secret" });
          return;
        }
        json(res, 200, {
          email: record.email,
          plan: record.plan,
          seats: record.seats,
          status: record.status,
          valid_until: record.valid_until,
          device: { id: device.id, name: device.name },
        });
        return;
      }

      // Who holds a seat, and since when. An operator looking at "12 of 12 seats
      // used" needs to see the twelve; otherwise the only way to find the stale
      // one is to guess device ids.
      //
      // Still unauthenticated, like /api/entitlement: it exposes device names and
      // ids but no secret, and it is the inventory half of the same gap. The ids
      // are useless without the matching secret.
      if (method === "GET" && url.pathname === "/api/devices") {
        const email = normalizeEmail(url.searchParams.get("email"));
        if (!email) {
          json(res, 400, { error: "email_required" });
          return;
        }
        const record = store.get(email);
        if (!record) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        json(res, 200, {
          email,
          seats: record.seats,
          used: devices.count(email),
          devices: devices.forEmail(email).map((d) => ({
            id: d.id,
            name: d.name,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
          })),
        });
        return;
      }

      // Reclaim seats from devices that stopped checking in. A phone sold in
      // March otherwise holds a seat in November.
      if (method === "POST" && url.pathname === "/api/devices/sweep") {
        const email = normalizeEmail(url.searchParams.get("email"));
        if (!email) {
          json(res, 400, { error: "email_required" });
          return;
        }
        if (!store.get(email)) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        const removed = devices.sweepStale(DEVICE_STALE_DAYS);
        for (const id of removed) {
          audit({ event: "device.swept", email, device: id });
        }
        json(res, 200, { swept: removed.length, ids: removed });
        return;
      }

      // Free a seat. Without this a lost phone holds one forever and the family
      // cap is a leak: the only way to recover would be to delete the ledger by
      // hand. The device proves it owns the seat by presenting that device's
      // secret, which is the only proof the registry has.
      if (method === "DELETE" && url.pathname === "/api/devices") {
        const id = url.searchParams.get("id") ?? "";
        const secret = bearerToken(req.headers.authorization);
        if (!id || !secret) {
          json(res, 400, { error: "device_required" });
          return;
        }
        const device = devices.get(id);
        if (!device || !secretMatches(secret, device.secret_hash)) {
          json(res, 404, { error: "unknown_device" });
          return;
        }
        const revoked = devices.revoke(id);
        if (!revoked) {
          json(res, 404, { error: "unknown_device" });
          return;
        }
        audit({ event: "device.revoked", email: device.email, device: device.id, name: device.name });
        json(res, 200, { revoked: true, id });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      console.error("unhandled: error", err);
      json(res, 500, { error: "internal" });
    }
  };

  const server = createHttpServer((req, res) => {
    void handler(req, res);
  });

  return {
    server,
    url: "",
    store,
    devices,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Start listening on a port. Port 0 asks the OS for a free one. */
export function startServer(
  port = Number(process.env.PORT ?? DEFAULT_PORT),
  deps: ServerDeps = {},
): Promise<DebrisServer> {
  const instance = createDebrisServer(deps);
  return new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(port, () => {
      const address = instance.server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      instance.url = `http://127.0.0.1:${actual}`;
      resolve(instance);
    });
  });
}

// Run as a process, not as an import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const instance = await startServer(port);
  console.log(`debris: listening on ${instance.url}`);
  console.log(`debris: stripe ${process.env.STRIPE_SECRET_KEY ? "configured" : "unconfigured"}`);

  // A webhook in flight is a grant in progress. Closing the listener and then
  // waiting for the open requests to finish is the difference between a restart
  // that costs nothing and one that loses a customer's payment.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`debris: ${signal} received, draining`);

    const force = setTimeout(() => {
      console.log("debris: drain exceeded, forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref?.();

    void instance.close().then(
      () => {
        clearTimeout(force);
        console.log("debris: drained, closing");
        process.exit(0);
      },
      (err: unknown) => {
        console.error("debris: close failed", err);
        process.exit(1);
      },
    );
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}