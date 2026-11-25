/**
 * routingStore.ts — the routing switches, read on EVERY decision:
 *  - agent availability (vacation/leave): the agent's cities go on standby and
 *    fall to the N1 queue; flipping it back restores direct assignment at once;
 *  - "triage only" mode (global pause): nothing is distributed, everything stays
 *    with the triage agent;
 *  - N1 watch: tickets left in the N1 queue without an owner, to send back to
 *    triage if nobody picks them up.
 *
 * Persisted so a restart never loses a vacation or a pause, and cheap to read
 * (single-row primary-key lookups) because the poller reads them per ticket.
 */

import type { Db } from "./db.js";

export interface Availability {
  agentId: string;
  away: boolean;
  note: string | null;
  updatedAt: string;
}

export interface TriageOnlyMode {
  active: boolean;
  actor: string | null;
  note: string | null;
  updatedAt: string | null;
}

type Row = Record<string, unknown>;

export class RoutingStore {
  constructor(private readonly db: Db) {}

  setAgentAway(agentId: string, away: boolean, opts: { note?: string | null; now?: string } = {}): Availability {
    const id = String(agentId ?? "").trim();
    if (!/^\d+$/.test(id)) throw new Error("invalid agentId");
    if (typeof away !== "boolean") throw new Error("away must be a boolean");
    const note = opts.note ? String(opts.note).trim().slice(0, 300) : null;
    this.db
      .prepare(
        `INSERT INTO agent_availability (agent_id, away, note, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET away = excluded.away, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(id, away ? 1 : 0, note, opts.now ?? new Date().toISOString());
    return this.getAvailability(id)!;
  }

  getAvailability(agentId: string): Availability | null {
    const row = this.db
      .prepare("SELECT agent_id, away, note, updated_at FROM agent_availability WHERE agent_id = ?")
      .get(String(agentId)) as Row | undefined;
    return row ? toAvailability(row) : null;
  }

  listAvailability(): Availability[] {
    return (this.db.prepare("SELECT agent_id, away, note, updated_at FROM agent_availability ORDER BY agent_id").all() as Row[]).map(toAvailability);
  }

  awayAgentIds(): Set<string> {
    return new Set(
      (this.db.prepare("SELECT agent_id FROM agent_availability WHERE away = 1").all() as Row[]).map((r) => String(r.agent_id)),
    );
  }

  /** Missing row = off: a database from an older schema must never come up paused. */
  triageOnly(): TriageOnlyMode {
    const row = this.db.prepare("SELECT triage_only, actor, note, updated_at FROM routing_mode WHERE id = 1").get() as Row | undefined;
    return {
      active: !!row?.triage_only,
      actor: (row?.actor as string) ?? null,
      note: (row?.note as string) ?? null,
      updatedAt: (row?.updated_at as string) ?? null,
    };
  }

  setTriageOnly(active: boolean, opts: { actor?: string | null; note?: string | null; now?: string } = {}): TriageOnlyMode {
    if (typeof active !== "boolean") throw new Error("active must be a boolean");
    this.db
      .prepare(
        `INSERT INTO routing_mode (id, triage_only, actor, note, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET triage_only = excluded.triage_only, actor = excluded.actor,
           note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(
        active ? 1 : 0,
        opts.actor ? String(opts.actor).slice(0, 120) : null,
        opts.note ? String(opts.note).trim().slice(0, 300) : null,
        opts.now ?? new Date().toISOString(),
      );
    return this.triageOnly();
  }

  /** Start watching a ticket left in the N1 queue without owner (idempotent). */
  watch(ticketId: string, now: number = Date.now()): void {
    this.db.prepare("INSERT OR IGNORE INTO n1_watch (ticket, routed_at) VALUES (?, ?)").run(String(ticketId), now);
  }

  unwatch(ticketId: string): void {
    this.db.prepare("DELETE FROM n1_watch WHERE ticket = ?").run(String(ticketId));
  }

  /** Tickets watched for longer than `ageMs`. */
  due(ageMs: number, now: number = Date.now()): string[] {
    return (this.db.prepare("SELECT ticket FROM n1_watch WHERE routed_at <= ? ORDER BY routed_at").all(now - ageMs) as Row[]).map((r) =>
      String(r.ticket),
    );
  }

  watchCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM n1_watch").get() as Row).n);
  }
}

function toAvailability(row: Row): Availability {
  return {
    agentId: String(row.agent_id),
    away: !!row.away,
    note: (row.note as string) ?? null,
    updatedAt: String(row.updated_at),
  };
}
