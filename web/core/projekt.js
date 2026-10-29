// Projektdatei (.mmpa.json): Profilbibliothek, gerechnete Polaren und später die Modelle.
// Eine Datei pro Projekt; Polaren tragen einen Fingerabdruck aus Geometrie und Einstellungen,
// damit eine Polare nur einmal gerechnet wird.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;

  const FORMAT = 'mm-plane-analyzer';
  const VERSION = 1;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  // FNV-1a, 32 bit, als Hex: reicht als Fingerabdruck
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  const DEFAULT_MOD = { thickness: 1, camber: 1, xThickness: null, xCamber: null };

  function createProject(name = 'Neues Projekt') {
    return { format: FORMAT, version: VERSION, name, created: new Date().toISOString(), profiles: [], polars: [], variants: [], models: [] };
  }

  // Profil aus .dat-Text oder Koordinaten anlegen. Die Originalkoordinaten bleiben unverändert gespeichert.
  function addProfile(project, { name, coords, datText, source = 'import' }) {
    let c = coords, n = name;
    if (datText != null) { const d = P.parseDat(datText, name); c = d.coords; n = name || d.name; }
    const prof = { id: uid(), name: n || 'Profil', source, coords: c.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]), mod: { ...DEFAULT_MOD } };
    project.profiles.push(prof);
    return prof;
  }

  // Abgeleitetes Profil: gleiche Basis, eigene Dicke/Wölbung (z. B. Aussenflügel)
  function deriveProfile(project, base, mod, name) {
    const prof = { id: uid(), name: name || base.name + ' (abgeleitet)', source: 'abgeleitet', baseId: base.id, coords: base.coords, mod: { ...DEFAULT_MOD, ...mod } };
    project.profiles.push(prof);
    return prof;
  }

  const isModified = mod => mod && (mod.thickness !== 1 || mod.camber !== 1 || mod.xThickness != null || mod.xCamber != null);

  // Geometrie, wie gerechnet wird: normiert, neu verteilt, Dicke/Wölbung angewendet, Klappe gedreht
  function geometry(prof, flap = null) {
    // immer über modify, damit Original und Änderung gleich diskretisiert sind
    let c = P.modify(prof.coords, isModified(prof.mod) ? prof.mod : {});
    if (flap && flap.deflection) c = P.flap(c, flap.deflection, flap.hingeX ?? 0.75, flap.hinge || 'auto');
    return c;
  }

  // Fingerabdruck einer Polare: Geometrie + Rechner + Einstellungen
  function polarKey(prof, flap, opts, solver = 'neuralfoil-0.3.3-xlarge') {
    return hash(JSON.stringify([prof.coords, prof.mod, flap || null, opts, solver]));
  }

  function findPolar(project, key) { return project.polars.find(p => p.key === key) || null; }

  function storePolar(project, prof, flap, result, solver = 'neuralfoil-0.3.3-xlarge') {
    const key = polarKey(prof, flap, result.opts, solver);
    const old = findPolar(project, key);
    if (old) return old;
    const pol = { id: uid(), key, profileId: prof.id, flap: flap || null, solver, opts: result.opts, points: result.points, summary: result.summary, created: new Date().toISOString() };
    project.polars.push(pol);
    return pol;
  }

  function removeProfile(project, id) {
    project.profiles = project.profiles.filter(p => p.id !== id);
    project.polars = project.polars.filter(p => p.profileId !== id);
  }

  // Gemerkter Zustand aus dem Profil-Labor: Ausgangsprofil (Koordinaten kopiert), Änderung und Klappe.
  // Bleibt gültig, auch wenn das Ausgangsprofil später gelöscht wird.
  function addVariant(project, base, mod, flap, name) {
    const v = {
      id: uid(), name: name || base.name, baseId: base.id, baseName: base.name, coords: base.coords,
      mod: { ...DEFAULT_MOD, ...mod }, flap: flap && flap.deflection ? { deflection: flap.deflection, hingeX: flap.hingeX ?? 0.75, hinge: flap.hinge || 'auto' } : null,
      created: new Date().toISOString(),
    };
    (project.variants = project.variants || []).push(v);
    return v;
  }

  // Zustand als eigenes Profil ablegen. Ohne Klappe als abgeleitetes Profil (nur die Änderung wird gespeichert),
  // mit Klappe werden die Koordinaten samt Klappe übernommen.
  function variantToProfile(project, v, name) {
    const n = name || v.name;
    if (!v.flap) {
      const prof = deriveProfile(project, { id: v.baseId, name: v.baseName, coords: v.coords }, v.mod, n);
      prof.source = 'labor';
      return prof;
    }
    return addProfile(project, { name: n, coords: geometry(v, v.flap), source: 'labor' });
  }

  function serialize(project) { return JSON.stringify(project, null, 1); }

  function parse(text) {
    const p = JSON.parse(text);
    if (!p || p.format !== FORMAT) throw new Error('Keine Projektdatei von MM Plane Analyzer');
    if (p.version > VERSION) throw new Error('Projektdatei ist neuer als diese App (Version ' + p.version + ')');
    p.profiles = (p.profiles || []).map(pr => ({ ...pr, mod: { ...DEFAULT_MOD, ...(pr.mod || {}) } }));
    p.polars = p.polars || [];
    p.variants = (p.variants || []).map(v => ({ ...v, mod: { ...DEFAULT_MOD, ...(v.mod || {}) }, flap: v.flap || null }));
    p.models = (p.models || []).filter(validModel);
    return p;
  }

  // Modell: Flügel und Höhenleitwerk als Stationen wie in XFLR5. Längen in mm, Masse in g, Winkel in Grad.
  // Eine Station: y (Spannweite entlang der Fläche ab Mitte), Tiefe, Versatz der Nasenleiste, V-Form und Klappe
  // bis zur nächsten Station, Schränkung, Profil mit eigener Dicke und Wölbung (null = wie das Profil).
  const station = (y, chord, offset, o = {}) => ({ y, chord, offset, dihedral: 0, twist: 0, profileId: null, thickness: null, camber: null, flapDepth: 25, flap: 0, ...o });
  function createModel(name = 'Neues Modell', wingProfileId = null, tailProfileId = null) {
    const w = (y, c, off, o) => station(y, c, off, { dihedral: 3, profileId: wingProfileId, ...o });
    const t = (y, c, off) => station(y, c, off, { profileId: tailProfileId });
    return {
      id: uid(), name, notes: '', mass: 1800,
      wing: { incidence: 0, stations: [w(0, 220, 0), w(600, 210, 3), w(950, 170, 15), w(1250, 100, 50)] },
      tail: { x: 950, z: 30, stations: [t(0, 130, 0), t(300, 80, 35)] },
      cg: { mode: 'sigma', sigma: 0.12, x: 60 }, clDesign: 0.4,
    };
  }
  const validModel = m => m && m.wing && Array.isArray(m.wing.stations) && m.wing.stations.length >= 2 && m.tail && Array.isArray(m.tail.stations);

  const api = { FORMAT, VERSION, createProject, addProfile, deriveProfile, geometry, polarKey, findPolar, storePolar, removeProfile, addVariant, variantToProfile, serialize, parse, createModel, station, hash, isModified };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).projekt = api;
})(typeof self !== 'undefined' ? self : this);
