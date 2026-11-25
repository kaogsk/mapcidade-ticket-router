/**
 * serviceRules.ts — which product line (service) a ticket text belongs to.
 *
 * Order matters and mirrors how the false positives were found in production:
 *   requester exception → Sensors (unless it is the GIS monitoring module)
 *   → mobile app → explicit GIS evidence (blocks the permits regex)
 *   → building permits → business permits → permits inferred from
 *     high-precision words or the requester's own history → default GIS.
 */

import type { RequesterHistory } from "../catalog.js";
import type { Service } from "../domain.js";

/** Sensor network (weather/hydrology telemetry). */
export const SENSORS_RE = /\bsensors? feed\b|\brain ?gauges?\b|\bweather stations?\b|\bmeteorolog\w*|\bhydrolog\w*|\briver level\b|\btelemetry station\b|^\[sensors\]/;

/** The GIS "monitoring module" (change alerts on the map) is GIS, not the sensor network. */
export const MONITORING_MODULE_RE = /\bmonitoring module\b|\bchange alerts?\b|\balert analysis\b|\bmonitoring cycles?\b|\bmonitoring profile\b/;

export const MOBILE_RE = /\bmobile app\b|\bfield app\b|\bandroid\b|\btablet\b|\boffline sync\b|\bcollector app\b/;

/** Text that names the GIS platform itself: the permits regex is not even evaluated. */
export const GIS_EVIDENCE_RE = /\bgis\b|\btheme\b.{0,40}\bprofile\b|\bprofile\b.{0,40}\btheme\b|\bmap viewer\b/;

export const PERMITS_BUILDING_RE = /\bbuilding permits?\b|\bconstruction (?:permits?|approval)\b|\bplans? review\b|\bplans ?online\b|\bapproval online\b|\burban control\b|\bprocess (?:no\.?|number|#)\s*\d|\bzoning approval\b/;

export const PERMITS_BUSINESS_RE = /\bbusiness licen[cs]e\b|\boperating licen[cs]e\b|\bentrepreneur portal\b|\blicen[cs]e to operate\b|\bbusiness registration\b/;

/** High-precision words measured against closed tickets: almost always business permits. */
const PERMITS_BUSINESS_WORDS = /\bbusiness activity code\b|\bsole proprietor\b|\bmunicipal registration\b|\bcompany\b.{0,20}\bregist\w*|\bclosing a business\b|\bopening a business\b/;
/** High-precision words: almost always building permits. */
const PERMITS_BUILDING_WORDS = /\bapplicant\b|\bprocess tracking\b|\bprofessional registration\b|\barchitect\b|\bblueprints?\b/;

/** Same rule the router uses to force the permits squad type from content (see routing/resolveRoute.ts). */
export const PERMITS_CONTENT_RE = /\bpermits?\b|\bprm-?\d|\bprocess (?:no\.?|number|#)\s*\d|\bplans ?online\b|\bapproval online\b/;

export interface PermitsInference {
  service: Service;
  reason: string;
}

/**
 * Permits inferred where the regex would fall back to GIS. Requester history
 * counts only with enough data (≥ 3 tickets) and a clear majority (≥ 80%).
 */
export function inferPermits(textNorm: string, history: RequesterHistory | null | undefined): PermitsInference | null {
  if (PERMITS_BUSINESS_WORDS.test(textNorm)) return { service: "Permits - Business", reason: "business-permit vocabulary" };
  if (PERMITS_BUILDING_WORDS.test(textNorm)) return { service: "Permits - Building", reason: "building-permit vocabulary" };
  if (history && history.total >= 3) {
    const permits = history.building + history.business;
    if (permits / history.total >= 0.8) {
      const service: Service = history.business > history.building ? "Permits - Business" : "Permits - Building";
      return { service, reason: `requester history: ${permits}/${history.total} permits tickets` };
    }
  }
  return null;
}

/**
 * The AI said Permits but this requester essentially only opens GIS tickets and
 * the text has no permits word: do not trust either side, send it to a human.
 */
export function requesterConflict(textNorm: string, history: RequesterHistory | null | undefined): string | null {
  if (!history || history.total < 3) return null;
  if (PERMITS_BUILDING_RE.test(textNorm) || PERMITS_BUSINESS_RE.test(textNorm) || PERMITS_CONTENT_RE.test(textNorm)) return null;
  const permitsShare = (history.building + history.business) / history.total;
  if (permitsShare > 0.2) return null;
  return `requester history is ${history.gis}/${history.total} GIS and the text has no permits word`;
}

export function isPermits(service: string): boolean {
  return service.startsWith("Permits");
}
