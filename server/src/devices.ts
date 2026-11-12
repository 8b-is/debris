/**
 * Device registry.
 *
 * A device is one physical thing that asks for a bundle: a TV, a phone, a laptop.
 * It gets one secret, issued on first use, and that secret is what makes the seat
 * limit mean anything (docs/adr/0005).
 *
 * Secrets are stored hashed, never in the clear. A leaked registry file must not
 * be enough to impersonate a device, which is the whole reason a token exists
 * rather than just trusting an email.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { JsonStore } from "./store.ts";

export interface Device {
  /** Stable id, used in the URL and the audit line. */
  id: string;
  email: string;
  name: string;
  /** sha256 of the secret, hex. The secret itself is never stored. */
  secret_hash: string;
  created_at: string;
  last_seen_at: string;
}

type Registry = Record<string, Device>;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newId(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length]!;
  return `dev_${out}`;
}

/** Hash a secret. There is no unhash, and there is no need for one. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time secret comparison.
 *
 * Length is compared first because timingSafeEqual requires equal buffers; the
 * length of a hash is not a secret.
 */
export function secretMatches(secret: string, storedHash: string): boolean {
  const got = Buffer.from(hashSecret(secret), "hex");
  let want: Buffer;
  try {
    want = Buffer.from(storedHash, "hex");
  } catch {
    return false;
  }
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export interface IssuedDevice {
  device: Device;
  /** Shown once. The only time the secret exists outside this process. */
  secret: string;
}

export class DeviceRegistry {
  #devices: Registry = {};
  #onPersist: ((devices: Device[]) => void) | null = null;

  constructor(seed?: readonly Device[]) {
    for (const d of seed ?? []) this.#devices[d.id] = d;
  }

  /**
   * Persist after every change.
   *
   * A registry held only in memory forgets every device on restart, and a device
   * that is no longer known asks for a new seat. Nine devices and a restart is
   * nine burned seats, so the registry has to survive the process.
   */
  persistOnChange(sink: (devices: Device[]) => void): void {
    this.#onPersist = sink;
  }

  #changed(): void {
    this.#onPersist?.(this.all());
  }

  /** Every device for one email, oldest first. */
  forEmail(email: string): Device[] {
    const key = email.trim().toLowerCase();
    return Object.values(this.#devices)
      .filter((d) => d.email === key)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  count(email: string): number {
    return this.forEmail(email).length;
  }

  /** Look up by id, or null. */
  get(id: string): Device | null {
    return this.#devices[id] ?? null;
  }

  /**
   * Issue a device, or return the existing one if this device is already known.
   *
   * `existingSecret` is the secret presented by a caller who may already be
   * registered. When it matches a known device for the same email, that device is
   * returned and no new seat is consumed — a TV that reconnects must not cost a
   * second seat.
   */
  issue(email: string, name: string, existingSecret?: string): IssuedDevice | null {
    const key = email.trim().toLowerCase();
    if (!key) return null;

    if (existingSecret) {
      const match = this.#matchSecret(existingSecret);
      if (match && match.email === key) {
        match.last_seen_at = new Date().toISOString();
        this.#changed();
        // The secret is already held by the caller; returning a fresh one would
        // silently rotate a device that did nothing wrong.
        return { device: { ...match }, secret: existingSecret };
      }
    }

    const now = new Date().toISOString();
    const secret = randomBytes(32).toString("base64url");
    const device: Device = {
      id: newId(),
      email: key,
      name: (name || "unnamed device").trim().slice(0, 64),
      secret_hash: hashSecret(secret),
      created_at: now,
      last_seen_at: now,
    };
    this.#devices[device.id] = device;
    this.#changed();
    return { device: { ...device }, secret };
  }

  /** Resolve a presented secret to a device, or null. */
  #matchSecret(secret: string): Device | null {
    for (const d of Object.values(this.#devices)) {
      if (secretMatches(secret, d.secret_hash)) return d;
    }
    return null;
  }

  /**
   * Verify a presented secret belongs to this email, and refresh last_seen.
   *
   * Returns the device when the secret matches, null otherwise. A secret valid
   * for a different email is a mismatch, not a partial success.
   */
  authenticate(email: string, secret: string): Device | null {
    const key = email.trim().toLowerCase();
    if (!key || !secret) return null;
    const found = this.#matchSecret(secret);
    if (!found) return null;
    if (found.email !== key) return null;
    found.last_seen_at = new Date().toISOString();
    this.#changed();
    return { ...found };
  }

  /**
   * Drop devices that have not been seen for `staleDays`.
   *
   * `last_seen_at` was recorded and never acted on, so a phone sold in March still
   * held a seat in November and the family cap slowly filled with ghosts. Returns
   * the ids it removed, so the caller can audit them.
   *
   * Devices are only removed on an explicit sweep, never as a side effect of a
   * read: a family that is away for a month must not come home to find its TVs
   * deregistered.
   */
  sweepStale(staleDays: number, now: number = Date.now()): string[] {
    const cutoff = now - staleDays * 86_400_000;
    const removed: string[] = [];
    for (const d of Object.values(this.#devices)) {
      const seen = Date.parse(d.last_seen_at);
      if (Number.isNaN(seen) || seen < cutoff) {
        delete this.#devices[d.id];
        removed.push(d.id);
      }
    }
    if (removed.length > 0) this.#changed();
    return removed;
  }

  /** Revoke one device by id. Returns false when it does not exist. */
  revoke(id: string): boolean {
    if (!this.#devices[id]) return false;
    delete this.#devices[id];
    this.#changed();
    return true;
  }

  /** Every device, for persistence. */
  all(): Device[] {
    return Object.values(this.#devices);
  }
}

/** Where the device registry lives. */
export const DEFAULT_DEVICES_FILE = join(
  // Same directory as the entitlement ledger.
  new URL(".", import.meta.url).pathname.replace(/\/$/, ""),
  "..",
  "data",
  "devices.json",
);

/** Load the registry from disk, or start empty. */
export function loadDevices(file: string = DEFAULT_DEVICES_FILE): DeviceRegistry {
  // The file is required, never defaulted to the entitlement ledger's path: a
  // registry that shares the ledger's file would overwrite every subscription
  // with an array of devices on the first registration.
  const store = new JsonStore<Device[]>(
    [],
    (devices) => `${JSON.stringify(devices, null, 2)}\n`,
    (raw) => (Array.isArray(raw) ? (raw as Device[]) : null),
    { file },
  );
  const registry = new DeviceRegistry(store.read());
  registry.persistOnChange((devices) => {
    void store.write(devices);
  });
  return registry;
}
