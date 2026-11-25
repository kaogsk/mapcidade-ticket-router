/**
 * helpdesk/types.ts — the only surface of the ticketing API the router uses.
 * The repo ships a fake implementation; a real adapter would implement the
 * same interface (that is the whole point of keeping it this small).
 */

import type { Ticket, TicketAction } from "../domain.js";

export interface TicketSummary {
  id: string;
  subject: string;
  status: string;
  ownerTeam: string | null;
  category: string | null;
  createdAt: string;
}

export interface TicketPatch {
  service?: string;
  category?: string;
  urgency?: string;
  status?: string;
  ownerTeam?: string;
  /** null clears the owner */
  owner?: { id: string } | null;
  addTags?: string[];
  customFields?: Record<string, string>;
}

export interface HelpdeskApi {
  /** most recent tickets first */
  listTickets(query: { status?: string; limit?: number }): Promise<TicketSummary[]>;
  getTicket(id: string): Promise<Ticket | null>;
  updateTicket(id: string, patch: TicketPatch): Promise<void>;
  addAction(id: string, action: Pick<TicketAction, "type" | "description" | "createdBy">): Promise<void>;
  countOpenByOwner(agentId: string): Promise<number>;
}

/** HTTP-like error from the helpdesk. 5xx and network errors are retryable on reads. */
export class HelpdeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HelpdeskError";
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
