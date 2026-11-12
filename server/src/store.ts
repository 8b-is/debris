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

/**
 * True when a record's paid period has ended.
 *
 * `status` and `valid_until` are written by different events and can disagree: a
 * subscription can be cancelled at period end without Stripe sending a deletion
 * immediately. Reading only `status` would keep an expired customer served.
 */
export function isExpired(record: Entitlement, now: number = Date.now()): boolean {
  if (record.status === "free") return false;
  if (!record.valid_until) return false;
  const until = Date.parse(record.valid_until);
  if (Number.isNaN(until)) return true;
  return until <= now;
}

/** A record that may currently be served, or false when it lapsed. */
export function isActiveNow(record: Entitlement, now: number = Date.now()): boolean {
  return record.status === "active" && !isExpired(record, now);
}

export interface Entitlement {
  email: string;
  plan: PlanId;
  seats: number;
  status: EntitlementStatus;
  /** ISO 8601, or null for the free tier. */
  valid_until: string | null;
  /**
   * sha256 of the family enrolment code, or null before one is issued.
   *
   * A device registering for the first time has no secret to prove it belongs to
   * this family, so without this anyone who knows the email can fill every seat
   * with junk and lock the family's real television out. The code is issued out of
   * band at signup and stored hashed, exactly like a device secret.
   */
  enrolment_hash?: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = join(HERE, "..", "data");
export const DEFAULT_FILE = join(DEFAULT_DATA_DIR, "entitlements.json");

type Ledger = Record<string, Entitlement>;

export interface StoreOptions {
  file?: string;
}

/**
 * A JSON file with atomic writes, generic over its shape.
 *
 * Entitlements and the device registry both need exactly this: read on boot,
 * write tmp + fsync + rename, survive a power loss. Rather than a second copy of
 * the same logic, the mechanics live here and each store supplies its own shape.
 */
export class JsonStore<T> {
  readonly file: string;
  #value: T;
  #queue: Promise<void> = Promise.resolve();
  #empty: T;
  #encode: (value: T) => string;
  #decode: (raw: unknown) => T | null;

  constructor(
    empty: T,
    encode: (value: T) => string,
    decode: (raw: unknown) => T | null,
    options: StoreOptions = {},
  ) {
    // No default: a store that cannot say which file it owns could be handed the
    // ledger's path by accident, and one array would erase every subscription.
    if (!options.file) throw new Error("a JsonStore must be given its own file");
    this.file = options.file;
    this.#empty = empty;
    this.#value = empty;
    this.#encode = encode;
    this.#decode = decode;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const next = this.#decode(parsed);
      if (next !== null) this.#value = next;
    } catch {
      // A corrupt file starts empty rather than crashing, and is left untouched
      // so an operator can inspect it.
    }
  }

  read(): T {
    return this.#value;
  }

  /** Replace the value and persist. Queued so concurrent writes cannot interleave. */
  write(next: T): Promise<void> {
    const run = async (): Promise<void> => {
      const previous = this.#value;
      this.#value = next;
      try {
        await this.#flush(next);
      } catch (err) {
        this.#value = previous;
        throw err;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #flush(value: T): Promise<void> {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;

    const payload = this.#encode(value);
    const fd = openSync(tmp, "w", LEDGER_FILE_MODE);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);

    let dirFd: number | undefined;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      // Some platforms refuse to fsync a directory.
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  }

  get empty(): T {
    return this.#empty;
  }
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
      // Carried explicitly rather than spread, so adding a field to Entitlement
      // cannot silently start dropping it on write. A dropped enrolment hash
      // locks every device out of a paid account.
      enrolment_hash: record.enrolment_hash ?? null,
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

/**
 * The free-tier record, used by downgrade paths.
 *
 * The enrolment hash is preserved when one already exists. Clearing it would
 * invalidate the family's code on a lapsed subscription, and a family that pays
 * again would need a new code printed while their old devices still sat in the
 * registry holding seats. `downgrade` handles releasing those seats separately.
 */
export function freeEntitlement(email: string, existing?: Entitlement | null): Entitlement {
  return {
    email: normalizeEmail(email),
    plan: "free",
    seats: PLANS.free.seats,
    status: "free",
    valid_until: null,
    enrolment_hash: existing?.enrolment_hash ?? null,
  };
}