// Fase 4: lógica del proceso principal que no depende de Electron (filas, deltas y política de proyectos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRows, diff, applyDelta } from '../main/rows.js';
import { listProjects, setPolicy } from '../main/policy.js';

const S = '11111111-1111-1111-1111-111111111111';
const p = (state, since, agentState = 'WORKING') => ({
  sessions: [{ session_id: S, project_id: null, state, since, starts: [{ x: 1 }] }],
  agents: [{ session_id: S, source_id: 'hooks', agent_id: 'a1', agent_types: ['Explore'], state: agentState, since, events: [{ x: 1 }] }],
});

test('toRows: filas planas, hora en ms y sin referencias a eventos', () => {
  const r = toRows(p('IDLE', '2026-11-02T10:00:00.1234567+00:00'));
  assert.deepEqual(r[`s:${S}`], { kind: 'session', session_id: S, project_id: null, state: 'IDLE', since: Date.UTC(2026, 10, 2, 10, 0, 0, 123) });
  assert.equal(r[`a:${S}:hooks:a1`].since, Date.UTC(2026, 10, 2, 10, 0, 0, 123));
  assert.ok(!JSON.stringify(r).includes('"x"'));
  assert.equal(toRows(p('IDLE', null))[`s:${S}`].since, null);
});

test('diff + applyDelta: solo lo que cambia y el resultado es el estado nuevo', () => {
  const a = toRows(p('WORKING', '2026-11-02T10:00:00.0000000+00:00'));
  const b = toRows(p('WORKING', '2026-11-02T10:00:00.0000000+00:00', 'ENDED'));
  assert.deepEqual(diff(a, a), { upsert: [], remove: [] });
  const d = diff(a, b);
  assert.deepEqual(d.upsert.map(([k]) => k), [`a:${S}:hooks:a1`]);
  assert.deepEqual(applyDelta(a, d), b);
  const gone = diff(b, {});
  assert.equal(gone.remove.length, 2);
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
