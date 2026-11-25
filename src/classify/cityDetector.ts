/**
 * cityDetector.ts — which city is this ticket about?
 *
 * A single detector always has a blind spot, and the original system's first
 * version (one regex cascade that stopped at the first match) sent many tickets
 * to "city not identified" even when a squad existed. So every detector runs,
 * every time, and the most trustworthy hit wins. The winning `source` is stored
 * with the routing decision so a wrong city can be traced back to its detector.
 *
 * Trust order:
 *   1. organization — the ticket's organization client is "City Hall of X"
 *   2. email        — a client's e-mail domain belongs to a catalogued city
 *   3. project      — a project code (PM_<CITY>_..) quoted in subject/body
 *   4. text         — a catalogued city named in subject/body (whole word,
 *                     longest name first, so "Elm" never matches "Elmhurst")
 */

import type { CityInfo } from "../catalog.js";
import type { Client } from "../domain.js";
import { containsWholeWord, norm } from "../text/normalize.js";

export type CitySource = "organization" | "email" | "project" | "text";

export interface CityDetection {
  city: string | null;
  source: CitySource | null;
  /** every detector's answer, for diagnostics */
  candidates: Array<{ source: CitySource; city: string }>;
}

export type CityDetector = (input: { subject: string; body: string; clients: Client[] }) => CityDetection;

export function createCityDetector(cities: CityInfo[]): CityDetector {
  // longest first: a longer name that contains a shorter one must win the text scan
  const byLength = [...cities].sort((a, b) => norm(b.name).length - norm(a.name).length);
  const byDomain = new Map<string, string>();
  for (const c of cities) for (const d of c.emailDomains) byDomain.set(norm(d), c.name);
  // keyed by the code's city core ("pm_rivermeadow"): a new contract year/number still points to the city,
  // and comparing cores exactly keeps PM_ELM_.. from claiming PM_ELMHURST_..
  const projectCore = (code: string) => norm(code).replace(/_\d+_\d{4}$/, "");
  const byProject = new Map(cities.map((c) => [projectCore(c.projectCode), c.name]));

  function fromOrganization(clients: Client[]): string | null {
    for (const client of clients) {
      if (client.personType !== "organization") continue;
      const m = /^city hall of (.+)$/.exec(norm(client.name));
      if (!m) continue;
      const hit = byLength.find((c) => norm(c.name) === m[1].trim());
      if (hit) return hit.name;
    }
    return null;
  }

  function fromEmail(clients: Client[]): string | null {
    for (const client of clients) {
      const domain = norm(client.email).split("@")[1];
      if (!domain) continue;
      // exact domain or a subdomain of it (planning.rivermeadow.gov.example)
      for (const [d, city] of byDomain) {
        if (domain === d || domain.endsWith(`.${d}`)) return city;
      }
    }
    return null;
  }

  function fromProject(textNorm: string): string | null {
    const codes = textNorm.match(/\bpm_[a-z0-9_]+/g) || [];
    for (const code of codes) {
      const city = byProject.get(projectCore(code));
      if (city) return city;
    }
    return null;
  }

  function fromText(textNorm: string): string | null {
    const hit = byLength.find((c) => containsWholeWord(textNorm, norm(c.name)));
    return hit ? hit.name : null;
  }

  return ({ subject, body, clients }) => {
    const textNorm = norm(`${subject} ${body}`);
    const candidates: CityDetection["candidates"] = [];
    const run: Array<[CitySource, string | null]> = [
      ["organization", fromOrganization(clients || [])],
      ["email", fromEmail(clients || [])],
      ["project", fromProject(textNorm)],
      ["text", fromText(textNorm)],
    ];
    for (const [source, city] of run) if (city) candidates.push({ source, city });
    const best = candidates[0];
    return { city: best?.city ?? null, source: best?.source ?? null, candidates };
  };
}
