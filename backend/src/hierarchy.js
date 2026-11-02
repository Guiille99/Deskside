// H2-B: modelo determinista de identidad y jerarquía. Lee eventos ya validados por H1 y deriva
// sesiones, MAIN, agentes, invocaciones, relaciones y anomalías. No guarda nada y no lee contenido.
// Evidencia: OBSERVED (los eventos lo demuestran), INFERRED (deducido por reglas), UNKNOWN (no se puede atribuir).

// Ventana de lanzamiento Pre(Agent) <-> SubagentStart. PROVISIONAL y NO CALIBRADA.
export const LAUNCH_WINDOW_MS = 5000;
const TICKS_PER_MS = 10000n; // los timestamps de H1 tienen resolución de 100 ns
const WINDOW_TICKS = BigInt(LAUNCH_WINDOW_MS) * TICKS_PER_MS;

export const ANOMALY_CODES = ['SOLO_START', 'SOLO_STOP', 'REPEATED', 'NEGATIVE_INTERVAL', 'CONTEXT_CONFLICT',
  'ATTR_CONFLICT', 'SOURCE_COLLISION'];

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Contenido del evento sin procedencia: sirve para detectar duplicados exactos y para desempatar filas con la misma tripleta de orden.
const content = (e) => JSON.stringify(Object.keys(e).sort().filter((k) => k !== 'source_id' && k !== 'byte_offset' && e[k] != null).map((k) => [k, e[k]]));
const cmp = (a, b) => lt(a.e.timestamp, b.e.timestamp) || lt(a.e.source_id, b.e.source_id) || lt(a.e.byte_offset, b.e.byte_offset) || lt(a.key, b.key);
const absDiff = (a, b) => (a > b ? a - b : b - a);
const sorted = (it) => [...it].sort(lt);
const ref = (e) => ({ source_id: e.source_id, byte_offset: e.byte_offset, event: e.event, timestamp: e.timestamp });
const group = (items, keyFn) => {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return m;
};

// 'YYYY-MM-DDTHH:MM:SS.fffffff+00:00' -> BigInt en unidades de 100 ns (exacto, sin pasar por Number).
export function ticks(ts) {
  const d = new Date(0);
  d.setUTCFullYear(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10)); // Date.UTC trataría los años < 100 como 19xx
  d.setUTCHours(+ts.slice(11, 13), +ts.slice(14, 16), +ts.slice(17, 19), 0);
  return BigInt(d.getTime() / 1000) * 10000000n + BigInt(ts.slice(20, 27));
}

// Constructor puro: no toca SQLite, no modifica `events`, no usa hora ni azar.
export function buildModel(events) {
  const items = events.map((e) => ({ e, key: content(e) })).sort(cmp).map((it) => ({ ...it, t: ticks(it.e.timestamp), ref: ref(it.e) }));
  const model = {
    sessions: [], agents: [], invocations: [], relations: [], unknown: [], anomalies: [],
    counts: {
      events: items.length, context_conflicts: 0,
      attributed: { SESSION: 0, MAIN: 0, AGENT: 0, UNKNOWN: 0 },
      anomalies: Object.fromEntries(ANOMALY_CODES.map((c) => [c, 0])),
    },
  };
  const anomaly = (code, scope, id, refs, detail = null) => {
    model.anomalies.push({ code, scope, ...id, detail, refs });
    model.counts.anomalies[code]++;
  };

  const bySession = [...group(items, (it) => it.e.session_id)].sort((a, b) => lt(a[0], b[0]));
  for (const [sid, list] of bySession) {
    const sources = sorted(new Set(list.map((it) => it.e.source_id)));
    const collision = sources.length > 1;
    const session = {
      session_id: sid, sources, collision,
      starts: list.filter((it) => it.e.event === 'SessionStart').map((it) => ({ ...it.ref, source: it.e.source ?? null })),
      ends: list.filter((it) => it.e.event === 'SessionEnd').map((it) => ({ ...it.ref, reason: it.e.reason ?? null })),
      mains: [],
    };
    model.sessions.push(session);
    if (collision) {
      anomaly('SOURCE_COLLISION', 'session', { session_id: sid, source_id: null },
        sources.map((s) => list.find((it) => it.e.source_id === s).ref), { sources });
    }
    // Con colisión, cada fuente es una partición aislada: ninguna regla lee eventos de otra fuente.
    const parts = collision ? [...group(list, (it) => it.e.source_id)].sort((a, b) => lt(a[0], b[0])) : [[sources[0], list]];
    for (const [src, part] of parts) partition(sid, src, part, session, model, anomaly);
  }
  return model;
}

function partition(sid, src, items, session, model, anomaly) {
  const where = { session_id: sid, source_id: src };

  // Duplicados exactos (mismo contenido salvo source_id y byte_offset) dentro de la partición: se conservan todos.
  // Si un REPEATED de agente o de invocación solo repite ese mismo evento, no se emite aparte: queda anotado en
  // `detail.entities` del REPEATED de evento (misma evidencia, sin anomalía redundante). Con eventos distintos se emite el suyo.
  const dups = new Map([...group(items, (it) => it.key)].filter(([, g]) => g.length > 1).map(([k, g]) => [k, { items: g, entities: [] }]));
  const repeated = (list, scope, id, kind, who) => {
    if (list.length < 2) return;
    const d = list.every((it) => it.key === list[0].key) && dups.get(list[0].key);
    if (d) d.entities.push({ scope, kind, ...who });
    else anomaly('REPEATED', scope, id, list.map((it) => it.ref), { kind });
  };

  // Invocaciones y C4: (session_id[, source_id], tool_use_id) sin contexto en la clave.
  const inv = group(items.filter((it) => it.e.tool_use_id != null && TOOL_EVENTS.has(it.e.event)), (it) => it.e.tool_use_id);
  const conflicted = new Set();
  for (const [tuid, its] of [...inv].sort((a, b) => lt(a[0], b[0]))) {
    const ctx = sorted(new Set(its.map((it) => it.e.agent_id ?? '')));
    const conflict = ctx.length > 1;
    if (conflict) {
      its.forEach((it) => conflicted.add(it));
      model.counts.context_conflicts++;
    }
    const pre = its.filter((it) => it.e.event === 'PreToolUse');
    const closes = its.filter((it) => it.e.event !== 'PreToolUse');
    const names = sorted(new Set(its.map((it) => it.e.tool_name).filter((n) => n != null)));
    const id = { ...where, tool_use_id: tuid };
    const refs = (a) => a.map((it) => it.ref);
    model.invocations.push({
      ...id, tool_names: names, pre: refs(pre), closes: refs(closes), conflict,
      contexts: ctx.map((a) => (a === '' ? { kind: 'MAIN', evidence: 'INFERRED' } : { kind: 'AGENT', agent_id: a, evidence: 'OBSERVED' })),
    });
    if (conflict) anomaly('CONTEXT_CONFLICT', 'invocation', id, refs(its), { contexts: ctx.map((a) => a || null) });
    repeated(pre, 'invocation', id, 'pre', { tool_use_id: tuid });
    repeated(closes, 'invocation', id, 'close', { tool_use_id: tuid });
    if (pre.length && !closes.length) anomaly('SOLO_START', 'invocation', id, refs(pre));
    if (closes.length && !pre.length) anomaly('SOLO_STOP', 'invocation', id, refs(closes));
    if (pre.length && closes.length && closes[0].t < pre[pre.length - 1].t) anomaly('NEGATIVE_INTERVAL', 'invocation', id, refs(its));
    if (names.length > 1) anomaly('ATTR_CONFLICT', 'invocation', id, refs(its), { attribute: 'tool_name', values: names });
  }

  // Atribución: cada evento va a exactamente una categoría.
  const agents = new Map();
  const mainEvents = [];
  const unknownIn = (it, cause) => {
    model.unknown.push({ ...where, ...it.ref, causes: [cause] });
    return 'UNKNOWN';
  };
  for (const it of items) {
    const { e } = it;
    let cat;
    if (e.event === 'SessionStart' || e.event === 'SessionEnd') cat = 'SESSION';
    else {
      if (conflicted.has(it)) cat = unknownIn(it, 'CONTEXT_CONFLICT');
      else if ((e.event === 'SubagentStart' || e.event === 'SubagentStop') && e.agent_id == null) cat = unknownIn(it, 'MISSING_AGENT_ID');
      else if (e.agent_id != null) {
        cat = 'AGENT';
        // El agente solo existe (y solo recibe atributos, contador y primera evidencia) con eventos no conflictivos.
        if (!agents.has(e.agent_id)) agents.set(e.agent_id, { types: new Set(), starts: [], stops: [], events: [], first: it, n: 0 });
        const a = agents.get(e.agent_id);
        a.n++;
        if (e.agent_type != null) a.types.add(e.agent_type);
        a.events.push(it);
        if (e.event === 'SubagentStart') a.starts.push(it);
        if (e.event === 'SubagentStop') a.stops.push(it);
      } else { cat = 'MAIN'; mainEvents.push(it); }
    }
    model.counts.attributed[cat]++;
  }
  // MAIN solo existe si hay evidencia ordinaria sin agent_id y sin conflicto; SessionStart no basta.
  if (mainEvents.length) session.mains.push({ source_id: src, evidence: 'INFERRED', events: mainEvents.map((it) => it.ref) });

  const refs = (a) => a.map((it) => it.ref);
  for (const [aid, a] of [...agents].sort((x, y) => lt(x[0], y[0]))) {
    const id = { ...where, agent_id: aid };
    const ok = a.starts.length === 1 && a.stops.length === 1 && a.stops[0].t >= a.starts[0].t;
    const dur = ok ? a.stops[0].t - a.starts[0].t : null;
    model.agents.push({
      ...id, evidence: 'OBSERVED', agent_types: sorted(a.types), starts: refs(a.starts), stops: refs(a.stops), events: refs(a.events),
      duration_ticks: dur === null ? null : String(dur), duration_ms: dur === null ? null : Number(dur) / Number(TICKS_PER_MS),
    });
    repeated(a.starts, 'agent', id, 'start', { agent_id: aid });
    repeated(a.stops, 'agent', id, 'stop', { agent_id: aid });
    if (a.starts.length && !a.stops.length) anomaly('SOLO_START', 'agent', id, refs(a.starts));
    if (a.stops.length && !a.starts.length) anomaly('SOLO_STOP', 'agent', id, refs(a.stops));
    if (a.starts.length && a.stops.length && a.stops[0].t < a.starts[a.starts.length - 1].t) anomaly('NEGATIVE_INTERVAL', 'agent', id, refs([...a.starts, ...a.stops]));
    if (a.types.size > 1) anomaly('ATTR_CONFLICT', 'agent', id, refs(a.events), { attribute: 'agent_type', values: sorted(a.types) });
    model.relations.push({ kind: 'SESSION_AGENT', evidence: 'OBSERVED', ...id, first: a.first.ref, events: a.n });
  }

  // Padre-hijo: siempre INFERRED o UNKNOWN, nunca OBSERVED. Candidato único en ambos sentidos.
  const launchers = items.filter((it) => it.e.event === 'PreToolUse' && it.e.tool_name === 'Agent');
  const starts = items.filter((it) => it.e.event === 'SubagentStart');
  const near = (a, b) => absDiff(a.t, b.t) <= WINDOW_TICKS;
  for (const [aid, a] of [...agents].sort((x, y) => lt(x[0], y[0]))) {
    if (!a.starts.length) continue;
    const base = { kind: 'PARENT_CHILD', ...where, child: { kind: 'AGENT', agent_id: aid, evidence: 'OBSERVED' } };
    if (a.starts.length > 1) {
      model.relations.push({ ...base, evidence: 'UNKNOWN', parent: null, launcher: null, child_start: null, delta_ticks: null,
        delta_ms: null, window_ms: LAUNCH_WINDOW_MS, candidates: null, causes: ['REPEATED_START'] });
      continue;
    }
    const s = a.starts[0];
    const cands = launchers.filter((l) => (l.e.agent_id !== aid || conflicted.has(l)) && near(l, s)); // autolanzamientos (contexto conocido) fuera antes de contar
    const causes = [];
    let l = null;
    if (!cands.length) causes.push('NO_CANDIDATE');
    else if (cands.length > 1) causes.push('MULTIPLE_LAUNCHERS');
    else l = cands[0];
    if (cands.some((c) => conflicted.has(c))) causes.push('CONTEXT_CONFLICT'); // los no limpios también bloquean
    let kids = 0;
    if (l) {
      if (conflicted.has(l)) causes.push('LAUNCHER_CONTEXT_UNKNOWN');
      kids = starts.filter((o) => (l.e.agent_id == null || o.e.agent_id !== l.e.agent_id) && near(l, o)).length;
      if (kids > 1) causes.push('MULTIPLE_CHILDREN');
    }
    const inferred = causes.length === 0;
    const delta = l ? absDiff(l.t, s.t) : null;
    model.relations.push({
      ...base, evidence: inferred ? 'INFERRED' : 'UNKNOWN',
      parent: !inferred ? null : l.e.agent_id == null ? { kind: 'MAIN', evidence: 'INFERRED' } : { kind: 'AGENT', agent_id: l.e.agent_id, evidence: 'OBSERVED' },
      launcher: l ? { ...l.ref, tool_use_id: l.e.tool_use_id ?? null, context: l.e.agent_id == null ? 'MAIN' : l.e.agent_id } : null,
      child_start: s.ref,
      delta_ticks: delta === null ? null : String(delta), delta_ms: delta === null ? null : Number(delta) / Number(TICKS_PER_MS),
      window_ms: LAUNCH_WINDOW_MS, candidates: { launchers: cands.length, children: kids }, causes,
    });
  }
  for (const [, d] of dups) {
    anomaly('REPEATED', 'event', where, d.items.map((it) => it.ref), { kind: 'exact_duplicate', event: d.items[0].e.event, entities: d.entities });
  }
  // shortcut: el cruce lanzador/hijo es cuadrático por partición; optimizar con índice temporal si crecen las sesiones.
}

// Adaptador de solo lectura sobre la tabla `event` de H1.
export function loadModel(db) {
  // SELECT *: la comparación de duplicados exactos necesita todas las columnas de H1.
  const rows = db.prepare('SELECT * FROM event ORDER BY timestamp, source_id, byte_offset').all();
  return buildModel(rows);
}
