/**
 * squadRegistry.ts — effective squad map = reviewable baseline (JSON in git)
 * + overlay edited at runtime (SQLite). resolveRoute() always reads this.
 *
 * The composed map is cached and rebuilt only when the store's version moves,
 * so a panel edit is visible on the very next decision without re-reading
 * anything on the hot path.
 */

import fs from "node:fs";
import type { SquadType } from "../domain.js";
import { SQUAD_TYPES } from "../domain.js";
import { norm } from "../text/normalize.js";
import type { Overlay, SquadStore } from "../store/squadStore.js";
import type { SquadEntry, SquadMap } from "./resolveRoute.js";

type BaselineFile = Partial<Record<SquadType, Record<string, { id?: string; cities?: string[] }>>>;

/**
 * Reads the baseline JSON into normalized indexes. Never throws: a read error
 * yields an EMPTY map plus a warning (an entry without id is skipped, so its
 * cities fall to N1 — fail-safe, never a wrong owner).
 */
export function loadBaseline(file: string): SquadMap {
  const out: SquadMap = { permits: {}, gis: {}, warnings: [] };
  let raw: BaselineFile;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8")) as BaselineFile;
  } catch (e) {
    out.warnings.push(`failed to read ${file}: ${(e as Error).message}`);
    return out;
  }
  for (const type of SQUAD_TYPES) {
    for (const [name, def] of Object.entries(raw[type] || {})) {
      if (!def?.id) {
        out.warnings.push(`squad '${name}' (${type}) has no id — its cities fall to N1`);
        continue;
      }
      for (const city of def.cities || []) {
        const key = norm(city);
        if (!key) continue;
        const prev = out[type][key];
        if (prev && prev.id !== String(def.id)) {
          out.warnings.push(`conflict ${type}: '${city}' already owned by ${prev.name}; ignoring ${name}`);
          continue;
        }
        out[type][key] = { id: String(def.id), name, city };
      }
    }
  }
  return out;
}

/** Pure composition: removed members drop their baseline cities; overlay rows win. */
export function buildSquads(baseline: SquadMap, overlay: Overlay | null | undefined): SquadMap {
  const out: SquadMap = { permits: {}, gis: {}, warnings: [...baseline.warnings] };
  const removed = new Map((overlay?.members || []).filter((m) => m.removed).map((m) => [m.agentId, m.name]));

  for (const type of SQUAD_TYPES) {
    for (const [cityNorm, entry] of Object.entries(baseline[type])) {
      if (removed.has(entry.id)) continue;
      out[type][cityNorm] = { ...entry, source: "baseline" };
    }
  }
  for (const name of new Set(removed.values())) out.warnings.push(`agent '${name}' removed — their cities fall to N1`);

  for (const c of overlay?.cities || []) {
    if (c.agentId === null) {
      delete out[c.type][c.cityNorm];
      continue;
    }
    out[c.type][c.cityNorm] = { id: c.agentId, name: c.agentName || c.agentId, city: c.city, source: "override" };
  }
  return out;
}

const isEmpty = (m: SquadMap) => SQUAD_TYPES.every((t) => Object.keys(m[t]).length === 0);
const hasReadFailure = (m: SquadMap) => m.warnings.some((w) => /failed to read/i.test(w));

export interface SquadAgentSummary {
  id: string;
  name: string;
  types: SquadType[];
  cities: string[];
}

export function listSquadAgents(map: SquadMap): SquadAgentSummary[] {
  const agents = new Map<string, { id: string; name: string; types: Set<SquadType>; cities: Set<string> }>();
  for (const type of SQUAD_TYPES) {
    for (const entry of Object.values(map[type])) {
      let a = agents.get(entry.id);
      if (!a) agents.set(entry.id, (a = { id: entry.id, name: entry.name, types: new Set(), cities: new Set() }));
      a.types.add(type);
      a.cities.add(entry.city);
    }
  }
  return [...agents.values()]
    .map((a) => ({ id: a.id, name: a.name, types: [...a.types].sort(), cities: [...a.cities].sort((x, y) => x.localeCompare(y)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SquadRegistry {
  current(): SquadMap;
  version(): number;
  effective(): { version: number; types: Record<SquadType, Array<SquadEntry & { cityNorm: string }>> };
  agents(): SquadAgentSummary[];
}

export function createSquadRegistry(opts: {
  store: SquadStore;
  loadBaseline: () => SquadMap;
  log?: (msg: string) => void;
}): SquadRegistry {
  const log = opts.log ?? ((m: string) => console.warn(m));
  let cached: SquadMap | null = null;
  let cachedVersion = -1;
  let lastGood: SquadMap | null = null;

  /**
   * The baseline is re-read on every rebuild. If a write lands while a deploy is
   * swapping the file, loadBaseline() returns an empty map and EVERY city would
   * lose its owner until the next write. Fail-safe: empty + read failure →
   * keep the last good baseline in memory.
   */
  function baselineOrLastGood(): SquadMap {
    const loaded = opts.loadBaseline();
    if (isEmpty(loaded) && hasReadFailure(loaded) && lastGood) {
      log("[squads] baseline unreadable right now — keeping the last good map in memory");
      return lastGood;
    }
    if (!isEmpty(loaded)) lastGood = loaded;
    return loaded;
  }

  function current(): SquadMap {
    const version = opts.store.version();
    if (!cached || cachedVersion !== version) {
      cached = buildSquads(baselineOrLastGood(), opts.store.overlay());
      cachedVersion = version;
      for (const w of cached.warnings) log(`[squads] ${w}`);
    }
    return cached;
  }

  return {
    current,
    version: () => opts.store.version(),
    effective() {
      const map = current();
      const types = {} as Record<SquadType, Array<SquadEntry & { cityNorm: string }>>;
      for (const type of SQUAD_TYPES) {
        types[type] = Object.entries(map[type])
          .map(([cityNorm, e]) => ({ ...e, cityNorm }))
          .sort((a, b) => a.city.localeCompare(b.city));
      }
      return { version: opts.store.version(), types };
    },
    agents: () => listSquadAgents(current()),
  };
}
