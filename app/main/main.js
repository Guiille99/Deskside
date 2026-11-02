// Fase 4: proceso principal. Arranca el servicio en un utilityProcess, guarda el último estado (snapshot)
// y reenvía los deltas al renderer por IPC. Sin puerto local ni contenido remoto.
import { app, BrowserWindow, ipcMain, session, utilityProcess } from 'electron';
import { mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { applyDelta } from './rows.js';
import { listProjects, setPolicy } from './policy.js';

const here = import.meta.dirname;
const POLICY_DIR = join(app.getPath('appData'), 'ClaudeOffice');
// shortcut: ruta fija del hook de claude-office-test (la misma que capture-event.ps1); la Fase 7 (hooks globales) la sustituye.
const SOURCE = join(app.getPath('home'), 'Proyectos', 'Claude Office', 'claude-office-test', 'hooks-events.jsonl');

let win = null;
let rows = {};
let status = null; // código fijo de error del servicio o null
const send = (ch, data) => win?.webContents.send(ch, data);
const fromWin = (e) => e.sender === win?.webContents; // solo la ventana propia usa el IPC

function startHost() {
  const child = utilityProcess.fork(join(here, 'host.js'), [], {
    serviceName: 'claude-office-service',
    env: { ...process.env, CO_DB: join(app.getPath('userData'), 'claude-office.db'), CO_SOURCE: SOURCE },
  });
  child.on('message', (m) => {
    if (m.type === 'delta') { rows = applyDelta(rows, m.delta); send('delta', m.delta); }
    if (m.type === 'status' && m.code !== status) { status = m.code; send('status', status); }
  });
  child.on('exit', () => { status = 'SERVICE_EXITED'; send('status', status); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, title: 'Claude Office', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(join(here, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
}

// Una sola instancia: dos servicios ingiriendo el mismo JSONL en la misma BD no aportan nada.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => win?.focus());
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  ipcMain.handle('snapshot', (e) => (fromWin(e) ? { rows, status } : null));
  ipcMain.handle('projects', (e) => (fromWin(e) ? listProjects(POLICY_DIR) : []));
  ipcMain.handle('set-policy', (e, id, st) => {
    if (!fromWin(e)) return [];
    setPolicy(POLICY_DIR, id, st); // lanza INVALID_POLICY / UNKNOWN_PROJECT
    return listProjects(POLICY_DIR);
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    mkdirSync(POLICY_DIR, { recursive: true });
    let t = null; // los pendientes nuevos los crea el hook: se avisa al renderer sin sondear
    watch(POLICY_DIR, { recursive: true }, () => {
      clearTimeout(t);
      t = setTimeout(() => send('projects', listProjects(POLICY_DIR)), 200);
    });
    startHost();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
