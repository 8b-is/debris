/**
 * A one-line audit log for the events that move money or grant access.
 *
 * Every entitlement change comes from a webhook, and a webhook arrives with no
 * operator watching. Without this, "why does this customer have household" has no
 * answer after the fact.
 *
 * This is an audit trail, not telemetry: it is written to the process's own stdout,
 * never shipped anywhere, and it records no request bodies — only the event type,
 * the email, and the resulting plan. The landing makes no request beyond checkout
 * and nothing here phones home (README, "what debris never does").
 */

import { appendFileSync } from "node:fs";

export interface AuditEntry {
  /** What happened, e.g. `entitlement.granted`. */
  event: string;
  /** Who it happened to. Already normalised. */
  email: string;
  /** The resulting plan, when there is one. */
  plan?: string;
  /** Stripe's event id, so a replay is visible as a duplicate. */
  stripe_event?: string;
}

/** Serialise one entry. Newline-delimited JSON: one object per line. */
export function formatAudit(entry: AuditEntry): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
}

/**
 * Append one entry to the audit stream.
 *
 * Failures are swallowed deliberately: a service that refuses to grant an
 * entitlement because its log could not be written has traded a working product
 * for a complete log. The console error is the fallback.
 */
export function audit(entry: AuditEntry): void {
  const line = formatAudit(entry);
  try {
    appendFileSync(process.env.DEBRIS_AUDIT_LOG ?? "", line);
  } catch {
    // No log file configured, or it is unwritable. stdout is the fallback.
  }
  process.stdout.write(`audit ${line}`);
}