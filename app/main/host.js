// utilityProcess que ejecuta el servicio del backend y envía al proceso principal solo deltas de filas.
import { startService } from '../../backend/src/service.js';
import { presence } from '../../backend/src/presence.js';
import { toRows, diff } from './rows.js';

const REFRESH_MS = 15000; // las caducidades de presence dependen de la hora, no solo de los eventos
const post = (m) => process.parentPort.postMessage(m);
let model = null;
let rows = {};

const push = () => {
  if (!model) return;
  const next = toRows(presence(model, Date.now()), model);
  const d = diff(rows, next);
  rows = next;
  if (d.upsert.length || d.remove.length) post({ type: 'delta', delta: d });
};

startService({
  // sourceId 'global': 'hooks' era el registro de claude-office-test (otro archivo, otro cursor).
  dbPath: process.env.CO_DB, sourceId: 'global', path: process.env.CO_SOURCE,
  // shortcut: el error solo se limpia cuando llega un modelo nuevo; si se recupera sin eventos nuevos, el aviso sigue hasta el siguiente.
  onModel: (m) => { model = m; post({ type: 'status', code: null }); push(); },
  onError: (code) => post({ type: 'status', code }),
});
setInterval(push, REFRESH_MS);
