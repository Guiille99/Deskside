// Fase 6: los sprites son rectangulares y solo usan claves de la paleta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, CHAR, STAND, SPRITES, ROLES, SKINS, HAIRS, variant, charPalette } from '../src/art.ts';

const HEX = /^#[0-9a-f]{6}$/;

test('art: paleta válida y sprites rectangulares con claves de la paleta', () => {
  assert.ok(Object.keys(PALETTE).every((k) => k.length === 1 && k !== '.' && k !== ' '));
  for (const c of [...Object.values(PALETTE), ...Object.values(ROLES).flat(), ...SKINS.flat(), ...HAIRS.flat()]) assert.match(c, HEX);
  for (const [name, rows] of [...Object.entries(SPRITES), ...[...CHAR, ...STAND].map((r, i) => [`char${i}`, r])]) {
    assert.ok(rows.every((r) => r.length === rows[0].length), `${name}: ancho`);
    for (const r of rows) for (const ch of r) assert.ok(ch === '.' || ch in PALETTE, `${name}: clave ${ch}`);
  }
  assert.deepEqual([CHAR[0].length, CHAR[1].length, STAND[0].length, STAND[2].length, CHAR[0][0].length], [18, 18, 21, 21, 16]);
});

test('art: variante estable y dentro de rango', () => {
  const v = variant('a:s:h:x');
  assert.equal(variant('a:s:h:x'), v);
  const p = charPalette('visitor', v);
  assert.ok(SKINS.some(([s, S]) => p.s === s && p.S === S) && HAIRS.some(([h, H]) => p.h === h && p.H === H));
  assert.deepEqual([p.c, p.C], ROLES.visitor);
  assert.equal(p.d, PALETTE.d);
});
