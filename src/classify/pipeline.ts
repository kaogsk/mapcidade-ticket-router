/**
 * pipeline.ts — layered classification, cheapest and most auditable first:
 *
 *   0. noise        automatic e-mail? stop here (no classification, no reply)
 *   1. rules        deterministic regexes            — free, instant
 *   2. full-text    majority of similar closed tickets — free, milliseconds
 *   3. AI           model, only for what is left      — paid, guarded
 *   4. policy       business rules over WHATEVER layer answered
 *
 * A ticket already categorized by a human takes the "prefilled" path: no
 * reclassification, only the policy (and, for permits, a type re-check).
 *
 * Every step appends to `trace`, which the API/CLI/MCP return verbatim: when a
 * ticket lands in the wrong place, the trace says which layer decided and why.
 */

import type { Catalog, RequesterHistory, RoutingException } from "../catalog.js";
import type { Category, Classification, Service, Ticket, Urgency } from "../domain.js";
import { CATEGORIES } from "../domain.js";
import { openingMessage, ticketText } from "../text/normalize.js";
import type { Band, GuardedClassifier } from "./ai/guardedClassifier.js";
import type { AiOutput } from "./ai/types.js";
import { normalizeService } from "./ai/types.js";
import {
  CRITICAL,
  criticalUpgrade,
  decideType,
  isPermitsService,
  maintenanceFamily,
  permitsUrgency,
  permitsUrgencyUpgrade,
} from "./categoryRules.js";
import type { CityDetector } from "./cityDetector.js";
import type { KnowledgeBase } from "./knowledgeBase.js";
import { type NoiseMatch, detectNoise } from "./noise.js";
import { classifyByRules, detectService, findException } from "./rulesLayer.js";
import { GIS_EVIDENCE_RE, MOBILE_RE, MONITORING_MODULE_RE, requesterConflict } from "./serviceRules.js";

export type Layer = "noise" | "city" | "rules" | "knowledge_base" | "ai" | "policy" | "prefilled";

export interface TraceStep {
  layer: Layer;
  outcome: "hit" | "miss" | "skip" | "adjust";
  detail: string;
}

export type PipelineResult =
  | { kind: "noise"; noise: NoiseMatch; trace: TraceStep[] }
  | { kind: "classified"; classification: Classification; trace: TraceStep[] }
  | {
      kind: "needs_human";
      reason: string;
      /** what the AI suggested, for the review queue (null when it gave nothing usable) */
      suggestion: AiOutput | null;
      band: Band | null;
      city: string | null;
      citySource: string | null;
      trace: TraceStep[];
    };

export interface PipelineDeps {
  catalog: Catalog;
  detectCity: CityDetector;
  kb: KnowledgeBase | null;
  ai: GuardedClassifier | null;
  flags: { noiseExtraRules: boolean; ideaExplicitRule: boolean; genericWordsToAi: boolean };
  /** minimum agreement among similar tickets for the full-text layer */
  kbMinConfidence?: number;
}

export interface Pipeline {
  classify(ticket: Ticket): Promise<PipelineResult>;
}

/**
 * Service corrections applied to the AI's answer, using the same evidence the
 * rules use. Each one came from a measured confusion in production (the model
 * kept calling GIS tickets "permits" until these rules existed).
 */
export function correctAiService(
  service: Service,
  textNorm: string,
  exception: RoutingException | null,
  history: RequesterHistory | null | undefined,
): { service: Service; note: string | null; conflict: string | null } {
  if (exception) return { service: exception.service, note: `requester exception → ${exception.service}`, conflict: null };
  if (service === "Sensors" && MONITORING_MODULE_RE.test(textNorm)) return { service: "GIS", note: "monitoring module is GIS, not Sensors", conflict: null };
  if ((service === "GIS" || isPermitsService(service)) && MOBILE_RE.test(textNorm)) return { service: "GIS - Mobile", note: "mobile app vocabulary", conflict: null };
  if (isPermitsService(service)) {
    if (GIS_EVIDENCE_RE.test(textNorm)) return { service: "GIS", note: "AI said permits but the text names the GIS platform", conflict: null };
    const conflict = requesterConflict(textNorm, history);
    if (conflict) return { service, note: null, conflict: `AI said ${service}, but ${conflict}` };
  }
  return { service, note: null, conflict: null };
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const kbMin = deps.kbMinConfidence ?? 0.6;
  const cityInfo = (city: string | null) => deps.catalog.cities.find((c) => c.name === city) ?? null;

  /** business rules over any layer's answer */
  function applyPolicy(service: Service, category: Category, urgency: Urgency, trace: TraceStep[]): { category: Category; urgency: Urgency } {
    let finalCategory = category;
    let finalUrgency = urgency;
    const upgraded = criticalUpgrade(category, service);
    if (upgraded) {
      trace.push({ layer: "policy", outcome: "adjust", detail: `${service}: "${category}" → "${upgraded}"` });
      finalCategory = upgraded;
    }
    if (isPermitsService(service)) {
      const u = permitsUrgency(urgency);
      if (u !== urgency) trace.push({ layer: "policy", outcome: "adjust", detail: `permits urgency "${urgency}" → "${u}"` });
      finalUrgency = u;
    }
    return { category: finalCategory, urgency: finalUrgency };
  }

  async function prefilled(ticket: Ticket, textNorm: string, city: string | null, citySource: string | null, trace: TraceStep[]): Promise<PipelineResult> {
    const service = ticket.service ? normalizeService(ticket.service) : detectService(ticket, textNorm, { catalog: deps.catalog, ...deps.flags }).service;
    const existing = String(ticket.category) as Category;
    let category: Category = existing;
    let urgency = ((ticket.urgency as Urgency) || "Normal") as Urgency;
    trace.push({ layer: "prefilled", outcome: "hit", detail: `already categorized by a human: "${existing}" / ${service}` });

    if (!(CATEGORIES as readonly string[]).includes(existing)) {
      trace.push({ layer: "policy", outcome: "skip", detail: "category outside the managed list — left as is" });
    } else {
      const upgraded = criticalUpgrade(existing, service);
      if (upgraded) {
        trace.push({ layer: "policy", outcome: "adjust", detail: `${service}: "${existing}" → "${upgraded}"` });
        category = upgraded;
      }
      if (isPermitsService(service)) {
        // the TYPE (corrective × adaptive) may be wrong either way; the AI decides when confident
        let ai = null;
        if (deps.ai) ai = await deps.ai.classify({ ticketId: ticket.id, subject: ticket.subject, description: openingMessage(ticket), city });
        const decided = decideType({ aiCategory: ai?.output.category, aiConfidence: ai?.output.confidence, highConfidence: deps.ai?.opts.highConfidence, textNorm });
        const currentFamily = maintenanceFamily(existing);
        if (decided && currentFamily && decided.family !== currentFamily) {
          category = CRITICAL[decided.family];
          trace.push({ layer: "policy", outcome: "adjust", detail: `type re-checked (${decided.source}): ${currentFamily} → ${decided.family} → "${category}"` });
        } else {
          trace.push({ layer: "policy", outcome: "hit", detail: decided ? `type confirmed (${decided.source})` : "no type verdict — type kept" });
        }
        const u = permitsUrgencyUpgrade(ticket.urgency, service, textNorm);
        if (u) {
          trace.push({ layer: "policy", outcome: "adjust", detail: `permits urgency "${ticket.urgency ?? "-"}" → "${u}"` });
          urgency = u;
        }
      }
    }
    const info = cityInfo(city);
    return {
      kind: "classified",
      trace,
      classification: { service, category, urgency, city, citySource, plan: info?.plan ?? null, projectCode: info?.projectCode ?? null, source: "prefilled" },
    };
  }

  return {
    async classify(ticket: Ticket): Promise<PipelineResult> {
      const trace: TraceStep[] = [];

      const noise = detectNoise({ subject: ticket.subject, clients: ticket.clients }, { extras: deps.flags.noiseExtraRules });
      if (noise) {
        trace.push({ layer: "noise", outcome: "hit", detail: `${noise.rule}: ${noise.label}` });
        return { kind: "noise", noise, trace };
      }
      trace.push({ layer: "noise", outcome: "miss", detail: "not an automatic e-mail" });

      const text = ticketText(ticket);
      const detected = deps.detectCity({ subject: text.subject, body: text.body, clients: ticket.clients });
      const exception = findException(deps.catalog.requesters.exceptions, ticket.clients);
      const city = exception ? exception.city : detected.city;
      const citySource = exception ? "requester_exception" : detected.source;
      trace.push({
        layer: "city",
        outcome: city ? "hit" : "miss",
        detail: city ? `${city} (via ${citySource})` : "no detector found a city",
      });

      if (ticket.category) return prefilled(ticket, text.textNorm, city, citySource, trace);

      const build = (service: Service, category: Category, urgency: Urgency, source: Classification["source"], confidence?: number): PipelineResult => {
        const policy = applyPolicy(service, category, urgency, trace);
        const info = cityInfo(city);
        return {
          kind: "classified",
          trace,
          classification: {
            service, ...policy, city, citySource, plan: info?.plan ?? null, projectCode: info?.projectCode ?? null, source,
            ...(confidence !== undefined ? { confidence } : {}),
          },
        };
      };

      // 1. rules
      const rules = classifyByRules(ticket, { catalog: deps.catalog, ...deps.flags });
      if (rules.kind === "hit") {
        trace.push({ layer: "rules", outcome: "hit", detail: `${rules.category} / ${rules.urgency} — ${rules.why}; service ${rules.service} (${rules.serviceWhy})` });
        return build(rules.service, rules.category, rules.urgency, "rules");
      }
      trace.push({ layer: "rules", outcome: "miss", detail: rules.why });

      // 2. full-text over closed tickets
      if (deps.kb) {
        const v = deps.kb.classify(ticket.subject);
        if (v && v.confidence >= kbMin) {
          // a real service signal from the rules beats the neighbours' majority
          const service = rules.service.isDefault ? v.service : rules.service.service;
          trace.push({
            layer: "knowledge_base",
            outcome: "hit",
            detail: `${v.agreeing}/${v.matches} similar closed tickets were "${v.category}" (${Math.round(v.confidence * 100)}%); service ${service}`,
          });
          return build(service, v.category, v.urgency, "knowledge_base", v.confidence);
        }
        trace.push({
          layer: "knowledge_base",
          outcome: "miss",
          detail: v ? `only ${Math.round(v.confidence * 100)}% agreement among ${v.matches} similar tickets` : "not enough similar tickets",
        });
      } else {
        trace.push({ layer: "knowledge_base", outcome: "skip", detail: "knowledge base not loaded" });
      }

      // 3. AI
      if (!deps.ai) {
        trace.push({ layer: "ai", outcome: "skip", detail: "no AI classifier configured" });
        return { kind: "needs_human", reason: "rules and full-text were not decisive", suggestion: null, band: null, city, citySource, trace };
      }
      const ai = await deps.ai.classify({ ticketId: ticket.id, subject: ticket.subject, description: openingMessage(ticket), city });
      if (!ai) {
        trace.push({ layer: "ai", outcome: "miss", detail: "no usable answer (budget, timeout or error)" });
        return { kind: "needs_human", reason: "AI unavailable", suggestion: null, band: null, city, citySource, trace };
      }
      const pct = Math.round(ai.output.confidence * 100);
      const tag = `${ai.output.category} / ${ai.output.service} at ${pct}%${ai.cached ? " (cached answer, no new call)" : ""}`;
      if (ai.band !== "apply") {
        trace.push({ layer: "ai", outcome: "miss", detail: `${tag} → ${ai.band === "review" ? "human review" : "discarded (too vague)"}` });
        return {
          kind: "needs_human",
          reason: ai.band === "review" ? `AI below the auto-apply cut (${pct}%)` : `AI too unsure (${pct}%)`,
          suggestion: ai.output,
          band: ai.band,
          city, citySource, trace,
        };
      }
      const requesterId = ticket.clients.find((c) => c.personType === "person")?.id ?? ticket.clients[0]?.id;
      const fix = correctAiService(ai.output.service, text.textNorm, exception, requesterId ? deps.catalog.requesters.history[requesterId] : null);
      if (fix.conflict) {
        trace.push({ layer: "ai", outcome: "miss", detail: `${tag}, but ${fix.conflict} → human review` });
        return { kind: "needs_human", reason: fix.conflict, suggestion: ai.output, band: "review", city, citySource, trace };
      }
      trace.push({ layer: "ai", outcome: "hit", detail: `${tag}${fix.note ? `; service corrected: ${fix.note}` : ""}` });
      return build(fix.service, ai.output.category, ai.output.urgency, "ai", ai.output.confidence);
    },
  };
}
