/**
 * squadAdmin.ts — rules of the squad/vacation/pause operations.
 *
 * Every function returns {status, body} and knows nothing about HTTP, so the
 * same rules serve the REST API, the CLI and (through the API) the MCP bridge,
 * and are tested without starting a server. Invariants enforced here:
 *   - an owner must be an active N1/N2 agent;
 *   - a city must exist in the catalog (or already be in the map);
 *   - one owner per (city, type);
 *   - writes blocked when the editor is disabled — EXCEPT turning the pause
 *     off, which is the safe state and must never become unreachable;
 *   - a concurrent edit (stale expectedVersion) is a 409, not a silent overwrite;
 *   - no change reassigns tickets that are already open.
 */

import type { Catalog } from "../catalog.js";
import type { SquadType } from "../domain.js";
import { SQUAD_TYPES } from "../domain.js";
import type { SquadRegistry } from "../routing/squadRegistry.js";
import type { RoutingStore } from "../store/routingStore.js";
import type { SquadStore } from "../store/squadStore.js";
import { norm } from "../text/normalize.js";

export interface AdminResult {
  status: number;
  body: Record<string, unknown>;
}

export interface SquadAdminDeps {
  registry: SquadRegistry;
  store: SquadStore;
  routingStore: RoutingStore;
  catalog: Catalog;
  editorEnabled: boolean;
}

const fail = (status: number, error: string): AdminResult => ({ status, body: { ok: false, error } });

export function createSquadAdmin(d: SquadAdminDeps) {
  const cityIndex = (): Map<string, string> => {
    const m = new Map(d.catalog.cities.map((c) => [norm(c.name), c.name]));
    const eff = d.registry.effective();
    for (const t of SQUAD_TYPES) for (const e of eff.types[t]) if (!m.has(e.cityNorm)) m.set(e.cityNorm, e.city);
    return m;
  };
  const candidates = () => d.catalog.agents.agents.filter((a) => a.active && (a.level === "N1" || a.level === "N2"));
  const candidate = (id: unknown) => candidates().find((a) => a.id === String(id ?? "").trim()) ?? null;
  const validId = (id: unknown) => /^\d+$/.test(String(id ?? "").trim());
  const stale = (expected: unknown): AdminResult | null => {
    if (expected === undefined || expected === null) return null;
    const current = d.store.version();
    return Number(expected) === current ? null : { status: 409, body: { ok: false, error: "the squad map changed since you loaded it; reload and retry", version: current } };
  };
  const nameOf = (id: string) => d.catalog.agents.agents.find((a) => a.id === id)?.name ?? d.store.overlay().members.find((m) => m.agentId === id)?.name ?? id;

  function getSquads(): AdminResult {
    const eff = d.registry.effective();
    const away = d.routingStore.awayAgentIds();
    const types = {} as Record<SquadType, unknown[]>;
    for (const t of SQUAD_TYPES) types[t] = eff.types[t].map((e) => ({ ...e, away: away.has(e.id) }));

    // roster = agents with a city + members added without a city yet (otherwise invisible)
    const roster = new Map(d.registry.agents().map((a) => [a.id, { ...a, away: away.has(a.id) }]));
    for (const m of d.store.overlay().members) {
      if (m.removed || roster.has(m.agentId)) continue;
      roster.set(m.agentId, { id: m.agentId, name: m.name, types: [], cities: [], away: away.has(m.agentId) });
    }
    const mode = d.routingStore.triageOnly();
    return {
      status: 200,
      body: {
        ok: true,
        version: eff.version,
        editorEnabled: d.editorEnabled,
        triageOnly: mode,
        types,
        members: [...roster.values()].sort((a, b) => a.name.localeCompare(b.name)),
        warnings: d.registry.current().warnings,
      },
    };
  }

  function setCity(input: { type?: unknown; city?: unknown; agentId?: unknown; expectedVersion?: unknown; actor?: string }): AdminResult {
    if (!d.editorEnabled) return fail(503, "squad editing is disabled (SQUAD_EDITOR_ENABLED=0)");
    const conflict = stale(input.expectedVersion);
    if (conflict) return conflict;
    const type = String(input.type) as SquadType;
    if (!SQUAD_TYPES.includes(type)) return fail(400, `type must be one of ${SQUAD_TYPES.join(", ")}`);
    const cityNorm = norm(input.city);
    const city = cityIndex().get(cityNorm);
    if (!city) return fail(400, `unknown city: ${String(input.city)}`);

    const current = d.registry.current()[type][cityNorm];
    let agentId: string | null = null;
    let agentName: string | null = null;
    if (input.agentId !== null && input.agentId !== undefined && input.agentId !== "") {
      if (!validId(input.agentId)) return fail(400, `invalid agentId: ${String(input.agentId)}`);
      const agent = candidate(input.agentId);
      if (!agent) return fail(400, `${String(input.agentId)} is not an active N1/N2 agent`);
      agentId = agent.id;
      agentName = agent.name;
    }
    if ((current?.id ?? null) === agentId) return { status: 200, body: { ok: true, unchanged: true, version: d.store.version() } };
    const version = d.store.setCity({
      type, cityNorm, city, agentId, agentName, actor: input.actor, fromAgent: current?.name ?? null,
    });
    return { status: 200, body: { ok: true, version, type, city, owner: agentName, previous: current?.name ?? null } };
  }

  function addMember(input: { agentId?: unknown; city?: unknown; type?: unknown; actor?: string }): AdminResult {
    if (!d.editorEnabled) return fail(503, "squad editing is disabled (SQUAD_EDITOR_ENABLED=0)");
    if (!validId(input.agentId)) return fail(400, `invalid agentId: ${String(input.agentId)}`);
    const agent = candidate(input.agentId);
    if (!agent) return fail(400, `${String(input.agentId)} is not an active N1/N2 agent`);
    // validate the optional city BEFORE writing anything: no half-applied add
    if (input.city) {
      if (!SQUAD_TYPES.includes(String(input.type) as SquadType)) return fail(400, "type is required with a city");
      if (!cityIndex().has(norm(input.city))) return fail(400, `unknown city: ${String(input.city)}`);
    }
    let version = d.store.addMember({ agentId: agent.id, name: agent.name, actor: input.actor });
    if (input.city) {
      const r = setCity({ type: input.type, city: input.city, agentId: agent.id, actor: input.actor });
      if (r.status !== 200) return r;
      version = Number(r.body.version);
    }
    return { status: 200, body: { ok: true, version, agent: agent.name } };
  }

  function removeMember(input: { agentId?: unknown; actor?: string }): AdminResult {
    if (!d.editorEnabled) return fail(503, "squad editing is disabled (SQUAD_EDITOR_ENABLED=0)");
    if (!validId(input.agentId)) return fail(400, `invalid agentId: ${String(input.agentId)}`);
    const id = String(input.agentId).trim();
    // drop overlay cities owned by the agent too, or they would keep receiving tickets
    for (const c of d.store.overlay().cities.filter((x) => x.agentId === id)) {
      d.store.setCity({ type: c.type, cityNorm: c.cityNorm, city: c.city, agentId: null, actor: input.actor, fromAgent: c.agentName });
    }
    const version = d.store.removeMember({ agentId: id, actor: input.actor, name: nameOf(id) });
    return { status: 200, body: { ok: true, version, removed: nameOf(id) } };
  }

  function setAway(input: { agentId?: unknown; away?: unknown; note?: unknown; actor?: string }): AdminResult {
    if (!d.editorEnabled) return fail(503, "squad editing is disabled (SQUAD_EDITOR_ENABLED=0)");
    if (!validId(input.agentId)) return fail(400, `invalid agentId: ${String(input.agentId)}`);
    if (typeof input.away !== "boolean") return fail(400, "away must be true or false");
    const id = String(input.agentId).trim();
    const known = d.registry.agents().some((a) => a.id === id) || d.store.overlay().members.some((m) => m.agentId === id && !m.removed);
    if (!known) return fail(404, `agent ${id} is not in any squad`);
    const note = input.note ? String(input.note) : null;
    const state = d.routingStore.setAgentAway(id, input.away, { note });
    d.store.recordAway({ agentName: nameOf(id), away: input.away, note, actor: input.actor });
    return { status: 200, body: { ok: true, agent: nameOf(id), ...state } };
  }

  function setTriageOnly(input: { active?: unknown; note?: unknown; actor?: string }): AdminResult {
    if (typeof input.active !== "boolean") return fail(400, "active must be true or false");
    // disabling the editor blocks PAUSING, never RESUMING: the safe state must stay reachable
    if (input.active && !d.editorEnabled) return fail(503, "squad editing is disabled (SQUAD_EDITOR_ENABLED=0); resuming is still allowed");
    const note = input.note ? String(input.note) : null;
    const mode = d.routingStore.setTriageOnly(input.active, { actor: input.actor ?? null, note });
    d.store.recordTriageOnly({ active: input.active, note, actor: input.actor });
    return { status: 200, body: { ok: true, triageOnly: mode } };
  }

  return {
    getSquads,
    setCity,
    addMember,
    removeMember,
    setAway,
    setTriageOnly,
    getCandidates: (): AdminResult => ({ status: 200, body: { ok: true, agents: candidates() } }),
    getCities: (): AdminResult => ({ status: 200, body: { ok: true, cities: [...cityIndex().values()].sort() } }),
    getAudit: (limit?: unknown): AdminResult => ({ status: 200, body: { ok: true, entries: d.store.audit(Number(limit) || 50) } }),
  };
}

export type SquadAdmin = ReturnType<typeof createSquadAdmin>;
