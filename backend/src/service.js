// Fase 3: servicio que vigila el JSONL, lo ingiere y entrega el modelo de jerarquía cuando cambia.
// fs.watch da la latencia baja; el sondeo cubre lo que fs.watch pierde (archivo aún sin crear, renombrado, red).
import { watch } from 'node:fs';
import { openDatabase } from './schema.js';
import { ingest, IngestError } from './ingest.js';
import { loadModel } from './hierarchy.js';

// Aprobado el 2026-11-02.
export const RETENTION_DAYS = 30;
const HOUR_MS = 3600000;

// Borra las sesiones completas cuyo último evento es anterior al corte: no deja sesiones a medias (SOLO_STOP falsos).
// Los rechazos no tienen fecha y se conservan (solo offset y código). Devuelve el número de eventos borrados.
export function prune(db, nowMs, days = RETENTION_DAYS) {
  const cutoff = new Date(nowMs - days * 24 * HOUR_MS).toISOString().slice(0, 23) + '0000+00:00'; // mismo formato que H1
  return Number(db.prepare(`DELETE FROM event WHERE session_id IN
    (SELECT session_id FROM event GROUP BY session_id HAVING max(timestamp) < ?)`).run(cutoff).changes);
}

// onModel(model) tras cada cambio; onError(code) con códigos fijos, solo cuando el código cambia.
export function startService({ dbPath, sourceId, path, onModel, onError = () => {}, pollMs = 500, retentionDays = RETENTION_DAYS }) {
  const db = openDatabase(dbPath);
  db.exec('PRAGMA journal_mode = WAL'); // lectores concurrentes (la UI) sin bloquear la ingesta
  let watcher = null;
  let lastError = null;
  let lastPrune = 0;

  const report = (code) => { if (code !== lastError) { lastError = code; onError(code); } };
  const emit = () => { try { onModel(loadModel(db)); } catch { report('SERVICE_FAILED'); } };

  const tick = (force = false) => {
    let changed = force;
    try {
      if (Date.now() - lastPrune >= HOUR_MS) { changed = prune(db, Date.now(), retentionDays) > 0 || changed; lastPrune = Date.now(); }
      const t = ingest(db, { sourceId, path });
      changed ||= t.events + t.rejects > 0;
      lastError = null;
    } catch (e) {
      report(e instanceof IngestError ? e.code : 'SERVICE_FAILED'); // sin mensaje original
    }
    if (changed) emit();
    if (!watcher) {
      try {
        watcher = watch(path, () => tick());
        watcher.on('error', () => { watcher.close(); watcher = null; });
      } catch { watcher = null; } // archivo aún sin crear: lo cubre el sondeo
    }
  };
  tick(true);
  const timer = setInterval(() => tick(), pollMs);
  return {
    stop() { clearInterval(timer); watcher?.close(); db.close(); },
  };
}
