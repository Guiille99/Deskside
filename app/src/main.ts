// Oficina en Phaser + panel de proyectos. Todo el texto del DOM entra con textContent (el nombre de carpeta no es de confianza).
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

// Una oficina por proyecto. Las sesiones sin project_id (conflicto o datos anteriores al project_id) van a «Sin proyecto».
const NONE = '';
const KEY = 'deskside.project';
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

const BTN = 'rounded px-2 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-sky-400';
const PRIMARY = `${BTN} bg-emerald-700 font-medium text-white hover:bg-emerald-600`;
const SECONDARY = `${BTN} border border-slate-600 hover:bg-slate-800`;
function button(cls: string, text: string, run: () => Promise<void>): HTMLButtonElement {
  const b = el('button', cls, text) as HTMLButtonElement;
  b.onclick = async () => { b.disabled = true; try { await run(); } finally { b.disabled = false; } };
  return b;
}

// Aviso en el botón del panel: se ve aunque el panel esté plegado.
let hookOk = true;
const updateAlert = () => { $('alert').hidden = hookOk && !projects.some((p) => p.status === 'pending'); };

const CHIP: Record<Project['status'], string> = { enabled: 'text-emerald-400', excluded: 'text-slate-500', pending: 'text-amber-400' };
const ORDER: Record<Project['status'], number> = { pending: 0, enabled: 1, excluded: 2 };
function renderProjects() {
  const set = (p: Project, to: 'enabled' | 'excluded') => async () => { setProjects(await window.office.setPolicy(p.project_id, to)); };
  if (!projects.length) {
    $('projects').replaceChildren(el('p', 'text-xs text-slate-500', 'Aún no hay proyectos. Aparecerán como pendientes la primera vez que uses Claude Code en una carpeta con el hook instalado.'));
    return;
  }
  const list = el('ul', 'divide-y divide-slate-800');
  for (const p of [...projects].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.name ?? '').localeCompare(b.name ?? ''))) {
    const li = el('li', 'flex items-center gap-2 py-2');
    const info = el('div', 'min-w-0 flex-1');
    const name = el('p', 'truncate', p.name ?? short(p.project_id));
    name.title = `${p.name ?? '—'} (${short(p.project_id)})`;
    info.append(name, el('p', `text-xs ${CHIP[p.status]}`, POLICY[p.status]));
    li.append(info);
    if (p.status !== 'enabled') li.append(button(p.status === 'pending' ? PRIMARY : SECONDARY, p.status === 'pending' ? 'Autorizar' : 'Activar', set(p, 'enabled')));
    if (p.status !== 'excluded') li.append(button(SECONDARY, 'Excluir', set(p, 'excluded')));
    list.append(li);
  }
  $('projects').replaceChildren(list);
}

function setProjects(p: Project[]) {
  projects = p;
  renderProjects();
  updateAlert();
  refresh(); // el desplegable lleva los nombres de los proyectos
}

// El cambio que se va a hacer en settings.json se enseña antes de pulsar.
const HOOK: Record<Hook['status'], string> = { installed: 'Instalado', partial: 'Incompleto', absent: 'No instalado', invalid: 'settings.json no válido' };
const HOOK_HINT: Record<Hook['status'], string> = {
  installed: 'Claude Code envía la actividad a la oficina.',
  partial: 'Faltan entradas: repáralo para ver toda la actividad.',
  absent: 'Instálalo para que la oficina reciba la actividad de Claude Code.',
  invalid: 'Corrige ~/.claude/settings.json (no es JSON válido) y vuelve a abrir la app.',
};
function renderHook(h: Hook) {
  hookOk = h.status === 'installed';
  updateAlert();
  const apply = (action: 'install' | 'uninstall') => async () => { renderHook(await window.office.hookApply(action)); };
  const head = el('p', `font-medium ${hookOk ? 'text-emerald-400' : 'text-amber-400'}`, `${HOOK[h.status]}${h.error ? ` (${h.error})` : ''}`);
  const acts = el('p', 'my-2 flex gap-2');
  if (h.status === 'absent' || h.status === 'partial') acts.append(button(PRIMARY, h.status === 'partial' ? 'Reparar' : 'Instalar', apply('install')));
  if (h.status === 'installed' || h.status === 'partial') acts.append(button(SECONDARY, 'Desinstalar', apply('uninstall')));
  const details = el('details', 'text-xs text-slate-400');
  details.append(el('summary', 'cursor-pointer', 'Qué cambia en settings.json'),
    el('p', 'mt-1', `Añade esta entrada en ${h.events.length} eventos (${h.events.join(', ')}). Antes guarda una copia .bak; desinstalar solo quita estas entradas.`),
    el('pre', 'mt-1 overflow-x-auto rounded bg-slate-900 p-2', h.entry));
  $('hook').replaceChildren(head, el('p', 'text-xs text-slate-400', HOOK_HINT[h.status]), acts, details);
}

// El panel se pliega para dar más sitio a la oficina; Phaser (Scale.RESIZE) se recoloca con el resize.
const PANEL = 'deskside.panel';
function showPanel(open: boolean) {
  $('panel').hidden = !open;
  $('toggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(PANEL, open ? '1' : '0'); } catch { /* preferencia visual */ }
  window.dispatchEvent(new Event('resize'));
}
$('toggle').onclick = () => showPanel($('toggle').getAttribute('aria-expanded') !== 'true');
try { if (localStorage.getItem(PANEL) === '0') showPanel(false); } catch { /* sin almacenamiento: panel abierto */ }

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
