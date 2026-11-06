// Fase 7: instalador del hook global (settings.json sintéticos en %TEMP%) y el hook de app/hook con un APPDATA aislado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EVENTS, apply, entry, plan, hookStatus, errorCode } from '../main/install.js';
import { validateLine } from '../../backend/src/validator.js';

const HOOK_SRC = join(import.meta.dirname, '..', 'hook', 'capture-event.ps1');
// realpathSync.native: PowerShell (.NET Framework) expande los nombres cortos 8.3 de Windows (p. ej. RUNNER~1) y Node no;
// con la ruta ya expandida, el hook .ps1 y el .mjs calculan el mismo project_id.
const tmp = (t) => { const d = mkdtempSync(join(realpathSync.native(tmpdir()), 'co-h1-install-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const paths = (d) => ({ settings: join(d, '.claude', 'settings.json'), hook: join(d, 'ClaudeOffice', 'hook', 'capture-event.ps1') });
const baks = (d) => readdirSync(join(d, '.claude')).filter((f) => f.endsWith('.bak'));
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Ajustes del usuario que no se pueden perder: otras claves, un hook suyo en el mismo evento y en el mismo grupo que uno nuestro.
const USER = { model: 'x', env: { A: 'ZZSECRETO7Q' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mio.exe' }] }], Other: [] } };

test('sin settings.json: lo crea con una entrada por evento, copia el hook y no deja .bak', (t) => {
  const d = tmp(t), { settings, hook } = paths(d);
  assert.equal(hookStatus(settings, hook), 'absent');
  assert.equal(apply(settings, hook, 'install', HOOK_SRC), true);
  const s = json(settings);
  assert.deepEqual(Object.keys(s.hooks), EVENTS);
  for (const ev of EVENTS) assert.deepEqual(s.hooks[ev][0].hooks[0].args.at(-1), hook);
  assert.equal(readFileSync(hook, 'utf8'), readFileSync(HOOK_SRC, 'utf8'));
  assert.deepEqual(baks(d), []);
  assert.equal(hookStatus(settings, hook), 'installed');
});

test('idempotente, con copia .bak exacta, y desinstalar deja los ajustes del usuario como estaban', (t) => {
  const d = tmp(t), { settings, hook } = paths(d);
  mkdirSync(join(d, '.claude'));
  const original = '\uFEFF' + JSON.stringify(USER);
  writeFileSync(settings, original);
  const now = new Date(Date.UTC(2026, 10, 5, 12));
  assert.equal(apply(settings, hook, 'install', HOOK_SRC, now), true);
  assert.equal(apply(settings, hook, 'install', HOOK_SRC, now), false); // misma fecha: un segundo .bak fallaría con wx
  assert.deepEqual(baks(d), ['settings.json.claude-office-2026-11-05T12-00-00-000Z.bak']);
  assert.equal(readFileSync(join(d, '.claude', baks(d)[0]), 'utf8'), original);
  const s = json(settings);
  assert.equal(s.hooks.Stop.length, 2);
  assert.deepEqual(s.env, USER.env);

  // Un hook del usuario dentro de un grupo nuestro se conserva al desinstalar.
  s.hooks.Stop[1].hooks.push({ type: 'command', command: 'otro.exe' });
  writeFileSync(settings, JSON.stringify(s));
  assert.equal(apply(settings, hook, 'uninstall', HOOK_SRC, new Date(now.getTime() + 1)), true);
  const u = json(settings);
  assert.deepEqual(u.hooks.Stop, [...USER.hooks.Stop, { hooks: [{ type: 'command', command: 'otro.exe' }] }]);
  u.hooks.Stop.pop();
  assert.deepEqual(u, USER);
  assert.equal(hookStatus(settings, hook), 'absent');
  assert.equal(apply(settings, hook, 'uninstall', HOOK_SRC), false);
});

test('falta un evento: estado partial; instalar lo completa', (t) => {
  const d = tmp(t), { settings, hook } = paths(d);
  apply(settings, hook, 'install', HOOK_SRC);
  const s = json(settings);
  delete s.hooks.Notification;
  writeFileSync(settings, JSON.stringify(s));
  assert.equal(hookStatus(settings, hook), 'partial');
  apply(settings, hook, 'install', HOOK_SRC, new Date(1));
  assert.equal(hookStatus(settings, hook), 'installed');
  assert.equal(plan(settings, hook, 'uninstall').after, '{}\n');
});

test('settings.json inválido: SETTINGS_INVALID sin escribir nada', (t) => {
  for (const bad of ['{', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    const d = tmp(t), { settings, hook } = paths(d);
    mkdirSync(join(d, '.claude'));
    writeFileSync(settings, bad);
    assert.throws(() => apply(settings, hook, 'install', HOOK_SRC), { message: 'SETTINGS_INVALID' });
    assert.equal(readFileSync(settings, 'utf8'), bad);
    assert.deepEqual(baks(d), []);
    assert.equal(existsSync(hook), false);
  }
  assert.equal(errorCode(new Error('EPERM C:\\ruta')), 'INSTALL_FAILED');
});

const hasPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;
test('hook de app/hook: pendiente, y tras activarlo escribe en %APPDATA%\\ClaudeOffice\\hooks-events.jsonl sin contenido', { skip: hasPowerShell ? false : 'requiere powershell.exe' }, (t) => {
  const d = tmp(t), proj = join(d, 'proyecto'), co = join(d, 'ClaudeOffice');
  mkdirSync(proj);
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK_SRC], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '11111111-2222', tool_name: 'Bash', tool_use_id: 't1',
      tool_input: { command: 'ZZSECRETO7Q' }, cwd: 'C:\\ZZSECRETO7Q', prompt: 'ZZSECRETO7Q' }),
    env: { ...process.env, APPDATA: d, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const [pending] = readdirSync(join(co, 'pending'));
  assert.deepEqual(json(join(co, 'pending', pending)), { name: 'proyecto' });
  assert.equal(existsSync(join(co, 'hooks-events.jsonl')), false);
  renameSync(join(co, 'pending', pending), join(co, 'enabled', pending));
  assert.equal(run().status, 0);
  const log = readFileSync(join(co, 'hooks-events.jsonl'), 'utf8');
  assert.equal(log.includes('ZZSECRETO7Q'), false);
  const r = validateLine(log.trim());
  assert.equal(r.ok, true);
  assert.equal(r.event.project_id, pending.slice(0, -5));
});

// Hook de macOS/Linux: se ejecuta con el Node actual en cualquier sistema, copiado a <tmp>/ClaudeOffice/hook como lo instala la app.
const MJS_SRC = join(import.meta.dirname, '..', 'hook', 'capture-event.mjs');
const PAYLOADS = [
  { hook_event_name: 'SessionStart', session_id: '11111111-2222', source: 'startup', model: 'claude-x[1m]', permission_mode: 'raro', prompt: 'ZZSECRETO7Q' },
  { hook_event_name: 'PreToolUse', session_id: '11111111-2222', agent_id: 'a1', agent_type: 'Explore', tool_name: 'mcp__x__y', tool_use_id: 't1', tool_input: { command: 'ZZSECRETO7Q' } },
  { hook_event_name: 'PostToolUse', session_id: '11111111-2222', agent_type: 'mio:plug', tool_name: 'Inventada', tool_use_id: 't1', duration_ms: 12, tool_response: 'ZZSECRETO7Q' },
  { hook_event_name: 'PostToolUseFailure', session_id: '11111111-2222', agent_type: 'otro', tool_name: 'Bash', is_interrupt: true, error: 'ZZSECRETO7Q' },
  { hook_event_name: 'Stop', session_id: '11111111-2222', stop_hook_active: false, background_tasks: [1, 2], session_crons: 'x', last_assistant_message: 'ZZSECRETO7Q' },
  { hook_event_name: 'StopFailure', session_id: '11111111-2222', error: 'rate_limit' },
  { hook_event_name: 'Notification', session_id: '11111111-2222', notification_type: 'ZZSECRETO7Q', message: 'ZZSECRETO7Q' },
  { hook_event_name: 'SessionEnd', session_id: '11111111-2222', reason: 'prompt_input_exit' },
  { hook_event_name: 'Desconocido', session_id: '11111111-2222' },
  { hook_event_name: 'Stop', session_id: 'corto' },
];
const setup = (t, ext) => {
  const d = tmp(t), proj = join(d, 'proyecto'), co = join(d, 'ClaudeOffice'), hook = join(co, 'hook', `capture-event.${ext}`);
  mkdirSync(proj); mkdirSync(join(co, 'hook'), { recursive: true });
  writeFileSync(hook, readFileSync(join(import.meta.dirname, '..', 'hook', `capture-event.${ext}`)));
  const cmd = ext === 'mjs' ? [process.execPath, [hook]] : ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hook]];
  const env = { ...process.env, APPDATA: d, CLAUDE_PROJECT_DIR: proj };
  return { d, co, cmd, env, run: (p) => spawnSync(...cmd, { input: typeof p === 'string' ? p : JSON.stringify(p), env, encoding: 'utf8' }) };
};
const enable = (co) => { const [p] = readdirSync(join(co, 'pending')); renameSync(join(co, 'pending', p), join(co, 'enabled', p)); return p.slice(0, -5); };
const lines = (co) => readFileSync(join(co, 'hooks-events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);

test('hook .mjs: entrada con env y el binario de la app', () => {
  assert.deepEqual(entry('/h/capture-event.mjs', '/opt/Claude Office/claude-office').hooks[0],
    { type: 'command', command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', '/opt/Claude Office/claude-office', '/h/capture-event.mjs'], timeout: 5 });
});

test('hook .mjs: pendiente, excluido no escribe, activado escribe líneas válidas sin contenido', (t) => {
  const { co, run } = setup(t, 'mjs');
  assert.equal(run(PAYLOADS[0]).status, 0);
  assert.deepEqual(readdirSync(join(co, 'pending')).map((f) => json(join(co, 'pending', f))), [{ name: 'proyecto' }]);
  assert.equal(existsSync(join(co, 'hooks-events.jsonl')), false);
  const id = enable(co);
  writeFileSync(join(co, 'excluded', `${id}.json`), '{}');
  assert.equal(run(PAYLOADS[0]).status, 0);
  assert.equal(existsSync(join(co, 'hooks-events.jsonl')), false);
  rmSync(join(co, 'excluded', `${id}.json`));
  for (const p of PAYLOADS) assert.equal(run(p).status, 0);
  const out = lines(co);
  assert.equal(out.length, PAYLOADS.length - 2);
  for (const l of out) { assert.equal(l.includes('ZZSECRETO7Q'), false); const r = validateLine(l); assert.equal(r.ok, true, l); assert.equal(r.event.project_id, id); }
  assert.equal(run('no es json').status, 1);
});

test('hook .mjs: 20 procesos a la vez no pierden ni mezclan líneas', async (t) => {
  const { co, cmd, env, run } = setup(t, 'mjs');
  run(PAYLOADS[1]); enable(co);
  const one = () => new Promise((ok) => { const c = spawn(...cmd, { env, stdio: ['pipe', 'ignore', 'ignore'] }); c.on('exit', ok); c.stdin.end(JSON.stringify(PAYLOADS[1])); });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, one)), Array(20).fill(0));
  const out = lines(co);
  assert.equal(out.length, 20);
  for (const l of out) assert.equal(validateLine(l).ok, true);
});

test('paridad: el hook .mjs y el .ps1 dan las mismas líneas (salvo la hora) y el mismo project_id', { skip: hasPowerShell ? false : 'requiere powershell.exe' }, (t) => {
  const mjs = setup(t, 'mjs'), ps = setup(t, 'ps1');
  ps.env.CLAUDE_PROJECT_DIR = mjs.env.CLAUDE_PROJECT_DIR + '/'; // la barra final no cambia el project_id
  mjs.run(PAYLOADS[0]); enable(mjs.co);
  mkdirSync(join(ps.co, 'enabled'), { recursive: true });
  writeFileSync(join(ps.co, 'install.key'), readFileSync(join(mjs.co, 'install.key')));
  for (const f of readdirSync(join(mjs.co, 'enabled'))) writeFileSync(join(ps.co, 'enabled', f), '{}');
  for (const p of PAYLOADS) { mjs.run(p); ps.run(p); }
  const strip = (co) => lines(co).map((l) => ({ ...JSON.parse(l), timestamp: null }));
  assert.deepEqual(strip(mjs.co), strip(ps.co));
});
