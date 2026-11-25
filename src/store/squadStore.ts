/**
 * squadStore.ts — editable overlay on top of the reviewable squad map + audit.
 *
 * The baseline (data/seed/squads.json) stays in git. Every edit made by a
 * manager in the panel/CLI/API lives HERE, so that:
 *   - a deploy (git pull) never conflicts with mutable state;
 *   - the change applies on the next routing decision, without a restart;
 *   - there is a history of who changed what.
 *
 * `version` is bumped in the SAME transaction as every write. It invalidates the
 * registry cache and lets the API reject a concurrent edit (409) instead of
 * silently overwriting it.
 */

import type { SquadType } from "../domain.js";
import { SQUAD_TYPES } from "../domain.js";
import { type Db, tx } from "./db.js";

export interface OverlayCity {
  type: SquadType;
  cityNorm: string;
  city: string;
  /** null = city explicitly taken away from its baseline owner (falls to N1) */
  agentId: string | null;
  agentName: string | null;
}

export interface OverlayMember {
  agentId: string;
  name: string;
  removed: boolean;
}

export interface Overlay {
  version: number;
  cities: OverlayCity[];
  members: OverlayMember[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  type: string | null;
  city: string | null;
  fromAgent: string | null;
  toAgent: string | null;
  note: string | null;
}

interface AuditInput {
  actor?: string | null;
  action: string;
  type?: string | null;
  city?: string | null;
  fromAgent?: string | null;
  toAgent?: string | null;
  note?: string | null;
}

type Row = Record<string, unknown>;

export class SquadStore {
  constructor(private readonly db: Db) {}

  version(): number {
    return Number((this.db.prepare("SELECT version FROM squad_meta WHERE id = 1").get() as Row).version);
  }

  overlay(): Overlay {
    const cities = (this.db.prepare("SELECT type, city_norm, city, agent_id, agent_name FROM squad_city ORDER BY type, city_norm").all() as Row[]).map(
      (r) => ({
        type: r.type as SquadType,
        cityNorm: String(r.city_norm),
        city: String(r.city),
        agentId: r.agent_id == null ? null : String(r.agent_id),
        agentName: r.agent_name == null ? null : String(r.agent_name),
      }),
    );
    const members = (this.db.prepare("SELECT agent_id, name, removed FROM squad_member ORDER BY name").all() as Row[]).map((r) => ({
      agentId: String(r.agent_id),
      name: String(r.name),
      removed: !!r.removed,
    }));
    return { version: this.version(), cities, members };
  }

  /** write + audit row + version bump, atomically. Returns the new version. */
  private write(apply: (now: string) => void, audit: AuditInput): number {
    const now = new Date().toISOString();
    tx(this.db, () => {
      apply(now);
      this.db
        .prepare(
          `INSERT INTO squad_audit (at, actor, action, type, city, from_agent, to_agent, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          now,
          String(audit.actor || "unknown"),
          audit.action,
          audit.type ?? null,
          audit.city ?? null,
          audit.fromAgent ?? null,
          audit.toAgent ?? null,
          audit.note ? String(audit.note).trim().slice(0, 300) : null,
        );
      this.db.prepare("UPDATE squad_meta SET version = version + 1 WHERE id = 1").run();
    });
    return this.version();
  }

  setCity(input: {
    type: SquadType;
    cityNorm: string;
    city: string;
    agentId: string | null;
    agentName?: string | null;
    actor?: string | null;
    fromAgent?: string | null;
  }): number {
    if (!SQUAD_TYPES.includes(input.type)) throw new Error(`invalid type: ${input.type}`);
    if (!input.cityNorm || !input.city) throw new Error("city is required");
    const id = input.agentId == null ? null : String(input.agentId);
    if (id !== null && !/^\d+$/.test(id)) throw new Error("invalid agentId");
    return this.write(
      (now) =>
        this.db
          .prepare(
            `INSERT INTO squad_city (type, city_norm, city, agent_id, agent_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(type, city_norm) DO UPDATE SET city = excluded.city, agent_id = excluded.agent_id,
               agent_name = excluded.agent_name, updated_at = excluded.updated_at`,
          )
          .run(input.type, input.cityNorm, input.city, id, id === null ? null : (input.agentName ?? null), now),
      {
        actor: input.actor,
        action: id === null ? "remove_city" : "move_city",
        type: input.type,
        city: input.city,
        fromAgent: input.fromAgent ?? null,
        toAgent: id === null ? null : (input.agentName ?? id),
      },
    );
  }

  addMember(input: { agentId: string; name: string; actor?: string | null }): number {
    const id = String(input.agentId ?? "").trim();
    if (!/^\d+$/.test(id)) throw new Error("invalid agentId");
    if (!input.name) throw new Error("name is required");
    return this.write(
      (now) =>
        this.db
          .prepare(
            `INSERT INTO squad_member (agent_id, name, removed, updated_at) VALUES (?, ?, 0, ?)
             ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, removed = 0, updated_at = excluded.updated_at`,
          )
          .run(id, input.name, now),
      { actor: input.actor, action: "add_member", toAgent: input.name },
    );
  }

  removeMember(input: { agentId: string; actor?: string | null; name?: string | null }): number {
    const id = String(input.agentId ?? "").trim();
    if (!/^\d+$/.test(id)) throw new Error("invalid agentId");
    const current = this.db.prepare("SELECT name FROM squad_member WHERE agent_id = ?").get(id) as Row | undefined;
    const name = (current?.name as string) || input.name || id;
    return this.write(
      (now) =>
        this.db
          .prepare(
            `INSERT INTO squad_member (agent_id, name, removed, updated_at) VALUES (?, ?, 1, ?)
             ON CONFLICT(agent_id) DO UPDATE SET removed = 1, updated_at = excluded.updated_at`,
          )
          .run(id, name, now),
      { actor: input.actor, action: "remove_member", toAgent: name },
    );
  }

  /** Vacation state lives in RoutingStore; this only records the history line. */
  recordAway(input: { agentName: string; away: boolean; note?: string | null; actor?: string | null }): number {
    return this.write(() => undefined, {
      actor: input.actor,
      action: "set_away",
      toAgent: input.agentName,
      note: input.note || (input.away ? "away" : "available"),
    });
  }

  /** Who paused distribution for the whole support team, and when, is what gets asked later. */
  recordTriageOnly(input: { active: boolean; note?: string | null; actor?: string | null }): number {
    return this.write(() => undefined, {
      actor: input.actor,
      action: "set_triage_only",
      toAgent: input.active ? "PAUSED" : "RESUMED",
      note: input.note || (input.active ? "distribution paused (everything to triage)" : "distribution resumed"),
    });
  }

  audit(limit = 50): AuditEntry[] {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return (this.db.prepare("SELECT * FROM squad_audit ORDER BY id DESC LIMIT ?").all(n) as Row[]).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      type: (r.type as string) ?? null,
      city: (r.city as string) ?? null,
      fromAgent: (r.from_agent as string) ?? null,
      toAgent: (r.to_agent as string) ?? null,
      note: (r.note as string) ?? null,
    }));
  }
}
