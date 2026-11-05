// Fases 5 y 6: colocación de mesas y salas (src/layout.ts, cargado con la eliminación de tipos de Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, office, route, spots, place, BLOCK, SEATS, ROOMS, ROOM_H, ROOM_W, WALL, GAP, SEAT, AISLE, BLOCK_C, BLOCK_R } from '../src/layout.ts';

const s = (sid, first, state = 'IDLE') => [`s:${sid}`, { kind: 'session', session_id: sid, state, first }];
const a = (sid, id, first, evidence = 'INFERRED', state = 'WORKING') => [`a:${sid}:h:${id}`, { kind: 'agent', session_id: sid, agent_id: id, state, first, evidence }];

const W2 = 2 * GAP + 2 * (BLOCK_C * SEAT) + AISLE; // dos bloques por fila, sin margen sobrante

test('layout: bloques con pasillos; por sesión (llegada), MAIN, hijos por llegada y visitantes; terminados fuera', () => {
  const rows = Object.fromEntries([
    s('B', 50), s('A', 10),
    a('A', 'v', 11, 'UNKNOWN'), a('A', 'x', 30), a('A', 'y', 20), a('A', 'z', 15, 'INFERRED', 'ENDED'),
    a('B', 'w', null),
  ]);
  const L = layout(rows, W2);
  assert.deepEqual([...L.seatOf], [['s:A', 0], ['a:A:h:y', 1], ['a:A:h:x', 2], ['a:A:h:v', 3], ['s:B', 4], ['a:B:h:w', 5]]);
  assert.deepEqual(L.seats.get('s:A'), { x: GAP, y: GAP });
  assert.deepEqual(L.seats.get('a:A:h:v'), { x: GAP, y: GAP + SEAT }); // segunda fila del bloque
  assert.equal(L.seats.get('a:A:h:z'), undefined);
  assert.equal(L.desks.length, 2 * BLOCK_C * BLOCK_R); // una fila completa de bloques, también las mesas libres
  assert.deepEqual(L.desks[BLOCK_C * BLOCK_R], { x: GAP + BLOCK_C * SEAT + AISLE, y: GAP }); // segundo bloque tras el pasillo
  assert.equal(L.height, GAP + BLOCK_R * SEAT + GAP);
  assert.deepEqual(layout({}, W2 + 10).desks[0], { x: GAP + 4, y: GAP }); // centrado
});

test('layout: cada uno conserva su puesto; los nuevos ocupan el hueco más cercano a su MAIN', () => {
  const rows = Object.fromEntries([s('A', 1), ...Array.from({ length: 4 }, (_, i) => a('A', 'g' + i, 2 + i))]);
  const L1 = layout(rows, W2);
  const rows2 = { ...rows, 'a:A:h:g0': { ...rows['a:A:h:g0'], state: 'ENDED' } };
  const L2 = layout(rows2, W2, L1.seatOf);
  assert.equal(L2.seatOf.get('a:A:h:g3'), L1.seatOf.get('a:A:h:g3')); // nadie se mueve al irse otro
  const L3 = layout(Object.fromEntries([...Object.entries(rows2), a('A', 'n', 99)]), W2, L2.seatOf);
  assert.equal(L3.seatOf.get('a:A:h:n'), 1); // el hueco que dejó g0, junto al MAIN
  // Más puestos que una fila de bloques: se añade otra fila completa.
  const many = Object.fromEntries([s('A', 1), ...Array.from({ length: 12 }, (_, i) => a('A', 'm' + i, 2 + i))]);
  const L4 = layout(many, W2);
  assert.equal(L4.desks.length, 4 * BLOCK_C * BLOCK_R);
  assert.equal(L4.height, GAP + 2 * (BLOCK_R * SEAT) + AISLE + GAP);
  assert.equal(layout({}, 10).seats.size, 0);
});

test('office: mesa si trabaja o espera permiso, reuniones si la sesión espera prompt, cafetería, descanso y fuera si termina', () => {
  const rows = Object.fromEntries([
    s('A', 1, 'IDLE'), a('A', 'w', 2, 'INFERRED', 'WORKING'), a('A', 'p', 3, 'INFERRED', 'PERMISSION'),
    a('A', 'i', 4, 'INFERRED', 'IDLE'), a('A', 'z', 5, 'UNKNOWN', 'STALE'), a('A', 'e', 6, 'INFERRED', 'ENDED'),
  ]);
  const W = office(rows, 1200);
  const t = (k) => W.targets.get(k);
  assert.deepEqual(['s:A', 'a:A:h:w', 'a:A:h:p', 'a:A:h:i', 'a:A:h:z'].map((k) => t(k).zone), ['meeting', 'desks', 'desks', 'cafe', 'lounge']);
  assert.equal(t('a:A:h:e'), undefined);
  assert.ok(t('a:A:h:w').seated && !t('a:A:h:w').seat && !t('a:A:h:i').seated);
  assert.equal(t('s:A').seat, 'behind'); // primera plaza de la sala de reuniones
  assert.equal(t('a:A:h:w').y, W.seats.get('a:A:h:w').y + 44);
  assert.equal(W.seats.get('s:A').y, GAP + WALL); // bajo la pared (en x, centrada)
  assert.equal(W.seats.has('s:A'), true); // la mesa se queda reservada mientras está fuera
  // Toda salida termina en el pasillo; la ruta entre zonas pasa por él y dentro de la misma zona va recta.
  for (const v of W.targets.values()) assert.equal(v.exit.at(-1).x, W.corridorX);
  assert.deepEqual(route(t('a:A:h:w'), t('a:A:h:p')), [t('a:A:h:p')]);
  const r = route(t('a:A:h:w'), t('s:A'));
  assert.deepEqual(r.slice(0, 2).map((p) => p.x), [W.corridorX, W.corridorX]);
  assert.equal(r.at(-1), t('s:A'));
  assert.ok(W.width <= 1200 && W.rooms.cafe.x === W.workW + 56);
});

test('office: los huecos de las salas no pisan los muebles y caben en la sala', () => {
  for (const room of ROOMS) {
    const b = BLOCK[room];
    assert.ok(spots(room).length + SEATS[room].length >= 20, room); // de pie y sentados
    for (const p of spots(room)) {
      assert.ok(p.x >= 16 && p.x <= ROOM_W - 16, room);
      if (b) assert.ok(!(p.x + 16 > b[0] && p.x - 16 < b[0] + b[2] && p.y > b[1] && p.y - 12 < b[1] + b[3]), room);
    }
  }
  // Más gente que huecos: se reparten sin error.
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => a('A', `c${i}`, i, 'INFERRED', 'IDLE')));
  assert.equal([...office(many, 800).targets.values()].filter((v) => v.zone === 'cafe').length, 60);
  assert.equal(place({ kind: 'session', state: 'PERMISSION' }), 'desk');
  assert.equal(place({ kind: 'session', state: 'ERROR' }), 'desk');
});

test('office: en las salas se ocupan antes las plazas sentadas, que no pisan muebles, huecos ni otras plazas', () => {
  for (const room of ROOMS) {
    const b = BLOCK[room], seats = SEATS[room];
    for (const p of seats) {
      assert.ok(p.x >= 16 && p.x <= ROOM_W - 16 && p.y <= ROOM_H - 8, room);
      // Los pies no caen sobre el mueble (los de detrás de la mesa, como mucho 6 px por debajo de su borde superior).
      if (b) assert.ok(!(p.x > b[0] && p.x < b[0] + b[2] && p.y > b[1] + 6 && p.y < b[1] + b[3]), `${room} ${p.x},${p.y}`);
      for (const q of spots(room)) assert.ok(Math.abs(p.x - q.x) >= 32 || Math.abs(p.y - q.y) >= 36, room);
      for (const q of seats) if (q !== p) assert.ok(Math.abs(p.x - q.x) >= 32 || Math.abs(p.y - q.y) >= 26, room);
    }
  }
  assert.ok(SEATS.meeting.length >= 6 && SEATS.lounge.length >= 2 && SEATS.cafe.length === 0);
  // Ocho sesiones inactivas: las seis primeras (por llegada) sentadas en orden, el resto de pie en los huecos.
  const rows = Object.fromEntries(Array.from({ length: 8 }, (_, i) => s(`S${i}`, i)));
  const W = office(rows, 1200), R = W.rooms.meeting;
  const ts = Object.keys(rows).map((k) => W.targets.get(k));
  assert.deepEqual(ts.slice(0, 6).map((t) => [t.x - R.x, t.y - R.y, t.seat]), SEATS.meeting.map((p) => [p.x, p.y, p.seat]));
  assert.ok(ts.slice(0, 6).every((t) => t.seated) && ts.slice(6).every((t) => !t.seated && !t.seat));
  assert.deepEqual([ts[6].x - R.x, ts[6].y - R.y], [spots('meeting')[0].x, spots('meeting')[0].y]);
  // En el descanso, dos en el sofá y el tercero de pie.
  const st = Object.fromEntries(Array.from({ length: 3 }, (_, i) => a('A', `z${i}`, i, 'INFERRED', 'STALE')));
  assert.deepEqual([...office(st, 1200).targets.values()].map((t) => t.seat ?? null), ['front', 'front', null]);
});

test('art-seats: todas las filas de cada sprite tienen el mismo ancho y solo usan claves de la paleta', async () => {
  const { SEATED, SEAT_SPRITES } = await import('../src/art-seats.ts');
  const { PALETTE } = await import('../src/art.ts');
  for (const [k, rows] of Object.entries({ ...SEATED, ...SEAT_SPRITES })) {
    assert.ok(rows.every((r) => r.length === rows[0].length), k);
    assert.ok([...rows.join('')].every((c) => c === '.' || c in PALETTE), k);
  }
});
