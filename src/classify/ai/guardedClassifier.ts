/**
 * guardedClassifier.ts — what makes an AI classifier safe to run unattended.
 *
 *  - Confidence bands: ≥ high → applied automatically; between low and high →
 *    sent to a human (review queue); < low → discarded (triage decides).
 *    The production cut ended at 0.6 after the calibration measurement showed
 *    the 0.6–0.7 band was right ~77% of the time.
 *  - Daily budget (USD): exceeded → no call, the ticket goes to triage.
 *  - Dedupe: same ticket + same text within the window → the previous answer,
 *    no new call. Without it the poller re-asked the model every cycle for a
 *    ticket that stayed unclassified (one spam ticket was sent 84 times), and
 *    each new sample was one more chance to cross the threshold by luck.
 *  - Ledger: every call that was made is recorded with tokens and cost, even
 *    when the answer was unusable — it was paid for.
 *  - Never blocks the caller: timeout or error → null.
 */

import crypto from "node:crypto";
import type { Db } from "../../store/db.js";
import type { AiClassifier, AiInput, AiOutput } from "./types.js";
import { costOf } from "./types.js";

export type Band = "apply" | "review" | "discard";

export interface GuardedResult {
  output: AiOutput;
  band: Band;
  cached: boolean;
  costUsd: number;
}

export interface GuardOptions {
  highConfidence: number;
  lowConfidence: number;
  dailyBudgetUsd: number;
  dedupeHours: number;
  timeoutMs: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

type Row = Record<string, unknown>;

export class GuardedClassifier {
  private readonly dedupe = new Map<string, { hash: string; at: number; result: GuardedResult | null }>();
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(
    readonly inner: AiClassifier,
    private readonly db: Db,
    readonly opts: GuardOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  get model(): string {
    return this.inner.model;
  }

  bandFor(confidence: number): Band {
    if (confidence >= this.opts.highConfidence) return "apply";
    if (confidence >= this.opts.lowConfidence) return "review";
    return "discard";
  }

  spentToday(): number {
    const day = this.now().toISOString().slice(0, 10);
    return Number((this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE day = ?").get(day) as Row).s);
  }

  private hash(input: AiInput): string {
    return crypto.createHash("sha1").update(`${this.inner.model}\u0001${input.subject}\u0001${input.description}`).digest("hex");
  }

  /** null = no usable answer (unavailable, budget, timeout, error, invalid output). */
  async classify(input: AiInput): Promise<GuardedResult | null> {
    const hash = this.hash(input);
    const windowMs = this.opts.dedupeHours * 3_600_000;
    const previous = this.dedupe.get(input.ticketId);
    if (windowMs > 0 && previous && previous.hash === hash && this.now().getTime() - previous.at <= windowMs) {
      return previous.result && { ...previous.result, cached: true, costUsd: 0 };
    }

    const spent = this.spentToday();
    if (spent >= this.opts.dailyBudgetUsd) {
      this.log(`[ai] #${input.ticketId} daily budget exhausted ($${spent.toFixed(4)} / $${this.opts.dailyBudgetUsd.toFixed(2)}) — skipped`);
      return null;
    }

    let call;
    try {
      call = await withTimeout(this.inner.classify(input), this.opts.timeoutMs);
    } catch (e) {
      this.log(`[ai] #${input.ticketId} ${(e as Error).message}`);
      return null;
    }

    const costUsd = this.recordUsage(input.ticketId, call.usage);
    if (!call.output) {
      this.log(`[ai] #${input.ticketId} unusable answer (no valid tool input)`);
      this.remember(input.ticketId, hash, null);
      return null;
    }
    const band = this.bandFor(call.output.confidence);
    this.recordClassification(input.ticketId, call.output, band);
    const result: GuardedResult = { output: call.output, band, cached: false, costUsd };
    this.remember(input.ticketId, hash, result);
    return result;
  }

  private remember(ticketId: string, hash: string, result: GuardedResult | null): void {
    if (this.opts.dedupeHours <= 0) return;
    this.dedupe.delete(ticketId);
    this.dedupe.set(ticketId, { hash, at: this.now().getTime(), result });
    if (this.dedupe.size > 2000) this.dedupe.delete(this.dedupe.keys().next().value!);
  }

  private recordUsage(ticketId: string, usage: { inputTokens: number; outputTokens: number }): number {
    const cost = costOf(usage, this.inner.model);
    const now = this.now();
    this.db
      .prepare("INSERT INTO ai_usage (ticket, day, model, input_tokens, output_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ticketId, now.toISOString().slice(0, 10), this.inner.model, usage.inputTokens, usage.outputTokens, cost, now.toISOString());
    return cost;
  }

  private recordClassification(ticketId: string, out: AiOutput, band: Band): void {
    this.db
      .prepare(
        "INSERT INTO ai_classifications (ticket, model, service, category, urgency, confidence, band, reasoning, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ticketId, this.inner.model, out.service, out.category, out.urgency, out.confidence, band, out.reasoning, this.now().toISOString());
  }

  /** Totals for /ai/usage and the CLI. */
  usageSummary(): {
    calls: number;
    tickets: number;
    costUsd: number;
    spentToday: number;
    dailyBudgetUsd: number;
    bands: Record<Band, number>;
    model: string;
  } {
    const u = this.db.prepare("SELECT COUNT(*) AS calls, COUNT(DISTINCT ticket) AS tickets, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage").get() as Row;
    const bands: Record<Band, number> = { apply: 0, review: 0, discard: 0 };
    for (const r of this.db.prepare("SELECT band, COUNT(*) AS n FROM ai_classifications GROUP BY band").all() as Row[]) {
      bands[r.band as Band] = Number(r.n);
    }
    return {
      calls: Number(u.calls),
      tickets: Number(u.tickets),
      costUsd: Number(u.cost),
      spentToday: this.spentToday(),
      dailyBudgetUsd: this.opts.dailyBudgetUsd,
      bands,
      model: this.inner.model,
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    }),
  ]);
}
