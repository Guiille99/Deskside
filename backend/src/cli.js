// Diagnóstico: solo recuentos. Nunca imprime identificadores, timestamps ni contenido.
// Uso: node src/cli.js --db <ruta.db> [--source <ruta.jsonl> [--watch]]
import { parseArgs } from 'node:util';
import { openDatabase } from './schema.js';
import { ingest, IngestError } from './ingest.js';
import { loadModel } from './hierarchy.js';
import { presence, STATES } from './presence.js';
import { startService } from './service.js';

const SOURCE_ID = 'hooks';
const tally = (list, key, keys) => Object.fromEntries(keys.map((k) => [k, list.filter((x) => x[key] === k).length]));

export function counts(model, rejects, nowMs) {
  const p = presence(model, nowMs);
  return {
    events: model.counts.events, rejects, sessions: model.sessions.length, agents: model.agents.length,
    anomalies: model.counts.anomalies, sessionStates: tally(p.sessions, 'state', STATES), agentStates: tally(p.agents, 'state', STATES),
  };
}

const rejectCounts = (db) => Object.fromEntries(db.prepare('SELECT code, count(*) AS n FROM ingest_reject GROUP BY code ORDER BY code').all().map((r) => [r.code, r.n]));

if (import.meta.main) {
  const { values: o } = parseArgs({ options: { db: { type: 'string' }, source: { type: 'string' }, watch: { type: 'boolean' } } });
  if (!o.db || (o.watch && !o.source)) {
    console.error('Uso: node src/cli.js --db <ruta.db> [--source <ruta.jsonl> [--watch]]');
    process.exit(2);
  }
  if (o.watch) {
    // Lee los rechazos con otra conexión (WAL) para no tocar la del servicio.
    let reader;
    startService({ dbPath: o.db, sourceId: SOURCE_ID, path: o.source,
      onModel: (m) => {
        reader ??= openDatabase(o.db);
        const d = new Date(); // hora local de emisión (HH:mm:ss.fff): sirve para medir la latencia contra la hora de escritura del JSONL
        const at = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
        console.log(JSON.stringify({ at, ...counts(m, rejectCounts(reader), d.getTime()) }));
      },
      onError: (code) => console.error(code) });
  } else {
    const db = openDatabase(o.db);
    try {
      if (o.source) ingest(db, { sourceId: SOURCE_ID, path: o.source });
      console.log(JSON.stringify(counts(loadModel(db), rejectCounts(db), Date.now()), null, 2));
    } catch (e) {
      console.error(e instanceof IngestError ? e.code : 'DIAG_FAILED');
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
}
