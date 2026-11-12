/**
 * Entitlement ledger.
 *
 * A JSON file with atomic writes. Correct size of solution for a family
 * (README "what is deliberately absent"). No database, no schema migration.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEDGER_FILE_MODE, MONTHS_PER_YEAR, MS_PER_SECOND } from "./consts.ts";
import { PLANS, type PlanId } from "./plans.ts";

export type EntitlementStatus = "active" | "past_due" | "free";

export interface Entitlement {
  email: string;
  plan: PlanId;
  seats: number;
  status: EntitlementStatus;
  /** ISO 8601, or null for the free tier. */
  valid_until: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(HERE, "..", "data");
export const DEFAULT_FILE = join(DEFAULT_DATA_DIR, "entitlements.json");

type Ledger = Record<string, Entitlement>;

export interface StoreOptions {
  file?: string;
}

/**
 * The store. Reads are served from memory; writes are queued so concurrent
 * callers cannot interleave and the temp-file rename stays atomic.
 */
export class EntitlementStore {
  readonly file: string;
  #ledger: Ledger = {};
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: StoreOptions = {}) {
    this.file = options.file ?? DEFAULT_FILE;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.#ledger = raw as Ledger;
      }
    } catch {
      // A corrupt ledger is not silently discarded: start empty rather than
      // crash, but leave the file untouched so an operator can inspect it.
      this.#ledger = {};
    }
  }

  get(email: string): Entitlement | null {
    const key = normalizeEmail(email);
    if (!key) return null;
    return this.#ledger[key] ?? null;
  }

  all(): Entitlement[] {
    return Object.values(this.#ledger);
  }

  /**
   * Insert or replace one entitlement. Resolves once the file has landed.
   *
   * The ledger is updated only after a successful flush. Updating memory first
   * would leave the store claiming a write that never reached disk, and a later
   * read would report it as persisted.
   */
  put(record: Entitlement): Promise<void> {
    const key = normalizeEmail(record.email);
    if (!key) return Promise.reject(new Error("email_required"));

    const next: Entitlement = {
      email: key,
      plan: record.plan,
      seats: record.seats,
      status: record.status,
      valid_until: record.valid_until ?? null,
    };

    const run = async (): Promise<void> => {
      const previous = this.#ledger[key];
      this.#ledger[key] = next;
      try {
        await this.#flush();
      } catch (err) {
        // Roll memory back so a failed write is not reported as persisted.
        if (previous === undefined) delete this.#ledger[key];
        else this.#ledger[key] = previous;
        throw err;
      }
    };

    // Chain onto the queue, but keep the queue itself from ever rejecting:
    // a failed write must not poison every later write.
    const result = this.#writeQueue.then(run, run);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #flush(): Promise<void> {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;

    const payload = `${JSON.stringify(this.#ledger, null, 2)}\n`;
    const fd = openSync(tmp, "w", LEDGER_FILE_MODE);
    try {
      writeSync(fd, payload);
      // Without the sync, the rename can reach disk before the bytes do, and a
      // power loss leaves a valid but empty ledger. That is a silent loss of
      // every entitlement.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Same directory, so this is a rename rather than a copy.
    renameSync(tmp, this.file);

    // Sync the directory too, so the rename itself is durable.
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      // Some platforms refuse to fsync a directory. The file sync above is the
      // load-bearing one; this is best effort.
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  }
}

/** Lower-case and trim an email. Returns "" for anything unusable. */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/**
 * One month from a Unix timestamp in seconds, clamped to the last valid day.
 *
 * A naive `setUTCMonth(+1)` turns 31 January into 3 March: the 31st of February
 * does not exist, so the overflow rolls forward twice. We clamp to the last day
 * of the target month instead, which is what a subscription actually means.
 */
export function oneMonthAfter(seconds: number): string {
  const d = new Date(seconds * MS_PER_SECOND);
  const targetMonth = d.getUTCMonth() + 1;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonth / MONTHS_PER_YEAR);
  const month = ((targetMonth % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return new Date(Date.UTC(targetYear, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())).toISOString();
}

/** The free-tier record, used by downgrade paths. */
export function freeEntitlement(email: string): Entitlement {
  return {
    email: normalizeEmail(email),
    plan: "free",
    seats: PLANS.free.seats,
    status: "free",
    valid_until: null,
  };
}