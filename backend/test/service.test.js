import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/schema.js';
import { ingest } from '../src/ingest.js';
import { startService, prune } from '../src/service.js';
import { MARK } from './fixtures/cases.js';

const line = (event, iso, sid = 'fixture-0001', extra = {}) =>
  JSON.stringify({ timestamp: `${iso.slice(0, 19)}.0000000+00:00`, event, session_id: sid, ...extra }) + '\n';
const nowIso = () => new Date().toISOString();

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-h3-'));
  const ctx = { dir, log: join(dir, 'events.jsonl'), dbPath: join(dir, 'office.db'), services: [], dbs: [] };
  t.after(() => { ctx.services.forEach((s) => s.stop()); ctx.dbs.forEach((d) => d.close()); rmSync(dir, { recursive: true, force: true }); });
  ctx.open = () => { const db = openDatabase(ctx.dbPath); ctx.dbs.push(db); return db; };
  // Arranca el servicio y devuelve una función que espera al siguiente modelo (o error) que cumpla `pred`.
  ctx.start = (opts = {}) => {
    const waiters = [];
    const seen = { models: [], errors: [] };
    const notify = () => waiters.splice(0).forEach((w) => (w.pred(seen) ? w.resolve() : waiters.push(w)));
    const svc = startService({ dbPath: ctx.dbPath, sourceId: 'hooks', path: ctx.log, ...opts,
      onModel: (m) => { seen.models.push(m); notify(); }, onError: (c) => { seen.errors.push(c); notify(); } });
    ctx.services.push(svc);
    ctx.seen = seen;
    ctx.until = (pred, ms = 3000) => new Promise((resolve, reject) => {
      if (pred(seen)) return resolve();
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms).unref();
    });
    return svc;
  };
  return ctx;
}

test('1. el modelo se actualiza en < 1 s tras añadir un evento (salida de la Fase 3)', async (t) => {
  const c = setup(t);
  writeFileSync(c.log, line('SessionStart', nowIso(), undefined, { source: 'startup' }));
  c.start();
  await c.until((s) => s.models.at(-1)?.counts.events === 1);
  for (let i = 2; i <= 4; i++) {
    const t0 = performance.now();
    appendFileSync(c.log, line('UserPromptSubmit', nowIso()));
    await c.until((s) => s.models.at(-1).counts.events === i);
    const ms = performance.now() - t0;
    t.diagnostic(`latencia ${i - 1}: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 1000, `${ms} ms`);
  }
});

test('2. sin líneas nuevas no se recalcula el modelo; con ellas, sí', async (t) => {
  const c = setup(t);
  writeFileSync(c.log, '');
  c.start({ pollMs: 100 });
  await c.until((s) => s.models.length === 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(c.seen.models.length, 1); // sondeos sin líneas nuevas: nada que emitir
  appendFileSync(c.log, line('Stop', nowIso()));
  await c.until((s) => s.models.at(-1).counts.events === 1);
});

test('3. JSONL aún sin crear: modelo vacío, SOURCE_UNREADABLE una sola vez, y empieza al aparecer', async (t) => {
  const c = setup(t);
  c.start({ pollMs: 50 });
  await c.until((s) => s.models.length === 1 && s.errors.length === 1);
  assert.equal(c.seen.models[0].counts.events, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(c.seen.errors, ['SOURCE_UNREADABLE']);
  writeFileSync(c.log, line('Stop', nowIso()));
  await c.until((s) => s.models.at(-1).counts.events === 1);
});

test('4. error fijo de la ingesta (truncamiento): se notifica el código, sin mensaje, y el servicio sigue', async (t) => {
  const c = setup(t);
  writeFileSync(c.log, line('Stop', nowIso()) + line('Stop', nowIso()));
  c.start({ pollMs: 50 });
  await c.until((s) => s.models.at(-1)?.counts.events === 2);
  truncateSync(c.log, 0);
  await c.until((s) => s.errors.includes('SOURCE_TRUNCATED'));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(c.seen.errors, ['SOURCE_TRUNCATED']);
});

test('5. WAL activo y lectores concurrentes mientras el servicio escribe', async (t) => {
  const c = setup(t);
  writeFileSync(c.log, line('Stop', nowIso()));
  c.start();
  await c.until((s) => s.models.length === 1);
  const reader = c.open();
  assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  reader.exec('BEGIN');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM event').get().n, 1); // lectura abierta
  appendFileSync(c.log, line('Stop', nowIso()));
  await c.until((s) => s.models.at(-1).counts.events === 2); // la escritura no espera al lector
  reader.exec('COMMIT');
});

test('6. retención: borra sesiones enteras cuyo último evento es anterior al corte', (t) => {
  const c = setup(t);
  const db = c.open();
  const day = 24 * 3600000;
  const now = Date.UTC(2026, 10, 2, 12);
  const iso = (d) => new Date(now - d * day).toISOString();
  writeFileSync(c.log, line('Stop', iso(40), 'vieja-0001') + line('Stop', iso(31), 'vieja-0001')
    + line('Stop', iso(40), 'larga-0001') + line('Stop', iso(1), 'larga-0001') + line('Stop', iso(0), 'nueva-0001'));
  ingest(db, { sourceId: 'hooks', path: c.log });
  assert.equal(prune(db, now, 30), 2);
  assert.deepEqual(db.prepare('SELECT session_id, count(*) AS n FROM event GROUP BY 1 ORDER BY 1').all().map((r) => [r.session_id, r.n]),
    [['larga-0001', 2], ['nueva-0001', 1]]); // una sesión larga no se parte
  assert.equal(prune(db, now, 30), 0);
});

test('7. CLI de diagnóstico: solo recuentos, sin identificadores ni la marca', (t) => {
  const c = setup(t);
  const sid = `${MARK}-0001`;
  writeFileSync(c.log, line('SessionStart', nowIso(), sid, { source: 'startup' }) + line('UserPromptSubmit', nowIso(), sid)
    + line('SubagentStart', nowIso(), sid, { agent_id: `${MARK}a` }) + '{"no":"valido"}\n');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '--db', c.dbPath, '--source', c.log], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(MARK) && !r.stdout.includes('0001'));
  const out = JSON.parse(r.stdout);
  assert.equal(out.events, 3);
  assert.deepEqual(out.rejects, { missing_required: 1 });
  assert.equal(out.sessions, 1);
  assert.equal(out.sessionStates.WORKING, 1);
  assert.equal(out.agentStates.WORKING, 1);
  assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
});
