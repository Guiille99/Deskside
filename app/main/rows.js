// Filas planas para la UI a partir de presence() y del modelo (Fase 5: herramienta abierta, padre y recuentos).
// Deltas entre dos estados. Sin referencias a eventos: solo valores ya validados y recuentos.
import { ticks } from '../../backend/src/hierarchy.js';

const ms = (ts) => (ts === null || ts === undefined ? null : Number(ticks(ts) / 10000n));
const sKey = (sid) => `s:${sid}`;
const aKey = (sid, src, aid) => `a:${sid}:${src}:${aid}`;

// Por actor: herramientas usadas y la última abierta (PreToolUse sin cierre). Las invocaciones en conflicto no se atribuyen.
function tools(model) {
  const out = new Map();
  for (const i of model.invocations) {
    if (i.conflict) continue;
    const c = i.contexts[0];
    const k = c.kind === 'MAIN' ? sKey(i.session_id) : aKey(i.session_id, i.source_id, c.agent_id);
    const x = out.get(k) ?? { n: 0, open: null, ts: '' };
    x.n++;
    const pre = i.pre.at(-1);
    if (pre && !i.closes.length && pre.timestamp >= x.ts) { x.open = i.tool_names[0] ?? null; x.ts = pre.timestamp; }
    out.set(k, x);
  }
  return out;
}

export function toRows(p, model) {
  const inv = tools(model);
  const sessions = new Map(model.sessions.map((s) => [s.session_id, s]));
  const agents = new Map(model.agents.map((a) => [aKey(a.session_id, a.source_id, a.agent_id), a]));
  const parents = new Map(model.relations.filter((r) => r.kind === 'PARENT_CHILD')
    .map((r) => [aKey(r.session_id, r.source_id, r.child.agent_id), r]));
  const extra = (k, refs) => ({
    tool: inv.get(k)?.open ?? null, tools: inv.get(k)?.n ?? 0, events: refs.length,
    first: ms(refs.map((r) => r.timestamp).sort()[0]),
  });

  const out = {};
  for (const s of p.sessions) {
    const m = sessions.get(s.session_id);
    const refs = m ? [...m.starts, ...m.ends, ...m.mains.flatMap((x) => x.events)] : [];
    out[sKey(s.session_id)] = { kind: 'session', session_id: s.session_id, project_id: s.project_id, state: s.state, since: ms(s.since),
      ...extra(sKey(s.session_id), refs) };
  }
  for (const a of p.agents) {
    const k = aKey(a.session_id, a.source_id, a.agent_id);
    const r = parents.get(k); // sin relación: el agente no tiene SubagentStart (p. ej. SubagentStop suelto)
    out[k] = { kind: 'agent', session_id: a.session_id, agent_id: a.agent_id, agent_types: a.agent_types, state: a.state, since: ms(a.since),
      ...extra(k, agents.get(k)?.events ?? []),
      evidence: r?.evidence ?? 'UNKNOWN',
      parent: r?.evidence !== 'INFERRED' ? null : r.parent.kind === 'MAIN' ? sKey(a.session_id) : aKey(a.session_id, a.source_id, r.parent.agent_id) };
  }
  return out;
}

// { upsert: [[clave, fila]], remove: [clave] }: solo lo que cambia entre prev y next.
export function diff(prev, next) {
  const upsert = Object.entries(next).filter(([k, r]) => JSON.stringify(prev[k]) !== JSON.stringify(r));
  const remove = Object.keys(prev).filter((k) => !(k in next));
  return { upsert, remove };
}

export function applyDelta(rows, { upsert, remove }) {
  const out = { ...rows, ...Object.fromEntries(upsert) };
  for (const k of remove) delete out[k];
  return out;
}
