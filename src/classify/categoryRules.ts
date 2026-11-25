/**
 * categoryRules.ts — deterministic category/urgency policy and text signals.
 *
 * Business rules (decided with the support manager, not learned):
 *  - Permits (building/business) corrective or adaptive work is ALWAYS the
 *    "- Critical" variant, whatever level was picked.
 *  - GIS is NEVER critical: "Corrective - Critical" goes down to "Corrective",
 *    "Adaptive - Critical" to "Adaptive - N1 - Simple" (the team adjusts the level).
 *  - Permits urgency: "Urgent" only when the system itself is down; everything
 *    else in permits is "High".
 *
 * They run after every layer (rules, full-text, AI, pre-filled by a human), so a
 * ticket opened by an agent already marked "Adaptive - N1 - Simple" for permits
 * does not slip through untouched.
 */

import type { Category, Urgency } from "../domain.js";
import { norm } from "../text/normalize.js";

export type Family = "corrective" | "adaptive";

export const CRITICAL: Record<Family, Category> = {
  corrective: "Corrective - Critical",
  adaptive: "Adaptive - Critical",
};

export const GIS_NON_CRITICAL: Record<Family, Category> = {
  corrective: "Corrective",
  adaptive: "Adaptive - N1 - Simple",
};

export function isPermitsService(service: unknown): boolean {
  return /^permits\b/.test(norm(service));
}

export function isGisService(service: unknown): boolean {
  return /^gis\b/.test(norm(service));
}

export function maintenanceFamily(category: unknown): Family | null {
  const m = /^(corrective|adaptive)\b/.exec(norm(category));
  return m ? (m[1] as Family) : null;
}

export function isCritical(category: unknown): boolean {
  return /\bcritical\b/.test(norm(category));
}

/**
 * Category the policy wants instead of `category`, or null when nothing changes
 * (null also prevents a pointless re-PATCH of an already-correct ticket).
 */
export function criticalUpgrade(category: unknown, service: unknown): Category | null {
  const family = maintenanceFamily(category);
  if (!family) return null;
  if (isGisService(service)) return isCritical(category) ? GIS_NON_CRITICAL[family] : null;
  if (isPermitsService(service)) return isCritical(category) ? null : CRITICAL[family];
  return null;
}

// ── text signals ────────────────────────────────────────────────────────────
// All regexes run over normForRules() text: lower case, no accents, "won't" → "will not".

const SEP = String.raw`[\s,.:;()-]+`;
const SYSTEM = "(?:system|site|website|portal|platform|application|environment|server)";
// a "passing" word between the system and the verb — never a specific item
const FILLER = String.raw`(?:(?!document|file|attachment|pdf|image|photo|report|certificate|invoice|plan|project|process|screen|page|field|button|map|layer|theme)\w+${SEP})`;
const WONT_OPEN = "(?:open|opens|opening|load|loads|loading|respond|responds|responding)";
const SYSTEM_DOES_NOT_OPEN = [
  // "the system (for permit approval) is not opening"
  String.raw`\b${SYSTEM}${SEP}${FILLER}{0,4}not${SEP}${FILLER}{0,1}${WONT_OPEN}\b`,
  // direct object right after the verb: "does not load the portal" counts, "does not load IN the portal" does not
  String.raw`\bnot${SEP}${WONT_OPEN}\s+(?:(?:the|this|our)\s+)?${SYSTEM}\b`,
].join("|");

/** The system itself is down/unavailable → corrective, urgency "Urgent". */
export const OUTAGE_RE = new RegExp(
  String.raw`\boutage\b|\boffline\b|out of service|\binaccessible\b|\bunavailable\b|\bslowness\b|` +
    String.raw`\b${SYSTEM}\b(?:\s+\w+){0,2}\s+(?:down|slow|unstable)\b|\b(?:slow|unstable)\s+${SYSTEM}\b|` +
    SYSTEM_DOES_NOT_OPEN,
);

/** The system answers that an existing record does not exist ("shows that the company is not registered"). */
const SYSTEM_SAYS_NOT = String.raw`\b(?:says|shows|states|reports|informs)\s+(?:that|as)\s+(?:\w+\s+){0,3}not\b`;

/** A defect, not an outage → corrective, urgency "High". */
export const ERROR_RE = new RegExp(
  String.raw`\berror\b|\bbug\b|\bfail(?:s|ed|ing|ure)?\b|\bnot\s+(?:\w+\s+){0,2}work(?:s|ing)?\b|\bcan not\b|\bunable to\b|` +
    String.raw`incorrect behaviou?r|\bduplicat\w*|negative (?:time|value)|` +
    String.raw`\bnot\s+(?:\w+\s+){0,2}(?:show|shows|showing|appear|appears|appearing|display|displaying|load|loading|open|opening)\b|` +
    String.raw`\bproblem (?:with|accessing)\b|\btrouble (?:accessing|logging)\b|` +
    SYSTEM_SAYS_NOT,
);

export function hasCorrectiveSignal(textNorm: string): boolean {
  return OUTAGE_RE.test(textNorm) || ERROR_RE.test(textNorm);
}

export function hasOutageSignal(textNorm: string): boolean {
  return OUTAGE_RE.test(textNorm);
}

/** Urgency for a permits ticket from what the classifier said. */
export function permitsUrgency(classified: unknown): Urgency {
  return norm(classified) === "urgent" ? "Urgent" : "High";
}

/**
 * Urgency to write on a permits ticket that arrived with one (pre-filled path).
 * Both directions: "Urgent" without an outage goes down to "High"; an outage
 * marked lower goes up. Returns null when nothing changes.
 */
export function permitsUrgencyUpgrade(existing: unknown, service: unknown, textNorm: string): Urgency | null {
  if (!isPermitsService(service)) return null;
  const target: Urgency = hasOutageSignal(textNorm) ? "Urgent" : "High";
  return norm(existing) === norm(target) ? null : target;
}

/**
 * Re-evaluation of the TYPE (corrective × adaptive) of a permits ticket that
 * arrived pre-categorized: whoever opened it may have erred either way.
 * The AI decides when confident; without it, a corrective signal in the text
 * decides corrective. Absence of a signal does NOT prove adaptive → null (keep).
 */
export function decideType(input: {
  aiCategory?: string | null;
  aiConfidence?: number | null;
  highConfidence?: number;
  textNorm: string;
}): { family: Family; source: "ai" | "rules"; confidence?: number } | null {
  const aiFamily = maintenanceFamily(input.aiCategory);
  const high = input.highConfidence ?? 0.7;
  if (aiFamily && Number(input.aiConfidence) >= high) {
    return { family: aiFamily, source: "ai", confidence: Number(input.aiConfidence) };
  }
  if (hasCorrectiveSignal(input.textNorm)) return { family: "corrective", source: "rules" };
  return null;
}

// "Idea: ...", "Suggestion - ...", "[Suggestion] ...", "Suggestion for improvement: ..." — prefix only.
export const IDEA_SUBJECT_RE = /^\s*(?:\[\s*)?(?:idea|suggestion)(?:\s+for\s+improvement)?\s*(?:\]|:|-|–)/;
// defects the corrective regex does not catch but that contradict "idea" ("Idea - report freezes")
const DEFECT_EXTRA_RE = /\bfreez\w*|\bhang(?:s|ing)?\b|\bcrash\w*|\bbroke\w*|\b(?:disappeared|vanished|stopped)\b/;

/** Subject declares itself an idea AND nothing in the text says defect. */
export function isExplicitIdea(subject: unknown, textNorm: string): boolean {
  if (!IDEA_SUBJECT_RE.test(norm(subject))) return false;
  return !hasCorrectiveSignal(textNorm) && !DEFECT_EXTRA_RE.test(textNorm);
}
