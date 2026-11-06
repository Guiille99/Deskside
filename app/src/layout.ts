// Colocación de mesas, pura (sin Phaser) para poder probarla con node --test.
import type { Row } from './types.ts';

// Las mesas van en bloques de BLOCK_C × BLOCK_R puestos separados por pasillos de AISLE px.
export const SEAT = 64, GAP = 16, BLOCK_C = 3, BLOCK_R = 2, AISLE = 32;
type P = { x: number; y: number };
// seats: dónde se sienta cada uno. desks: todas las mesas (también las libres), en filas completas de bloques.
// seatOf: número de puesto de cada uno; se pasa a la siguiente llamada para que nadie cambie de mesa.
export type Layout = { seats: Map<string, P>; desks: P[]; height: number; seatOf: Map<string, number> };

// Por llegada (primer evento); sin fecha al final; la clave desempata para que el orden sea estable.
const byFirst = (a: [string, Row], b: [string, Row]) =>
  (a[1].first ?? Infinity) - (b[1].first ?? Infinity) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const rank = (r: Row) => (r.kind === 'session' ? 0 : r.evidence === 'INFERRED' ? 1 : 2);

// Una sola zona de mesas para todo el proyecto, en bloques con pasillos y centrada en el ancho. Cada uno conserva su
// puesto (prev) hasta que termina. Los nuevos, en orden por sesión (MAIN, hijos por llegada, visitantes), ocupan el puesto
// libre más cercano al de su MAIN; los puestos se llenan bloque a bloque, así un equipo queda junto.
export function layout(rows: Record<string, Row>, width: number, prev = new Map<string, number>()): Layout {
  const groups = new Map<string, [string, Row][]>();
  for (const e of Object.entries(rows).sort(byFirst)) {
    if (e[1].state === 'ENDED') continue;
    const g = groups.get(e[1].session_id) ?? [];
    g.push(e);
    groups.set(e[1].session_id, g);
  }
  const seatOf = new Map<string, number>();
  for (const g of groups.values()) for (const [k] of g) if (prev.has(k)) seatOf.set(k, prev.get(k)!);
  const used = new Set(seatOf.values());
  for (const [sid, g] of groups) {
    g.sort((a, b) => rank(a[1]) - rank(b[1])); // sort estable: conserva el orden por llegada dentro de cada rango
    for (const [k] of g) {
      if (seatOf.has(k)) continue;
      const t = seatOf.get(`s:${sid}`) ?? 0;
      let i = t;
      for (let d = 0; used.has(i); d++) i = !used.has(t + d) ? t + d : t - d >= 0 ? t - d : t + d;
      seatOf.set(k, i);
      used.add(i);
    }
  }
  const per = BLOCK_C * BLOCK_R, blockW = BLOCK_C * SEAT, blockH = BLOCK_R * SEAT;
  const perRow = Math.max(1, Math.floor((width - 2 * GAP + AISLE) / (blockW + AISLE)));
  const left = GAP + Math.floor((width - 2 * GAP - (perRow * (blockW + AISLE) - AISLE)) / 4) * 2; // centrado, en píxel par
  const at = (i: number): P => {
    const b = Math.floor(i / per), j = i % per;
    return { x: left + (b % perRow) * (blockW + AISLE) + (j % BLOCK_C) * SEAT,
      y: GAP + Math.floor(b / perRow) * (blockH + AISLE) + Math.floor(j / BLOCK_C) * SEAT };
  };
  const rowsOfBlocks = Math.max(1, Math.ceil((Math.max(-1, ...used) + 1) / (per * perRow)));
  return {
    seats: new Map([...seatOf].map(([k, i]) => [k, at(i)])),
    desks: Array.from({ length: rowsOfBlocks * per * perRow }, (_, i) => at(i)),
    height: GAP + rowsOfBlocks * (blockH + AISLE) - AISLE + GAP,
    seatOf,
  };
}

// La oficina de un proyecto. A la izquierda la zona de mesas (layout(), bajo una pared con estanterías);
// en medio un pasillo con la puerta de entrada arriba; a la derecha tres salas apiladas con la puerta hacia el pasillo.
export const WALL = 48, CORRIDOR = 56, ROOM_W = 304, ROOM_H = 216, ROOM_WALL = 56;
export type Room = 'cafe' | 'meeting' | 'lounge';
export const ROOMS: Room[] = ['cafe', 'meeting', 'lounge'];
export type Pt = { x: number; y: number };
// Pies del personaje y la ruta para salir hasta el pasillo (se recorre al revés para entrar).
// seat: pose de quien está sentado en una sala (behind = tras una mesa que tapa las piernas, como en las mesas de trabajo;
// left/right = de perfil mirando a ese lado). Sin seat y sentado: en su mesa de trabajo.
export type Seat = 'behind' | 'front' | 'back' | 'left' | 'right';
export type Target = Pt & { zone: string; seated: boolean; seat?: Seat; exit: Pt[] };
export type World = Layout & { width: number; workW: number; corridorX: number; door: Pt;
  rooms: Record<Room, Pt>; targets: Map<string, Target> };

// Muebles que ocupan suelo (x, y, ancho, alto, relativos a la sala): nadie se coloca encima.
export const BLOCK: Partial<Record<Room, [number, number, number, number]>> = { meeting: [96, 118, 112, 42], lounge: [120, 60, 64, 24] };

// Plazas sentadas (pies y pose, relativos a la sala); se ocupan en este orden antes que los huecos de pie. Reuniones: dos
// tras la mesa, una a cada lado y dos delante, de espaldas. Descanso: dos en el sofá. office.ts pone sillas en cada una.
export const SEATS: Record<Room, (Pt & { seat: Seat })[]> = {
  cafe: [],
  meeting: [{ x: 128, y: 122, seat: 'behind' }, { x: 176, y: 122, seat: 'behind' }, { x: 82, y: 150, seat: 'right' },
    { x: 222, y: 150, seat: 'left' }, { x: 128, y: 186, seat: 'back' }, { x: 176, y: 186, seat: 'back' }],
  lounge: [{ x: 136, y: 86, seat: 'front' }, { x: 168, y: 86, seat: 'front' }],
};

// Huecos donde ponerse de pie en cada sala, del centro hacia fuera (en la sala de reuniones quedan alrededor de la mesa),
// sin pisar los muebles ni a quien está sentado.
const SPOTS = Object.fromEntries(ROOMS.map((room) => {
  const b = BLOCK[room], out: Pt[] = [];
  for (let y = ROOM_WALL + 28; y <= ROOM_H - 12; y += 40) for (let x = 24; x <= ROOM_W - 24; x += 40) {
    if (b && x + 16 > b[0] && x - 16 < b[0] + b[2] && y > b[1] && y - 12 < b[1] + b[3]) continue;
    if (SEATS[room].some((s) => Math.abs(x - s.x) < 32 && Math.abs(y - s.y) < 36)) continue;
    out.push({ x, y });
  }
  const d = (p: Pt) => Math.hypot(p.x - ROOM_W / 2, p.y - (ROOM_WALL + ROOM_H) / 2);
  return [room, out.sort((a, b) => d(a) - d(b))];
})) as Record<Room, Pt[]>;
export const spots = (room: Room) => SPOTS[room];

// Dónde está cada uno según su estado. Una sesión inactiva espera el siguiente prompt: sala de reuniones.
// Con error se queda en su mesa, para que se vea dónde trabajaba.
export function place(r: Row): 'desk' | Room {
  if (r.state === 'WORKING' || r.state === 'PERMISSION' || r.state === 'ERROR') return 'desk';
  if (r.state === 'STALE') return 'lounge';
  return r.kind === 'session' ? 'meeting' : 'cafe';
}

export function office(rows: Record<string, Row>, width: number, prev?: Map<string, number>): World {
  const workW = Math.max(BLOCK_C * SEAT + 2 * GAP, width - CORRIDOR - ROOM_W - GAP);
  const L = layout(rows, workW, prev);
  const corridorX = workW + CORRIDOR / 2, roomX = workW + CORRIDOR;
  for (const s of [...L.seats.values(), ...L.desks]) s.y += WALL;
  const rooms = Object.fromEntries(ROOMS.map((r, i) => [r, { x: roomX, y: GAP + i * (ROOM_H + GAP) }])) as Record<Room, Pt>;
  const targets = new Map<string, Target>();
  const used: Record<Room, number> = { cafe: 0, meeting: 0, lounge: 0 };
  for (const [k, r] of Object.entries(rows).sort(byFirst)) {
    if (r.state === 'ENDED') continue;
    const p = place(r);
    if (p === 'desk') {
      const s = L.seats.get(k)!, y = s.y + 44;
      targets.set(k, { x: s.x + SEAT / 2, y, zone: 'desks', seated: true, exit: [{ x: corridorX, y }] });
      continue;
    }
    const R = rooms[p], doorY = R.y + ROOM_H - 28, exit = [{ x: R.x + 20, y: doorY }, { x: corridorX, y: doorY }];
    const seats = SEATS[p], i = used[p]++ - seats.length;
    if (i < 0) {
      const st = seats[i + seats.length];
      targets.set(k, { x: R.x + st.x, y: R.y + st.y, zone: p, seated: true, seat: st.seat, exit });
      continue;
    }
    // shortcut: si una sala se llena, los siguientes se apiñan con un pequeño desplazamiento; con cientos se solapan.
    const all = SPOTS[p], o = (Math.floor(i / all.length) % 4) * 6, at = all[i % all.length];
    targets.set(k, { x: R.x + at.x + o, y: R.y + at.y + o, zone: p, seated: false, exit });
  }
  const height = Math.max(L.height + WALL, GAP + ROOMS.length * (ROOM_H + GAP));
  return { ...L, height, width: roomX + ROOM_W + GAP, workW, corridorX, door: { x: corridorX, y: WALL }, rooms, targets };
}

// Camino entre dos sitios: dentro de la misma zona, recto; si no, sale al pasillo, lo recorre y entra por la otra puerta.
export function route(from: Pick<Target, 'zone' | 'exit'>, to: Target | (Pt & { zone: string; exit: Pt[] })): Pt[] {
  return from.zone === to.zone ? [to] : [...from.exit, ...[...to.exit].reverse(), to];
}
