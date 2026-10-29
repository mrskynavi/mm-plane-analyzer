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
    return { format: FORMAT, version: VERSION, name, created: new Date().toISOString(), profiles: [], polars: [], models: [] };
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

  function serialize(project) { return JSON.stringify(project, null, 1); }

  function parse(text) {
    const p = JSON.parse(text);
    if (!p || p.format !== FORMAT) throw new Error('Keine Projektdatei von MM Plane Analyzer');
    if (p.version > VERSION) throw new Error('Projektdatei ist neuer als diese App (Version ' + p.version + ')');
    p.profiles = (p.profiles || []).map(pr => ({ ...pr, mod: { ...DEFAULT_MOD, ...(pr.mod || {}) } }));
    p.polars = p.polars || [];
    p.models = p.models || [];
    return p;
  }

  // Modell für P1: Flügel aus Segmenten, Leitwerk, Massen. Längen in mm, Massen in g, Winkel in Grad.
  function createModel(name = 'Neues Modell') {
    return {
      id: uid(), name, class: 'segler', notes: '',
      wing: {
        x: 0, z: 0, incidence: 0,
        root: { chord: 200, profileId: null },
        segments: [{ span: 1000, chordOut: 150, sweepLE: 0, dihedral: 2, twistOut: 0, profileOutId: null, flaps: [] }],
      },
      tail: { type: 'kreuz', distance: 900, root: { chord: 120, profileId: null }, segments: [{ span: 300, chordOut: 80, sweepLE: 20, dihedral: 0, twistOut: 0, profileOutId: null }], incidence: 0 },
      fin: { height: 250, chordRoot: 200, chordTip: 120, sweepLE: 60 },
      fuselage: { stations: [] },
      masses: [],
    };
  }

  const api = { FORMAT, VERSION, createProject, addProfile, deriveProfile, geometry, polarKey, findPolar, storePolar, removeProfile, serialize, parse, createModel, hash, isModified };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).projekt = api;
})(typeof self !== 'undefined' ? self : this);
