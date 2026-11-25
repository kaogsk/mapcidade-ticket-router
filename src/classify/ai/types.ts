/**
 * ai/types.ts — the contract every AI classifier implements.
 *
 * Same interface, two implementations: a deterministic fake (default, no
 * network, no key) and an Anthropic adapter. Everything that makes the AI safe
 * to run unattended — confidence bands, budget, dedupe, ledger, timeouts — lives
 * in GuardedClassifier, outside the implementations, so both get it.
 */

import type { Category, Service, Urgency } from "../../domain.js";
import { CATEGORIES, SERVICES, URGENCIES } from "../../domain.js";

export interface AiInput {
  ticketId: string;
  subject: string;
  description: string;
  city?: string | null;
}

export interface AiOutput {
  service: Service;
  category: Category;
  urgency: Urgency;
  confidence: number;
  reasoning: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * A call that was made is a call that was paid: `usage` comes back even when
 * the model's answer was unusable (`output: null`).
 */
export interface AiCallResult {
  output: AiOutput | null;
  usage: AiUsage;
}

export interface AiClassifier {
  readonly name: string;
  readonly model: string;
  classify(input: AiInput): Promise<AiCallResult>;
}

/** Tool schema shared by the adapter and the output validator. */
export const CLASSIFY_TOOL = {
  name: "classify_ticket",
  description: "Classify a municipal GIS support ticket: service, maintenance category, urgency and your confidence.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      service: { type: "string", enum: [...SERVICES.filter((s) => s !== "GIS - Mobile")], description: "Main product line of the ticket." },
      category: { type: "string", enum: [...CATEGORIES], description: "Maintenance category." },
      urgency: { type: "string", enum: [...URGENCIES], description: "Urgency." },
      confidence: { type: "number", description: "Confidence in the classification, 0.0 to 1.0." },
      reasoning: { type: "string", description: "Short justification (max 100 chars)." },
    },
    required: ["service", "category", "urgency", "confidence", "reasoning"],
    additionalProperties: false,
  },
};

/** Fixed rules of the prompt: cached as a system block by the adapter. */
export const CLASSIFIER_RULES = `You classify support tickets of a municipal GIS platform by calling the classify_ticket tool.
Rules:
- GIS = maps, layers, parcels, cadastre, orthophotos, the map viewer and its admin panel.
- Sensors = the weather/hydrology sensor network: rain gauges, river level, weather stations, alert thresholds.
- The GIS "monitoring module" (change alerts on the map) is GIS, not Sensors.
- Permits - Building = building permits, construction approval, plans review, urban control, process numbers.
- Permits - Business = business/operating licenses, the entrepreneur portal.
- "down", "unavailable", "outage", "slowness" of the system -> Corrective, urgency Urgent.
- "error", "bug", "fails", "not working" -> Corrective, urgency High.
- "create", "add", "adjust", "enable", "grant access", "password" -> Adaptive - N1 - Simple, urgency Low.
- A user's own access (password, locked login, activate account) or a profile's permission is Adaptive - N1 - Simple even if the text says "error"; when nobody can log in, it is Corrective.
- Requests for data (spreadsheet, list, report, export) are Adaptive, never Evolutive.
- Permits + corrective -> Corrective - Critical. Permits + adaptive -> Adaptive - Critical.
- GIS is never Critical.
- confidence < 0.4 when the text is too vague to classify.`;

function canon(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SERVICE_CANON = new Map(SERVICES.map((s) => [canon(s), s]));

/** Coerces model variants ("permits-building", "Permit - Buildings") back to the enum; unknown → GIS. */
export function normalizeService(s: unknown): Service {
  if ((SERVICES as readonly string[]).includes(String(s))) return s as Service;
  const key = canon(s).replace(/\bpermit\b/g, "permits").replace(/\bbuildings\b/g, "building");
  return SERVICE_CANON.get(key) ?? "GIS";
}

/** Validates a tool input against the enums. null = unusable answer. */
export function validateOutput(raw: unknown): AiOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const category = (CATEGORIES as readonly string[]).includes(String(r.category)) ? (r.category as Category) : null;
  const urgency = (URGENCIES as readonly string[]).includes(String(r.urgency)) ? (r.urgency as Urgency) : null;
  const confidence = Number(r.confidence);
  if (!category || !urgency || !Number.isFinite(confidence)) return null;
  return {
    service: normalizeService(r.service),
    category,
    urgency,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: String(r.reasoning ?? "").slice(0, 200),
  };
}

/** USD per million tokens (input, output). Estimate only: the provider's console is the source of truth. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "fake-deterministic": { input: 0, output: 0 },
};

export function costOf(usage: AiUsage, model: string): number {
  const p = PRICES[model] ?? PRICES["claude-haiku-5-5"];
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
