// Fase 4: tablas en directo. Todo el texto entra con textContent (el nombre de carpeta del proyecto no es de confianza).
export {}; // hace de este archivo un módulo (necesario para `declare global` y el await de nivel superior)
type State ='WORKING' | 'PERMISSION' | 'IDLE' | 'ENDED' | 'STALE';
type Session = { kind: 'session'; session_id: string; project_id: string | null; state: State; since: number | null };
type Agent = { kind: 'agent'; session_id: string; agent_id: string; agent_types: string[]; state: State; since: number | null };
type Row = Session | Agent;
type Delta = { upsert: [string, Row][]; remove: string[] };
type Project = { project_id: string; name: string | null; status: 'enabled' | 'excluded' | 'pending' };

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

const LABEL: Record<State, [string, string]> = {
  WORKING: ['Trabajando', 'bg-emerald-700'],
  PERMISSION: ['Esperando permiso', 'bg-amber-600'],
  IDLE: ['Inactivo', 'bg-slate-600'],
  ENDED: ['Terminado', 'bg-slate-800 text-slate-400'],
  STALE: ['Caducado', 'bg-rose-900'],
};
const POLICY: Record<Project['status'], string> = { enabled: 'Activado', excluded: 'Excluido', pending: 'Pendiente' };

let rows: Record<string, Row> = {};
let projects: Project[] = [];
const $ = (id: string) => document.getElementById(id)!;
const showEnded = $('show-ended') as HTMLInputElement;

function el(tag: string, cls = '', text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

const short = (id: string) => id.slice(0, 8);
function ago(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86400 ? `hace ${Math.floor(s / 3600)} h` : `hace ${Math.floor(s / 86400)} d`;
}
const badge = (st: State) => el('span', `rounded px-2 py-0.5 text-xs ${LABEL[st][1]}`, LABEL[st][0]);
const projectName = (id: string | null) => (id === null ? '—' : projects.find((p) => p.project_id === id)?.name ?? short(id));

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

const bySince = (a: Row, b: Row) => (b.since ?? 0) - (a.since ?? 0);

function render() {
  const all = Object.values(rows);
  const visible = (r: Row) => showEnded.checked || r.state !== 'ENDED';
  const sessions = all.filter((r): r is Session => r.kind === 'session' && visible(r)).sort(bySince);
  const agents = all.filter((r): r is Agent => r.kind === 'agent' && visible(r)).sort(bySince);
  const live = (sid: string) => all.filter((r) => r.kind === 'agent' && r.session_id === sid && r.state !== 'ENDED').length;

  $('sessions').replaceChildren(table(['Proyecto', 'Sesión', 'Estado', 'Último evento', 'Agentes activos'],
    sessions.map((s) => [projectName(s.project_id), short(s.session_id), badge(s.state), ago(s.since), String(live(s.session_id))]),
    'Sin sesiones.'));
  $('agents').replaceChildren(table(['Sesión', 'Agente', 'Tipo', 'Estado', 'Último evento'],
    agents.map((a) => [short(a.session_id), short(a.agent_id), a.agent_types.join(', ') || '—', badge(a.state), ago(a.since)]),
    'Sin agentes.'));

  const action = (p: Project, to: 'enabled' | 'excluded', text: string) => {
    const b = el('button', 'mr-2 rounded border border-slate-600 px-2 py-0.5 text-xs hover:bg-slate-800', text) as HTMLButtonElement;
    b.onclick = async () => { projects = await window.office.setPolicy(p.project_id, to); render(); };
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

function setStatus(code: string | null) {
  const s = $('status');
  s.textContent = code ?? 'En directo';
  s.className = `rounded px-2 py-0.5 text-xs ${code ? 'bg-rose-900' : 'bg-emerald-900'}`;
}

// Suscripción antes del snapshot: un delta ya incluido en él se reaplica sin efecto (upsert idempotente).
window.office.onDelta((d) => {
  rows = { ...rows, ...Object.fromEntries(d.upsert) };
  for (const k of d.remove) delete rows[k];
  render();
});
window.office.onStatus(setStatus);
window.office.onProjects((p) => { projects = p; render(); });
showEnded.onchange = render;

const [snap, proj] = await Promise.all([window.office.snapshot(), window.office.projects()]);
rows = snap.rows;
projects = proj;
setStatus(snap.status);
render();
setInterval(render, 5000); // refresca los «hace X»
