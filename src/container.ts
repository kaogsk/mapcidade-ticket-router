/**
 * container.ts — composition root. Builds the whole engine from a Config, so
 * the server, the CLI and the tests wire exactly the same objects.
 */

import { type Catalog, loadCatalog } from "./catalog.js";
import { GuardedClassifier } from "./classify/ai/guardedClassifier.js";
import { createAnthropicClassifier } from "./classify/ai/anthropicClassifier.js";
import { FakeClassifier } from "./classify/ai/fakeClassifier.js";
import type { AiClassifier } from "./classify/ai/types.js";
import { createCityDetector } from "./classify/cityDetector.js";
import { KnowledgeBase } from "./classify/knowledgeBase.js";
import { type Pipeline, createPipeline } from "./classify/pipeline.js";
import type { Config } from "./config.js";
import { Poller } from "./engine/poller.js";
import { TicketProcessor } from "./engine/processor.js";
import { type SquadAdmin, createSquadAdmin } from "./engine/squadAdmin.js";
import { FakeHelpdesk } from "./helpdesk/fakeHelpdesk.js";
import { ResilientHelpdesk } from "./helpdesk/resilientHelpdesk.js";
import type { HelpdeskApi } from "./helpdesk/types.js";
import { type SquadRegistry, createSquadRegistry, loadBaseline } from "./routing/squadRegistry.js";
import { generateKbTickets } from "./seed/kbSeed.js";
import { demoTickets } from "./seed/demoTickets.js";
import { type Db, openDb } from "./store/db.js";
import { DecisionLog } from "./store/decisionLog.js";
import { RoutingStore } from "./store/routingStore.js";
import { SquadStore } from "./store/squadStore.js";

export interface Container {
  config: Config;
  db: Db;
  catalog: Catalog;
  kb: KnowledgeBase;
  ai: GuardedClassifier;
  pipeline: Pipeline;
  registry: SquadRegistry;
  routingStore: RoutingStore;
  squadStore: SquadStore;
  decisions: DecisionLog;
  /** the fake, when the default helpdesk is in use (exposed for the simulator routes) */
  fakeHelpdesk: FakeHelpdesk | null;
  helpdesk: HelpdeskApi;
  processor: TicketProcessor;
  admin: SquadAdmin;
  poller: Poller;
  close(): Promise<void>;
}

export interface ContainerOptions {
  catalog?: Catalog;
  /** inject a specific helpdesk (tests); default: fake seeded with demo tickets */
  helpdesk?: HelpdeskApi;
  seedDemoTickets?: boolean;
  aiClassifier?: AiClassifier;
  now?: () => Date;
  log?: (msg: string) => void;
}

async function chooseClassifier(config: Config, log: (m: string) => void): Promise<AiClassifier> {
  if (config.ai.provider === "anthropic") {
    if (config.ai.apiKey) {
      log(`[ai] Anthropic adapter on (${config.ai.model})`);
      return createAnthropicClassifier({ apiKey: config.ai.apiKey, model: config.ai.model, timeoutMs: config.ai.timeoutMs });
    }
    log("[ai] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — using the deterministic fake");
  }
  return new FakeClassifier();
}

export async function buildContainer(config: Config, opts: ContainerOptions = {}): Promise<Container> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const catalog = opts.catalog ?? loadCatalog();
  const db = openDb(config.dbPath);

  const kb = new KnowledgeBase(db);
  if (kb.count() === 0) kb.load(generateKbTickets());

  const ai = new GuardedClassifier(opts.aiClassifier ?? (await chooseClassifier(config, log)), db, {
    highConfidence: config.ai.highConfidence,
    lowConfidence: config.ai.lowConfidence,
    dailyBudgetUsd: config.ai.dailyBudgetUsd,
    dedupeHours: config.ai.dedupeHours,
    timeoutMs: config.ai.timeoutMs,
    now: opts.now,
    log,
  });

  const pipeline = createPipeline({ catalog, detectCity: createCityDetector(catalog.cities), kb, ai, flags: config.flags });
  const squadStore = new SquadStore(db);
  const routingStore = new RoutingStore(db);
  const registry = createSquadRegistry({ store: squadStore, loadBaseline: () => loadBaseline(catalog.squadsPath), log });
  const decisions = new DecisionLog(db);

  let fakeHelpdesk: FakeHelpdesk | null = null;
  let helpdesk: HelpdeskApi;
  if (opts.helpdesk) {
    helpdesk = opts.helpdesk;
    if (opts.helpdesk instanceof FakeHelpdesk) fakeHelpdesk = opts.helpdesk;
  } else {
    fakeHelpdesk = new FakeHelpdesk(opts.seedDemoTickets === false ? [] : demoTickets());
    helpdesk = new ResilientHelpdesk(fakeHelpdesk, { timeoutMs: 10_000, readAttempts: 3, baseDelayMs: 300 });
  }

  const processor = new TicketProcessor({ helpdesk, pipeline, registry, routingStore, decisions, catalog, config, now: opts.now, log });
  const admin = createSquadAdmin({ registry, store: squadStore, routingStore, catalog, editorEnabled: config.routing.squadEditorEnabled });
  const poller = new Poller({ helpdesk, processor, decisions, log }, config.poller.intervalMs);

  return {
    config, db, catalog, kb, ai, pipeline, registry, routingStore, squadStore, decisions, fakeHelpdesk, helpdesk, processor, admin, poller,
    async close() {
      await poller.stop();
      db.close();
    },
  };
}
