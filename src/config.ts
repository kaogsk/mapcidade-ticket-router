/**
 * config.ts — every environment variable is read here and nowhere else.
 */

import { type InternMode, parseWindow } from "./routing/internWindow.js";

export interface Config {
  port: number;
  dbPath: string;
  adminToken: string | null;
  routing: {
    enabled: boolean;
    dryRun: boolean;
    triageAgentId: string;
    n1FallbackMinutes: number;
    squadEditorEnabled: boolean;
  };
  poller: { enabled: boolean; intervalMs: number };
  ai: {
    provider: "fake" | "anthropic";
    model: string;
    apiKey: string | null;
    highConfidence: number;
    lowConfidence: number;
    dailyBudgetUsd: number;
    dedupeHours: number;
    timeoutMs: number;
  };
  flags: { noiseExtraRules: boolean; ideaExplicitRule: boolean; genericWordsToAi: boolean };
  intern: { mode: InternMode; window: { startMin: number; endMin: number }; windowText: string; tz: string; maxOpen: number; weekdaysOnly: boolean };
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? dflt : n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = env.AI_PROVIDER === "anthropic" ? "anthropic" : "fake";
  const mode = (["off", "shadow", "on"].includes(String(env.INTERN_MODE)) ? env.INTERN_MODE : "shadow") as InternMode;
  const windowText = env.INTERN_WINDOW || "08:00-11:59";
  return {
    port: num(env.PORT, 4101),
    dbPath: env.ROUTER_DB_PATH || "data/runtime/router.db",
    adminToken: env.ADMIN_TOKEN || null,
    routing: {
      enabled: bool(env.ROUTING_ENABLED, true),
      dryRun: bool(env.ROUTING_DRY_RUN, false),
      triageAgentId: env.TRIAGE_AGENT_ID || "1900",
      n1FallbackMinutes: num(env.N1_FALLBACK_MINUTES, 30),
      squadEditorEnabled: bool(env.SQUAD_EDITOR_ENABLED, true),
    },
    poller: { enabled: bool(env.POLLER_ENABLED, false), intervalMs: num(env.POLL_INTERVAL_SECONDS, 30) * 1000 },
    ai: {
      provider,
      model: env.AI_MODEL || (provider === "anthropic" ? "claude-haiku-5-5" : "fake-deterministic"),
      apiKey: env.ANTHROPIC_API_KEY || null,
      highConfidence: num(env.AI_HIGH_CONFIDENCE, 0.6),
      lowConfidence: num(env.AI_LOW_CONFIDENCE, 0.4),
      dailyBudgetUsd: num(env.AI_DAILY_BUDGET_USD, 1),
      dedupeHours: num(env.AI_DEDUPE_HOURS, 6),
      timeoutMs: num(env.AI_TIMEOUT_MS, 30_000),
    },
    flags: {
      noiseExtraRules: bool(env.NOISE_EXTRA_RULES, true),
      ideaExplicitRule: bool(env.IDEA_EXPLICIT_RULE, true),
      genericWordsToAi: bool(env.GENERIC_WORDS_TO_AI, true),
    },
    intern: {
      mode,
      window: parseWindow(windowText),
      windowText,
      tz: env.INTERN_TZ || "America/Sao_Paulo",
      maxOpen: num(env.INTERN_MAX_OPEN, 5),
      weekdaysOnly: bool(env.INTERN_WEEKDAYS_ONLY, true),
    },
  };
}
