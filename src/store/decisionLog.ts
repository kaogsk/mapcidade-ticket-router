/**
 * decisionLog.ts — what the router did and what is waiting for a human:
 * processed markers (a ticket is handled once — re-processing would send the
 * first reply twice), the routing decision log behind /routing/stats, and the
 * human review queue for AI suggestions below the auto-apply cut.
 */

import type { AiOutput } from "../classify/ai/types.js";
import type { RouteDecision } from "../routing/resolveRoute.js";
import type { Db } from "./db.js";

type Row = Record<string, unknown>;

export interface DecisionRecord {
  id: number;
  at: string;
  ticket: string;
  action: string;
  squadType: string | null;
  ownerId: string | null;
  ownerName: string | null;
  team: string | null;
  city: string | null;
  citySource: string | null;
  fallback: string | null;
  forcedPermits: boolean;
  triageOnly: boolean;
  noise: string | null;
  classSource: string | null;
  category: string | null;
  service: string | null;
  dryRun: boolean;
  reason: string;
  intern: unknown;
}

export interface ReviewItem {
  ticket: string;
  subject: string;
  suggestion: AiOutput | null;
  confidence: number | null;
  reason: string;
  status: "pending" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  final: unknown;
}

export class DecisionLog {
  constructor(private readonly db: Db) {}

  isProcessed(ticket: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed WHERE ticket = ?").get(String(ticket));
  }

  markProcessed(ticket: string, outcome: string): void {
    this.db
      .prepare("INSERT INTO processed (ticket, at, outcome) VALUES (?, ?, ?) ON CONFLICT(ticket) DO UPDATE SET at = excluded.at, outcome = excluded.outcome")
      .run(String(ticket), new Date().toISOString(), outcome);
  }

  processedOutcomes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT outcome, COUNT(*) AS n FROM processed GROUP BY outcome").all() as Row[]) out[String(r.outcome)] = Number(r.n);
    return out;
  }

  record(
    ticket: string,
    d: RouteDecision,
    extra: { classSource?: string | null; category?: string | null; service?: string | null; dryRun?: boolean; intern?: unknown } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO decisions (at, ticket, action, squad_type, owner_id, owner_name, team, city, city_source, fallback,
           forced_permits, triage_only, noise, class_source, category, service, dry_run, reason, intern_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        String(ticket),
        d.action,
        d.squadType ?? null,
        d.owner,
        d.ownerName ?? null,
        d.ownerTeam,
        d.city ?? null,
        d.citySource ?? null,
        d.fallback ?? null,
        d.forcedPermits ? 1 : 0,
        d.triageOnly ? 1 : 0,
        d.noise ?? null,
        extra.classSource ?? null,
        extra.category ?? null,
        extra.service ?? null,
        extra.dryRun ? 1 : 0,
        d.reason,
        extra.intern ? JSON.stringify(extra.intern) : null,
      );
  }

  recent(limit = 50): DecisionRecord[] {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return (this.db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(n) as Row[]).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      ticket: String(r.ticket),
      action: String(r.action),
      squadType: (r.squad_type as string) ?? null,
      ownerId: (r.owner_id as string) ?? null,
      ownerName: (r.owner_name as string) ?? null,
      team: (r.team as string) ?? null,
      city: (r.city as string) ?? null,
      citySource: (r.city_source as string) ?? null,
      fallback: (r.fallback as string) ?? null,
      forcedPermits: !!r.forced_permits,
      triageOnly: !!r.triage_only,
      noise: (r.noise as string) ?? null,
      classSource: (r.class_source as string) ?? null,
      category: (r.category as string) ?? null,
      service: (r.service as string) ?? null,
      dryRun: !!r.dry_run,
      reason: String(r.reason),
      intern: r.intern_json ? JSON.parse(String(r.intern_json)) : null,
    }));
  }

  /** Distribution by destination, load per agent and routing health counters. */
  stats(sinceIso?: string) {
    const since = sinceIso ?? "0000";
    const group = (col: string) => {
      const out: Record<string, number> = {};
      for (const r of this.db.prepare(`SELECT COALESCE(${col}, '-') AS k, COUNT(*) AS n FROM decisions WHERE at >= ? GROUP BY k`).all(since) as Row[]) {
        out[String(r.k)] = Number(r.n);
      }
      return out;
    };
    const one = (sql: string) => Number((this.db.prepare(sql).get(since) as Row).n);
    return {
      total: one("SELECT COUNT(*) AS n FROM decisions WHERE at >= ?"),
      byAction: group("action"),
      byFallback: group("fallback"),
      byClassificationSource: group("class_source"),
      perAgent: group("owner_name"),
      forcedPermits: one("SELECT COUNT(*) AS n FROM decisions WHERE at >= ? AND forced_permits = 1"),
      cityUnknown: one("SELECT COUNT(*) AS n FROM decisions WHERE at >= ? AND fallback = 'city_unknown'"),
      duringTriageOnly: one("SELECT COUNT(*) AS n FROM decisions WHERE at >= ? AND triage_only = 1"),
    };
  }

  // ── human review queue ──

  enqueueReview(input: { ticket: string; subject: string; suggestion: AiOutput | null; confidence: number | null; reason: string }): void {
    this.db
      .prepare(
        `INSERT INTO review_queue (ticket, subject, suggestion, confidence, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(ticket) DO UPDATE SET suggestion = excluded.suggestion, confidence = excluded.confidence,
           reason = excluded.reason, status = 'pending', resolved_at = NULL, resolved_by = NULL, final = NULL`,
      )
      .run(
        String(input.ticket),
        input.subject,
        input.suggestion ? JSON.stringify(input.suggestion) : null,
        input.confidence,
        input.reason,
        new Date().toISOString(),
      );
  }

  getReview(ticket: string): ReviewItem | null {
    const r = this.db.prepare("SELECT * FROM review_queue WHERE ticket = ?").get(String(ticket)) as Row | undefined;
    return r ? toReview(r) : null;
  }

  reviews(status: "pending" | "resolved" | "all" = "pending"): ReviewItem[] {
    const rows = (status === "all"
      ? this.db.prepare("SELECT * FROM review_queue ORDER BY created_at DESC").all()
      : this.db.prepare("SELECT * FROM review_queue WHERE status = ? ORDER BY created_at DESC").all(status)) as Row[];
    return rows.map(toReview);
  }

  resolveReview(ticket: string, final: unknown, actor: string): void {
    this.db
      .prepare("UPDATE review_queue SET status = 'resolved', resolved_at = ?, resolved_by = ?, final = ? WHERE ticket = ?")
      .run(new Date().toISOString(), actor, JSON.stringify(final), String(ticket));
  }
}

function toReview(r: Row): ReviewItem {
  return {
    ticket: String(r.ticket),
    subject: String(r.subject),
    suggestion: r.suggestion ? (JSON.parse(String(r.suggestion)) as AiOutput) : null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    reason: String(r.reason),
    status: r.status as ReviewItem["status"],
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string) ?? null,
    resolvedBy: (r.resolved_by as string) ?? null,
    final: r.final ? JSON.parse(String(r.final)) : null,
  };
}
