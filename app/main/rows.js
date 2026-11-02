// Fase 4: filas planas para la UI a partir de presence() y deltas entre dos estados. Sin referencias a eventos.
import { ticks } from '../../backend/src/hierarchy.js';

const ms = (ts) => (ts === null ? null : Number(ticks(ts) / 10000n));

export function toRows(p) {
  const out = {};
  for (const s of p.sessions) {
    out[`s:${s.session_id}`] = { kind: 'session', session_id: s.session_id, project_id: s.project_id, state: s.state, since: ms(s.since) };
  }
  for (const a of p.agents) {
    out[`a:${a.session_id}:${a.source_id}:${a.agent_id}`] = { kind: 'agent', session_id: a.session_id, agent_id: a.agent_id,
      agent_types: a.agent_types, state: a.state, since: ms(a.since) };
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
