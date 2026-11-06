// Paridad con backend/tools/audit-log.ps1 -Schema Nuevo, ejecutado solo sobre fixtures sintéticos.
// Se omite si no hay Windows PowerShell (powershell.exe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateLine } from '../src/validator.js';
import { openDatabase } from '../src/schema.js';
import { ingest } from '../src/ingest.js';
import { CASES, BLANK } from './fixtures/cases.js';

const AUDITOR = fileURLToPath(new URL('../tools/audit-log.ps1', import.meta.url));
const T0F = fileURLToPath(new URL('./fixtures/t0f.jsonl', import.meta.url));
const hasPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status === 0;
// Se omiten sin powershell.exe o sin el auditor (por si se ejecuta fuera del repositorio completo); el motivo sale en el informe de node:test.
const SKIP = !hasPowerShell ? 'requiere powershell.exe (Windows PowerShell 5.1)' : !existsSync(AUDITOR) ? 'falta backend/tools/audit-log.ps1' : false;

// Casos en los que el auditor acepta y el validador JS rechaza (documentados en backend/README.md).
const KNOWN_DIFFERENCES = ['evento-guion-blando-escapado', 'evento-guion-blando-literal', 'evento-zwj-escapado',
  'comillas-simples-valor', 'nbsp-inicial', 'nel-entre-tokens', 'ceros-izquierda', 'mas-inicial'];

function audit(path) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUDITOR, '-Path', path, '-Schema', 'Nuevo'], { encoding: 'utf8' });
  const flagged = new Set([...r.stdout.matchAll(/^L(\d+) \|/gm)].map((m) => Number(m[1])));
  return { exit: r.status, stdout: r.stdout, flagged };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-h1-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('T0-F con el auditor: incidencias=9, exit 1 y recuento por evento de la rev3', { skip: SKIP }, () => {
  const r = audit(T0F);
  assert.equal(r.exit, 1);
  assert.match(r.stdout, /ESQUEMA=Nuevo lineas=9 incidencias=9/);
  for (const kv of ['PostToolUse=1', 'PreToolUse=1', 'SessionEnd=1', 'SessionStart=1', 'Stop=3', 'UserPromptSubmit=1']) assert.match(r.stdout, new RegExp(`^  ${kv}\\r?$`, 'm'));
  assert.match(r.stdout, /L5 \| SessionEnd \| clave desconocida de 6 caracteres/);
  assert.deepEqual([...r.flagged].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test('aceptar/rechazar coincide con el auditor salvo las diferencias documentadas', { skip: SKIP }, (t) => {
  const dir = tempDir(t);
  const lines = [...CASES.map((c) => c.line), ...BLANK];
  const path = join(dir, 'cases.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  const { flagged } = audit(path);
  const diffs = [];
  lines.forEach((line, i) => {
    const name = CASES[i]?.name ?? `blanca-${i}`;
    const auditorRejects = flagged.has(i + 1);
    const jsRejects = i < CASES.length ? !validateLine(line).ok : false;
    if (auditorRejects !== jsRejects) diffs.push(`${name}:${auditorRejects ? 'auditor-rechaza' : 'auditor-acepta'}`);
  });
  assert.deepEqual(diffs, KNOWN_DIFFERENCES.map((n) => `${n}:auditor-acepta`));
});

test('BOM inicial, CRLF y líneas en blanco: el auditor da exit 0 y el ingestor lo ingiere todo', { skip: SKIP }, (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'crlf-bom.jsonl');
  const ok = CASES.filter((c) => c.code === null && !KNOWN_DIFFERENCES.includes(c.name)).map((c) => c.line);
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([...ok, ...BLANK].join('\r\n') + '\r\n')]));
  const r = audit(path);
  assert.equal(r.exit, 0, r.stdout);
  const db = openDatabase(':memory:');
  const res = ingest(db, { sourceId: 'paridad', path });
  db.close();
  assert.deepEqual([res.events, res.rejects, res.blank], [ok.length, 0, BLANK.length]);
});
