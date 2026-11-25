/**
 * resilientHelpdesk.ts — deadline on every call, retry with backoff on READS
 * only. A write (PATCH, reply) is never retried: if it timed out, it may have
 * been applied, and a retried reply is a duplicate e-mail to a citizen.
 * Same interface in and out, so it wraps the fake or a real adapter alike.
 */

import type { Ticket, TicketAction } from "../domain.js";
import { type HelpdeskApi, HelpdeskError, type TicketPatch, type TicketSummary } from "./types.js";

export interface ResilienceOptions {
  timeoutMs: number;
  /** total attempts for a read (1 = no retry) */
  readAttempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ResilientHelpdesk implements HelpdeskApi {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: HelpdeskApi,
    private readonly opts: ResilienceOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private deadline<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new HelpdeskError(`${what}: timeout after ${this.opts.timeoutMs} ms`, 0)), this.opts.timeoutMs);
      }),
    ]);
  }

  private async read<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.opts.readAttempts; attempt++) {
      try {
        return await this.deadline(fn(), what);
      } catch (e) {
        last = e;
        const retryable = e instanceof HelpdeskError ? e.retryable : true;
        if (!retryable || attempt === this.opts.readAttempts) break;
        await this.sleep(this.opts.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw last;
  }

  listTickets(query: { status?: string; limit?: number }): Promise<TicketSummary[]> {
    return this.read("listTickets", () => this.inner.listTickets(query));
  }

  getTicket(id: string): Promise<Ticket | null> {
    return this.read(`getTicket ${id}`, () => this.inner.getTicket(id));
  }

  countOpenByOwner(agentId: string): Promise<number> {
    return this.read(`countOpenByOwner ${agentId}`, () => this.inner.countOpenByOwner(agentId));
  }

  updateTicket(id: string, patch: TicketPatch): Promise<void> {
    return this.deadline(this.inner.updateTicket(id, patch), `updateTicket ${id}`);
  }

  addAction(id: string, action: Pick<TicketAction, "type" | "description" | "createdBy">): Promise<void> {
    return this.deadline(this.inner.addAction(id, action), `addAction ${id}`);
  }
}
