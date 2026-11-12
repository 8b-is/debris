/**
 * A per-caller token bucket, for the routes a stranger can reach.
 *
 * This is not a defence against guessing an enrolment code — that is 50 bits and
 * not the threat. It is a defence against being made to do work: every request to
 * /api/bundle does a sha256 and, for a first-time device, a registry write and an
 * fsync. A caller who can send those without limit is choosing how much disk the
 * service writes.
 *
 * Keyed by remote address, with the usual caveat: behind a reverse proxy every
 * request shares one address unless the proxy is trusted for the forwarding header.
 * The service assumes it is reached directly or through a proxy that sets it.
 */

/** Requests allowed per window, and the window length. */
export interface BucketOptions {
  capacity: number;
  windowMs: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  readonly #capacity: number;
  readonly #windowMs: number;
  #buckets = new Map<string, Bucket>();

  constructor(options: BucketOptions) {
    this.#capacity = options.capacity;
    this.#windowMs = options.windowMs;
  }

  /** True when the caller may proceed. Consumes one token when it does. */
  allow(key: string, now: number = Date.now()): boolean {
    if (!key) return true; // no identity, no bucket: never the thing that blocks
    const bucket = this.#buckets.get(key);

    if (!bucket) {
      this.#buckets.set(key, { tokens: this.#capacity - 1, last: now });
      return true;
    }

    // Refill proportionally to elapsed time, so a quiet caller recovers steadily
    // rather than in a lump at the window boundary.
    const elapsed = now - bucket.last;
    if (elapsed > 0) {
      const refill = (elapsed / this.#windowMs) * this.#capacity;
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + refill);
      bucket.last = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Drop buckets for callers not seen for a while. */
  sweep(now: number = Date.now(), maxIdleMs: number = 600_000): number {
    let dropped = 0;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.last > maxIdleMs) {
        this.#buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.#buckets.size;
  }
}