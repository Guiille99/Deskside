// Fase 5: oficina en Phaser + panel de proyectos. Todo el texto del DOM entra con textContent (el nombre de carpeta no es de confianza).
import type { Delta, Hook, Project, Row } from './types.ts';
import { createOffice } from './office.ts';

declare global {
  interface Window {
    office: {
      snapshot(): Promise<{ rows: Record<string, Row>; status: string | null }>;
      projects(): Promise<Project[]>;
      setPolicy(id: string, status: 'enabled' | 'excluded'): Promise<Project[]>;
      hook(): Promise<Hook>;
      hookApply(action: 'install' | 'uninstall'): Promise<Hook>;
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

// Una oficina por proyecto. Las sesiones sin project_id (conflicto o datos de antes de la Fase 2) van a «Sin proyecto».
const NONE = '';
const KEY = 'claude-office.project';
let selected: string | null = null;
const projectOf = (r: Row) => { const s = rows[`s:${r.session_id}`]; return (s?.kind === 'session' ? s.project_id : null) ?? NONE; };
const view = () => (selected === null ? {} : Object.fromEntries(Object.entries(rows).filter(([, r]) => projectOf(r) === selected)));

// Proyectos activados más los que tengan filas; primero los que tienen gente activa.
function options() {
  const m = new Map<string, { live: number; last: number }>();
  for (const p of projects) if (p.status === 'enabled') m.set(p.project_id, { live: 0, last: 0 });
  for (const r of Object.values(rows)) {
    const id = projectOf(r), o = m.get(id) ?? { live: 0, last: 0 };
    if (r.state !== 'ENDED') o.live++;
    o.last = Math.max(o.last, r.since ?? r.first ?? 0);
    m.set(id, o);
  }
  return [...m].map(([id, o]) => ({ id, name: id === NONE ? 'Sin proyecto' : projectName(id), ...o }))
    .sort((a, b) => Number(b.live > 0) - Number(a.live > 0) || a.name.localeCompare(b.name));
}

function refresh() {
  const opts = options(), has = (id: string | null) => opts.some((o) => o.id === id);
  let next = selected;
  if (!has(next)) {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* sin almacenamiento: se usa el más reciente */ }
    next = has(saved) ? saved : opts.reduce<(typeof opts)[0] | null>((b, o) => (!b || o.last > b.last ? o : b), null)?.id ?? null;
  }
  const sel = $('project') as HTMLSelectElement;
  const text = (o: (typeof opts)[0]) => (o.live ? `${o.name} · ${o.live} activos` : o.name);
  // Si la lista no cambia solo se actualizan los textos, para no cerrar el desplegable si está abierto.
  if ([...sel.options].map((o) => o.value).join('\n') === opts.map((o) => o.id).join('\n')) opts.forEach((o, i) => { sel.options[i].textContent = text(o); });
  else sel.replaceChildren(...opts.map((o) => { const e = el('option', '', text(o)) as HTMLOptionElement; e.value = o.id; return e; }));
  if (!opts.length) sel.replaceChildren(el('option', '', 'Sin proyectos'));
  sel.disabled = !opts.length;
  if (next !== null) sel.value = next;
  const reset = next !== selected;
  selected = next;
  office.setRows(view(), reset);
}

($('project') as HTMLSelectElement).onchange = (e) => {
  selected = (e.target as HTMLSelectElement).value;
  try { localStorage.setItem(KEY, selected); } catch { /* preferencia visual: si falla no pasa nada */ }
  office.setRows(view(), true);
};

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
  refresh(); // el desplegable lleva los nombres de los proyectos
}

// Fase 7: el cambio que se va a hacer en settings.json se enseña antes de pulsar.
const HOOK: Record<Hook['status'], string> = { installed: 'Instalado', partial: 'Incompleto', absent: 'No instalado', invalid: 'settings.json no válido' };
function renderHook(h: Hook) {
  const btn = (action: 'install' | 'uninstall', text: string) => {
    const b = el('button', 'mr-2 rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-800', text) as HTMLButtonElement;
    b.onclick = async () => { renderHook(await window.office.hookApply(action)); };
    return b;
  };
  const acts = el('p', 'my-2');
  if (h.status === 'absent' || h.status === 'partial') acts.append(btn('install', h.status === 'partial' ? 'Reparar' : 'Instalar'));
  if (h.status === 'installed' || h.status === 'partial') acts.append(btn('uninstall', 'Desinstalar'));
  const details = el('details', 'text-xs text-slate-400');
  details.append(el('summary', 'cursor-pointer', `Cambio en ~/.claude/settings.json: esta entrada en ${h.events.length} eventos (${h.events.join(', ')}). Antes se guarda una copia .bak; desinstalar solo quita estas entradas.`),
    el('pre', 'mt-1 overflow-x-auto rounded bg-slate-900 p-2', h.entry));
  $('hook').replaceChildren(el('p', '', `Estado: ${HOOK[h.status]}${h.error ? ` (${h.error})` : ''}`), acts, details);
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
  refresh();
});
window.office.onStatus(setStatus);
window.office.onProjects(setProjects);

const [snap, proj, hook] = await Promise.all([window.office.snapshot(), window.office.projects(), window.office.hook()]);
renderHook(hook);
rows = snap.rows;
setStatus(snap.status);
setProjects(proj);
