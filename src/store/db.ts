/**
 * db.ts — one SQLite file (node:sqlite, no native build) for all mutable state:
 * routing mode, vacations, squad overlay + audit, decisions, review queue, AI
 * ledger and the full-text knowledge base. ":memory:" in tests.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routing_mode (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  triage_only INTEGER NOT NULL DEFAULT 0 CHECK (triage_only IN (0, 1)),
  actor       TEXT,
  note        TEXT,
  updated_at  TEXT
);
INSERT OR IGNORE INTO routing_mode (id, triage_only) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS agent_availability (
  agent_id   TEXT PRIMARY KEY,
  away       INTEGER NOT NULL DEFAULT 0 CHECK (away IN (0, 1)),
  note       TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS n1_watch (
  ticket    TEXT PRIMARY KEY,
  routed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_city (
  type       TEXT NOT NULL CHECK (type IN ('permits', 'gis')),
  city_norm  TEXT NOT NULL,
  city       TEXT NOT NULL,
  agent_id   TEXT,
  agent_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (type, city_norm)
);

CREATE TABLE IF NOT EXISTS squad_member (
  agent_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  removed    INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  type       TEXT,
  city       TEXT,
  from_agent TEXT,
  to_agent   TEXT,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS squad_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO squad_meta (id, version) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS processed (
  ticket  TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  outcome TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  ticket         TEXT NOT NULL,
  action         TEXT NOT NULL,
  squad_type     TEXT,
  owner_id       TEXT,
  owner_name     TEXT,
  team           TEXT,
  city           TEXT,
  city_source    TEXT,
  fallback       TEXT,
  forced_permits INTEGER NOT NULL DEFAULT 0,
  triage_only    INTEGER NOT NULL DEFAULT 0,
  noise          TEXT,
  class_source   TEXT,
  category       TEXT,
  service        TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,
  intern_json    TEXT
);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);

CREATE TABLE IF NOT EXISTS review_queue (
  ticket       TEXT PRIMARY KEY,
  subject      TEXT NOT NULL,
  suggestion   TEXT,
  confidence   REAL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  final        TEXT
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket        TEXT,
  day           TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage (day);

CREATE TABLE IF NOT EXISTS ai_classifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket       TEXT NOT NULL,
  model        TEXT NOT NULL,
  service      TEXT,
  category     TEXT,
  urgency      TEXT,
  confidence   REAL NOT NULL DEFAULT 0,
  band         TEXT NOT NULL,
  reasoning    TEXT,
  at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_tickets (
  id       INTEGER PRIMARY KEY,
  subject  TEXT NOT NULL,
  body     TEXT NOT NULL,
  service  TEXT NOT NULL,
  category TEXT NOT NULL,
  urgency  TEXT NOT NULL,
  city     TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  subject, body, content='kb_tickets', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
`;

export type Db = DatabaseSync;

export function openDb(file: string = ":memory:"): Db {
  if (file !== ":memory:") {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Runs `fn` in one IMMEDIATE transaction (node:sqlite has no transaction helper). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
