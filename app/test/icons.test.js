// Iconos de herramienta: sprites rectangulares con claves de su paleta y categoría por nombre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICON_PALETTE, ICON_SPRITES, toolIcon } from '../src/art-icons.ts';

test('iconos: sprites rectangulares con claves de la paleta', () => {
  for (const c of Object.values(ICON_PALETTE)) assert.match(c, /^#[0-9a-f]{6}$/);
  for (const [name, rows] of Object.entries(ICON_SPRITES)) {
    assert.deepEqual([rows.length, rows[0].length], [14, 12], `${name}: tamaño`);
    assert.ok(rows.every((r) => r.length === rows[0].length), `${name}: ancho`);
    for (const r of rows) for (const ch of r) assert.ok(ch === '.' || ch in ICON_PALETTE, `${name}: clave ${ch}`);
  }
});

test('iconos: categoría por herramienta', () => {
  const want = { Read: 'read', Edit: 'edit', Bash: 'shell', PowerShell: 'shell', WebFetch: 'web', Agent: 'agent',
    Task: 'agent', mcp__x__y: 'mcp', Desconocida: 'other' };
  for (const [tool, cat] of Object.entries(want)) assert.equal(toolIcon(tool), cat, tool);
  assert.equal(toolIcon(null), null);
  assert.deepEqual(Object.keys(ICON_SPRITES).sort(), [...new Set(Object.values(want))].sort());
});
