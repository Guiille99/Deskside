import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/schema.js';
import { ingest } from '../src/ingest.js';
import { ALL_FIELDS } from '../src/validator.js';
import { buildModel, loadModel, LAUNCH_WINDOW_MS, ANOMALY_CODES } from '../src/hierarchy.js';

// Fixtures sintéticos: filas con la forma que guarda la ingesta (NULL para lo ausente).
const SID = 'sess-0001';
let seq = 0;
const ts = (s, f = 0) => `${new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString().slice(0, 19)}.${String(f).padStart(7, '0')}+00:00`;
const ev = (event, s, o = {}) => ({
  source_id: 'src-a', byte_offset: seq++, timestamp: ts(s, o.f ?? 0), event, session_id: SID,
  ...Object.fromEntries(ALL_FIELDS.slice(3).map((k) => [k, null])), ...o, f: undefined,
});
const clean = (r) => { delete r.f; return r; };
const E = (event, s, o) => clean(ev(event, s, o));
const pre = (s, o) => E('PreToolUse', s, { tool_name: 'Agent', ...o });
const start = (s, o) => E('SubagentStart', s, o);
const stop = (s, o) => E('SubagentStop', s, o);

const rels = (m, kind) => m.relations.filter((r) => r.kind === kind);
const parentOf = (m, id) => rels(m, 'PARENT_CHILD').find((r) => r.child.agent_id === id);
const codes = (m) => m.anomalies.map((a) => a.code);

test('1. eventos ordinarios sin agent_id: MAIN inferido, nunca observado', () => {
  const m = buildModel([E('UserPromptSubmit', 0), E('Stop', 1)]);
  assert.equal(m.sessions[0].mains.length, 1);
  assert.equal(m.sessions[0].mains[0].evidence, 'INFERRED');
  assert.equal(m.sessions[0].mains[0].events.length, 2);
  assert.deepEqual(m.counts.attributed, { SESSION: 0, MAIN: 2, AGENT: 0, UNKNOWN: 0 });
});

test('2. SessionStart/SessionEnd no crean MAIN: pertenecen a la sesión', () => {
  const m = buildModel([E('SessionStart', 0, { source: 'startup' }), E('SessionEnd', 1, { reason: 'other' })]);
  assert.deepEqual(m.sessions[0].mains, []);
  assert.equal(m.sessions[0].starts.length, 1);
  assert.equal(m.sessions[0].ends[0].reason, 'other');
  assert.equal(m.counts.attributed.SESSION, 2);
  assert.deepEqual(m.anomalies, []);
});

test('3. subagente simple: sesión→AGENT observada, lanzador→hijo inferida (doble inferencia con MAIN)', () => {
  const m = buildModel([pre(0, { tool_use_id: 'tu1' }), start(1, { agent_id: 'ag1', agent_type: 'Explore' }), stop(3, { agent_id: 'ag1' })]);
  const sa = rels(m, 'SESSION_AGENT')[0];
  assert.equal(sa.evidence, 'OBSERVED');
  const pc = parentOf(m, 'ag1');
  assert.equal(pc.evidence, 'INFERRED');
  assert.deepEqual(pc.parent, { kind: 'MAIN', evidence: 'INFERRED' });
  assert.deepEqual(pc.candidates, { launchers: 1, children: 1 });
  assert.equal(pc.window_ms, LAUNCH_WINDOW_MS);
  assert.equal(pc.launcher.tool_use_id, 'tu1');
  assert.equal(pc.launcher.context, 'MAIN');
  assert.equal(pc.child_start.event, 'SubagentStart');
  assert.equal(pc.delta_ms, 1000);
  assert.equal(m.agents[0].duration_ms, 2000);
  assert.equal(m.sessions[0].mains.length, 1);
  assert.ok(m.relations.every((r) => r.kind !== 'PARENT_CHILD' || r.evidence !== 'OBSERVED'));
});

test('4. subagente anidado: el lanzador puede ser un AGENT', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }),
    pre(20, { tool_use_id: 't2', agent_id: 'ag1' }), start(21, { agent_id: 'ag2' })]);
  assert.deepEqual(parentOf(m, 'ag1').parent, { kind: 'MAIN', evidence: 'INFERRED' });
  const p2 = parentOf(m, 'ag2');
  assert.equal(p2.evidence, 'INFERRED');
  assert.deepEqual(p2.parent, { kind: 'AGENT', agent_id: 'ag1', evidence: 'OBSERVED' });
});

test('5. varios agentes en paralelo bien separados', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }), pre(20, { tool_use_id: 't2' }), start(21, { agent_id: 'ag2' })]);
  assert.equal(parentOf(m, 'ag1').evidence, 'INFERRED');
  assert.equal(parentOf(m, 'ag2').evidence, 'INFERRED');
  assert.equal(m.agents.length, 2);
});

test('6. SubagentStart sin agent_id: UNKNOWN, sin agente ni MAIN', () => {
  const m = buildModel([start(0)]);
  assert.equal(m.agents.length, 0);
  assert.deepEqual(m.sessions[0].mains, []);
  assert.deepEqual(m.unknown.map((u) => u.causes), [['MISSING_AGENT_ID']]);
  assert.equal(m.counts.attributed.UNKNOWN, 1);
});

test('7. SubagentStop sin agent_id: UNKNOWN', () => {
  const m = buildModel([stop(0)]);
  assert.equal(m.agents.length, 0);
  assert.deepEqual(m.unknown.map((u) => u.event), ['SubagentStop']);
  assert.deepEqual(m.sessions[0].mains, []);
});

test('8. Pre con agent_id y Post sin él: CONTEXT_CONFLICT, eventos UNKNOWN', () => {
  const m = buildModel([E('PreToolUse', 0, { tool_name: 'Bash', tool_use_id: 'x1', agent_id: 'ag1' }),
    E('PostToolUse', 1, { tool_name: 'Bash', tool_use_id: 'x1' })]);
  assert.deepEqual(codes(m), ['CONTEXT_CONFLICT']);
  assert.equal(m.counts.context_conflicts, 1);
  assert.equal(m.counts.attributed.UNKNOWN, 2);
  assert.deepEqual(m.sessions[0].mains, []); // el Post en conflicto no crea MAIN
  assert.equal(m.invocations[0].conflict, true);
});

test('9. C4: mismo tool_use_id en dos agentes distintos', () => {
  const m = buildModel([E('PreToolUse', 0, { tool_name: 'Bash', tool_use_id: 'x1', agent_id: 'ag1' }),
    E('PostToolUse', 1, { tool_name: 'Bash', tool_use_id: 'x1', agent_id: 'ag2' }), E('PreToolUse', 2, { tool_name: 'Bash', tool_use_id: 'ok' })]);
  assert.equal(m.counts.context_conflicts, 1);
  assert.equal(m.counts.anomalies.CONTEXT_CONFLICT, 1);
  assert.equal(m.invocations.find((i) => i.tool_use_id === 'x1').contexts.length, 2);
  assert.equal(m.agents.length, 0); // sin evidencia no conflictiva no hay agente observado
});

test('10. eventos sin tool_use_id: no se emparejan, no son anomalía, no se pierden', () => {
  const m = buildModel([E('PreToolUse', 0, { tool_name: 'Bash' }), E('PostToolUse', 1, { tool_name: 'Bash' })]);
  assert.deepEqual(m.invocations, []);
  assert.deepEqual(m.anomalies, []);
  assert.equal(m.counts.events, 2);
  assert.equal(m.counts.attributed.MAIN, 2);
});

test('11. Start sin Stop: SOLO_START, sin duración ni fin inventado', () => {
  const m = buildModel([start(0, { agent_id: 'ag1' })]);
  assert.deepEqual(codes(m), ['SOLO_START']);
  assert.equal(m.agents[0].duration_ms, null);
  assert.deepEqual(m.agents[0].stops, []);
});

test('12. Stop sin Start: SOLO_STOP, el agente existe y no se infiere padre', () => {
  const m = buildModel([stop(0, { agent_id: 'ag1' })]);
  assert.deepEqual(codes(m), ['SOLO_STOP']);
  assert.equal(m.agents.length, 1);
  assert.equal(rels(m, 'PARENT_CHILD').length, 0);
});

test('13. duplicados exactos de un evento ordinario: REPEATED de evento con ambas evidencias, sin descartar', () => {
  const a = E('Stop', 0);
  const m = buildModel([a, { ...a, byte_offset: seq++ }, E('Stop', 1)]);
  assert.equal(m.anomalies.length, 1);
  const rep = m.anomalies[0];
  assert.deepEqual([rep.code, rep.scope, rep.detail.kind, rep.detail.event], ['REPEATED', 'event', 'exact_duplicate', 'Stop']);
  assert.equal(rep.refs.length, 2);
  assert.notEqual(rep.refs[0].byte_offset, rep.refs[1].byte_offset);
  assert.equal(m.counts.events, 3);
  assert.equal(m.counts.attributed.MAIN, 3);
  assert.deepEqual(buildModel([E('Stop', 0), E('Stop', 1)]).anomalies, []); // mismo evento en otro instante: no es duplicado
});

test('13b. Pre y SubagentStart duplicados: un solo REPEATED de evento con la entidad anotada; con eventos distintos, además el de entidad', () => {
  const p = pre(0, { tool_use_id: 'tp' });
  const m = buildModel([p, { ...p, byte_offset: seq++ }, E('PostToolUse', 1, { tool_name: 'Agent', tool_use_id: 'tp' })]);
  assert.deepEqual(m.anomalies.map((a) => [a.code, a.scope]), [['REPEATED', 'event']]);
  assert.deepEqual(m.anomalies[0].detail.entities, [{ scope: 'invocation', kind: 'pre', tool_use_id: 'tp' }]);
  const s = start(0, { agent_id: 'ag1' });
  const m2 = buildModel([s, { ...s, byte_offset: seq++ }, stop(1, { agent_id: 'ag1' })]);
  assert.deepEqual(m2.anomalies.map((a) => [a.code, a.scope]), [['REPEATED', 'event']]);
  assert.deepEqual(m2.anomalies[0].detail.entities, [{ scope: 'agent', kind: 'start', agent_id: 'ag1' }]);
  const m3 = buildModel([p, { ...p, byte_offset: seq++ }, pre(1, { tool_use_id: 'tp' }), E('PostToolUse', 2, { tool_name: 'Agent', tool_use_id: 'tp' })]);
  assert.deepEqual(m3.anomalies.map((a) => [a.code, a.scope]).sort(), [['REPEATED', 'event'], ['REPEATED', 'invocation']]);
  assert.equal(m3.anomalies.find((a) => a.scope === 'invocation').refs.length, 3);
});

test('13c. los duplicados solo se buscan dentro de la partición: no cruzan fuentes', () => {
  const a = E('Stop', 0);
  const m = buildModel([a, { ...a, source_id: 'src-b' }]);
  assert.deepEqual(codes(m), ['SOURCE_COLLISION']);
});

test('14. varios Start: REPEATED y relación padre UNKNOWN', () => {
  const m = buildModel([pre(0), start(1, { agent_id: 'ag1' }), start(2, { agent_id: 'ag1' }), stop(3, { agent_id: 'ag1' })]);
  assert.equal(m.counts.anomalies.REPEATED, 1);
  const p = parentOf(m, 'ag1');
  assert.equal(p.evidence, 'UNKNOWN');
  assert.deepEqual(p.causes, ['REPEATED_START']);
  assert.deepEqual([p.parent, p.launcher, p.child_start, p.candidates, p.delta_ticks], [null, null, null, null, null]);
});

test('15. varios Stop: REPEATED, sin duración', () => {
  const m = buildModel([start(0, { agent_id: 'ag1' }), stop(1, { agent_id: 'ag1' }), stop(2, { agent_id: 'ag1' })]);
  assert.deepEqual(codes(m), ['REPEATED']);
  assert.equal(m.agents[0].duration_ms, null);
});

test('16. Stop anterior a Start: NEGATIVE_INTERVAL sin duración negativa y sin descartar eventos', () => {
  const m = buildModel([stop(0, { agent_id: 'ag1' }), start(2, { agent_id: 'ag1' })]);
  assert.deepEqual(codes(m), ['NEGATIVE_INTERVAL']);
  assert.equal(m.agents[0].duration_ms, null);
  assert.equal(m.agents[0].events.length, 2);
});

test('17. mismo agent_id en sesiones distintas: agentes distintos sin anomalías', () => {
  const m = buildModel([start(0, { agent_id: 'ag1' }), stop(1, { agent_id: 'ag1' }),
    start(0, { agent_id: 'ag1', session_id: 'sess-0002' }), stop(1, { agent_id: 'ag1', session_id: 'sess-0002' })]);
  assert.equal(m.agents.length, 2);
  assert.deepEqual(m.agents.map((a) => a.session_id), [SID, 'sess-0002']);
  assert.deepEqual(m.anomalies, []);
});

test('18. session_id en varias fuentes: colisión, particiones aisladas, procedencias conservadas', () => {
  const B = (o) => ({ source_id: 'src-b', ...o });
  const m = buildModel([
    E('PreToolUse', 0, { tool_name: 'Bash', tool_use_id: 'same' }), E('PostToolUse', 1, { tool_name: 'Bash', tool_use_id: 'same', ...B({}) }),
    pre(10, { tool_use_id: 'la' }), start(11, { agent_id: 'ag1', ...B({}) }),
  ]);
  assert.equal(m.sessions.length, 1);
  assert.deepEqual(m.sessions[0].sources, ['src-a', 'src-b']);
  const col = m.anomalies.find((a) => a.code === 'SOURCE_COLLISION');
  assert.deepEqual(col.detail.sources, ['src-a', 'src-b']);
  assert.equal(col.refs.length, 2);
  const same = m.invocations.filter((i) => i.tool_use_id === 'same');
  assert.deepEqual(same.map((i) => i.source_id), ['src-a', 'src-b']); // no se emparejan entre fuentes
  assert.equal(m.counts.context_conflicts, 0);
  assert.equal(parentOf(m, 'ag1').evidence, 'UNKNOWN'); // lanzador en otra fuente
  assert.deepEqual(parentOf(m, 'ag1').causes, ['NO_CANDIDATE']);
  assert.equal(m.counts.events, 4);
});

test('19. resume con el mismo session_id: todos los SessionStart se conservan, sin REPEATED', () => {
  const m = buildModel([E('SessionStart', 0, { source: 'startup' }), E('SessionStart', 5, { source: 'resume' }), E('SessionStart', 6, { source: 'resume' })]);
  assert.deepEqual(m.sessions[0].starts.map((s) => s.source), ['startup', 'resume', 'resume']);
  assert.deepEqual(m.anomalies, []);
});

test('20. lanzador sin Post y otro SubagentStart cercano: ambiguo, UNKNOWN', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }), start(2, { agent_id: 'ag2' })]);
  for (const id of ['ag1', 'ag2']) {
    assert.equal(parentOf(m, id).evidence, 'UNKNOWN');
    assert.deepEqual(parentOf(m, id).causes, ['MULTIPLE_CHILDREN']);
  }
  assert.ok(codes(m).includes('SOLO_START')); // la invocación sin cierre
});

test('21. dos lanzadores candidatos: UNKNOWN, aunque uno esté en conflicto', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), pre(1, { tool_use_id: 't2' }), start(2, { agent_id: 'ag1' })]);
  assert.deepEqual(parentOf(m, 'ag1').causes, ['MULTIPLE_LAUNCHERS']);
  const v = buildModel([pre(0, { tool_use_id: 't1' }), E('PostToolUse', 0, { tool_name: 'Agent', tool_use_id: 't2', agent_id: 'zz' }),
    pre(1, { tool_use_id: 't2' }), start(2, { agent_id: 'ag1' })]);
  const p = parentOf(v, 'ag1');
  assert.equal(p.evidence, 'UNKNOWN');
  assert.ok(p.causes.includes('MULTIPLE_LAUNCHERS') && p.causes.includes('CONTEXT_CONFLICT'));
});

test('22. candidato único en ambos sentidos: INFERRED con toda la evidencia', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(2, { agent_id: 'ag1', f: 500 })]);
  const p = parentOf(m, 'ag1');
  assert.equal(p.evidence, 'INFERRED');
  assert.equal(p.launcher.event, 'PreToolUse');
  assert.equal(p.delta_ticks, '20000500');
  assert.deepEqual(p.candidates, { launchers: 1, children: 1 });
  assert.deepEqual(p.causes, []);
});

test('23-24. ventana por BigInt exacto: 5 s inferido, 5 s + 100 ns no', () => {
  const ok = parentOf(buildModel([pre(0), start(5, { agent_id: 'ag1' })]), 'ag1');
  assert.equal(ok.evidence, 'INFERRED');
  assert.equal(ok.delta_ticks, '50000000');
  assert.equal(ok.delta_ms, 5000);
  const late = parentOf(buildModel([pre(0), start(5, { agent_id: 'ag1', f: 1 })]), 'ag1');
  assert.equal(late.evidence, 'UNKNOWN');
  assert.deepEqual(late.causes, ['NO_CANDIDATE']);
  const sub = parentOf(buildModel([pre(0), start(0, { agent_id: 'ag1', f: 1 })]), 'ag1');
  assert.equal(sub.delta_ticks, '1'); // 100 ns conservados
  const before = parentOf(buildModel([start(0, { agent_id: 'ag1' }), pre(5)]), 'ag1');
  assert.equal(before.evidence, 'INFERRED'); // la ventana es simétrica
});

test('25. contexto del lanzador UNKNOWN (Pre con agent_id, Post sin él): no se infiere', () => {
  const m = buildModel([E('PreToolUse', 0, { tool_name: 'Agent', tool_use_id: 'tx', agent_id: 'ag1' }),
    E('PostToolUse', 1, { tool_name: 'Agent', tool_use_id: 'tx' }), start(2, { agent_id: 'ag2' })]);
  const p = parentOf(m, 'ag2');
  assert.equal(p.evidence, 'UNKNOWN');
  assert.ok(p.causes.includes('LAUNCHER_CONTEXT_UNKNOWN'));
  assert.equal(p.parent, null);
});

test('26. un conflicto C4 impide la inferencia jerárquica y se contabiliza', () => {
  const m = buildModel([pre(0, { tool_use_id: 'tc' }), E('PostToolUse', 3, { tool_name: 'Agent', tool_use_id: 'tc', agent_id: 'otro' }), start(1, { agent_id: 'ag1' })]);
  assert.equal(parentOf(m, 'ag1').evidence, 'UNKNOWN');
  assert.equal(m.counts.context_conflicts, 1);
});

// --- Determinismo, inmutabilidad, solo lectura ---

const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const shuffled = (arr, seed) => { const r = lcg(seed); const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fixture = () => [
  E('SessionStart', 0, { source: 'startup' }), pre(1, { tool_use_id: 't1' }), start(2, { agent_id: 'ag1', agent_type: 'Explore' }),
  pre(30, { tool_use_id: 't2', agent_id: 'ag1' }), start(31, { agent_id: 'ag2' }), stop(40, { agent_id: 'ag2' }),
  E('PostToolUse', 41, { tool_name: 'Agent', tool_use_id: 't1' }), start(50), stop(60, { agent_id: 'ag1' }),
  E('PreToolUse', 61, { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'ag1' }), E('PostToolUse', 62, { tool_name: 'Bash', tool_use_id: 'c1' }),
  E('Stop', 2), // mismo timestamp que otro evento: desempata source_id/byte_offset
  { ...E('SubagentStart', 2, { agent_id: 'ag1' }), source_id: 'src-b' }, { ...E('Stop', 70), source_id: 'src-b' },
];
const insert = (db, rows) => {
  const st = db.prepare(`INSERT INTO event (source_id, byte_offset, ${ALL_FIELDS.join(', ')}) VALUES (?, ?, ${ALL_FIELDS.map(() => '?').join(', ')})`);
  for (const r of rows) st.run(r.source_id, r.byte_offset, ...ALL_FIELDS.map((k) => r[k]));
};

test('27. determinismo: distinto orden de inserción en SQLite y de entrada, mismo modelo', () => {
  const rows = fixture();
  const models = [1, 2, 3].map((seed) => {
    const db = openDatabase(':memory:');
    insert(db, shuffled(rows, seed));
    const m = loadModel(db);
    db.close();
    return m;
  });
  assert.deepEqual(models[1], models[0]);
  assert.deepEqual(models[2], models[0]);
  assert.deepEqual(buildModel(shuffled(rows, 9)), models[0]);
  assert.ok(models[0].sessions[0].collision);
  assert.equal(JSON.stringify(buildModel(rows)), JSON.stringify(buildModel(shuffled(rows, 4))));
});

test('28. los eventos originales no se modifican', () => {
  const rows = fixture().map((r) => Object.freeze(r));
  const copy = structuredClone(rows);
  const input = Object.freeze(shuffled(rows, 5));
  buildModel(input);
  assert.deepEqual(rows, copy);
});

test('29. construir el modelo no escribe en SQLite y hierarchy.js no depende de la ingesta ni de SQLite', () => {
  const db = openDatabase(':memory:');
  insert(db, fixture());
  const snap = () => JSON.stringify(['event', 'ingest_reject', 'ingest_cursor'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
  const [s0, c0] = [snap(), changes()];
  loadModel(db);
  assert.equal(changes(), c0);
  assert.equal(snap(), s0);
  db.close();
  const src = readFileSync(new URL('../src/hierarchy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m);
});

test('30. las referencias conservan source_id y byte_offset exactos', () => {
  const rows = fixture();
  const m = buildModel(rows);
  const known = new Set(rows.map((r) => `${r.source_id}:${r.byte_offset}`));
  const refs = [...m.agents.flatMap((a) => [...a.starts, ...a.stops, ...a.events]), ...m.anomalies.flatMap((a) => a.refs),
    ...m.sessions.flatMap((s) => [...s.starts, ...s.mains.flatMap((x) => x.events)]), ...m.unknown,
    ...rels(m, 'PARENT_CHILD').flatMap((r) => [r.launcher, r.child_start].filter(Boolean)), ...rels(m, 'SESSION_AGENT').map((r) => r.first)];
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(known.has(`${r.source_id}:${r.byte_offset}`), JSON.stringify(r));
});

// --- Casos adicionales ---

test('A. lanzador sin tool_use_id: puede ser lanzador, con tool_use_id null en la evidencia', () => {
  const p = parentOf(buildModel([pre(0), start(1, { agent_id: 'ag1' })]), 'ag1');
  assert.equal(p.evidence, 'INFERRED');
  assert.equal(p.launcher.tool_use_id, null);
});

test('B. autolanzamiento: no cuenta como candidato y deja pasar al lanzador válido', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }), pre(2, { tool_use_id: 't2', agent_id: 'ag1' })]);
  const p = parentOf(m, 'ag1');
  assert.equal(p.evidence, 'INFERRED');
  assert.equal(p.launcher.tool_use_id, 't1');
  assert.deepEqual(p.candidates, { launchers: 1, children: 1 });
});

test('C. sesión sin SessionStart ni SessionEnd: listas vacías y sin anomalía', () => {
  const m = buildModel([E('Stop', 0)]);
  assert.deepEqual([m.sessions[0].starts, m.sessions[0].ends, m.anomalies], [[], [], []]);
});

test('D/I. colisión: inferencia válida dentro de cada fuente; un candidato de otra fuente no bloquea', () => {
  const B = { source_id: 'src-b' };
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }),
    { ...pre(0, { tool_use_id: 't1' }), ...B }, { ...start(1, { agent_id: 'ag1' }), ...B }, { ...pre(2, { tool_use_id: 't9' }), ...B }]);
  const pcs = rels(m, 'PARENT_CHILD');
  assert.equal(pcs.length, 2);
  assert.equal(pcs.find((r) => r.source_id === 'src-a').evidence, 'INFERRED');
  assert.equal(pcs.find((r) => r.source_id === 'src-b').evidence, 'UNKNOWN'); // dos lanzadores dentro de B
});

test('E. SubagentStart sin agent_id cerca de un lanzador bloquea la inferencia', () => {
  const p = parentOf(buildModel([pre(0), start(1, { agent_id: 'ag1' }), start(2)]), 'ag1');
  assert.equal(p.evidence, 'UNKNOWN');
  assert.deepEqual(p.causes, ['MULTIPLE_CHILDREN']);
});

test('F. colisión: mismo agent_id con agent_type distinto en fuentes distintas no es ATTR_CONFLICT; en la misma fuente sí', () => {
  const B = { source_id: 'src-b' };
  const m = buildModel([start(0, { agent_id: 'ag1', agent_type: 'Explore' }), { ...start(0, { agent_id: 'ag1', agent_type: 'Plan' }), ...B }]);
  assert.equal(m.agents.length, 2);
  assert.ok(!codes(m).includes('ATTR_CONFLICT'));
  const same = buildModel([start(0, { agent_id: 'ag1', agent_type: 'Explore' }), stop(1, { agent_id: 'ag1', agent_type: 'Plan' })]);
  assert.deepEqual(codes(same), ['ATTR_CONFLICT']);
});

test('G. colisión: Start en A y Stop en B son dos agentes, sin REPEATED ni NEGATIVE_INTERVAL cruzados', () => {
  const m = buildModel([start(5, { agent_id: 'ag1' }), { ...stop(0, { agent_id: 'ag1' }), source_id: 'src-b' }]);
  assert.equal(m.agents.length, 2);
  assert.deepEqual(codes(m).sort(), ['SOLO_START', 'SOLO_STOP', 'SOURCE_COLLISION']);
});

test('H. colisión: un MAIN por fuente con eventos candidatos, sin fusionar', () => {
  const both = buildModel([E('Stop', 0), { ...E('Stop', 1), source_id: 'src-b' }]);
  assert.deepEqual(both.sessions[0].mains.map((x) => x.source_id), ['src-a', 'src-b']);
  const onlyA = buildModel([E('Stop', 0), { ...E('SessionStart', 1), source_id: 'src-b' }]);
  assert.deepEqual(onlyA.sessions[0].mains.map((x) => x.source_id), ['src-a']);
});

test('J. colisión: SESSION_AGENT por fuente, sin conexiones cruzadas', () => {
  const m = buildModel([start(0, { agent_id: 'ag1' }), { ...start(1, { agent_id: 'ag1' }), source_id: 'src-b' }]);
  const sa = rels(m, 'SESSION_AGENT');
  assert.deepEqual(sa.map((r) => [r.source_id, r.events, r.first.source_id]), [['src-a', 1, 'src-a'], ['src-b', 1, 'src-b']]);
  assert.ok(sa.every((r) => r.evidence === 'OBSERVED'));
});

test('L. colisión: CONTEXT_CONFLICT en una fuente no se propaga a la otra', () => {
  const t = { tool_name: 'Bash', tool_use_id: 'x' };
  const m = buildModel([E('PreToolUse', 0, { ...t, agent_id: 'ag1' }), E('PostToolUse', 1, t),
    { ...E('PreToolUse', 0, t), source_id: 'src-b' }, { ...E('PostToolUse', 1, t), source_id: 'src-b' }]);
  assert.deepEqual(m.invocations.map((i) => [i.source_id, i.conflict]), [['src-a', true], ['src-b', false]]);
  assert.equal(m.counts.context_conflicts, 1);
  assert.equal(m.sessions[0].mains[0].source_id, 'src-b');
});

test('K. repeticiones de invocación: REPEATED, SOLO_*, NEGATIVE_INTERVAL y ATTR_CONFLICT de tool_name', () => {
  const t = (n) => ({ tool_name: n, tool_use_id: 'x' });
  const m = buildModel([E('PreToolUse', 0, t('Bash')), E('PreToolUse', 1, t('Read')), E('PostToolUse', 2, t('Bash')), E('PostToolUse', 3, t('Bash'))]);
  assert.deepEqual([...new Set(codes(m))].sort(), ['ATTR_CONFLICT', 'REPEATED']);
  const neg = buildModel([E('PostToolUse', 0, t('Bash')), E('PreToolUse', 1, t('Bash'))]);
  assert.deepEqual(codes(neg), ['NEGATIVE_INTERVAL']);
});

test('M. ningún evento se pierde y solo existen los siete códigos de anomalía', () => {
  const rows = fixture();
  const m = buildModel(rows);
  assert.equal(m.counts.events, rows.length);
  assert.equal(Object.values(m.counts.attributed).reduce((a, b) => a + b, 0), rows.length);
  assert.deepEqual(Object.keys(m.counts.anomalies), ANOMALY_CODES);
  assert.ok(m.anomalies.every((a) => ANOMALY_CODES.includes(a.code)));
  assert.equal(m.counts.anomalies.CONTEXT_CONFLICT, m.counts.context_conflicts);
});

test('N. ruta completa JSONL → ingest → loadModel', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-h2-'));
  const db = openDatabase(':memory:');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const line = (o) => JSON.stringify({ timestamp: ts(0), session_id: SID, ...o });
  writeFileSync(join(dir, 'e.jsonl'), [
    line({ event: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1' }),
    line({ event: 'SubagentStart', timestamp: ts(1), agent_id: 'ag1', agent_type: 'Explore' }),
  ].join('\n') + '\n');
  ingest(db, { sourceId: 'src-a', path: join(dir, 'e.jsonl') });
  const m = loadModel(db);
  assert.equal(parentOf(m, 'ag1').evidence, 'INFERRED');
  assert.equal(m.agents[0].agent_types[0], 'Explore');
});

// --- Corrección final: NEGATIVE_INTERVAL, conflictos fuera del agente, integridad ---

test('P. NEGATIVE_INTERVAL de agente: cualquier Stop anterior a cualquier Start', () => {
  const mid = buildModel([start(0, { agent_id: 'ag1' }), stop(3, { agent_id: 'ag1' }), start(5, { agent_id: 'ag1' })]); // Stop entre dos Start
  assert.deepEqual([...new Set(codes(mid))].sort(), ['NEGATIVE_INTERVAL', 'REPEATED']);
  assert.equal(mid.agents[0].duration_ms, null);
  assert.equal(mid.anomalies.find((a) => a.code === 'NEGATIVE_INTERVAL').refs.length, 3); // todas las evidencias implicadas
  const before = buildModel([stop(0, { agent_id: 'ag1' }), start(1, { agent_id: 'ag1' }), start(2, { agent_id: 'ag1' })]); // Stop anterior a todos los Start
  assert.ok(codes(before).includes('NEGATIVE_INTERVAL'));
  const ok = buildModel([start(0, { agent_id: 'ag1' }), start(1, { agent_id: 'ag1' }), stop(2, { agent_id: 'ag1' }), stop(3, { agent_id: 'ag1' })]);
  assert.ok(!codes(ok).includes('NEGATIVE_INTERVAL')); // varios, pero ningún Stop anterior a un Start
  assert.equal(ok.agents[0].duration_ms, null); // multiplicidad: sin duración
  const one = buildModel([start(0, { agent_id: 'ag1' }), stop(1, { agent_id: 'ag1' })]);
  assert.deepEqual(one.anomalies, []);
  assert.equal(one.agents[0].duration_ms, 1000);
});

test('Q. NEGATIVE_INTERVAL: timestamps iguales no son negativos; 100 ns antes sí', () => {
  const eq = buildModel([start(4, { agent_id: 'ag1' }), stop(4, { agent_id: 'ag1' })]);
  assert.deepEqual(eq.anomalies, []);
  assert.equal(eq.agents[0].duration_ticks, '0');
  const eq2 = buildModel([stop(4, { agent_id: 'ag1' }), start(4, { agent_id: 'ag1' })]); // Stop con byte_offset menor, mismo instante
  assert.ok(!codes(eq2).includes('NEGATIVE_INTERVAL'));
  const tick = buildModel([stop(4, { agent_id: 'ag1' }), start(4, { agent_id: 'ag1', f: 1 })]);
  assert.ok(codes(tick).includes('NEGATIVE_INTERVAL'));
});

test('R. NEGATIVE_INTERVAL de invocación: PostToolUseFailure anterior al Pre y casos sin negativo', () => {
  const t = { tool_name: 'Bash', tool_use_id: 'x' };
  const m = buildModel([E('PostToolUseFailure', 0, t), E('PreToolUse', 1, t)]);
  assert.deepEqual(codes(m), ['NEGATIVE_INTERVAL']);
  assert.equal(m.anomalies[0].refs.length, 2);
  const multi = buildModel([E('PreToolUse', 0, t), E('PostToolUse', 1, t), E('PreToolUse', 2, t)]); // cierre entre dos Pre
  assert.ok(codes(multi).includes('NEGATIVE_INTERVAL'));
  assert.deepEqual(buildModel([E('PreToolUse', 0, t), E('PostToolUseFailure', 1, t)]).anomalies, []);
  assert.deepEqual(buildModel([E('PreToolUse', 3, t), E('PostToolUse', 3, t)]).anomalies, []); // iguales
});

test('S. los eventos en conflicto no aportan nada al agente', () => {
  const t = { tool_name: 'Bash', tool_use_id: 'x' };
  const m = buildModel([
    E('PreToolUse', 0, { ...t, agent_id: 'ag1', agent_type: 'Plan' }), E('PostToolUse', 1, t), // conflicto: ag1 y MAIN
    E('PreToolUse', 2, { tool_name: 'Read', tool_use_id: 'y', agent_id: 'ag1', agent_type: 'Explore' }),
    E('PreToolUse', 3, { ...t, tool_use_id: 'z', agent_id: 'ag2', agent_type: 'Plan' }), E('PostToolUse', 4, { ...t, tool_use_id: 'z', agent_id: 'ag3' }),
  ]);
  assert.equal(m.counts.context_conflicts, 2);
  const a1 = m.agents.find((a) => a.agent_id === 'ag1');
  assert.deepEqual(a1.agent_types, ['Explore']);
  assert.equal(a1.events.length, 1);
  assert.ok(!codes(m).includes('ATTR_CONFLICT'));
  const sa = rels(m, 'SESSION_AGENT').find((r) => r.agent_id === 'ag1');
  assert.deepEqual([sa.events, sa.first.byte_offset], [1, a1.events[0].byte_offset]);
  assert.deepEqual(m.agents.map((a) => a.agent_id), ['ag1']); // ag2 y ag3 solo aparecen en eventos conflictivos
  assert.equal(rels(m, 'SESSION_AGENT').length, 1);
});

test('T. UNKNOWN coincide con el contador y las categorías son exclusivas y exhaustivas', () => {
  const small = [start(0), stop(1), E('PreToolUse', 2, { tool_name: 'Bash', tool_use_id: 'x', agent_id: 'a1' }), E('PostToolUse', 3, { tool_name: 'Bash', tool_use_id: 'x' })];
  for (const rows of [fixture(), small]) {
    const m = buildModel(rows);
    assert.equal(m.unknown.length, m.counts.attributed.UNKNOWN);
    const lists = {
      SESSION: m.sessions.flatMap((s) => [...s.starts, ...s.ends]), MAIN: m.sessions.flatMap((s) => s.mains.flatMap((x) => x.events)),
      AGENT: m.agents.flatMap((a) => a.events), UNKNOWN: m.unknown,
    };
    const seen = new Map();
    for (const [cat, refs] of Object.entries(lists)) {
      assert.equal(refs.length, m.counts.attributed[cat], cat);
      for (const r of refs) { const k = `${r.source_id}:${r.byte_offset}`; assert.ok(!seen.has(k), `${k} en ${seen.get(k)} y ${cat}`); seen.set(k, cat); }
    }
    assert.deepEqual([...seen.keys()].sort(), rows.map((r) => `${r.source_id}:${r.byte_offset}`).sort());
  }
});

test('U. procedencia exacta en invocations.pre e invocations.closes', () => {
  const rows = fixture();
  const m = buildModel(rows);
  const by = new Map(rows.map((r) => [`${r.source_id}:${r.byte_offset}`, r]));
  let n = 0;
  for (const inv of m.invocations) {
    for (const [list, kinds] of [[inv.pre, ['PreToolUse']], [inv.closes, ['PostToolUse', 'PostToolUseFailure']]]) {
      for (const r of list) {
        const row = by.get(`${r.source_id}:${r.byte_offset}`);
        assert.ok(row);
        assert.deepEqual([row.event, row.timestamp, row.tool_use_id, row.source_id], [r.event, r.timestamp, inv.tool_use_id, inv.source_id]);
        assert.ok(kinds.includes(r.event));
        n++;
      }
    }
  }
  assert.equal(n, 5); // 3 Pre + 2 cierres en la fixture
});

test('V. un SubagentStart de otra fuente no entra en el recuento de hijos', () => {
  const m = buildModel([pre(0, { tool_use_id: 't1' }), start(1, { agent_id: 'ag1' }), { ...start(2, { agent_id: 'ag2' }), source_id: 'src-b' }, { ...start(2), source_id: 'src-b' }]);
  const a = parentOf(m, 'ag1');
  assert.equal(a.evidence, 'INFERRED');
  assert.deepEqual(a.candidates, { launchers: 1, children: 1 });
  assert.deepEqual(parentOf(m, 'ag2').causes, ['NO_CANDIDATE']);
});

test('W. filas con la misma tripleta de orden: desempate estable por contenido, sin depender del orden de entrada', () => {
  const a = { ...E('Stop', 0), source_id: 'src-a', byte_offset: 7 };
  const b = { ...E('UserPromptSubmit', 0), source_id: 'src-a', byte_offset: 7 };
  const c = { ...E('SubagentStart', 0, { agent_id: 'ag1' }), source_id: 'src-a', byte_offset: 7 };
  const base = JSON.stringify(buildModel([a, b, c]));
  for (const order of [[a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) assert.equal(JSON.stringify(buildModel(order)), base);
  assert.equal(buildModel([a, b, c]).counts.events, 3); // no se rechaza ni se pierde ninguno
});

test('X. un lanzador con contexto UNKNOWN y agent_id igual al hijo no se excluye como autolanzamiento', () => {
  const m = buildModel([E('PreToolUse', 0, { tool_name: 'Agent', tool_use_id: 'tz', agent_id: 'ag1' }), E('PostToolUse', 1, { tool_name: 'Agent', tool_use_id: 'tz' }),
    start(2, { agent_id: 'ag1' })]);
  const p = parentOf(m, 'ag1');
  assert.equal(p.evidence, 'UNKNOWN');
  assert.ok(p.causes.includes('LAUNCHER_CONTEXT_UNKNOWN'));
});

test('Y. proyecto → sesión: project_id único o null, y ATTR_CONFLICT de sesión si hay varios', () => {
  const P1 = 'a'.repeat(32);
  const P2 = 'b'.repeat(32);
  const one = buildModel([E('UserPromptSubmit', 0, { project_id: P1 }), E('Stop', 1, { project_id: P1 })]);
  assert.equal(one.sessions[0].project_id, P1);
  assert.deepEqual(one.anomalies, []);
  assert.equal(buildModel([E('Stop', 0)]).sessions[0].project_id, null);
  const two = buildModel([E('UserPromptSubmit', 0, { project_id: P1 }), E('Stop', 1, { project_id: P2 })]);
  assert.equal(two.sessions[0].project_id, null);
  const a = two.anomalies.find((x) => x.code === 'ATTR_CONFLICT');
  assert.equal(a.scope, 'session');
  assert.deepEqual(a.detail, { attribute: 'project_id', values: [P1, P2] });
  assert.equal(a.refs.length, 2);
});
