/**
 * internWindow.ts — hand N1-without-owner tickets to interns, but only during
 * their (part-time) shift.
 *
 * The helpdesk's round-robin has no notion of working hours, so the interns'
 * queue is closed there and the router delivers instead:
 *   - inside the window (weekdays, configurable hours, in the support team's
 *     time zone) a ticket that would go to N1 WITHOUT owner goes to the intern
 *     of the same squad type, if they have fewer than `maxOpen` open tickets;
 *   - outside the window, above the limit, or if counting fails: nothing changes.
 *
 * Modes: off | shadow (decide and LOG what it would do, change nothing — how the
 * rule was validated before switching it on) | on.
 */

import type { Intern } from "../catalog.js";
import type { RouteDecision } from "./resolveRoute.js";

export type InternMode = "off" | "shadow" | "on";

export interface InternConfig {
  mode: InternMode;
  /** minutes since midnight; end exclusive */
  window: { startMin: number; endMin: number };
  tz: string;
  maxOpen: number;
  weekdaysOnly: boolean;
  interns: Intern[];
}

export interface InternOutcome {
  decision: RouteDecision;
  /** what the rule decided, for the decision log (also in shadow mode) */
  log: { mode: InternMode; applied: boolean; internId?: string; open?: number; skipped?: string } | null;
}

export function parseWindow(s: string): { startMin: number; endMin: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid window "${s}" (expected HH:MM-HH:MM)`);
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]) + 1; // "11:59" includes that minute
  if (startMin >= endMin || endMin > 24 * 60) throw new Error(`invalid window "${s}"`);
  return { startMin, endMin };
}

/** Local weekday (0=Sun) and minute of day in `tz`. */
export function localClock(now: Date, tz: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function insideWindow(now: Date, cfg: Pick<InternConfig, "window" | "tz" | "weekdaysOnly">): boolean {
  const { weekday, minute } = localClock(now, cfg.tz);
  if (cfg.weekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  return minute >= cfg.window.startMin && minute < cfg.window.endMin;
}

export async function applyInternWindow(
  decision: RouteDecision,
  cfg: InternConfig,
  deps: { now: Date; countOpen: (agentId: string) => Promise<number> },
): Promise<InternOutcome> {
  if (cfg.mode === "off" || decision.action !== "n1" || decision.owner !== null) return { decision, log: null };
  const intern = cfg.interns.find((i) => i.type === decision.squadType);
  if (!intern) return { decision, log: { mode: cfg.mode, applied: false, skipped: "no intern for this type" } };
  if (!insideWindow(deps.now, cfg)) return { decision, log: { mode: cfg.mode, applied: false, internId: intern.id, skipped: "outside window" } };

  let open: number;
  try {
    open = await deps.countOpen(intern.id);
  } catch {
    return { decision, log: { mode: cfg.mode, applied: false, internId: intern.id, skipped: "count failed" } };
  }
  if (open >= cfg.maxOpen) {
    return { decision, log: { mode: cfg.mode, applied: false, internId: intern.id, open, skipped: `at limit (${open}/${cfg.maxOpen})` } };
  }
  if (cfg.mode === "shadow") return { decision, log: { mode: "shadow", applied: false, internId: intern.id, open } };
  return {
    decision: { ...decision, action: "squad", owner: intern.id, ownerName: intern.name, reason: `${decision.reason}; intern window → ${intern.name} (${open} open)` },
    log: { mode: "on", applied: true, internId: intern.id, open },
  };
}
