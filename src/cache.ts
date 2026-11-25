/**
 * cache.ts — TTL cache keyed by a content hash.
 *
 * Used for the triage preview: the same ticket with the same content (subject,
 * last action, status) returns the cached analysis instead of running the
 * pipeline again; any new message changes the hash and invalidates it.
 */

import crypto from "node:crypto";
import type { Ticket } from "./domain.js";

export function ticketHash(t: Pick<Ticket, "subject" | "status" | "actions" | "category" | "service">): string {
  const last = t.actions.reduce((m, a) => Math.max(m, a.id), 0);
  return crypto.createHash("sha1").update([t.subject, t.status, t.category ?? "", t.service ?? "", last, t.actions.length].join("\u0001")).digest("hex");
}

export class HashCache<V> {
  private readonly entries = new Map<string, { hash: string; value: V; expires: number }>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, hash: string): V | undefined {
    const e = this.entries.get(key);
    if (!e || e.hash !== hash || e.expires < this.now()) {
      this.misses++;
      if (e) this.entries.delete(key);
      return undefined;
    }
    this.hits++;
    return e.value;
  }

  set(key: string, hash: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { hash, value, expires: this.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  stats() {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
