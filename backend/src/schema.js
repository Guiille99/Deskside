import { DatabaseSync as Database } from 'node:sqlite'; // DatabaseSync existe en Node 24 (Electron 45) y 26
import { REJECT_CODES } from './validator.js';

// event: solo campos de la lista blanca más la procedencia (source_id, byte_offset).
// agent_id, agent_type y tool_use_id admiten NULL: la identidad del agente se resuelve en H2.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_cursor (
  source_id     TEXT PRIMARY KEY,
  file_identity TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL CHECK (byte_offset >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS ingest_reject (
  source_id   TEXT NOT NULL,
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  code        TEXT NOT NULL CHECK (code IN (${REJECT_CODES.map((c) => `'${c}'`).join(', ')})),
  UNIQUE (source_id, byte_offset)
) STRICT;

CREATE TABLE IF NOT EXISTS event (
  source_id              TEXT NOT NULL,
  byte_offset            INTEGER NOT NULL CHECK (byte_offset >= 0),
  timestamp              TEXT NOT NULL,
  event                  TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  agent_id               TEXT,
  agent_type             TEXT,
  permission_mode        TEXT,
  source                 TEXT,
  model                  TEXT,
  reason                 TEXT,
  stop_hook_active       INTEGER CHECK (stop_hook_active IN (0, 1)),
  background_tasks_count INTEGER,
  session_crons_count    INTEGER,
  error                  TEXT,
  notification_type      TEXT,
  tool_name              TEXT,
  tool_use_id            TEXT,
  duration_ms            INTEGER,
  is_interrupt           INTEGER CHECK (is_interrupt IN (0, 1)),
  UNIQUE (source_id, byte_offset)
) STRICT;
`;

export function openDatabase(path) {
  const db = new Database(path, { timeout: 5000 });
  db.exec(SCHEMA);
  return db;
}
