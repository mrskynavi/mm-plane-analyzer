// MM Plane Analyzer als Desktop-App (Windows, macOS).
// Die App selbst ist dieselbe wie auf GitHub Pages. Mit Verbindung holt das Fenster jede Datei frisch
// von dort (neue Fassungen ohne Neuinstallation) und legt sie im Benutzerordner ab; ohne Verbindung
// kommt der zuletzt geholte Stand, beim allerersten Start ohne Netz die mitgelieferte Kopie.
// Die Adresse mmpa://app/ bleibt immer gleich, damit Projekte, Einstellungen und GitHub-Sync
// (localStorage, IndexedDB) zwischen Online- und Offline-Betrieb dieselben sind.
'use strict';
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const P = require('./pfad.js');

const WAIT = 6000;
const BUNDLE = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'web');
let CACHE = null;

protocol.registerSchemesAsPrivileged([{
  scheme: P.SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false },
}]);

if (!app.requestSingleInstanceLock()) app.quit();

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), ms))]);
}
function inside(dir, file) {
  const f = path.join(dir, ...file.split('/'));
  return f.startsWith(dir + path.sep) ? f : null;
}
function reply(buf, file, from) {
  return new Response(buf, { status: 200, headers: { 'content-type': P.mime(file), 'cache-control': 'no-store', 'x-mmpa-quelle': from } });
}
async function offline(file) {
  for (const [dir, from] of [[CACHE, 'zwischenspeicher'], [BUNDLE, 'mitgeliefert']]) {
    const f = inside(dir, file);
    if (f) { try { return reply(await fs.promises.readFile(f), file, from); } catch { /* nächste Quelle */ } }
  }
  return new Response('Nicht gefunden (offline)', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function handle(req) {
  const file = P.fileOf(req.url);
  if (!file) return new Response('Unbekannte Adresse', { status: 404 });
  const search = new URL(req.url).search;
  try {
    const r = await withTimeout(net.fetch(P.onlineOf(file, search), { cache: 'no-cache' }), WAIT);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const f = inside(CACHE, file);
      if (f) fs.promises.mkdir(path.dirname(f), { recursive: true }).then(() => fs.promises.writeFile(f, buf)).catch(() => {});
      return reply(buf, file, 'online');
    }
  } catch { /* offline oder zu langsam */ }
  return offline(file);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'MM Plane Analyzer',
    backgroundColor: '#0f1720',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // Links nach aussen (GitHub, Anleitungen) im normalen Browser öffnen
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(P.START)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.loadURL(P.START);
  return win;
}

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

app.whenReady().then(() => {
  CACHE = path.join(app.getPath('userData'), 'app-zwischenspeicher');
  protocol.handle(P.SCHEME, handle);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Datei', submenu: [{ role: 'reload', label: 'Neu laden' }, { role: 'forceReload', label: 'Neu laden ohne Speicher' }, { type: 'separator' }, { role: 'quit', label: 'Beenden' }] },
    { label: 'Bearbeiten', submenu: [{ role: 'undo', label: 'Rückgängig' }, { role: 'redo', label: 'Wiederholen' }, { type: 'separator' }, { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' }, { role: 'selectAll', label: 'Alles auswählen' }] },
    { label: 'Ansicht', submenu: [{ role: 'resetZoom', label: 'Originalgrösse' }, { role: 'zoomIn', label: 'Vergrössern' }, { role: 'zoomOut', label: 'Verkleinern' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' }, { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
