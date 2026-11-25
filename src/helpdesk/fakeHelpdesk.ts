/**
 * fakeHelpdesk.ts — in-memory ticketing API with the behaviours that mattered
 * in production: it rejects values outside its own catalog (unknown category or
 * service → 400, like the real API), supports failure injection for the
 * resilience tests, and keeps a log of every write for assertions/demo.
 */

import type { Ticket, TicketAction } from "../domain.js";
import { CATEGORIES, SERVICES, URGENCIES } from "../domain.js";
import { type HelpdeskApi, HelpdeskError, type TicketPatch, type TicketSummary } from "./types.js";

export interface WriteLogEntry {
  at: string;
  ticketId: string;
  kind: "update" | "action";
  payload: unknown;
}

const OPEN_STATUSES = new Set(["New", "In analysis", "Waiting"]);

export class FakeHelpdesk implements HelpdeskApi {
  private readonly tickets = new Map<string, Ticket>();
  private nextId = 9000;
  private failures: Array<{ op: "read" | "write"; status: number }> = [];
  readonly writes: WriteLogEntry[] = [];
  /** reads served (including failed ones), for retry assertions */
  reads = 0;

  constructor(seed: Ticket[] = [], private readonly opts: { latencyMs?: number } = {}) {
    for (const t of seed) this.tickets.set(t.id, structuredClone(t));
  }

  /** The next `count` operations of `op` fail with `status` (0 = network error). */
  injectFailures(op: "read" | "write", status: number, count = 1): void {
    for (let i = 0; i < count; i++) this.failures.push({ op, status });
  }

  private async gate(op: "read" | "write"): Promise<void> {
    if (op === "read") this.reads++;
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const i = this.failures.findIndex((f) => f.op === op);
    if (i >= 0) {
      const f = this.failures.splice(i, 1)[0];
      throw new HelpdeskError(f.status === 0 ? "fetch failed (ECONNRESET)" : `helpdesk answered ${f.status}`, f.status);
    }
  }

  /** Creates a ticket as the helpdesk would when an e-mail/form arrives. */
  createTicket(input: Partial<Ticket> & { subject: string; body?: string }): Ticket {
    const id = String(input.id ?? this.nextId++);
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id,
      subject: input.subject,
      status: input.status ?? "New",
      ownerTeam: input.ownerTeam ?? "Support - Triage",
      owner: input.owner ?? null,
      service: input.service ?? null,
      category: input.category ?? null,
      urgency: input.urgency ?? null,
      tags: input.tags ?? [],
      clients: input.clients ?? [],
      actions: input.actions ?? (input.body ? [{ id: 1, type: "public", description: input.body, createdBy: { id: input.clients?.[0]?.id ?? "0" }, createdAt: now }] : []),
      createdAt: input.createdAt ?? now,
    };
    this.tickets.set(id, ticket);
    return structuredClone(ticket);
  }

  async listTickets(query: { status?: string; limit?: number }): Promise<TicketSummary[]> {
    await this.gate("read");
    return [...this.tickets.values()]
      .filter((t) => !query.status || t.status === query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.id) - Number(a.id))
      .slice(0, query.limit ?? 100)
      .map((t) => ({ id: t.id, subject: t.subject, status: t.status, ownerTeam: t.ownerTeam, category: t.category, createdAt: t.createdAt }));
  }

  async getTicket(id: string): Promise<Ticket | null> {
    await this.gate("read");
    const t = this.tickets.get(String(id));
    return t ? structuredClone(t) : null;
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<void> {
    await this.gate("write");
    const t = this.tickets.get(String(id));
    if (!t) throw new HelpdeskError(`ticket ${id} not found`, 404);
    if (patch.category !== undefined && !(CATEGORIES as readonly string[]).includes(patch.category)) {
      throw new HelpdeskError(`category "${patch.category}" does not exist`, 400);
    }
    if (patch.service !== undefined && !(SERVICES as readonly string[]).includes(patch.service)) {
      throw new HelpdeskError(`service "${patch.service}" does not exist`, 400);
    }
    if (patch.urgency !== undefined && !(URGENCIES as readonly string[]).includes(patch.urgency)) {
      throw new HelpdeskError(`urgency "${patch.urgency}" does not exist`, 400);
    }
    if (patch.service !== undefined) t.service = patch.service;
    if (patch.category !== undefined) t.category = patch.category;
    if (patch.urgency !== undefined) t.urgency = patch.urgency;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.ownerTeam !== undefined) t.ownerTeam = patch.ownerTeam;
    if (patch.owner !== undefined) t.owner = patch.owner ? { id: patch.owner.id } : null;
    if (patch.addTags) t.tags = [...new Set([...t.tags, ...patch.addTags])];
    if (patch.customFields) t.customFields = { ...(t.customFields || {}), ...patch.customFields };
    this.writes.push({ at: new Date().toISOString(), ticketId: t.id, kind: "update", payload: patch });
  }

  async addAction(id: string, action: Pick<TicketAction, "type" | "description" | "createdBy">): Promise<void> {
    await this.gate("write");
    const t = this.tickets.get(String(id));
    if (!t) throw new HelpdeskError(`ticket ${id} not found`, 404);
    const nextActionId = t.actions.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    t.actions.push({ id: nextActionId, ...action, createdAt: new Date().toISOString() });
    this.writes.push({ at: new Date().toISOString(), ticketId: t.id, kind: "action", payload: action });
  }

  async countOpenByOwner(agentId: string): Promise<number> {
    await this.gate("read");
    return [...this.tickets.values()].filter((t) => t.owner?.id === String(agentId) && OPEN_STATUSES.has(t.status)).length;
  }

  /** Test/demo helper: simulate an analyst picking a ticket up. */
  assign(id: string, agentId: string): void {
    const t = this.tickets.get(String(id));
    if (t) t.owner = { id: agentId };
  }

  snapshot(id: string): Ticket | null {
    const t = this.tickets.get(String(id));
    return t ? structuredClone(t) : null;
  }
}
