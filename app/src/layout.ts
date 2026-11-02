// Fase 5: colocación de mesas, pura (sin Phaser) para poder probarla con node --test.
import type { Row } from './types.ts';

export const SEAT = 64, COLS = 4, PAD = 16, LABEL = 20, GAP = 16;
export const POD_W = COLS * SEAT + 2 * PAD;
export type Pod = { session_id: string; x: number; y: number; h: number };
export type Layout = { pods: Pod[]; seats: Map<string, { x: number; y: number }>; height: number };

// Por llegada (primer evento); sin fecha al final; la clave desempata para que el orden sea estable.
const byFirst = (a: [string, Row], b: [string, Row]) =>
  (a[1].first ?? Infinity) - (b[1].first ?? Infinity) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const rank = (r: Row) => (r.kind === 'session' ? 0 : r.evidence === 'INFERRED' ? 1 : 2);

// Una isla por sesión: MAIN en la primera mesa, después sus agentes por llegada y al final los visitantes (sin padre inferido).
// Los terminados no ocupan mesa. Las islas fluyen de izquierda a derecha según el ancho disponible.
export function layout(rows: Record<string, Row>, width: number): Layout {
  const groups = new Map<string, [string, Row][]>();
  for (const e of Object.entries(rows).sort(byFirst)) {
    if (e[1].state === 'ENDED') continue;
    const g = groups.get(e[1].session_id) ?? [];
    g.push(e);
    groups.set(e[1].session_id, g);
  }
  const perRow = Math.max(1, Math.floor((width - GAP) / (POD_W + GAP)));
  const pods: Pod[] = [];
  const seats = new Map<string, { x: number; y: number }>();
  let x = GAP, y = GAP, rowH = 0, i = 0;
  for (const [sid, g] of groups) {
    if (i > 0 && i % perRow === 0) { x = GAP; y += rowH + GAP; rowH = 0; }
    g.sort((a, b) => rank(a[1]) - rank(b[1])); // sort estable: conserva el orden por llegada dentro de cada rango
    const h = LABEL + Math.ceil(g.length / COLS) * SEAT + PAD;
    pods.push({ session_id: sid, x, y, h });
    g.forEach(([k], j) => seats.set(k, { x: x + PAD + (j % COLS) * SEAT, y: y + LABEL + Math.floor(j / COLS) * SEAT }));
    x += POD_W + GAP;
    rowH = Math.max(rowH, h);
    i++;
  }
  return { pods, seats, height: y + rowH + GAP };
}
