// Añade o quita el hook global en ~/.claude/settings.json. Solo toca entradas propias: las que ejecutan `hook`
// (la copia instalada en <appData>/ClaudeOffice/hook). Copia .bak antes de escribir, escritura atómica e idempotente.
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { dirname, win32 } from 'node:path';

// Los mismos eventos que la lista blanca del hook.
export const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop'];
const CODES = new Set(['SETTINGS_INVALID', 'SETTINGS_UNREADABLE']);
// Los errores de fs llevan rutas: hacia fuera solo salen códigos fijos.
export const errorCode = (e) => (CODES.has(e?.message) ? e.message : 'INSTALL_FAILED');

// Windows: hook en PowerShell. macOS/Linux: hook .mjs ejecutado por el binario de la app como Node (`runtime`).
// Si la aplicación cambia de ubicación, la entrada deja de coincidir y el estado pasa a «partial»; se corrige reinstalando.
// Ruta absoluta: con un nombre suelto, Windows puede buscar primero en el directorio del proyecto.
export const POWERSHELL = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const command = (hook, runtime) => (hook.endsWith('.ps1')
  ? { command: POWERSHELL, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hook] }
  : { command: '/usr/bin/env', args: ['ELECTRON_RUN_AS_NODE=1', runtime, hook] });
export const entry = (hook, runtime = process.execPath) => ({ hooks: [{ type: 'command', ...command(hook, runtime), timeout: 5 }] });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mine = (h, hook) => Array.isArray(h?.args) && h.args.includes(hook);

function read(path) {
  let text = null;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new Error('SETTINGS_UNREADABLE'); }
  if (text === null) return { text, data: {} };
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('SETTINGS_INVALID'); }
  if (!isObj(data) || (data.hooks !== undefined && !(isObj(data.hooks) && Object.values(data.hooks).every(Array.isArray)))) throw new Error('SETTINGS_INVALID');
  return { text, data };
}

// Quita los hooks propios; un grupo o un evento solo desaparece si se queda vacío por eso.
function strip(data, hook) {
  const out = structuredClone(data);
  for (const [ev, groups] of Object.entries(out.hooks ?? {})) {
    const kept = groups.flatMap((g) => {
      if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some((h) => mine(h, hook))) return [g];
      const rest = g.hooks.filter((h) => !mine(h, hook));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length || !groups.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (isObj(data.hooks) && Object.keys(data.hooks).length && !Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// action: 'install' | 'uninstall'. No escribe nada.
export function plan(settingsPath, hook, action) {
  const { text, data } = read(settingsPath);
  const next = strip(data, hook);
  if (action === 'install') { next.hooks ??= {}; for (const ev of EVENTS) (next.hooks[ev] ??= []).push(entry(hook)); }
  return { before: text, after: JSON.stringify(next, null, 2) + '\n', changed: JSON.stringify(next) !== JSON.stringify(data) };
}

export function hookStatus(settingsPath, hook) {
  if (!plan(settingsPath, hook, 'install').changed) return 'installed';
  return plan(settingsPath, hook, 'uninstall').changed ? 'partial' : 'absent';
}

// Al instalar también se recopia el hook (actualiza la versión aunque settings.json ya esté bien).
export function apply(settingsPath, hook, action, hookSrc, now = new Date()) {
  const p = plan(settingsPath, hook, action); // SETTINGS_INVALID antes de tocar nada
  if (action === 'install') { mkdirSync(dirname(hook), { recursive: true }); copyFileSync(hookSrc, hook); }
  if (!p.changed) return false;
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  // settings.json puede llevar secretos (env): en POSIX, el temporal y el .bak conservan el modo del original, o 0600 si no existe.
  // En Windows mode solo afecta al bit de solo lectura; los permisos salen de la ACL heredada de la carpeta.
  const mode = p.before === null ? 0o600 : statSync(settingsPath).mode & 0o777;
  if (p.before !== null) writeFileSync(`${settingsPath}.claude-office-${now.toISOString().replace(/[:.]/g, '-')}.bak`, p.before, { flag: 'wx', mode });
  const tmp = `${settingsPath}.claude-office.tmp`;
  rmSync(tmp, { force: true }); // mode solo se aplica al crear: un temporal que sobró de un fallo conservaría sus permisos
  writeFileSync(tmp, p.after, { mode });
  renameSync(tmp, settingsPath);
  return true;
}
