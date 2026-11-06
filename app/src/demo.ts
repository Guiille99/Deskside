// Datos sintéticos para probar la escena fuera de Electron (vite preview), donde no existe window.office.
// 20 sesiones × 10 agentes en tres proyectos; cada segundo cambian estados y herramientas, y algunos agentes terminan y llegan otros.
import type { Delta, Project, Row, State } from './types.ts';

const SESSIONS = 20, AGENTS = 10;
const STATES: State[] = ['WORKING', 'WORKING', 'WORKING', 'PERMISSION', 'IDLE', 'ERROR', 'STALE'];
const TOOLS = ['Read', 'Edit', 'Bash', 'WebFetch', 'Agent', 'mcp__demo__x', 'Otra', null];
// Tres proyectos activados; una de cada cuatro sesiones va sin proyecto.
const PROJECTS: Project[] = ['tienda-web', 'api-pagos', 'docs'].map((name, i) => ({ project_id: `demo${i}`.padEnd(32, '0'), name, status: 'enabled' }));
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function installDemo() {
  const t0 = Date.now();
  const rows: Record<string, Row> = {};
  const live = new Map<string, string[]>(); // sesión → claves de agentes vivos
  let n = 0;
  const agent = (sid: string): [string, Row] => {
    const ids = live.get(sid)!;
    const k = `a:${sid}:demo:ag${n++}`;
    const visitor = Math.random() < 0.15;
    rows[k] = { kind: 'agent', session_id: sid, agent_id: `ag${n}`.padEnd(8, '0'), agent_types: [pick(['Explore', 'Plan', 'general-purpose'])],
      state: 'WORKING', since: Date.now(), first: Date.now(), tool: pick(TOOLS), tools: 0, events: 1,
      evidence: visitor ? 'UNKNOWN' : 'INFERRED', parent: visitor ? null : ids.length && Math.random() < 0.3 ? pick(ids) : `s:${sid}` };
    ids.push(k);
    return [k, rows[k]];
  };
  for (let s = 0; s < SESSIONS; s++) {
    const sid = `demo${String(s).padStart(4, '0')}-0000`;
    rows[`s:${sid}`] = { kind: 'session', session_id: sid, project_id: s % 4 === 3 ? null : PROJECTS[s % 4].project_id, state: 'WORKING', since: t0, first: t0 + s, tool: 'Bash', tools: 3, events: 10 };
    live.set(sid, []);
    for (let a = 0; a < AGENTS; a++) agent(sid);
  }

  const cbs: ((d: Delta) => void)[] = [];
  setInterval(() => {
    const upsert: [string, Row][] = [];
    const keys = Object.keys(rows).filter((k) => rows[k].state !== 'ENDED');
    for (let i = 0; i < 30; i++) {
      const k = pick(keys);
      rows[k] = { ...rows[k], state: pick(STATES), tool: pick(TOOLS), since: Date.now(), events: rows[k].events + 1 };
      upsert.push([k, rows[k]]);
    }
    for (let i = 0; i < 3; i++) { // tres agentes terminan y llegan tres nuevos
      const sid = `demo${String(Math.floor(Math.random() * SESSIONS)).padStart(4, '0')}-0000`;
      const ids = live.get(sid)!;
      const k = ids.splice(Math.floor(Math.random() * ids.length), 1)[0];
      rows[k] = { ...rows[k], state: 'ENDED' };
      // los hijos del que termina pasan a colgar de MAIN para no dejar líneas huérfanas en la demo
      for (const c of ids) { const r = rows[c]; if (r.kind === 'agent' && r.parent === k) { rows[c] = { ...r, parent: `s:${sid}` }; upsert.push([c, rows[c]]); } }
      upsert.push([k, rows[k]], agent(sid));
    }
    cbs.forEach((cb) => cb({ upsert, remove: [] }));
  }, 1000);

  window.office = {
    snapshot: async () => ({ rows: { ...rows }, status: 'DEMO' }),
    projects: async () => PROJECTS,
    setPolicy: async () => [],
    hook: async () => ({ status: 'absent', error: null, events: ['Stop'], entry: '{}' }),
    hookApply: async () => ({ status: 'installed', error: null, events: ['Stop'], entry: '{}' }),
    onDelta: (cb) => { cbs.push(cb); },
    onStatus: () => {},
    onProjects: () => {},
  };
}
