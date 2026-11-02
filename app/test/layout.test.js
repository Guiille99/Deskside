// Fase 5: colocación de mesas (src/layout.ts, cargado con la eliminación de tipos de Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, POD_W, GAP, PAD, LABEL, SEAT, COLS } from '../src/layout.ts';

const s = (sid, first, state = 'IDLE') => [`s:${sid}`, { kind: 'session', session_id: sid, state, first }];
const a = (sid, id, first, evidence = 'INFERRED', state = 'WORKING') => [`a:${sid}:h:${id}`, { kind: 'agent', session_id: sid, agent_id: id, state, first, evidence }];

test('layout: MAIN primero, agentes por llegada, visitantes al final y terminados fuera', () => {
  const rows = Object.fromEntries([
    s('B', 50), s('A', 10),
    a('A', 'v', 11, 'UNKNOWN'), a('A', 'x', 30), a('A', 'y', 20), a('A', 'z', 15, 'INFERRED', 'ENDED'),
    a('B', 'w', null),
  ]);
  const L = layout(rows, 2 * (POD_W + GAP) + GAP);
  assert.deepEqual(L.pods.map((p) => p.session_id), ['A', 'B']);
  const seat = (k) => L.seats.get(k);
  assert.deepEqual(seat('s:A'), { x: GAP + PAD, y: GAP + LABEL });
  assert.equal(seat('a:A:h:y').x, GAP + PAD + SEAT);
  assert.equal(seat('a:A:h:x').x, GAP + PAD + 2 * SEAT);
  assert.equal(seat('a:A:h:v').x, GAP + PAD + 3 * SEAT);
  assert.equal(seat('a:A:h:z'), undefined);
  assert.equal(seat('s:B').x, 2 * GAP + POD_W + PAD); // segunda isla a la derecha
});

test('layout: más de COLS mesas crecen hacia abajo y las islas saltan de fila según el ancho', () => {
  const rows = Object.fromEntries([s('A', 1), ...Array.from({ length: COLS }, (_, i) => a('A', `g${i}`, 2 + i)), s('B', 100)]);
  const L = layout(rows, POD_W + 2 * GAP); // una isla por fila
  const [A, B] = L.pods;
  assert.equal(A.h, LABEL + 2 * SEAT + PAD);
  assert.deepEqual(L.seats.get(`a:A:h:g${COLS - 1}`), { x: GAP + PAD, y: GAP + LABEL + SEAT });
  assert.deepEqual([B.x, B.y], [GAP, GAP + A.h + GAP]);
  assert.equal(L.height, B.y + B.h + GAP);
  assert.deepEqual(layout({}, 10).pods, []);
});
