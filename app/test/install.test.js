// Fase 7: instalador del hook global (settings.json sintéticos en %TEMP%) y el hook de app/hook con un APPDATA aislado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EVENTS, apply, plan, hookStatus, errorCode } from '../main/install.js';
import { validateLine } from '../../backend/src/validator.js';

const HOOK_SRC = join(import.meta.dirname, '..', 'hook', 'capture-event.ps1');
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), 'co-h1-install-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
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
