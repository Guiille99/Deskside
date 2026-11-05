// Idea 2: accesorio sobre la cabeza según el tipo de agente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, CHAR } from '../src/art.ts';
import { ACCESSORIES, LIFT, accessory } from '../src/art-accessories.ts';

test('accesorios: rectangulares, del ancho de la cabeza y con claves de la paleta', () => {
  for (const [name, rows] of Object.entries(ACCESSORIES)) {
    assert.ok(rows.every((r) => r.length === CHAR[0][0].length), `${name}: ancho`);
    for (const r of rows) for (const ch of r) assert.ok(ch === '.' || ch in PALETTE, `${name}: clave ${ch}`);
    // No baja de la cabeza (filas 0-11).
    assert.ok(rows.length <= LIFT + 12, `${name}: alto`);
  }
});

test('accesorios: elección por tipo', () => {
  const ag = (...agent_types) => ({ kind: 'agent', agent_types });
  assert.equal(accessory({ kind: 'session' }), 'crown');
  assert.equal(accessory(ag('Explore')), 'cap');
  assert.equal(accessory(ag('Plan', 'Explore')), 'glasses');
  assert.equal(accessory(ag('general-purpose')), 'headphones');
  assert.equal(accessory(ag('mi-agente')), null);
  assert.equal(accessory(ag('toString')), null);
  assert.equal(accessory(ag()), null);
  for (const t of ['Explore', 'Plan', 'general-purpose']) assert.ok(accessory(ag(t)) in ACCESSORIES);
});
