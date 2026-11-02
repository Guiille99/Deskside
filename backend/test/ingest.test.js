import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync, truncateSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/schema.js';
import { ingest, IngestError } from '../src/ingest.js';
import { ALL_FIELDS } from '../src/validator.js';
import { CASES, MARK, T0F_CODES } from './fixtures/cases.js';

const SRC = 'fuente-prueba';
const valid = (n, extra = '') =>
  `{"timestamp":"2026-10-31T10:00:${String(n % 60).padStart(2, '0')}.0000000+00:00","event":"Stop","session_id":"fixture-0001"${extra}}`;

// Cada test trabaja en su propia carpeta temporal, creada aquí y borrada al terminar.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-h1-'));
  const log = join(dir, 'events.jsonl');
  const dbPath = join(dir, 'office.db');
  let db = openDatabase(dbPath);
  t.after(() => { if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const ctx = {
    dir, log, dbPath,
    get db() { return db; },
    reopen() { db.close(); db = openDatabase(dbPath); },
    run(opts = {}) { return ingest(db, { sourceId: SRC, path: log, ...opts }); },
    events() { return db.prepare('SELECT * FROM event ORDER BY byte_offset').all(); },
    rejects() { return db.prepare('SELECT byte_offset, code FROM ingest_reject ORDER BY byte_offset').all().map((r) => ({ ...r })); },
    offsets() { return db.prepare('SELECT byte_offset FROM event UNION ALL SELECT byte_offset FROM ingest_reject ORDER BY 1').all().map((r) => r.byte_offset); },
    cursor() { return db.prepare('SELECT byte_offset FROM ingest_cursor WHERE source_id = ?').get(SRC)?.byte_offset; },
    snapshot() { return JSON.stringify(['event', 'ingest_reject', 'ingest_cursor'].map((tb) => db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all())); },
  };
  return ctx;
}

// Offset de inicio de cada línea completa del archivo (lo que debe quedar registrado, sin huecos).
function lineStarts(text, skip = 0) {
  const starts = [];
  let p = skip;
  while (p < text.length) { const nl = text.indexOf('\n', p); if (nl < 0) break; starts.push(p); p = nl + 1; }
  return starts;
}

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof IngestError && e.code === code && e.message === code && e.cause === undefined);

test('esquema exacto: tres tablas STRICT y columnas de la lista blanca', (t) => {
  const { db } = setup(t);
  const tables = db.prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(tables.map((r) => [r.name, r.strict]), [['event', 1], ['ingest_cursor', 1], ['ingest_reject', 1]]);
  const cols = (tb) => db.prepare(`SELECT name, type, "notnull" AS nn FROM pragma_table_info('${tb}')`).all().map((c) => [c.name, c.type, c.nn]);
  const expectedEvent = ['source_id', 'byte_offset', 'timestamp', 'event', 'session_id', 'agent_id', 'agent_type', 'permission_mode',
    'source', 'model', 'reason', 'stop_hook_active', 'background_tasks_count', 'session_crons_count', 'error', 'notification_type',
    'tool_name', 'tool_use_id', 'duration_ms', 'is_interrupt'];
  assert.deepEqual(cols('event').map((c) => c[0]), expectedEvent);
  assert.deepEqual(expectedEvent.slice(2), ALL_FIELDS);
  const nn = Object.fromEntries(cols('event').map((c) => [c[0], c[2]]));
  for (const k of ['source_id', 'byte_offset', 'timestamp', 'event', 'session_id']) assert.equal(nn[k], 1, k);
  for (const k of ALL_FIELDS.slice(3)) assert.equal(nn[k], 0, `${k} admite NULL`);
  assert.deepEqual(cols('ingest_cursor'), [['source_id', 'TEXT', 1], ['file_identity', 'TEXT', 1], ['byte_offset', 'INTEGER', 1]]);
  assert.deepEqual(cols('ingest_reject'), [['source_id', 'TEXT', 1], ['byte_offset', 'INTEGER', 1], ['code', 'TEXT', 1]]);
  const uniques = db.prepare("SELECT il.name FROM pragma_index_list('event') il WHERE il.\"unique\" = 1").all()
    .map((r) => db.prepare('SELECT name FROM pragma_index_info(?)').all(r.name).map((c) => c.name).join(','));
  assert.deepEqual(uniques, ['source_id,byte_offset']);
});

test('T0-F: un evento y ocho rechazos con su código y offset', (t) => {
  const s = setup(t);
  copyFileSync(new URL('./fixtures/t0f.jsonl', import.meta.url), s.log);
  const text = readFileSync(s.log, 'latin1');
  const r = s.run();
  assert.deepEqual({ events: r.events, rejects: r.rejects }, { events: 1, rejects: 8 });
  const starts = lineStarts(text);
  assert.equal(s.events()[0].byte_offset, starts[0]);
  assert.deepEqual(s.rejects(), starts.slice(1).map((o, i) => ({ byte_offset: o, code: T0F_CODES[i + 1] })));
  assert.equal(s.cursor(), text.length);
});

test('ausencia de agent_id, agent_type y tool_use_id se guarda como NULL', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n{"timestamp":"2026-10-31T10:00:02.0000000+00:00","event":"PreToolUse","session_id":"fixture-0001","tool_name":"Bash"}\n`);
  s.run();
  for (const e of s.events()) {
    assert.equal(e.agent_id, null);
    assert.equal(e.agent_type, null);
    assert.equal(e.tool_use_id, null);
  }
  const types = s.db.prepare('SELECT typeof(agent_id) a, typeof(stop_hook_active) b FROM event').all();
  assert.deepEqual(types.map((r) => [r.a, r.b]), [['null', 'null'], ['null', 'null']]);
});

test('booleanos y enteros se guardan como INTEGER sin alterar su valor', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1, ',"stop_hook_active":true,"background_tasks_count":7')}\n`);
  s.run();
  const e = s.db.prepare('SELECT stop_hook_active, background_tasks_count, typeof(background_tasks_count) ty FROM event').get();
  assert.deepEqual([e.stop_hook_active, e.background_tasks_count, e.ty], [1, 7, 'integer']);
});

test('BOM solo se acepta al inicio del archivo', (t) => {
  const s = setup(t);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(s.log, Buffer.concat([bom, Buffer.from(`${valid(1)}\n`), bom, Buffer.from(`${valid(2)}\n`)]));
  s.run();
  assert.deepEqual(s.events().map((e) => e.byte_offset), [3]);
  assert.deepEqual(s.rejects(), [{ byte_offset: 3 + valid(1).length + 1, code: 'invalid_json' }]);
});

test('CRLF y LF mezclados; un CR suelto dentro de la línea se rechaza', (t) => {
  const s = setup(t);
  const text = `${valid(1)}\r\n${valid(2)}\n${valid(3)}\r\n\r\n   \r\n${valid(4).replace(',', ',\r')}\n`;
  writeFileSync(s.log, text);
  const r = s.run();
  assert.deepEqual([r.events, r.blank, r.rejects], [3, 2, 1]);
  assert.equal(s.rejects()[0].code, 'line_break');
  assert.equal(s.cursor(), text.length);
});

test('una línea incompleta no se ingiere hasta que se completa', (t) => {
  const s = setup(t);
  const line = valid(1, ',"agent_type":"Explore"');
  writeFileSync(s.log, `${valid(0)}\n${line.slice(0, 40)}`);
  s.run();
  assert.equal(s.events().length, 1);
  assert.equal(s.rejects().length, 0);
  assert.equal(s.cursor(), valid(0).length + 1);
  appendFileSync(s.log, line.slice(40));
  s.run();
  assert.equal(s.events().length, 1, 'sigue sin \\n final');
  appendFileSync(s.log, '\r\n');
  s.run();
  assert.deepEqual(s.events().map((e) => [e.byte_offset, e.agent_type]), [[0, null], [valid(0).length + 1, 'Explore']]);
});

test('una línea cortada a mitad de un carácter UTF-8 se completa correctamente', (t) => {
  const s = setup(t);
  const bytes = Buffer.from(`${valid(1, ',"agent_id":"a1"')}\n`.replace('a1', 'a\u00e91'));
  writeFileSync(s.log, bytes.subarray(0, bytes.indexOf(0xa9)));
  s.run();
  assert.equal(s.rejects().length, 0);
  appendFileSync(s.log, bytes.subarray(bytes.indexOf(0xa9)));
  s.run();
  assert.deepEqual(s.rejects(), [{ byte_offset: 0, code: 'invalid_value' }], 'UTF-8 válido, pero agent_id no cumple el patrón');
});

test('reanudación tras reiniciar desde el cursor persistido', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n${valid(2)}\n`);
  s.run();
  s.reopen();
  appendFileSync(s.log, `${valid(3)}\nnot json\n`);
  const r = s.run();
  assert.deepEqual([r.events, r.rejects], [1, 1]);
  assert.deepEqual(s.offsets(), lineStarts(readFileSync(s.log, 'latin1')));
});

test('idempotencia: repetir la ingesta no duplica eventos ni rechazos', (t) => {
  const s = setup(t);
  writeFileSync(s.log, CASES.map((c) => c.line).join('\n') + '\n');
  s.run();
  const before = s.snapshot();
  for (let i = 0; i < 3; i++) assert.deepEqual(s.run(), { events: 0, rejects: 0, blank: 0, batches: 0 });
  s.reopen();
  s.run();
  assert.equal(s.snapshot(), before);
  assert.equal(s.events().length, CASES.filter((c) => c.code === null).length);
  assert.equal(s.rejects().length, CASES.filter((c) => c.code !== null).length);
});

test('lotes acotados: mismo resultado en varias transacciones', (t) => {
  const a = setup(t);
  const b = setup(t);
  const text = Array.from({ length: 7 }, (_, i) => valid(i)).join('\n') + '\n';
  writeFileSync(a.log, text);
  writeFileSync(b.log, text);
  assert.equal(a.run({ batchLines: 2 }).batches, 4);
  assert.equal(b.run().batches, 1);
  // Archivos distintos: todo igual salvo la identidad física del cursor.
  assert.deepEqual([a.events(), a.rejects(), a.cursor()], [b.events(), b.rejects(), b.cursor()]);
});

test('rollback por excepción inyectada: el lote falla entero y se recupera sin huecos ni duplicados', (t) => {
  const s = setup(t);
  const lines = [valid(0), 'x', valid(2), valid(3), valid(4), 'y', valid(6)];
  writeFileSync(s.log, lines.join('\n') + '\n');
  const starts = lineStarts(readFileSync(s.log, 'latin1'));
  // Fallo inyectado desde SQLite al insertar la línea 4 (segundo lote con batchLines = 2).
  s.db.exec(`CREATE TEMP TRIGGER fallo BEFORE INSERT ON event WHEN NEW.byte_offset = ${starts[3]} BEGIN SELECT RAISE(ABORT, 'inyectado'); END`);
  throwsCode(() => s.run({ batchLines: 2 }), 'INGEST_FAILED');
  assert.equal(s.db.isTransaction, false);
  assert.deepEqual(s.offsets(), starts.slice(0, 2), 'solo el primer lote quedó confirmado');
  assert.equal(s.cursor(), starts[2]);
  throwsCode(() => s.run({ batchLines: 2 }), 'INGEST_FAILED');
  assert.deepEqual(s.offsets(), starts.slice(0, 2), 'reintento con el fallo activo: nada cambia');
  s.db.exec('DROP TRIGGER fallo');
  s.run({ batchLines: 2 });
  assert.deepEqual(s.offsets(), starts);
  assert.equal(s.cursor(), readFileSync(s.log).length);
});

test('rollback cuando falla la inserción de un rechazo', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(0)}\nbad\n${valid(2)}\n`);
  s.db.exec("CREATE TEMP TRIGGER fallo BEFORE INSERT ON ingest_reject BEGIN SELECT RAISE(ABORT, 'inyectado'); END");
  throwsCode(() => s.run(), 'INGEST_FAILED');
  assert.deepEqual([s.events().length, s.rejects().length], [0, 0]);
  assert.equal(s.cursor(), undefined, 'ni siquiera se crea el cursor');
  s.db.exec('DROP TRIGGER fallo');
  s.run();
  assert.deepEqual(s.offsets(), lineStarts(readFileSync(s.log, 'latin1')));
});

test('truncamiento detiene la ingesta sin tocar el estado', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n${valid(2)}\n`);
  s.run();
  const before = s.snapshot();
  truncateSync(s.log, valid(1).length + 1 - 5);
  throwsCode(() => s.run(), 'SOURCE_TRUNCATED');
  assert.equal(s.snapshot(), before);
});

test('truncamiento y reescritura del mismo archivo hasta superar el cursor', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n`);
  s.run();
  const before = s.snapshot();
  // Misma identidad física, contenido distinto. Se detecta porque el byte en offset-1 ya no es \n; si lo fuera, no se detectaría.
  writeFileSync(s.log, `${valid(1, ',"agent_id":"abc"')}\n`);
  throwsCode(() => s.run(), 'SOURCE_TRUNCATED');
  assert.equal(s.snapshot(), before);
});

test('sustitución del archivo (renombrado encima) detiene la ingesta', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n`);
  s.run();
  const before = s.snapshot();
  const other = join(s.dir, 'otro.jsonl');
  writeFileSync(other, `${valid(1)}\n${valid(2)}\n`);
  renameSync(other, s.log);
  throwsCode(() => s.run(), 'SOURCE_REPLACED');
  throwsCode(() => s.run(), 'SOURCE_REPLACED');
  assert.equal(s.snapshot(), before);
});

// Garantía de NTFS, no de Node: en NTFS el FileId cambia al borrar y recrear. En POSIX un inode liberado
// puede reutilizarse y dev:ino no distingue los dos archivos (no verificado: estos tests solo se han ejecutado
// en Windows NTFS). Fuera de Windows no se exige la detección, pero cualquier error debe seguir siendo SOURCE_REPLACED.
test('sustitución del archivo (borrado y recreado): detectada en Windows, limitación documentada en el resto', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n`);
  s.run();
  unlinkSync(s.log);
  writeFileSync(s.log, `${valid(1)}\n${valid(2)}\n`);
  if (process.platform === 'win32') return throwsCode(() => s.run(), 'SOURCE_REPLACED');
  let code = null;
  try { s.run(); } catch (e) { code = e.code; }
  assert.ok(code === null || code === 'SOURCE_REPLACED', 'solo se admite SOURCE_REPLACED o ningún error');
  t.diagnostic(code === null
    ? `${process.platform}: la sustitución NO se detectó (dev:ino reutilizado). Limitación conocida, ver README.`
    : `${process.platform}: la sustitución se detectó. No es una garantía: depende del sistema de archivos.`);
});

test('la identidad lógica no depende de la ruta: mover el archivo y seguir', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `${valid(1)}\n`);
  s.run();
  const moved = join(s.dir, 'movido.jsonl');
  renameSync(s.log, moved);
  appendFileSync(moved, `${valid(2)}\n`);
  ingest(s.db, { sourceId: SRC, path: moved });
  assert.equal(s.events().length, 2);
  // Solo documenta que el esquema lo permite: dos sourceId sobre el mismo archivo ingieren dos veces. No es un uso soportado.
  ingest(s.db, { sourceId: 'otra-fuente', path: moved });
  assert.equal(s.db.prepare("SELECT count(*) n FROM event WHERE source_id = 'otra-fuente'").get().n, 2);
});

test('UTF-8 inválido y líneas más largas que el lote', (t) => {
  const s = setup(t);
  const long = valid(2, `,"agent_id":"${'a'.repeat(300)}"`);
  writeFileSync(s.log, Buffer.concat([Buffer.from(`${valid(0)}\n`), Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), Buffer.from(`${long}\n${valid(3)}\n`)]));
  s.run({ batchBytes: 128 });
  const o = valid(0).length + 1;
  assert.deepEqual(s.rejects(), [{ byte_offset: o, code: 'invalid_utf8' }, { byte_offset: o + 4, code: 'line_too_long' }]);
  assert.equal(s.events().length, 2);
  assert.equal(s.cursor(), readFileSync(s.log).length);
});

test('una línea larga incompleta no se rechaza todavía', (t) => {
  const s = setup(t);
  writeFileSync(s.log, `{"timestamp":"${'x'.repeat(500)}`);
  s.run({ batchBytes: 64 });
  assert.deepEqual([s.rejects().length, s.cursor()], [0, 0]);
});

test('errores fijos para fuente inválida o ilegible', (t) => {
  const s = setup(t);
  throwsCode(() => ingest(s.db, { sourceId: 'C:\\ruta\\x', path: s.log }), 'INVALID_SOURCE_ID');
  throwsCode(() => ingest(s.db, { sourceId: SRC, path: join(s.dir, `no-existe-${MARK}.jsonl`) }), 'SOURCE_UNREADABLE');
});

test('privacidad: ninguna marca sintética llega a SQLite, a la salida ni a los errores', (t) => {
  const s = setup(t);
  const marked = CASES.filter((c) => c.line.includes(MARK)).map((c) => c.line);
  assert.ok(marked.length >= 10);
  const extra = [
    Buffer.from(`{"prompt":"${MARK}",\u00ff`, 'latin1'), // UTF-8 inválido con marca
    Buffer.from(`{"${MARK}":"${MARK.repeat(50)}"}`), // más largo que el lote
  ];
  writeFileSync(s.log, Buffer.concat([...marked.map((l) => Buffer.from(`${l}\n`)), ...extra.flatMap((b) => [b, Buffer.from('\n')]), Buffer.from(`${valid(1)}\n`)]));

  const written = [];
  const orig = [process.stdout.write, process.stderr.write];
  process.stdout.write = process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  const origConsole = { ...console };
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) console[k] = (...a) => written.push(a.join(' '));
  let errors = [];
  try {
    const r = s.run({ batchBytes: 256 });
    assert.deepEqual([r.events, r.rejects], [1, marked.length + extra.length]);
    s.db.exec("CREATE TEMP TRIGGER fallo BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'x'); END");
    appendFileSync(s.log, `${valid(2, `,"zz":"${MARK}"`)}\n${valid(3)}\n`);
    try { s.run(); } catch (e) { errors.push(e); }
  } finally {
    [process.stdout.write, process.stderr.write] = orig;
    Object.assign(console, origConsole);
  }
  assert.deepEqual(written, [], 'el ingestor no escribe nada en stdout ni stderr');
  assert.equal(errors.length, 1);
  assert.ok(!`${errors[0].message}${errors[0].stack}${JSON.stringify(errors[0])}`.includes(MARK));

  assert.ok(!s.snapshot().includes(MARK), 'ninguna tabla contiene la marca');
  const codes = s.db.prepare('SELECT DISTINCT code FROM ingest_reject ORDER BY code').all().map((r) => r.code);
  assert.ok(codes.includes('forbidden_field') && codes.includes('invalid_utf8') && codes.includes('line_too_long'));
  s.db.close();
  for (const f of readdirSync(s.dir)) {
    if (f === 'events.jsonl') continue;
    assert.ok(!readFileSync(join(s.dir, f)).includes(MARK), `${f} no contiene la marca`);
  }
});
