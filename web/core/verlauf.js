// Verlauf: Rückgängig/Wiederholen und gemerkte Zwischenstände des Projekts.
// Jeder Stand ist der serialisierte Projekttext. Schritte, die kurz nacheinander kommen
// (Tippen, Optimierer), fasst die Oberfläche zu einem Schritt zusammen.
// Zwischenstände liegen in IndexedDB (nur auf diesem Gerät), automatisch alle paar Minuten
// beim Arbeiten und vor grossen Schritten, dazu benannte Stände, die nicht ausgedünnt werden.
(function (root) {
  'use strict';

  // ---------- Rückgängig / Wiederholen ----------
  function createHistory(start, limit = 100) {
    let cur = start;
    const undo = [], redo = [];
    return {
      get current() { return cur; },
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
      peekUndo: () => undo.length ? undo[undo.length - 1] : null,
      peekRedo: () => redo.length ? redo[redo.length - 1] : null,
      // neuer Stand nach einer Änderung; false, wenn sich nichts geändert hat
      record(text) {
        if (text === cur) return false;
        undo.push(cur); if (undo.length > limit) undo.shift();
        redo.length = 0; cur = text; return true;
      },
      undo() { if (!undo.length) return null; redo.push(cur); cur = undo.pop(); return cur; },
      redo() { if (!redo.length) return null; undo.push(cur); cur = redo.pop(); return cur; },
      reset(text) { cur = text; undo.length = 0; redo.length = 0; },
      get sizes() { return { undo: undo.length, redo: redo.length }; },
    };
  }

  // ---------- Was hat sich geändert? ----------
  // Pfade der geänderten Werte zwischen zwei Projektständen (Objekte), höchstens max.
  function changedPaths(a, b, max = 20) {
    const out = [];
    const walk = (x, y, path) => {
      if (out.length >= max) return;
      if (x === y) return;
      const ox = x && typeof x === 'object', oy = y && typeof y === 'object';
      if (!ox || !oy || Array.isArray(x) !== Array.isArray(y)) { out.push(path); return; }
      if (Array.isArray(x) && x.length !== y.length && !x.every(v => v && typeof v === 'object')) { out.push(path); return; }
      // Koordinatenlisten nicht Punkt für Punkt
      if (path[path.length - 1] === 'coords' || path[path.length - 1] === 'points' || path[path.length - 1] === 'table') {
        if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path);
        return;
      }
      if (Array.isArray(x)) {
        // Listen mit ids (Modelle, Profile …) über die id zuordnen, sonst über die Stelle
        const byId = x.concat(y).every(v => v && typeof v === 'object' && v.id != null);
        if (byId) {
          const ix = new Map(x.map((v, i) => [v.id, i])), iy = new Map(y.map((v, i) => [v.id, i]));
          for (const [id, i] of ix) { if (!iy.has(id)) out.push(path.concat([{ removed: i }])); else walk(x[i], y[iy.get(id)], path.concat([iy.get(id)])); if (out.length >= max) return; }
          for (const [id, i] of iy) if (!ix.has(id)) { out.push(path.concat([{ added: i }])); if (out.length >= max) return; }
          return;
        }
        const n = Math.max(x.length, y.length);
        for (let i = 0; i < n && out.length < max; i++) {
          if (i >= x.length) out.push(path.concat([{ added: i }]));
          else if (i >= y.length) out.push(path.concat([{ removed: i }]));
          else walk(x[i], y[i], path.concat([i]));
        }
        return;
      }
      const keys = new Set(Object.keys(x).concat(Object.keys(y)));
      for (const k of keys) { walk(x[k], y[k], path.concat([k])); if (out.length >= max) return; }
    };
    walk(a, b, []);
    return out;
  }

  const WORDS = {
    models: 'Modell', profiles: 'Profil', variants: 'Labor-Stand', measured: 'Messpolare', polars: 'Polare',
    wing: 'Flügel', tail: 'HLW', fuselage: 'Rumpf', cg: 'Schwerpunkt', drag: 'Widerstand', flaps: 'Klappen', opt: 'Optimierer',
    stations: 'Station', modes: 'Flugzustand', elevator: 'Höhenruder', build: 'Bauweise',
    name: 'Name', notes: 'Notizen', mass: 'Masse', clDesign: 'Auslegungs-Ca', incidence: 'Einstellwinkel', trimBy: 'Trimm nach', ewd: 'EWD',
    chord: 'Tiefe', offset: 'Versatz', dihedral: 'V-Form', twist: 'Schränkung', profileId: 'Profil', thickness: 'Dicke', camber: 'Wölbung',
    xThickness: 'Dickenrücklage', xCamber: 'Wölbungsrücklage', flapDepth: 'Klappentiefe', flap: 'Klappe', flapMix: 'Wölbanteil', y: 'Spannweite',
    x: 'Lage', z: 'Höhe', sigma: 'Stabilitätsmass', mode: 'Art', type: 'Art', nose: 'Nase', diameter: 'Durchmesser', fin: 'Seitenleitwerk',
    cl: 'Ca', weight: 'Gewicht', series: 'Klappenschar', radii: 'Kreisradien', circleMargin: 'Kreisreserve', vars: 'Variablen', vBest: 'Bestes Gleiten bei',
    mod: 'Änderung', coords: 'Koordinaten', te: 'Endleiste', table: 'Kontur',
  };
  // Lesbarer Name einer Änderung, z. B. „Shark: Flügel Station 3 Tiefe“
  function label(path, obj) {
    if (!path.length) return 'Projekt';
    const parts = []; let o = obj, prefix = '';
    for (let i = 0; i < path.length; i++) {
      const k = path[i];
      if (k && typeof k === 'object') { parts.push(k.added != null ? 'neu' : 'gelöscht'); break; }
      if (typeof k === 'number') {
        const it = o && o[k];
        if (i === 1 && it && it.name && ['models', 'profiles', 'variants', 'measured'].includes(path[0])) { prefix = it.name; parts.pop(); }
        else parts.push(String(k + 1));
        o = it; continue;
      }
      if (i === 0 && k === 'name') { parts.push('Projektname'); break; }
      parts.push(WORDS[k] || k);
      o = o && o[k];
    }
    // „Modell“ nur, wenn kein Name davorsteht
    const s = parts.join(' ');
    return prefix ? (s ? `${prefix}: ${s}` : prefix) : s;
  }
  // Kurzbeschreibung von a nach b (Texte oder Objekte)
  function describe(a, b) {
    try {
      const x = typeof a === 'string' ? JSON.parse(a) : a, y = typeof b === 'string' ? JSON.parse(b) : b;
      const ps = changedPaths(x, y, 30);
      if (!ps.length) return 'keine Änderung';
      const names = [];
      for (const p of ps) {
        const added = p.some(k => k && typeof k === 'object' && k.added != null);
        const l = label(p, added ? y : x);
        if (!names.includes(l)) names.push(l);
      }
      const more = names.length - 2;
      return names.slice(0, 2).join(', ') + (more > 0 ? ` und ${more} weitere` : '');
    } catch { return 'Änderung'; }
  }

  // ---------- Zwischenstände ausdünnen ----------
  // Automatische Stände: die letzten keepRecent ganz, ältere einer pro Stunde (bis 2 Tage),
  // dann einer pro Tag, insgesamt höchstens maxAuto. Benannte bleiben immer.
  function prune(list, now = Date.now(), { keepRecent = 20, maxAuto = 60 } = {}) {
    const auto = list.filter(s => s.kind !== 'named').sort((a, b) => b.time - a.time);
    const keep = new Set(auto.slice(0, keepRecent).map(s => s.id));
    const seen = new Set();
    for (const s of auto.slice(keepRecent)) {
      const age = now - s.time;
      const bucket = age < 2 * 864e5 ? 'h' + Math.floor(s.time / 36e5) : 'd' + Math.floor(s.time / 864e5);
      if (!seen.has(bucket)) { seen.add(bucket); keep.add(s.id); }
    }
    const kept = auto.filter(s => keep.has(s.id)).slice(0, maxAuto);
    const ok = new Set(kept.map(s => s.id));
    return list.filter(s => s.kind === 'named' || ok.has(s.id));
  }

  // ---------- Speicher (IndexedDB) ----------
  const DB = 'mmpa-verlauf', STORE = 'staende';
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('Dieser Browser kann keine Zwischenstände speichern')); return; }
      const rq = root.indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { const s = rq.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('project', 'project'); };
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result, tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
        let out;
        Promise.resolve(fn(st)).then(v => { out = v; });
        tx.oncomplete = () => { db.close(); resolve(out); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('abgebrochen')); };
      };
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Liste ohne Projekttext (für die Anzeige)
  function list(project) {
    return idb('readonly', st => req(st.index('project').getAll(project)))
      .then(all => all.map(({ text, ...s }) => ({ ...s, size: text.length })).sort((a, b) => b.time - a.time));
  }
  function get(id) { return idb('readonly', st => req(st.get(id))); }
  function add(project, text, { kind = 'auto', label: l = '', time = Date.now() } = {}) {
    const s = { id: uid(), project, text, kind, label: l, time };
    return idb('readwrite', async st => {
      st.put(s);
      const all = await req(st.index('project').getAll(project));
      const ok = new Set(prune(all, time).map(x => x.id));
      for (const x of all) if (!ok.has(x.id)) st.delete(x.id);
    }).then(() => s);
  }
  function update(id, fields) {
    return idb('readwrite', async st => { const s = await req(st.get(id)); if (s) st.put({ ...s, ...fields }); });
  }
  function remove(id) { return idb('readwrite', st => { st.delete(id); }); }

  const api = { createHistory, changedPaths, label, describe, prune, list, get, add, update, remove };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).verlauf = api;
})(typeof self !== 'undefined' ? self : this);
