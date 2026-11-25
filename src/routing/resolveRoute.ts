/**
 * resolveRoute.ts — who gets the ticket. Pure: no I/O, no clock, no database.
 *
 * Precedence (each step exists because of an incident or a manager decision):
 *   1. noise                → triage + noise tag (never a squad, never N1)
 *   2. classification failed→ triage
 *   3. service = Sensors    → triage + SENSORS tag (the triage agent escalates
 *                              to engineering; checked BEFORE the pause so the
 *                              pause does not silently drop the tag)
 *   4. triage-only (pause)  → triage, no distribution at all
 *   5. squad type from the service; permits words in the content force
 *      "permits" even when the ticket was filed as GIS
 *   6. city has a squad for that type:
 *        owner away         → N1 queue without owner (standby)
 *        otherwise          → that agent, N1 team
 *   7. no squad / unknown city → N1 queue without owner (the helpdesk's own
 *      round-robin picks whoever has fewer tickets)
 *
 * The squad map is keyed by (city + type): the same city may have one owner for
 * permits and another for GIS.
 */

import type { SquadType } from "../domain.js";
import { TEAM_N1, TEAM_TRIAGE } from "../domain.js";
import { norm } from "../text/normalize.js";
import { PERMITS_CONTENT_RE } from "../classify/serviceRules.js";
import type { NoiseMatch } from "../classify/noise.js";

export interface SquadEntry {
  id: string;
  name: string;
  city: string;
  source?: "baseline" | "override";
}

/** Effective map: type → normalized city → owner. */
export interface SquadMap {
  permits: Record<string, SquadEntry>;
  gis: Record<string, SquadEntry>;
  warnings: string[];
}

export type RouteAction = "triage" | "squad" | "n1";
export type Fallback = "agent_away" | "no_squad" | "city_unknown";

export interface RouteDecision {
  action: RouteAction;
  /** null = clear the owner (N1 queue without owner) */
  owner: string | null;
  ownerName?: string;
  ownerTeam: string;
  squadType?: SquadType;
  city?: string | null;
  citySource?: string | null;
  tags?: string[];
  fallback?: Fallback;
  forcedPermits?: boolean;
  triageOnly?: boolean;
  noise?: string;
  awayAgentId?: string;
  reason: string;
}

export interface RouteInput {
  city?: string | null;
  citySource?: string | null;
  service?: string | null;
  classificationFailed?: boolean;
  triageAgentId?: string | null;
  contentText?: string;
  awayAgentIds?: Set<string> | string[];
  triageOnly?: boolean;
  noise?: NoiseMatch | null;
}

export const SENSORS_TAG = "SENSORS";

export function contentForcesPermits(contentText: unknown): boolean {
  return PERMITS_CONTENT_RE.test(norm(contentText));
}

export function isPermitsService(service: unknown): boolean {
  return /^permits\b/.test(norm(service));
}

/** Routing only acts on support tickets; other departments' tickets are never touched. */
export function isSupportTeam(team: unknown): boolean {
  return norm(team).startsWith("support");
}

export function resolveRoute(squads: SquadMap, input: RouteInput = {}): RouteDecision {
  const triage = { action: "triage" as const, owner: input.triageAgentId || null, ownerTeam: TEAM_TRIAGE };

  if (input.noise) {
    return { ...triage, tags: [...input.noise.tags], noise: input.noise.rule, reason: input.noise.reason };
  }
  if (input.classificationFailed) {
    return { ...triage, reason: "classification failed → triage" };
  }
  if (norm(input.service) === "sensors") {
    return {
      ...triage,
      tags: [SENSORS_TAG],
      city: input.city ?? null,
      citySource: input.citySource ?? null,
      reason: "service=Sensors → triage + SENSORS tag (escalated by the triage agent)",
    };
  }
  if (input.triageOnly) {
    return {
      ...triage,
      city: input.city ?? null,
      citySource: input.citySource ?? null,
      triageOnly: true,
      reason: "triage-only mode is on → no distribution, stays with triage",
    };
  }

  const byService = isPermitsService(input.service);
  const forcedPermits = !byService && contentForcesPermits(input.contentText);
  const squadType: SquadType = byService || forcedPermits ? "permits" : "gis";
  const forceNote = forcedPermits ? " [type forced to permits by content]" : "";
  const key = norm(input.city);
  const hit = key ? squads[squadType][key] : undefined;
  const base = { squadType, city: input.city ?? null, citySource: input.citySource ?? null, forcedPermits };

  const away = input.awayAgentIds instanceof Set ? input.awayAgentIds : new Set((input.awayAgentIds || []).map(String));
  if (hit && away.has(String(hit.id))) {
    return {
      action: "n1",
      owner: null,
      ownerTeam: TEAM_N1,
      ...base,
      fallback: "agent_away",
      awayAgentId: String(hit.id),
      reason: `${squadType} squad of "${input.city}" on standby: ${hit.name} is away → N1 queue${forceNote}`,
    };
  }
  if (hit) {
    return {
      action: "squad",
      owner: hit.id,
      ownerName: hit.name,
      ownerTeam: TEAM_N1,
      ...base,
      reason: `${squadType} squad of "${input.city}" → ${hit.name}${forceNote}`,
    };
  }
  return {
    action: "n1",
    owner: null,
    ownerTeam: TEAM_N1,
    ...base,
    fallback: input.city ? "no_squad" : "city_unknown",
    reason: (input.city ? `"${input.city}" has no ${squadType} squad → N1 queue` : "city not identified → N1 queue") + forceNote,
  };
}
