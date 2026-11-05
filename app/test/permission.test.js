// Globo «esperando permiso» (src/permission.ts, cargado con la eliminación de tipos de Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionText } from '../src/permission.ts';

test('permissionText: sin since, segundos, minutos y horas', () => {
  const now = 10_000_000;
  assert.equal(permissionText(null, now), '?');
  assert.equal(permissionText(now - 42_000, now), '? 42 s');
  assert.equal(permissionText(now - 3 * 60_000 - 5_000, now), '? 3 min');
  assert.equal(permissionText(now - 2 * 3_600_000, now), '? 2 h');
  assert.equal(permissionText(now + 5_000, now), '? 0 s'); // reloj desfasado: nunca negativo
});
