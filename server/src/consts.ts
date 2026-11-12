/**
 * Canonical constants.
 *
 * Every number below carries a meaning that a call site cannot express. An HTTP
 * status code does not belong here — `400` is the protocol, not a decision.
 */

/** Largest request body accepted, in bytes. A webhook is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

import { readFileSync } from "node:fs";

/** Default listening port. */
export const DEFAULT_PORT = 8787;

/** How stale a signed webhook may be, in seconds. Five minutes is Stripe's own window. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Permissions on the entitlement ledger: owner read/write only. */
export const LEDGER_FILE_MODE = 0o600;

/** Months in a year. Named so the month arithmetic reads as arithmetic. */
export const MONTHS_PER_YEAR = 12;

/** Milliseconds in a second, for the seconds-to-millis conversions Stripe forces on us. */
export const MS_PER_SECOND = 1000;

/** How long a request body may take to arrive, in milliseconds. */
export const BODY_TIMEOUT_MS = 10_000;

/** How long a payment call may take before it is abandoned, in milliseconds. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** How long a restart may take to drain before it gives up and exits. */
export const SHUTDOWN_GRACE_MS = 15_000;

/**
 * A device not seen for this many days is stale enough to sweep.
 *
 * Ninety days is longer than any plausible family holiday and shorter than the
 * time it takes a house to fill with abandoned tablets.
 */
export const DEVICE_STALE_DAYS = 90;

/**
 * Version reported by /healthz.
 *
 * Read from package.json at import so a release is one edit in one file. If the
 * manifest is unreadable we fall back to "0.0.0" rather than crash: a version
 * string is not worth a failed boot.
 */
export const VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();