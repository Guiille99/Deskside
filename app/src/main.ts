// Fase 5: oficina en Phaser + panel de proyectos. Todo el texto del DOM entra con textContent (el nombre de carpeta no es de confianza).
import type { Delta, Project, Row } from './types.ts';
import { createOffice } from './office.ts';

declare global {
  interface Window {
    office: {
      snapshot(): Promise<{ rows: Record<string, Row>; status: string | null }>;
      projects(): Promise<Project[]>;
      setPolicy(id: string, status: 'enabled' | 'excluded'): Promise<Project[]>;
      onDelta(cb: (d: Delta) => void): void;
      onStatus(cb: (code: string | null) => void): void;
      onProjects(cb: (p: Project[]) => void): void;
    };
  }
}

// Fuera de Electron (vite preview) no hay preload: datos sintéticos para probar la escena.
if (!('office' in window)) (await import('./demo.ts')).installDemo();

const POLICY: Record<Project['status'], string> = { enabled: 'Activado', excluded: 'Excluido', pending: 'Pendiente' };

let rows: Record<string, Row> = {};
let projects: Project[] = [];
const $ = (id: string) => document.getElementById(id)!;

function el(tag: string, cls = '', text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

const short = (id: string) => id.slice(0, 8);
const projectName = (id: string | null) => (id === null ? '—' : projects.find((p) => p.project_id === id)?.name ?? short(id));
const sessionName = (sid: string) => { const r = rows[`s:${sid}`]; return r?.kind === 'session' ? projectName(r.project_id) : '—'; };
const office = createOffice($('scene'), $('hud'), sessionName);

function table(head: string[], body: (string | HTMLElement)[][], empty: string): HTMLElement {
  if (!body.length) return el('p', 'text-slate-500', empty);
  const t = el('table', 'w-full text-left');
  const tr = el('tr', 'border-b border-slate-800 text-xs text-slate-400');
  for (const h of head) tr.append(el('th', 'px-2 py-1 font-normal', h));
  t.append(el('thead'), el('tbody'));
  t.firstChild!.appendChild(tr);
  for (const r of body) {
    const row = el('tr', 'border-b border-slate-900');
    for (const c of r) { const td = el('td', 'px-2 py-1'); td.append(c); row.append(td); }
    t.lastChild!.appendChild(row);
  }
  return t;
}

function renderProjects() {
  const action = (p: Project, to: 'enabled' | 'excluded', text: string) => {
    const b = el('button', 'mr-2 rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-800', text) as HTMLButtonElement;
    b.onclick = async () => { setProjects(await window.office.setPolicy(p.project_id, to)); };
    return b;
  };
  $('projects').replaceChildren(table(['Nombre', 'Id', 'Estado', 'Acciones'],
    projects.map((p) => {
      const acts = el('span');
      if (p.status !== 'enabled') acts.append(action(p, 'enabled', p.status === 'pending' ? 'Autorizar' : 'Activar'));
      if (p.status !== 'excluded') acts.append(action(p, 'excluded', 'Excluir'));
      return [p.name ?? '—', short(p.project_id), POLICY[p.status], acts];
    }),
    'Sin proyectos. El hook crea uno pendiente la primera vez que se usa en una carpeta.'));
}

function setProjects(p: Project[]) {
  projects = p;
  renderProjects();
  office.setRows(rows); // los rótulos de las islas llevan el nombre del proyecto
}

function setStatus(code: string | null) {
  const s = $('status');
  s.textContent = code ?? 'En directo';
  s.className = `rounded px-2 py-0.5 text-xs ${code ? 'bg-rose-900' : 'bg-emerald-900'}`;
}

// Suscripción antes del snapshot: un delta ya incluido en él se reaplica sin efecto (upsert idempotente).
window.office.onDelta((d) => {
  rows = { ...rows, ...Object.fromEntries(d.upsert) };
  for (const k of d.remove) delete rows[k];
  office.setRows(rows);
});
window.office.onStatus(setStatus);
window.office.onProjects(setProjects);

const [snap, proj] = await Promise.all([window.office.snapshot(), window.office.projects()]);
rows = snap.rows;
setStatus(snap.status);
setProjects(proj);
