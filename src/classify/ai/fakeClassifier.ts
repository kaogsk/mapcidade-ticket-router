/**
 * fakeClassifier.ts — deterministic stand-in for the model.
 *
 * Not a copy of the rules layer: it uses a broader, weighted vocabulary and
 * returns a confidence that grows with the amount and the clarity of the
 * evidence, so the guard's bands (apply / human review / discard) are exercised
 * exactly as with the real model. Same input → same output, always.
 */

import type { Category, Service, Urgency } from "../../domain.js";
import { normForRules } from "../../text/normalize.js";
import type { AiCallResult, AiClassifier, AiInput } from "./types.js";

type Cues = Record<string, number>;

const SERVICE_CUES: Record<Exclude<Service, "GIS - Mobile">, Cues> = {
  GIS: { map: 2, layer: 2, parcel: 2, lot: 1, cadastre: 2, orthophoto: 2, street: 1, address: 1, theme: 1, viewer: 2, gis: 3, symbology: 2 },
  "Permits - Building": { permit: 2, construction: 2, building: 1, plans: 1, architect: 2, inspection: 1, zoning: 1, blueprint: 2, applicant: 2, process: 1 },
  "Permits - Business": { license: 2, licence: 2, business: 2, company: 2, entrepreneur: 3, storefront: 2, activity: 1 },
  Sensors: { sensor: 3, rain: 2, river: 2, gauge: 2, weather: 2, flood: 2, telemetry: 2, station: 1 },
};

const FAMILY_CUES: Record<"corrective" | "adaptive" | "evolutive", Cues> = {
  corrective: { error: 3, wrong: 2, broken: 2, fails: 2, failure: 2, stuck: 2, crash: 3, missing: 2, disappeared: 2, incorrect: 2, blank: 2, timeout: 2, not: 1, problem: 1 },
  adaptive: { please: 1, request: 2, need: 1, add: 2, create: 2, change: 2, update: 2, new: 1, grant: 2, access: 2, password: 2, export: 2, report: 1, adjust: 2, include: 2, remove: 2 },
  evolutive: { feature: 2, module: 2, integrate: 2, integration: 2, dashboard: 1, suggest: 2, idea: 3, improvement: 2, future: 2 },
};

const OUTAGE_WORDS = /\b(?:down|offline|outage|unavailable)\b/;

function score(words: string[], cues: Cues): number {
  return words.reduce((sum, w) => sum + (cues[w] ?? cues[w.replace(/s$/, "")] ?? 0), 0);
}

export class FakeClassifier implements AiClassifier {
  readonly name = "fake";
  readonly model = "fake-deterministic";

  async classify(input: AiInput): Promise<AiCallResult> {
    const text = normForRules(`${input.subject} ${input.description}`);
    const words = text.split(/[^a-z0-9]+/).filter(Boolean);

    const services = Object.entries(SERVICE_CUES).map(([s, cues]) => [s as Service, score(words, cues)] as const).sort((a, b) => b[1] - a[1]);
    const service: Service = services[0][1] > 0 ? services[0][0] : "GIS";

    const families = Object.entries(FAMILY_CUES).map(([f, cues]) => [f, score(words, cues)] as const).sort((a, b) => b[1] - a[1]);
    const [family, top] = families[0];
    const margin = top - families[1][1];
    const evidence = top + services[0][1];

    let category: Category;
    let urgency: Urgency;
    if (top === 0) {
      category = "Ideas";
      urgency = "Low";
    } else if (family === "corrective") {
      category = "Corrective";
      urgency = OUTAGE_WORDS.test(text) ? "Urgent" : "High";
    } else if (family === "adaptive") {
      category = "Adaptive - N1 - Simple";
      urgency = "Low";
    } else {
      category = /\bidea\b|\bsuggest/.test(text) ? "Ideas" : "Evolutive";
      urgency = "Low";
    }

    // more evidence and a clearer winner → more confidence; vague text stays under 0.4
    const confidence = top === 0 ? 0.2 : Math.min(0.92, 0.2 + 0.05 * Math.min(evidence, 8) + 0.06 * Math.min(margin, 4));
    const prompt = `${input.subject}\n${input.description}`;
    return {
      output: {
        service,
        category,
        urgency,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: `fake: ${family} (${top} vs ${families[1][1]}), ${service} (${services[0][1]})`,
      },
      usage: { inputTokens: 600 + Math.ceil(prompt.length / 4), outputTokens: 60 },
    };
  }
}
