// Añade o quita el hook global en ~/.claude/settings.json. Solo toca entradas propias: las que ejecutan `hook`
// (la copia instalada en <appData>/Deskside/hook). Copia .bak antes de escribir, escritura atómica e idempotente.
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, statSync, rmSync, readdirSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';

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

// settings.json puede llevar secretos (env): una sola copia propia, que se sobrescribe.
const backup = (settingsPath) => `${settingsPath}.deskside.bak`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Borra las copias con fecha de versiones anteriores (y, con all, también la copia actual). Los .bak ajenos no se tocan.
function cleanBackups(settingsPath, all) {
  const old = new RegExp(`^${escape(basename(settingsPath))}\\.deskside-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.bak$`);
  let files = [];
  try { files = readdirSync(dirname(settingsPath)); } catch { return; } // carpeta inexistente: nada que limpiar
  for (const f of files) if (old.test(f)) rmSync(join(dirname(settingsPath), f), { force: true });
  if (all) rmSync(backup(settingsPath), { force: true });
}

// Al instalar también se recopia el hook (actualiza la versión aunque settings.json ya esté bien).
export function apply(settingsPath, hook, action, hookSrc) {
  const p = plan(settingsPath, hook, action); // SETTINGS_INVALID antes de tocar nada
  if (action === 'install') { mkdirSync(dirname(hook), { recursive: true }); copyFileSync(hookSrc, hook); }
  if (!p.changed) return false;
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  // En POSIX, el temporal y el .bak conservan el modo del original, o 0600 si no existe.
  // En Windows mode solo afecta al bit de solo lectura; los permisos salen de la ACL heredada de la carpeta.
  const mode = p.before === null ? 0o600 : statSync(settingsPath).mode & 0o777;
  // mode solo se aplica al crear: por eso se borran antes la copia y un temporal que sobrara de un fallo.
  if (p.before !== null) { rmSync(backup(settingsPath), { force: true }); writeFileSync(backup(settingsPath), p.before, { mode }); }
  const tmp = `${settingsPath}.deskside.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, p.after, { mode });
  renameSync(tmp, settingsPath);
  cleanBackups(settingsPath, false);
  return true;
}

// Desinstalación de la aplicación: quita las entradas, las copias propias y el hook instalado.
// Si settings.json no se puede leer o es inválido, lanza sin borrar nada: un script borrado con las entradas
// aún presentes haría fallar el hook en cada evento de Claude Code.
export function removeAll(settingsPath, hook) {
  apply(settingsPath, hook, 'uninstall');
  cleanBackups(settingsPath, true);
  rmSync(dirname(hook), { recursive: true, force: true });
}
