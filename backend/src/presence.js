// Estado en vivo de cada sesión (MAIN) y agente a partir del modelo de jerarquía y de la hora actual.
// Función pura: no lee SQLite, no usa la hora del sistema y no modifica el modelo.
import { ticks } from './hierarchy.js';

export const STATES = ['WORKING', 'PERMISSION', 'IDLE', 'ERROR', 'ENDED', 'STALE']; // trabajando, esperando permiso, inactivo, error, terminado, caducado

// Caducidades aprobadas (2026-11-02), no calibradas con uso real (ms sin eventos del actor). Hallazgos de las pruebas con el hook real:
// Esc no deja Stop (A2) y un permiso rechazado deja PreToolUse + PermissionRequest sin cierre.
// ERROR (turno cerrado con StopFailure) espera el siguiente prompt como IDLE: misma caducidad.
export const TTL_MS = { WORKING: 30 * 60000, PERMISSION: 10 * 60000, IDLE: 24 * 3600000, ERROR: 24 * 3600000 };

// Notification no decide el estado: llega tarde y no siempre tras PermissionRequest (hallazgo 4).
const IGNORED = new Set(['Notification']);
const STATE_OF = { SessionStart: 'IDLE', Stop: 'IDLE', StopFailure: 'ERROR', SessionEnd: 'ENDED', SubagentStop: 'ENDED', PermissionRequest: 'PERMISSION' };
const order = (a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1
  : a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : a.byte_offset - b.byte_offset);

// Estado del último evento significativo; si ha caducado, STALE. Sin eventos significativos: IDLE sin fecha.
function stateOf(refs, nowTicks, ttl) {
  const last = refs.filter((r) => !IGNORED.has(r.event)).sort(order).at(-1);
  if (!last) return { state: 'IDLE', since: null };
  const state = STATE_OF[last.event] ?? 'WORKING';
  const age = nowTicks - ticks(last.timestamp);
  return { state: state in ttl && age > BigInt(ttl[state]) * 10000n ? 'STALE' : state, since: last.timestamp };
}

// nowMs: milisegundos desde la época (Date.now() de quien llama).
export function presence(model, nowMs, ttl = TTL_MS) {
  const now = BigInt(nowMs) * 10000n;
  const sessions = model.sessions.map((s) => {
    // MAIN y ciclo de vida de la sesión en una sola línea temporal: un SessionStart (resume) posterior al SessionEnd la reabre.
    const refs = [...s.starts, ...s.ends, ...s.mains.flatMap((m) => m.events)];
    return { session_id: s.session_id, project_id: s.project_id, ...stateOf(refs, now, ttl) };
  });
  const ended = new Set(sessions.filter((s) => s.state === 'ENDED').map((s) => s.session_id));
  // El Stop del padre llega antes que los SubagentStop (hallazgo 1): el agente tiene su propio estado hasta que acaba la sesión.
  const agents = model.agents.map((a) => {
    const own = stateOf(a.events, now, ttl);
    return { session_id: a.session_id, source_id: a.source_id, agent_id: a.agent_id, agent_types: a.agent_types,
      ...(ended.has(a.session_id) && own.state !== 'ENDED' ? { state: 'ENDED', since: own.since } : own) };
  });
  return { sessions, agents };
}
