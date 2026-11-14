const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const M = require('../web/core/modell.js');
const DB = require('../web/core/druckbild.js');
const D3 = require('../web/core/modell3d.js');

function setup() {
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const r = M.analyze(m, project.profiles, { nCrit: 9 });
  return { project, m, r };
}

test('Modellrechnung liefert die lineare Streifenbasis', () => {
  const { r } = setup();
  const L = r.load;
  assert.ok(L && L.y.length === L.c0.length && L.ca.length === L.ci.length && L.width.length === L.y.length);
  assert.ok(L.surf.includes(0) && L.surf.includes(1));
  // Gesamt-Ca aus der Basis = Trimm-Ca
  const CL = L.CL0 + r.trim.alpha * L.CLa + r.trim.tailIncidence * L.CLi;
  assert.ok(Math.abs(CL - r.trim.CL) < 0.05, CL + ' vs ' + r.trim.CL);
});

test('Flugzustände: Trimm, Arbeitstabelle, darüber hinaus', () => {
  const { m, r } = setup();
  const S = DB.states(m, r);
  assert.strictEqual(S[0].key, 'trim');
  const beyond = S.filter(q => q.beyond);
  assert.strictEqual(beyond.length, 6);
  for (let i = 1; i < beyond.length; i++) assert.ok(beyond[i].alpha > beyond[i - 1].alpha && beyond[i].v < beyond[i - 1].v);
});

test('Druckbild: Streifen je Fläche, Cp und Zustände je Grenzschichtpunkt, Abriss über der Tabelle', () => {
  const { project, m, r } = setup();
  const S = DB.states(m, r);
  const f = DB.compute(m, project.profiles, r, S[0]);
  assert.ok(f.wing.length > 5 && f.tail.length > 2);
  assert.strictEqual(f.x.length, DB.N_BL);
  for (const q of f.wing) {
    assert.strictEqual(q.upper.cp.length, DB.N_BL);
    assert.ok([...q.upper.st, ...q.lower.st].every(v => v >= 0 && v <= 3));
    assert.ok(Number.isFinite(q.alphaEff) && Number.isFinite(q.clProf));
  }
  // Im Reiseflug Sog auf der Oberseite, Profil-Ca nahe am Wirbelgitter-Ca
  const mid = f.wing[Math.floor(f.wing.length / 2)];
  assert.ok(mid.upper.cp[8] < 0);
  assert.ok(Math.abs(mid.clProf - mid.cl) < 0.2, mid.clProf + ' vs ' + mid.cl);
  assert.strictEqual(f.stall.first, null);
  const last = DB.compute(m, project.profiles, r, S[S.length - 1]);
  assert.ok(last.stall.stalled > 0.3, 'Abriss bei α +6°: ' + last.stall.stalled);
  assert.ok(last.stall.first.eta >= 0 && last.stall.first.eta <= 1);
});

test('3D-Netz kennt Lage auf dem Profil (x/c, Ober-/Unterseite)', () => {
  const { project, m } = setup();
  const g = D3.build(m, project.profiles);
  const w = g.parts.find(p => p.kind === 'wing');
  assert.strictEqual(w.surface.length, w.positions.length / 3 * 2);
  const sides = new Set(); for (let i = 1; i < w.surface.length; i += 2) sides.add(w.surface[i]);
  assert.ok(sides.has(1) && sides.has(-1));
  for (let i = 0; i < w.surface.length; i += 2) assert.ok(w.surface[i] >= 0 && w.surface[i] <= 1);
});

test('Interpolation über die Grenzschichtpunkte', () => {
  assert.strictEqual(DB.at([0, 0.5, 1], [0, 1, 3], 0.75), 2);
  assert.strictEqual(DB.at([0, 0.5, 1], [0, 1, 3], -1), 0);
  assert.strictEqual(DB.stateAt([0, 0.5, 1], [0, 1, 3], 0.6), 1);
});
