/**
 * processor.ts — applies the decisions to the helpdesk.
 *
 * Classification and routing are pure; this is the only place that writes.
 * Ordering rules that came from incidents:
 *  - the first reply goes out BEFORE routing to triage, so the response-time SLA
 *    never depends on a human picking the ticket up;
 *  - a ticket is marked processed even when a later step fails — the reply may
 *    already have been sent, and re-processing would e-mail the citizen twice;
 *  - the routing switches (vacations, pause) are read on every decision, never
 *    cached: a change made in the panel applies to the very next ticket;
 *  - nothing here reassigns a ticket that is already open with someone.
 */

import type { Catalog } from "../catalog.js";
import { criticalUpgrade, isPermitsService, permitsUrgency } from "../classify/categoryRules.js";
import type { Pipeline, PipelineResult, TraceStep } from "../classify/pipeline.js";
import type { Config } from "../config.js";
import type { Category, Classification, Service, Ticket, Urgency } from "../domain.js";
import { CATEGORIES, SERVICES, STATUS_IN_ANALYSIS, STATUS_NEW, TEAM_N1, TEAM_TRIAGE, URGENCIES } from "../domain.js";
import type { HelpdeskApi, TicketPatch } from "../helpdesk/types.js";
import { applyInternWindow } from "../routing/internWindow.js";
import { type RouteDecision, type RouteInput, isSupportTeam, resolveRoute } from "../routing/resolveRoute.js";
import type { SquadRegistry } from "../routing/squadRegistry.js";
import type { DecisionLog } from "../store/decisionLog.js";
import type { RoutingStore } from "../store/routingStore.js";
import { BOT, firstReply, triageReply } from "./replies.js";

export interface ProcessOutcome {
  ticketId: string;
  outcome: "noise" | "classified" | "needs_human" | "skipped" | "error";
  detail?: string;
  classification?: Classification;
  decision?: RouteDecision | null;
  trace?: TraceStep[];
  dryRun: boolean;
}

export interface ProcessorDeps {
  helpdesk: HelpdeskApi;
  pipeline: Pipeline;
  registry: SquadRegistry;
  routingStore: RoutingStore;
  decisions: DecisionLog;
  catalog: Catalog;
  config: Config;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class TicketProcessor {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: ProcessorDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m) => console.log(m));
  }

  /** Route with the switches as they are RIGHT NOW. */
  currentRoute(input: Omit<RouteInput, "awayAgentIds" | "triageOnly" | "triageAgentId">): RouteDecision {
    return resolveRoute(this.d.registry.current(), {
      ...input,
      triageAgentId: this.d.config.routing.triageAgentId,
      awayAgentIds: this.d.routingStore.awayAgentIds(),
      triageOnly: this.d.routingStore.triageOnly().active,
    });
  }

  /** Route for a classified ticket, including the intern window. */
  private async routeFor(ticket: Ticket, c: Classification): Promise<{ decision: RouteDecision; intern: unknown }> {
    const base = this.currentRoute({
      city: c.city,
      citySource: c.citySource,
      service: c.service,
      contentText: `${ticket.subject} ${ticket.actions.find((a) => a.description)?.description ?? ""}`,
    });
    const cfg = this.d.config.intern;
    const out = await applyInternWindow(
      base,
      { ...cfg, interns: this.d.catalog.agents.interns },
      { now: this.now(), countOpen: (id) => this.d.helpdesk.countOpenByOwner(id) },
    );
    return { decision: out.decision, intern: out.log };
  }

  /** Dry run for the API/CLI/MCP: classification + the route it would take. No helpdesk writes. */
  async preview(ticket: Ticket): Promise<{ result: PipelineResult; decision: RouteDecision }> {
    const result = await this.d.pipeline.classify(ticket);
    let decision: RouteDecision;
    if (result.kind === "noise") decision = this.currentRoute({ noise: result.noise });
    else if (result.kind === "needs_human") decision = this.currentRoute({ classificationFailed: true });
    else decision = (await this.routeFor(ticket, result.classification)).decision;
    return { result, decision };
  }

  async applyRouting(
    ticketId: string,
    decision: RouteDecision,
    opts: { keepStatus?: boolean; classification?: Classification | null; intern?: unknown } = {},
  ): Promise<void> {
    const dryRun = this.d.config.routing.dryRun;
    const patch: TicketPatch = { ownerTeam: decision.ownerTeam, owner: decision.owner ? { id: decision.owner } : null };
    if (decision.tags?.length) patch.addTags = decision.tags;
    // assigned to a person → "In analysis"; the N1 queue without owner stays as is for the helpdesk round-robin
    if (decision.action === "squad" && !opts.keepStatus) patch.status = STATUS_IN_ANALYSIS;
    if (!dryRun) {
      await this.d.helpdesk.updateTicket(ticketId, patch);
      if (decision.action === "n1" && !decision.owner) this.d.routingStore.watch(ticketId, this.now().getTime());
    }
    this.d.decisions.record(ticketId, decision, {
      classSource: opts.classification?.source ?? null,
      category: opts.classification?.category ?? null,
      service: opts.classification?.service ?? null,
      dryRun,
      intern: opts.intern,
    });
    this.log(`[route] #${ticketId} ${decision.action}${decision.ownerName ? ` → ${decision.ownerName}` : ""} — ${decision.reason}${dryRun ? " (dry run)" : ""}`);
  }

  async process(ticketId: string, opts: { force?: boolean } = {}): Promise<ProcessOutcome> {
    const id = String(ticketId);
    const dryRun = this.d.config.routing.dryRun;
    if (!opts.force && this.d.decisions.isProcessed(id)) return { ticketId: id, outcome: "skipped", detail: "already processed", dryRun };

    const ticket = await this.d.helpdesk.getTicket(id);
    if (!ticket) {
      this.d.decisions.markProcessed(id, "missing");
      return { ticketId: id, outcome: "skipped", detail: "ticket not found", dryRun };
    }
    if (ticket.status !== STATUS_NEW) return { ticketId: id, outcome: "skipped", detail: `status is "${ticket.status}"`, dryRun };
    if (ticket.actions.some((a) => a.type === "public" && a.createdBy?.isAgent)) {
      this.d.decisions.markProcessed(id, "already_answered");
      return { ticketId: id, outcome: "skipped", detail: "an agent already answered", dryRun };
    }

    const result = await this.d.pipeline.classify(ticket);
    const route = this.d.config.routing.enabled && isSupportTeam(ticket.ownerTeam);
    const write = async (fn: () => Promise<void>) => {
      if (!dryRun) await fn();
    };

    try {
      if (result.kind === "noise") {
        // no classification, no reply: it is not a request; keep "New" for triage to cancel
        const decision = this.currentRoute({ noise: result.noise });
        if (route) await this.applyRouting(id, decision, { keepStatus: true });
        this.d.decisions.markProcessed(id, "noise");
        return { ticketId: id, outcome: "noise", decision: route ? decision : null, trace: result.trace, dryRun };
      }

      if (result.kind === "needs_human") {
        this.d.decisions.enqueueReview({
          ticket: id,
          subject: ticket.subject,
          suggestion: result.suggestion,
          confidence: result.suggestion?.confidence ?? null,
          reason: result.reason,
        });
        await write(() => this.d.helpdesk.addAction(id, { type: "public", description: triageReply(ticket), createdBy: BOT }));
        const decision = this.currentRoute({ classificationFailed: true });
        if (route) await this.applyRouting(id, decision, { keepStatus: true });
        this.d.decisions.markProcessed(id, "needs_human");
        return { ticketId: id, outcome: "needs_human", detail: result.reason, decision: route ? decision : null, trace: result.trace, dryRun };
      }

      const c = result.classification;
      const patch = classificationPatch(ticket, c);
      if (Object.keys(patch).length) await write(() => this.d.helpdesk.updateTicket(id, patch));
      await write(() => this.d.helpdesk.addAction(id, { type: "public", description: firstReply(ticket, c), createdBy: BOT }));
      // marked before routing: the reply is out, a routing failure must not resend it
      this.d.decisions.markProcessed(id, `classified:${c.source}`);
      let decision: RouteDecision | null = null;
      if (route) {
        const r = await this.routeFor(ticket, c);
        decision = r.decision;
        await this.applyRouting(id, decision, { classification: c, intern: r.intern });
      }
      return { ticketId: id, outcome: "classified", classification: c, decision, trace: result.trace, dryRun };
    } catch (e) {
      this.d.decisions.markProcessed(id, "error");
      this.log(`[process] #${id} failed: ${(e as Error).message}`);
      return { ticketId: id, outcome: "error", detail: (e as Error).message, trace: result.trace, dryRun };
    }
  }

  /**
   * Safety net: a ticket left in the N1 queue without owner for too long goes
   * back to triage — but only once the first reply is out.
   */
  async checkN1Fallback(): Promise<string[]> {
    const cfg = this.d.config.routing;
    if (!cfg.enabled || cfg.dryRun) return [];
    const moved: string[] = [];
    for (const id of this.d.routingStore.due(cfg.n1FallbackMinutes * 60_000, this.now().getTime())) {
      try {
        const t = await this.d.helpdesk.getTicket(id);
        if (!t || t.ownerTeam !== TEAM_N1 || t.owner?.id) {
          this.d.routingStore.unwatch(id); // picked up, moved elsewhere or gone
          continue;
        }
        if (!t.actions.some((a) => a.type === "public" && a.createdBy?.isAgent)) continue;
        await this.applyRouting(id, {
          action: "triage",
          owner: cfg.triageAgentId,
          ownerTeam: TEAM_TRIAGE,
          reason: `no owner in the N1 queue for > ${cfg.n1FallbackMinutes} min → back to triage`,
        });
        this.d.routingStore.unwatch(id);
        moved.push(id);
      } catch (e) {
        this.log(`[n1-fallback] #${id} ${(e as Error).message}`); // retried next cycle
      }
    }
    return moved;
  }

  /**
   * A human settles a ticket the AI was unsure about: accept the suggestion or
   * give the classification; then it is written and routed like any other.
   */
  async resolveReview(
    ticketId: string,
    body: { accept?: boolean; service?: string; category?: string; urgency?: string },
    actor: string,
  ): Promise<{ status: number; body: unknown }> {
    const review = this.d.decisions.getReview(ticketId);
    if (!review || review.status !== "pending") return { status: 404, body: { ok: false, error: "no pending review for this ticket" } };
    const ticket = await this.d.helpdesk.getTicket(ticketId);
    if (!ticket) return { status: 404, body: { ok: false, error: "ticket not found" } };

    let service: Service, category: Category, urgency: Urgency;
    if (body.accept) {
      if (!review.suggestion) return { status: 400, body: { ok: false, error: "there is no suggestion to accept; send service/category/urgency" } };
      service = review.suggestion.service;
      // accepting the AI's answer still goes through the business policy
      category = criticalUpgrade(review.suggestion.category, service) ?? review.suggestion.category;
      urgency = isPermitsService(service) ? permitsUrgency(review.suggestion.urgency) : review.suggestion.urgency;
    } else {
      if (!(SERVICES as readonly string[]).includes(String(body.service))) return { status: 400, body: { ok: false, error: "invalid service" } };
      if (!(CATEGORIES as readonly string[]).includes(String(body.category))) return { status: 400, body: { ok: false, error: "invalid category" } };
      if (!(URGENCIES as readonly string[]).includes(String(body.urgency))) return { status: 400, body: { ok: false, error: "invalid urgency" } };
      service = body.service as Service;
      category = body.category as Category;
      urgency = body.urgency as Urgency;
    }
    const { result } = await this.preview(ticket);
    const city = result.kind === "noise" ? null : result.kind === "classified" ? result.classification.city : result.city;
    const citySource = result.kind === "noise" ? null : result.kind === "classified" ? result.classification.citySource : result.citySource;
    const info = this.d.catalog.cities.find((x) => x.name === city);
    const c: Classification = { service, category, urgency, city, citySource, plan: info?.plan ?? null, projectCode: info?.projectCode ?? null, source: "review" };

    const dryRun = this.d.config.routing.dryRun;
    if (!dryRun) await this.d.helpdesk.updateTicket(ticketId, classificationPatch({ ...ticket, category: null }, c));
    let decision: RouteDecision | null = null;
    if (this.d.config.routing.enabled && isSupportTeam(ticket.ownerTeam)) {
      const r = await this.routeFor(ticket, c);
      decision = r.decision;
      await this.applyRouting(ticketId, decision, { classification: c, intern: r.intern });
    }
    this.d.decisions.resolveReview(ticketId, c, actor);
    return { status: 200, body: { ok: true, classification: c, decision } };
  }
}

/** Only the fields that change (a pre-filled ticket that is already right gets no PATCH). */
function classificationPatch(ticket: Ticket, c: Classification): TicketPatch {
  const patch: TicketPatch = {};
  if (ticket.service !== c.service) patch.service = c.service;
  if (ticket.category !== c.category) patch.category = c.category;
  if (ticket.urgency !== c.urgency) patch.urgency = c.urgency;
  const fields: Record<string, string> = {};
  if (c.plan && ticket.customFields?.plan !== c.plan) fields.plan = c.plan;
  if (c.projectCode && ticket.customFields?.project !== c.projectCode) fields.project = c.projectCode;
  if (c.source !== "prefilled") fields.classified_by = c.source;
  if (Object.keys(fields).length) patch.customFields = fields;
  return patch;
}
