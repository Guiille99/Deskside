import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLine, isBlankLine, ALL_FIELDS, COMMON, EXTRA, REJECT_CODES } from '../src/validator.js';
import { CASES, BLANK, T0F_CODES, MARK } from './fixtures/cases.js';

test('cada caso sintético da el resultado esperado', () => {
  for (const c of CASES) {
    const r = validateLine(c.line);
    assert.equal(r.ok ? null : r.code, c.code, c.name);
  }
});

test('T0-F de la rev3: L1 válida y L2..L9 rechazadas con su código', () => {
  // Acepta CRLF: si git convierte el fixture en Windows, cada línea llegaría con \r al final
  const lines = readFileSync(new URL('./fixtures/t0f.jsonl', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 9);
  assert.deepEqual(lines.map((l) => { const r = validateLine(l); return r.ok ? null : r.code; }), T0F_CODES);
});

test('el resultado solo contiene el evento validado o un código fijo, nunca contenido', () => {
  for (const c of CASES) {
    const r = validateLine(c.line);
    if (r.ok) {
      assert.deepEqual(Object.keys(r), ['ok', 'event'], c.name);
      assert.ok(Object.keys(r.event).every((k) => ALL_FIELDS.includes(k)), c.name);
    } else {
      assert.deepEqual(Object.keys(r), ['ok', 'code'], c.name);
      assert.ok(REJECT_CODES.includes(r.code), c.name);
    }
    assert.ok(!JSON.stringify(r).includes(MARK), c.name);
  }
});

test('el evento válido conserva los valores sin normalizar y omite los ausentes', () => {
  const r = validateLine('{"timestamp":"2026-10-31T10:00:00.0000000+00:00","event":"PostToolUse","session_id":"fixture-0001","tool_name":"Read","duration_ms":42}');
  assert.deepEqual(r.event, { timestamp: '2026-10-31T10:00:00.0000000+00:00', event: 'PostToolUse', session_id: 'fixture-0001', tool_name: 'Read', duration_ms: 42 });
  assert.ok(!('agent_id' in r.event));
});

test('el $ de JavaScript se comporta como \\z: un fin de línea final no casa', () => {
  const base = '{"timestamp":"2026-10-31T10:00:00.0000000+00:00","event":"Stop","session_id":"fixture-0001"}';
  assert.equal(validateLine(base).ok, true);
  for (const tail of ['\\n', '\\r', '\\r\\n', '\\u2028', '\\u2029', '\\u0085']) {
    assert.equal(validateLine(base.replace('fixture-0001', `fixture-0001${tail}`)).code, 'invalid_value', tail);
  }
});

test('saltos de línea crudos dentro de la línea se rechazan', () => {
  const base = '{"timestamp":"2026-10-31T10:00:00.0000000+00:00","event":"Stop","session_id":"fixture-0001"}';
  assert.equal(validateLine(base.replace(',', ',\r')).code, 'line_break');
  assert.equal(validateLine(base.replace(',', ',\n')).code, 'line_break');
});

test('líneas en blanco según Char.IsWhiteSpace de .NET', () => {
  for (const b of BLANK) assert.equal(isBlankLine(b), true, JSON.stringify(b));
  assert.equal(isBlankLine(String.fromCharCode(0xfeff)), false, 'U+FEFF no es espacio en .NET');
  assert.equal(isBlankLine('x'), false);
});

test('la lista blanca coincide con la sección 2 del protocolo', () => {
  assert.deepEqual(COMMON, ['timestamp', 'event', 'session_id', 'project_id', 'agent_id', 'agent_type', 'permission_mode']);
  assert.deepEqual(Object.keys(EXTRA).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse',
    'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
});
