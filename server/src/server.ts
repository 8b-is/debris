/**
 * The five routes.
 *
 * Plain node:http. No framework, no runtime dependency. Correct status codes,
 * and error strings that are the API's own — the landing renders them verbatim
 * rather than paraphrasing (docs/adr/0004-static-landing-that-stands-alone.md).
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BODY_TIMEOUT_MS, DEFAULT_PORT, MAX_BODY_BYTES, VERSION } from "./consts.ts";
import { createBundle } from "./manifest.ts";
import { PLAN_LIST } from "./plans.ts";
import { EntitlementStore, normalizeEmail } from "./store.ts";
import { CheckoutError, createCheckoutSession, type StripeDeps } from "./stripe.ts";
import { handleWebhook } from "./webhook.ts";

export interface ServerDeps {
  store?: EntitlementStore;
  stripe?: StripeDeps;
}

export interface DebrisServer {
  server: Server;
  url: string;
  store: EntitlementStore;
  close: () => Promise<void>;
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
        const email = normalizeEmail(url.searchParams.get("email"));
        const record = email ? store.get(email) : null;
        if (!record) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        if (record.status !== "active") {
          json(res, 402, { error: "payment_required" });
          return;
        }
        const bundle = createBundle({ plan: record.plan, email: record.email });
        if (!bundle) {
          // A free record exists in the ledger but has no addons to configure.
          json(res, 402, { error: "payment_required" });
          return;
        }
        json(res, 200, bundle);
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
        try {
          const result = await createCheckoutSession(stripe, {
            plan: body.value.plan,
            email: typeof body.value.email === "string" ? body.value.email : "",
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

      if (method === "GET" && url.pathname === "/api/entitlement") {
        const email = normalizeEmail(url.searchParams.get("email"));
        const record = email ? store.get(email) : null;
        if (!record) {
          json(res, 404, { error: "unknown_entitlement" });
          return;
        }
        json(res, 200, record);
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
}