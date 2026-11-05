import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_FIELDS } from '../src/validator.js';
import { buildModel } from '../src/hierarchy.js';
import { presence, STATES, TTL_MS } from '../src/presence.js';

// Fixtures sintéticos con la forma de las filas de H1 (NULL para lo ausente). Segundos relativos a T0.
const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);
let seq = 0;
const ts = (s) => `${new Date(T0 + s * 1000).toISOString().slice(0, 19)}.0000000+00:00`;
const E = (event, s, o = {}) => ({
  source_id: 'src-a', byte_offset: seq++, timestamp: ts(s), event, session_id: 'sess-0001',
  ...Object.fromEntries(ALL_FIELDS.slice(3).map((k) => [k, null])), ...o,
});
const at = (rows, s) => presence(buildModel(rows), T0 + s * 1000);
const main = (rows, s) => at(rows, s).sessions[0];
const agent = (rows, s, id) => at(rows, s).agents.find((a) => a.agent_id === id);
const MIN = 60;

test('1. turno normal: UserPromptSubmit trabaja, Stop deja inactivo', () => {
  assert.equal(main([E('UserPromptSubmit', 0)], 1).state, 'WORKING');
  const s = main([E('UserPromptSubmit', 0), E('Stop', 5)], 6);
  assert.deepEqual([s.state, s.since], ['IDLE', ts(5)]);
});

test('2. Esc sin Stop (A2): trabajando hasta la caducidad, después caducado', () => {
  const rows = [E('UserPromptSubmit', 0), E('PreToolUse', 1, { tool_name: 'Bash', tool_use_id: 'tu1' })];
  const ttl = TTL_MS.WORKING / 1000;
  assert.equal(main(rows, 1 + ttl).state, 'WORKING'); // justo en el límite no caduca
  assert.equal(main(rows, 1 + ttl + 1).state, 'STALE');
});

test('3. permiso: espera, Notification no cambia nada, PostToolUse lo cierra, sin respuesta caduca', () => {
  const rows = [E('UserPromptSubmit', 0), E('PreToolUse', 1, { tool_name: 'Write', tool_use_id: 'tu1' }), E('PermissionRequest', 2, { tool_name: 'Write' })];
  assert.equal(main(rows, 3).state, 'PERMISSION');
  assert.equal(main([...rows, E('Notification', 8, { notification_type: 'permission_prompt' })], 9).state, 'PERMISSION');
  assert.equal(main([...rows, E('PostToolUse', 9, { tool_name: 'Write', tool_use_id: 'tu1' })], 10).state, 'WORKING');
  const s = main(rows, 2 + TTL_MS.PERMISSION / 1000 + 1);
  assert.deepEqual([s.state, s.since], ['STALE', ts(2)]);
});

test('4. SessionEnd termina la sesión y sus agentes; un resume posterior la reabre', () => {
  const rows = [E('SessionStart', 0, { source: 'startup' }), E('SubagentStart', 1, { agent_id: 'ag1' }), E('SessionEnd', 2, { reason: 'other' })];
  assert.equal(main(rows, 3).state, 'ENDED');
  assert.equal(agent(rows, 3, 'ag1').state, 'ENDED');
  assert.equal(main(rows, 10 * 24 * 3600).state, 'ENDED'); // terminado no caduca
  assert.equal(main([...rows, E('SessionStart', 5, { source: 'resume' })], 6).state, 'IDLE');
});

test('5. el Stop del padre llega antes que el SubagentStop (hallazgo 1): MAIN inactivo, agente trabajando', () => {
  const rows = [E('UserPromptSubmit', 0), E('PreToolUse', 1, { tool_name: 'Agent', tool_use_id: 'tu1' }),
    E('SubagentStart', 1, { agent_id: 'ag1', agent_type: 'Explore' }), E('PostToolUse', 1, { tool_name: 'Agent', tool_use_id: 'tu1' }), E('Stop', 2)];
  assert.equal(main(rows, 3).state, 'IDLE');
  const a = agent(rows, 3, 'ag1');
  assert.deepEqual([a.state, a.agent_types], ['WORKING', ['Explore']]);
  assert.equal(agent([...rows, E('SubagentStop', 4, { agent_id: 'ag1' })], 5, 'ag1').state, 'ENDED');
});

test('6. SubagentStop sin SubagentStart (hallazgo 2): agente terminado', () => {
  assert.equal(agent([E('Stop', 0), E('SubagentStop', 2, { agent_id: 'ag9', agent_type: 'none' })], 3, 'ag9').state, 'ENDED');
});

test('7. permiso pedido por un subagente: solo ese agente espera', () => {
  const rows = [E('UserPromptSubmit', 0), E('SubagentStart', 1, { agent_id: 'ag1' }), E('PermissionRequest', 2, { agent_id: 'ag1', tool_name: 'Edit' })];
  assert.equal(agent(rows, 3, 'ag1').state, 'PERMISSION');
  assert.equal(main(rows, 3).state, 'WORKING');
});

test('8. inactivo durante más de la caducidad: caducado (sesión sin SessionEnd, p. ej. proceso muerto)', () => {
  const rows = [E('SessionStart', 0, { source: 'startup' })];
  assert.equal(main(rows, 1).state, 'IDLE');
  assert.equal(main(rows, TTL_MS.IDLE / 1000 + 1).state, 'STALE');
});

test('9. sin eventos significativos: inactivo sin fecha', () => {
  const s = main([E('Notification', 0, { notification_type: 'idle_prompt' }), E('SubagentStart', 0, { agent_id: 'ag1' })], 1);
  assert.deepEqual([s.state, s.since], ['IDLE', null]);
});

test('10. desempate por procedencia con el mismo timestamp, caducidades configurables', () => {
  const rows = [E('Stop', 0), E('UserPromptSubmit', 0)]; // mismo instante: decide el byte_offset
  assert.equal(main(rows, 0).state, 'WORKING');
  assert.equal(presence(buildModel(rows), T0 + 2000, { ...TTL_MS, WORKING: 1000 }).sessions[0].state, 'STALE');
});

test('11. función pura: no modifica el modelo y solo devuelve estados conocidos', () => {
  const m = buildModel([E('SessionStart', 0, { source: 'startup' }), E('UserPromptSubmit', 1), E('SubagentStart', 2, { agent_id: 'ag1' })]);
  const before = JSON.stringify(m);
  const p = presence(m, T0 + 3000);
  assert.equal(JSON.stringify(m), before);
  assert.deepEqual(presence(m, T0 + 3000), p);
  assert.ok([...p.sessions, ...p.agents].every((x) => STATES.includes(x.state)));
  assert.equal(p.sessions[0].project_id, null);
});

test('12. StopFailure: error hasta el siguiente evento significativo; caduca como inactivo', () => {
  const rows = [E('UserPromptSubmit', 0), E('StopFailure', 5, { error: 'rate_limit' })];
  assert.deepEqual([main(rows, 6).state, main(rows, 6).since], ['ERROR', ts(5)]);
  assert.equal(main([...rows, E('Notification', 7, { notification_type: 'idle_prompt' })], 8).state, 'ERROR'); // Notification no lo borra
  assert.equal(main([...rows, E('UserPromptSubmit', 9)], 10).state, 'WORKING'); // nuevo turno
  assert.equal(main([...rows, E('Stop', 9)], 10).state, 'IDLE');
  assert.equal(main([...rows, E('SessionEnd', 9, { reason: 'other' })], 10).state, 'ENDED');
  assert.equal(main(rows, 5 + TTL_MS.ERROR / 1000).state, 'ERROR');
  assert.equal(main(rows, 5 + TTL_MS.ERROR / 1000 + 1).state, 'STALE');
});
