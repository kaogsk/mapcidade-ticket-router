/**
 * knowledgeBase.ts — layer 2: classify by similar closed tickets (SQLite FTS5).
 *
 * Costs nothing and runs in milliseconds: search the closed tickets that look
 * like this subject (BM25, subject weighted 10× over the body) and take the
 * category most of them ended up with. The share of agreement among the hits is
 * the confidence; below the cut the ticket moves on to the AI layer.
 *
 * Deviation from the original, on purpose: a minimum number of hits. With no
 * minimum, ONE similar ticket meant 100% agreement — a confident answer built
 * on a single example.
 */

import type { Category, Service, Urgency } from "../domain.js";
import { norm } from "../text/normalize.js";
import { type Db, tx } from "../store/db.js";

export interface KbTicket {
  subject: string;
  body: string;
  service: Service;
  category: Category;
  urgency: Urgency;
  city?: string | null;
}

export interface KbHit extends KbTicket {
  id: number;
  rank: number;
}

export interface KbVerdict {
  service: Service;
  category: Category;
  urgency: Urgency;
  confidence: number;
  matches: number;
  agreeing: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "our", "are", "was", "not", "can", "please", "need", "help",
  "issue", "ticket", "hello", "team", "city", "into", "have", "has", "but", "you", "your", "they", "them", "its",
]);

/** Subject → safe FTS5 query: quoted tokens OR'ed (no operator injection, tolerant of typos in other words). */
export function toFtsQuery(text: string): string | null {
  const tokens = [...new Set(norm(text).replace(/[^a-z0-9\s]/g, " ").split(/\s+/))]
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 12);
  return tokens.length ? tokens.map((t) => `"${t}"`).join(" OR ") : null;
}

type Row = Record<string, unknown>;

export class KnowledgeBase {
  constructor(
    private readonly db: Db,
    private readonly opts: { minMatches?: number; limit?: number } = {},
  ) {}

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM kb_tickets").get() as Row).n);
  }

  /** Inserts tickets and indexes them (external-content FTS kept in sync by hand). */
  load(tickets: KbTicket[]): number {
    const insert = this.db.prepare("INSERT INTO kb_tickets (subject, body, service, category, urgency, city) VALUES (?, ?, ?, ?, ?, ?)");
    const index = this.db.prepare("INSERT INTO kb_fts (rowid, subject, body) VALUES (?, ?, ?)");
    tx(this.db, () => {
      for (const t of tickets) {
        const r = insert.run(t.subject, t.body, t.service, t.category, t.urgency, t.city ?? null);
        index.run(Number(r.lastInsertRowid), t.subject, t.body);
      }
    });
    return tickets.length;
  }

  search(text: string, limit = this.opts.limit ?? 20): KbHit[] {
    const q = toFtsQuery(text);
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT t.id, t.subject, t.body, t.service, t.category, t.urgency, t.city, bm25(kb_fts, 10.0, 1.0) AS rank
         FROM kb_fts JOIN kb_tickets t ON t.id = kb_fts.rowid
         WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      subject: String(r.subject),
      body: String(r.body),
      service: r.service as Service,
      category: r.category as Category,
      urgency: r.urgency as Urgency,
      city: (r.city as string) ?? null,
      rank: Number(r.rank),
    }));
  }

  /** Majority vote over the top hits for the subject. null when there is not enough evidence. */
  classify(subject: string): KbVerdict | null {
    const hits = this.search(subject);
    if (hits.length < (this.opts.minMatches ?? 3)) return null;
    const top = <K extends keyof KbHit>(field: K) => {
      const freq = new Map<KbHit[K], number>();
      for (const h of hits) freq.set(h[field], (freq.get(h[field]) ?? 0) + 1);
      return [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    };
    const [category, agreeing] = top("category");
    return {
      category: category as Category,
      service: top("service")[0] as Service,
      urgency: top("urgency")[0] as Urgency,
      confidence: agreeing / hits.length,
      matches: hits.length,
      agreeing,
    };
  }
}
