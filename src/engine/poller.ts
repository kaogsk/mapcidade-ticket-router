/**
 * poller.ts — the cycle: N1 safety net, then every "New" ticket not yet handled.
 *
 * One lock for the whole cycle (a slow helpdesk must never make two cycles
 * overlap and answer the same ticket twice), and stop() waits for the cycle in
 * flight so a deploy never cuts a ticket between "replied" and "routed".
 */

import type { HelpdeskApi } from "../helpdesk/types.js";
import type { DecisionLog } from "../store/decisionLog.js";
import type { ProcessOutcome, TicketProcessor } from "./processor.js";

export interface PollerStats {
  cycles: number;
  processed: number;
  errors: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastOutcomes: Array<Pick<ProcessOutcome, "ticketId" | "outcome" | "detail">>;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private paused = false;
  readonly stats: PollerStats = { cycles: 0, processed: 0, errors: 0, lastRunAt: null, lastError: null, lastOutcomes: [] };

  constructor(
    private readonly deps: { helpdesk: HelpdeskApi; processor: TicketProcessor; decisions: DecisionLog; log?: (m: string) => void },
    private readonly intervalMs: number,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    void this.runOnce();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Runs a cycle; if one is already running, returns that one instead of starting another. */
  runOnce(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<void> {
    const log = this.deps.log ?? ((m: string) => console.log(m));
    this.stats.cycles++;
    this.stats.lastRunAt = new Date().toISOString();
    try {
      await this.deps.processor.checkN1Fallback();
      const tickets = await this.deps.helpdesk.listTickets({ status: "New", limit: 100 });
      for (const t of tickets) {
        if (this.deps.decisions.isProcessed(t.id)) continue;
        const out = await this.deps.processor.process(t.id);
        if (out.outcome === "skipped") continue;
        this.stats.processed++;
        if (out.outcome === "error") this.stats.errors++;
        this.stats.lastOutcomes.unshift({ ticketId: out.ticketId, outcome: out.outcome, detail: out.detail });
        this.stats.lastOutcomes.length = Math.min(this.stats.lastOutcomes.length, 50);
      }
    } catch (e) {
      // network failure: nothing is lost, the next cycle re-reads the latest tickets
      this.stats.errors++;
      this.stats.lastError = (e as Error).message;
      log(`[poller] cycle failed: ${(e as Error).message} — retrying next cycle`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
