/**
 * replies.ts — the router's first reply. Its opening sentence is what
 * isAutomatedFirstReply() recognizes, so it is never read back by the rules.
 */

import type { Classification, Ticket } from "../domain.js";

export const BOT = { id: "router-bot", isAgent: true };

const SLA: Record<string, string> = {
  Urgent: "within 4 business hours",
  High: "within 1 business day",
  Normal: "within 3 business days",
  Low: "within 5 business days",
};

export function firstReply(ticket: Ticket, c: Classification): string {
  return [
    `We confirm that your ticket has been received by the MapCidade support team (#${ticket.id}).`,
    `It was registered as "${c.category}" for ${c.service}${c.city ? ` (${c.city})` : ""}, urgency ${c.urgency}.`,
    `First analysis expected ${SLA[c.urgency] ?? "soon"}.`,
  ].join(" ");
}

export function triageReply(ticket: Ticket): string {
  return `We confirm that your ticket has been received by the MapCidade support team (#${ticket.id}). Our triage team will review it and get back to you shortly.`;
}
