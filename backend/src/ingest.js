import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { validateLine, isBlankLine, ALL_FIELDS, RE } from './validator.js';

// Errores con código fijo y sin causa adjunta: nunca arrastran mensajes originales ni contenido.
export class IngestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IngestError';
    this.code = code;
  }
}

const NL = 0x0a;
const CR = 0x0d;
const BOM = [0xef, 0xbb, 0xbf];
// ignoreBOM: un BOM fuera del inicio del archivo se conserva y hace fallar el JSON.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Ingiere de forma incremental la fuente `sourceId` (identificador lógico estable) leyendo `path`.
// Cada lote (como mucho `batchLines` líneas o `batchBytes` bytes) es una transacción BEGIN IMMEDIATE:
// eventos, rechazos y cursor se confirman o se revierten juntos. Una línea sin \n final no se toca.
export function ingest(db, { sourceId, path, batchLines = 1000, batchBytes = 1 << 20 }) {
  if (typeof sourceId !== 'string' || !RE.id.test(sourceId)) throw new IngestError('INVALID_SOURCE_ID');
  let fd;
  try { fd = openSync(path, 'r'); } catch { throw new IngestError('SOURCE_UNREADABLE'); }

  const sql = {
    getCursor: db.prepare('SELECT file_identity, byte_offset FROM ingest_cursor WHERE source_id = ?'),
    newCursor: db.prepare('INSERT INTO ingest_cursor (source_id, file_identity, byte_offset) VALUES (?, ?, 0)'),
    setCursor: db.prepare('UPDATE ingest_cursor SET byte_offset = ? WHERE source_id = ?'),
    reject: db.prepare('INSERT INTO ingest_reject (source_id, byte_offset, code) VALUES (?, ?, ?)'),
    event: db.prepare(`INSERT INTO event (source_id, byte_offset, ${ALL_FIELDS.join(', ')})
      VALUES (?, ?, ${ALL_FIELDS.map(() => '?').join(', ')})`),
  };
  const totals = { events: 0, rejects: 0, blank: 0, batches: 0 };
  try {
    while (runBatch(db, sql, fd, sourceId, batchLines, batchBytes, totals) > 0) totals.batches++;
  } finally {
    closeSync(fd);
  }
  return totals;
}

function runBatch(db, sql, fd, sourceId, batchLines, batchBytes, totals) {
  const counts = { events: 0, rejects: 0, blank: 0 };
  let lines = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const st = fstatSync(fd, { bigint: true });
    const identity = `${st.dev}:${st.ino}`;
    const size = Number(st.size);
    let cur = sql.getCursor.get(sourceId);
    if (!cur) {
      sql.newCursor.run(sourceId, identity);
      cur = { file_identity: identity, byte_offset: 0 };
    }
    // Sin recuperación automática: el archivo físico debe ser el mismo y no haber encogido.
    if (cur.file_identity !== identity) throw new IngestError('SOURCE_REPLACED');
    const offset = cur.byte_offset;
    if (size < offset) throw new IngestError('SOURCE_TRUNCATED');
    if (offset > 0 && readBytes(fd, offset - 1, 1)[0] !== NL) throw new IngestError('SOURCE_TRUNCATED');

    let pos = offset;
    if (pos === 0 && size >= 3 && readBytes(fd, 0, 3).every((b, i) => b === BOM[i])) pos = 3;
    const buf = readBytes(fd, pos, Math.min(batchBytes, size - pos));

    let start = 0;
    while (lines < batchLines) {
      const nl = buf.indexOf(NL, start);
      if (nl < 0) break;
      handleLine(sql, sourceId, buf.subarray(start, nl), pos + start, counts);
      lines++;
      start = nl + 1;
    }
    if (lines === 0 && buf.length === batchBytes) {
      // Línea más larga que el lote: se rechaza sin leerla entera, pero solo cuando ya está completa.
      const end = findNewline(fd, pos + buf.length, size);
      if (end >= 0) {
        sql.reject.run(sourceId, pos, 'line_too_long');
        counts.rejects++;
        lines = 1;
        start = end + 1 - pos;
      }
    }
    if (lines > 0) sql.setCursor.run(pos + start, sourceId);
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e instanceof IngestError ? e : new IngestError('INGEST_FAILED');
  }
  totals.events += counts.events;
  totals.rejects += counts.rejects;
  totals.blank += counts.blank;
  return lines;
}

function handleLine(sql, sourceId, bytes, offset, counts) {
  const body = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.subarray(0, -1) : bytes;
  let text;
  try { text = utf8.decode(body); } catch { text = null; }
  const result = text === null ? { ok: false, code: 'invalid_utf8' } : isBlankLine(text) ? null : validateLine(text);
  if (result === null) { counts.blank++; return; }
  if (!result.ok) { sql.reject.run(sourceId, offset, result.code); counts.rejects++; return; }
  const ev = result.event;
  sql.event.run(sourceId, offset, ...ALL_FIELDS.map((k) => (typeof ev[k] === 'boolean' ? Number(ev[k]) : ev[k] ?? null)));
  counts.events++;
}

function readBytes(fd, position, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function findNewline(fd, from, size) {
  for (let p = from; p < size; p += 1 << 16) {
    const i = readBytes(fd, p, Math.min(1 << 16, size - p)).indexOf(NL);
    if (i >= 0) return p + i;
  }
  return -1;
}
