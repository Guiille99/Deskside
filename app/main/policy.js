// Política de proyectos (%APPDATA%\Deskside\<estado>\<project_id>.json), la misma que lee el hook.
import { readdirSync, readFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Orden del hook: excluido gana sobre activado, y pendiente solo cuenta si no hay ninguno de los dos.
const PRIORITY = ['excluded', 'enabled', 'pending'];
const ID = /^[0-9a-f]{32}$/;

export function listProjects(dir) {
  const byId = new Map();
  for (const status of PRIORITY) {
    let files = [];
    try { files = readdirSync(join(dir, status)); } catch { continue; } // carpeta aún sin crear
    for (const f of files) {
      const id = f.slice(0, -5);
      if (!f.endsWith('.json') || !ID.test(id) || byId.has(id)) continue;
      let name = null;
      try {
        const v = JSON.parse(readFileSync(join(dir, status, f), 'utf8').replace(/^﻿/, '')).name;
        if (typeof v === 'string') name = v;
      } catch { /* sin nombre legible: se muestra el id */ }
      byId.set(id, { project_id: id, name, status });
    }
  }
  return [...byId.values()];
}

// Solo activar o excluir un proyecto que ya existe en alguna carpeta: conserva su archivo (y el nombre) moviéndolo.
export function setPolicy(dir, id, status) {
  if (typeof id !== 'string' || !ID.test(id) || (status !== 'enabled' && status !== 'excluded')) throw new Error('INVALID_POLICY');
  const dst = join(dir, status, `${id}.json`);
  const found = PRIORITY.map((s) => join(dir, s, `${id}.json`)).filter((p) => existsSync(p));
  if (!found.length) throw new Error('UNKNOWN_PROJECT');
  mkdirSync(join(dir, status), { recursive: true });
  // Primero el renombrado (nunca queda sin archivo) y después se quitan las copias del resto de carpetas.
  if (found[0] !== dst) renameSync(found[0], dst);
  for (const p of found) if (p !== dst && existsSync(p)) unlinkSync(p);
}
