// Fase 4: lógica del proceso principal que no depende de Electron (filas, deltas y política de proyectos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRows, diff, applyDelta } from '../main/rows.js';
import { listProjects, setPolicy } from '../main/policy.js';
import { buildModel } from '../../backend/src/hierarchy.js';
import { presence } from '../../backend/src/presence.js';
import { ALL_FIELDS } from '../../backend/src/validator.js';

// Fixtures sintéticos con la forma que H1 guarda (NULL para lo ausente).
const S = '11111111-1111-1111-1111-111111111111';
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
let seq = 0;
const E = (event, s, o = {}) => ({ source_id: 'hooks', byte_offset: seq++, timestamp: `${new Date(T0 + s * 1000).toISOString().slice(0, 19)}.1234567+00:00`,
  event, session_id: S, ...Object.fromEntries(ALL_FIELDS.slice(3).map((k) => [k, null])), ...o });
// MAIN lanza a1 (INFERRED) y deja Bash abierta; a1 usa Read y termina; a2 solo tiene SubagentStop (visitante).
const EVENTS = [
  E('SessionStart', 0), E('UserPromptSubmit', 1),
  E('PreToolUse', 2, { tool_name: 'Agent', tool_use_id: 't1' }), E('SubagentStart', 3, { agent_id: 'a1', agent_type: 'Explore' }),
  E('PreToolUse', 4, { tool_name: 'Read', tool_use_id: 't2', agent_id: 'a1' }), E('PostToolUse', 5, { tool_name: 'Read', tool_use_id: 't2', agent_id: 'a1' }),
  E('PostToolUse', 6, { tool_name: 'Agent', tool_use_id: 't1' }), E('PreToolUse', 7, { tool_name: 'Bash', tool_use_id: 't3' }),
  E('SubagentStop', 30, { agent_id: 'a2' }),
];
const rowsAt = (events, s) => { const m = buildModel(events); return toRows(presence(m, T0 + s * 1000), m); };

test('toRows: filas planas con herramienta abierta, padre, recuentos y sin referencias a eventos', () => {
  const r = rowsAt(EVENTS, 31);
  assert.deepEqual(r[`s:${S}`], { kind: 'session', session_id: S, project_id: null, state: 'WORKING', since: T0 + 7123,
    tool: 'Bash', tools: 2, events: 5, first: T0 + 123 });
  assert.deepEqual(r[`a:${S}:hooks:a1`], { kind: 'agent', session_id: S, agent_id: 'a1', agent_types: ['Explore'], state: 'WORKING', since: T0 + 5123,
    tool: null, tools: 1, events: 3, first: T0 + 3123, evidence: 'INFERRED', parent: `s:${S}` });
  assert.equal(r[`a:${S}:hooks:a2`].evidence, 'UNKNOWN');
  assert.equal(r[`a:${S}:hooks:a2`].parent, null);
  assert.equal(r[`a:${S}:hooks:a2`].state, 'ENDED');
  assert.ok(!JSON.stringify(r).includes('byte_offset'));
  assert.equal(rowsAt([E('Notification', 0)], 1)[`s:${S}`].since, null);
});

test('diff + applyDelta: solo lo que cambia y el resultado es el estado nuevo', () => {
  const a = rowsAt(EVENTS, 31);
  const b = rowsAt([...EVENTS, E('SubagentStop', 32, { agent_id: 'a1' })], 33);
  assert.deepEqual(diff(a, a), { upsert: [], remove: [] });
  const d = diff(a, b);
  assert.deepEqual(d.upsert.map(([k]) => k), [`a:${S}:hooks:a1`]);
  assert.deepEqual(applyDelta(a, d), b);
  const gone = diff(b, {});
  assert.equal(gone.remove.length, 3);
  assert.deepEqual(applyDelta(b, gone), {});
});

const ID = 'ab'.repeat(16);
function policyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'co-h1-app-'));
  for (const s of ['enabled', 'excluded', 'pending']) mkdirSync(join(dir, s));
  return dir;
}

test('listProjects: nombre, prioridad del hook (excluido > activado > pendiente) y archivos ajenos ignorados', (t) => {
  const dir = policyDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'pending', `${ID}.json`), '﻿{"name":"demo"}');
  writeFileSync(join(dir, 'pending', 'otro.json'), '{}');
  writeFileSync(join(dir, 'pending', `${'cd'.repeat(16)}.json`), 'no es json');
  assert.deepEqual(listProjects(dir).find((x) => x.project_id === ID), { project_id: ID, name: 'demo', status: 'pending' });
  assert.equal(listProjects(dir).find((x) => x.project_id === 'cd'.repeat(16)).name, null);
  assert.equal(listProjects(dir).length, 2);
  writeFileSync(join(dir, 'excluded', `${ID}.json`), '{}');
  assert.equal(listProjects(dir).find((x) => x.project_id === ID).status, 'excluded');
  assert.deepEqual(listProjects(join(dir, 'no-existe')), []);
});

test('setPolicy: mueve el archivo conservando el nombre, quita duplicados y rechaza entradas inválidas', (t) => {
  const dir = policyDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'pending', `${ID}.json`), '{"name":"demo"}');
  setPolicy(dir, ID, 'enabled');
  assert.ok(!existsSync(join(dir, 'pending', `${ID}.json`)));
  assert.equal(readFileSync(join(dir, 'enabled', `${ID}.json`), 'utf8'), '{"name":"demo"}');
  writeFileSync(join(dir, 'pending', `${ID}.json`), '{}'); // copia sobrante
  setPolicy(dir, ID, 'excluded');
  assert.deepEqual(listProjects(dir), [{ project_id: ID, name: 'demo', status: 'excluded' }]);
  assert.ok(!existsSync(join(dir, 'pending', `${ID}.json`)) && !existsSync(join(dir, 'enabled', `${ID}.json`)));
  assert.throws(() => setPolicy(dir, ID, 'pending'), /INVALID_POLICY/);
  assert.throws(() => setPolicy(dir, '../x', 'enabled'), /INVALID_POLICY/);
  assert.throws(() => setPolicy(dir, 'ef'.repeat(16), 'enabled'), /UNKNOWN_PROJECT/);
});
