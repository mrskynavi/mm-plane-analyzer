// Projektordner: Projekte direkt in einen Ordner auf dem Rechner oder einem Netzlaufwerk speichern.
// Nutzt die File System Access API (Chrome, Edge, Opera). Der gewählte Ordner wird als Handle in
// IndexedDB gemerkt; nach einem Neuladen muss der Zugriff einmal per Klick bestätigt werden.
// Andere Browser (Firefox, Safari) speichern weiter per Download.
(function (root) {
  'use strict';

  const EXT = '.mmpa.json';
  const DB = 'mmpa', STORE = 'handles', KEY = 'projektordner';

  const supported = () => typeof root.showDirectoryPicker === 'function';
  const fileName = name => (String(name || '').trim() || 'Projekt').replace(/[\\/:*?"<>|]+/g, '_') + EXT;
  const isProjectFile = n => /\.mmpa(\.json)?$|\.json$/i.test(n);

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const rq = root.indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const tx = rq.result.transaction(STORE, mode), r = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { rq.result.close(); resolve(r && r.result); };
        tx.onerror = () => { rq.result.close(); reject(tx.error); };
      };
    });
  }
  const loadDir = () => idb('readonly', s => s.get(KEY)).catch(() => null);
  const saveDir = h => idb('readwrite', s => s.put(h, KEY));
  const clearDir = () => idb('readwrite', s => s.delete(KEY)).catch(() => {});

  // 'granted', 'prompt' oder 'denied'. Mit ask=true fragt der Browser nach (nur aus einem Klick heraus).
  async function permission(h, ask = false) {
    const o = { mode: 'readwrite' };
    let p = await h.queryPermission(o);
    if (p === 'prompt' && ask) p = await h.requestPermission(o);
    return p;
  }

  async function pickDir(start) {
    const h = await root.showDirectoryPicker({ id: 'mmpa-projekte', mode: 'readwrite', startIn: start || 'documents' });
    await saveDir(h);
    return h;
  }

  async function writeFile(fh, text) {
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function writeInDir(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    await writeFile(fh, text);
    return fh;
  }

  // Projektdateien im Ordner, neueste zuerst
  async function listDir(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !isProjectFile(name)) continue;
      try { const f = await h.getFile(); out.push({ name, handle: h, modified: f.lastModified, size: f.size }); } catch {}
    }
    return out.sort((a, b) => b.modified - a.modified);
  }

  const api = { EXT, supported, fileName, isProjectFile, loadDir, saveDir, clearDir, permission, pickDir, writeFile, writeInDir, listDir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).ordner = api;
})(typeof self !== 'undefined' ? self : this);
