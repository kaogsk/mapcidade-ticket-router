/**
 * kbSeed.ts — deterministic synthetic history of closed tickets for the
 * full-text layer. Templates × fictional cities, expanded with a seeded PRNG so
 * the corpus (and every test that depends on it) is identical on every run.
 */

import type { KbTicket } from "../classify/knowledgeBase.js";
import type { Category, Service, Urgency } from "../domain.js";

interface Template {
  subjects: string[];
  body: string;
  service: Service;
  category: Category;
  urgency: Urgency;
  /** how many closed tickets to generate from this template */
  n: number;
}

const LAYERS = ["street centerline", "parcel", "zoning", "address points", "sidewalk", "drainage", "tree inventory"];

const TEMPLATES: Template[] = [
  {
    subjects: ["Update the {layer} layer", "Update {layer} layer attributes", "Update data on the {layer} layer"],
    body: "Please update the {layer} layer with the attached list from the planning department.",
    service: "GIS", category: "Adaptive - N1 - Simple", urgency: "Low", n: 18,
  },
  {
    subjects: ["Change symbology of the {layer} layer", "Change colors of {layer} layer"],
    body: "We would like the {layer} layer to use the new color scheme approved by the council.",
    service: "GIS", category: "Adaptive - N1 - Simple", urgency: "Low", n: 10,
  },
  {
    subjects: ["{layer} layer not showing on the map", "{layer} layer is blank on the map", "Error opening the {layer} layer"],
    body: "Since yesterday the {layer} layer does not show anything when we zoom in.",
    service: "GIS", category: "Corrective", urgency: "High", n: 16,
  },
  {
    subjects: ["Export {layer} data to spreadsheet", "Export of the {layer} table"],
    body: "We need the {layer} attributes exported to a spreadsheet for the annual report.",
    service: "GIS", category: "Adaptive - N1 - Simple", urgency: "Low", n: 10,
  },
  {
    subjects: ["Update applicant data on building permit process", "Change the architect on a building permit process", "Update address on construction approval"],
    body: "The applicant changed and the process must show the new responsible architect.",
    service: "Permits - Building", category: "Adaptive - Critical", urgency: "High", n: 14,
  },
  {
    subjects: ["Change company data on business license", "Update activity on operating license", "Change the address of a business license"],
    body: "The company moved and the license must show the new address before inspection.",
    service: "Permits - Business", category: "Adaptive - Critical", urgency: "High", n: 14,
  },
  {
    subjects: ["Business license portal is slow", "Entrepreneur portal timeout when issuing license"],
    body: "Applicants report the portal takes minutes to answer and then times out.",
    service: "Permits - Business", category: "Corrective - Critical", urgency: "Urgent", n: 8,
  },
  {
    subjects: ["Building permit fee calculated wrong", "Wrong fee on construction approval"],
    body: "The fee shown to the applicant does not match the municipal table.",
    service: "Permits - Building", category: "Corrective - Critical", urgency: "High", n: 10,
  },
  {
    subjects: ["Update rain gauge alert thresholds", "Change river level alert limits"],
    body: "Civil defense asked to change the alert thresholds for the rainy season.",
    service: "Sensors", category: "Adaptive - N2", urgency: "Normal", n: 8,
  },
  {
    subjects: ["Field app sync stuck", "Field app does not sync parcels", "Mobile app crash when saving photo"],
    body: "The field team cannot finish the survey because the app stops syncing.",
    service: "GIS - Mobile", category: "Corrective", urgency: "High", n: 10,
  },
  {
    subjects: ["New dashboard for property tax revenue", "Integrate parcels with the tax system"],
    body: "The finance secretary wants a new module, not available today, to follow revenue on the map.",
    service: "GIS", category: "Evolutive", urgency: "Low", n: 8,
  },
  {
    subjects: ["Idea: dark mode for the map viewer", "Suggestion: print map with legend", "Idea: favorite layers per user"],
    body: "It would be nice to have this in a future version.",
    service: "GIS", category: "Ideas", urgency: "Low", n: 9,
  },
];

const CITIES = ["Rivermeadow", "Lakeside", "Oakwood", "Elmhurst", "Stonebridge", "Maple Falls", "Cedar Grove", "Willow Creek", "Northgate"];

/** mulberry32: tiny seeded PRNG, enough for a reproducible corpus. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateKbTickets(seed = 20261125): KbTicket[] {
  const rnd = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const out: KbTicket[] = [];
  for (const t of TEMPLATES) {
    for (let i = 0; i < t.n; i++) {
      const layer = pick(LAYERS);
      const city = pick(CITIES);
      out.push({
        subject: pick(t.subjects).replace("{layer}", layer).replace(/^./, (c) => c.toUpperCase()),
        body: `${city}: ${t.body.replace("{layer}", layer)}`,
        service: t.service,
        category: t.category,
        urgency: t.urgency,
        city,
      });
    }
  }
  return out;
}
