/**
 * rulesLayer.ts — layer 1: deterministic classification (service, category,
 * urgency) from the ticket text. Free, instant and auditable, so it runs first;
 * it returns `null` whenever the text is not decisive and lets the next layer try.
 */

import type { Catalog, RoutingException } from "../catalog.js";
import type { Category, Service, Ticket, Urgency } from "../domain.js";
import { ticketText } from "../text/normalize.js";
import { ERROR_RE, OUTAGE_RE, isExplicitIdea } from "./categoryRules.js";
import {
  GIS_EVIDENCE_RE,
  MOBILE_RE,
  MONITORING_MODULE_RE,
  PERMITS_BUILDING_RE,
  PERMITS_BUSINESS_RE,
  SENSORS_RE,
  inferPermits,
} from "./serviceRules.js";

// Adaptive work, split in two. SPECIFIC says what is being asked (access, export,
// report, certificate...). GENERIC is a verb with no object ("change", "update"):
// it also shows up in defect reports ("I need to change X but it says Y does not
// exist"), so on its own it does not decide — see the generic branch below.
export const ADAPTIVE_GENERIC_RE = /\binclude\b|\binclusion\b|\bchange\b|\bchanges\b|\bupdate\b|\bupdating\b|\badjust(?:ment)?\b|\bcreate\b|\bcreation\b|\binsert\b|\badd\b|\breplace\b|\bconfigure\b|\bconfiguration\b|\bvalidate\b/;
export const ADAPTIVE_SPECIFIC_RE = /\badaptive\b|\bremove\b.{0,30}\blayer\b|\bdisable\b|\benable\b|\bgrant\b|\bpermissions?\b|\bexport\w*|\bimport\b|\borthophotos?\b|\breport\b|\bsuper ?user\b|\b(?:link|associate)\b.{0,40}\b(?:user|profile|access)\b|\bprofile\b.{0,15}\badmin\b|\badmin\b.{0,15}\bpanel\b|\bscript\b|\bsymbology\b|\bcertificate\b|\bwatermark\b|\bactivate\b.{0,20}\baccount\b|\breset\b.{0,20}\bpassword\b|\bforgot\b.{0,20}\bpassword\b|\brequest\b.{0,20}\baccess\b|\bform field\b|\bdropdown options\b/;

export interface RulesContext {
  catalog: Catalog;
  /** layer flags (mirror the rollout flags of the original system) */
  ideaExplicitRule: boolean;
  genericWordsToAi: boolean;
}

export interface ServiceDecision {
  service: Service;
  /** why — for the decision trace */
  why: string;
  /** true when no rule said anything and GIS is just the default */
  isDefault: boolean;
}

export function findException(exceptions: RoutingException[], clients: Ticket["clients"]): RoutingException | null {
  for (const c of clients || []) {
    const hit = exceptions.find((e) => e.requesterId === String(c.id));
    if (hit) return hit;
  }
  return null;
}

/** Service from text (and requester), in the order the false positives taught us. */
export function detectService(ticket: Ticket, textNorm: string, ctx: RulesContext): ServiceDecision {
  const exception = findException(ctx.catalog.requesters.exceptions, ticket.clients);
  if (exception) return { service: exception.service, why: `requester exception (${exception.requesterId})`, isDefault: false };
  if (SENSORS_RE.test(textNorm) && !MONITORING_MODULE_RE.test(textNorm)) {
    return { service: "Sensors", why: "sensor-network vocabulary", isDefault: false };
  }
  if (MOBILE_RE.test(textNorm)) return { service: "GIS - Mobile", why: "mobile app vocabulary", isDefault: false };
  if (GIS_EVIDENCE_RE.test(textNorm)) return { service: "GIS", why: "text names the GIS platform; permits regex not evaluated", isDefault: false };
  if (PERMITS_BUILDING_RE.test(textNorm)) return { service: "Permits - Building", why: "building-permit regex", isDefault: false };
  if (PERMITS_BUSINESS_RE.test(textNorm)) return { service: "Permits - Business", why: "business-permit regex", isDefault: false };
  const requesterId = ticket.clients.find((c) => c.personType === "person")?.id ?? ticket.clients[0]?.id;
  const inferred = inferPermits(textNorm, requesterId ? ctx.catalog.requesters.history[requesterId] : null);
  if (inferred) return { service: inferred.service, why: inferred.reason, isDefault: false };
  return { service: "GIS", why: "no service signal (default)", isDefault: true };
}

export type RulesOutcome =
  | { kind: "hit"; service: Service; category: Category; urgency: Urgency; why: string; serviceWhy: string }
  | { kind: "miss"; service: ServiceDecision; why: string };

export function classifyByRules(ticket: Ticket, ctx: RulesContext): RulesOutcome {
  const { subject, textNorm } = ticketText(ticket);
  const svc = detectService(ticket, textNorm, ctx);
  const hit = (category: Category, urgency: Urgency, why: string): RulesOutcome => ({
    kind: "hit", service: svc.service, category, urgency, why, serviceWhy: svc.why,
  });

  // "Idea:" / "Suggestion:" prefix with no defect in the text. Before the adaptive
  // regexes, which would match the "add"/"create" of nearly every suggestion.
  if (ctx.ideaExplicitRule && isExplicitIdea(subject, textNorm)) return hit("Ideas", "Low", "subject declares an idea, no defect signal");

  if (OUTAGE_RE.test(textNorm)) return hit("Corrective", "Urgent", "outage signal");
  if (ERROR_RE.test(textNorm)) return hit("Corrective", "High", "defect signal");
  if (ADAPTIVE_SPECIFIC_RE.test(textNorm)) return hit("Adaptive - N1 - Simple", "Low", "specific adaptive request");
  if (ADAPTIVE_GENERIC_RE.test(textNorm)) {
    // Only a generic change verb AND the service is GIS by default: the rules know
    // neither the service nor the type, so a smarter layer decides.
    if (ctx.genericWordsToAi && svc.isDefault) {
      const word = ADAPTIVE_GENERIC_RE.exec(textNorm)?.[0];
      return { kind: "miss", service: svc, why: `only a generic change word ("${word}") and no service signal` };
    }
    return hit("Adaptive - N1 - Simple", "Low", "generic adaptive request with a service signal");
  }
  return { kind: "miss", service: svc, why: "no category signal" };
}
