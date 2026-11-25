/**
 * catalog.ts — reviewable reference data (git, not database): cities, agents,
 * requester history and routing exceptions. Mutable state (who owns a city
 * right now, who is on vacation) lives in SQLite instead — see store/.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Service, SquadType } from "./domain.js";

export const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/seed");

export interface CityInfo {
  name: string;
  plan: string;
  projectCode: string;
  emailDomains: string[];
}

export interface Agent {
  id: string;
  name: string;
  level: string;
  active: boolean;
}

export interface Intern {
  id: string;
  name: string;
  type: SquadType;
}

export interface AgentsCatalog {
  triageAgent: { id: string; name: string };
  agents: Agent[];
  interns: Intern[];
}

/** How many past tickets of a requester fell in each product line. */
export interface RequesterHistory {
  total: number;
  building: number;
  business: number;
  gis: number;
}

/** A requester whose tickets always belong to a fixed city and service. */
export interface RoutingException {
  requesterId: string;
  city: string;
  service: Service;
  note?: string;
}

export interface Catalog {
  cities: CityInfo[];
  agents: AgentsCatalog;
  requesters: { history: Record<string, RequesterHistory>; exceptions: RoutingException[] };
  squadsPath: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

export function loadCatalog(dir: string = SEED_DIR): Catalog {
  return {
    cities: readJson<{ cities: CityInfo[] }>(path.join(dir, "cities.json")).cities,
    agents: readJson<AgentsCatalog>(path.join(dir, "agents.json")),
    requesters: readJson<Catalog["requesters"]>(path.join(dir, "requesters.json")),
    squadsPath: path.join(dir, "squads.json"),
  };
}
