/**
 * domain.ts — shared vocabulary of the router.
 *
 * The helpdesk is a generic ticketing API; these types are the subset of its
 * ticket shape that the decision engine reads and writes.
 */

/** Services a ticket can be filed under (the product line it belongs to). */
export const SERVICES = [
  "GIS",
  "GIS - Mobile",
  "Permits - Building",
  "Permits - Business",
  "Sensors",
] as const;
export type Service = (typeof SERVICES)[number];

/** Maintenance categories (the helpdesk rejects anything outside this list). */
export const CATEGORIES = [
  "Corrective",
  "Corrective - Critical",
  "Adaptive - N1 - Simple",
  "Adaptive - N1 - Complex",
  "Adaptive - Critical",
  "Adaptive - N2",
  "Adaptive - N3",
  "Evolutive",
  "Root Cause Analysis",
  "Ideas",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ["Low", "Normal", "High", "Urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Squad type: the same city can have one owner for permits and another for GIS. */
export type SquadType = "permits" | "gis";
export const SQUAD_TYPES: readonly SquadType[] = ["permits", "gis"];

export const TEAM_TRIAGE = "Support - Triage";
export const TEAM_N1 = "Support - N1";

export const STATUS_NEW = "New";
export const STATUS_IN_ANALYSIS = "In analysis";

export interface Client {
  id: string;
  name?: string;
  email?: string | null;
  personType: "person" | "organization";
}

export interface TicketAction {
  id: number;
  /** public = visible to the requester (a reply); internal = note */
  type: "public" | "internal";
  description: string;
  createdBy?: { id: string; isAgent?: boolean } | null;
  createdAt?: string;
}

export interface Ticket {
  id: string;
  subject: string;
  status: string;
  ownerTeam: string | null;
  owner: { id: string; name?: string } | null;
  service: string | null;
  category: string | null;
  urgency: string | null;
  tags: string[];
  clients: Client[];
  actions: TicketAction[];
  createdAt: string;
  customFields?: Record<string, string>;
}

/** What the classification step decided for a ticket. */
export interface Classification {
  service: Service;
  category: Category;
  urgency: Urgency;
  city: string | null;
  citySource: string | null;
  plan: string | null;
  projectCode: string | null;
  /** which layer produced the category */
  source: "rules" | "knowledge_base" | "ai" | "prefilled" | "review";
  confidence?: number;
}
