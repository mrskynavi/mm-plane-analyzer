const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const M = require('../web/core/modell.js');
const S = require('../web/core/struktur.js');
const AE = require('../web/core/aeroelastik.js');

function setup(edit) {
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  m.wing.stations.forEach((s, i, a) => { if (i < a.length - 1 && i >= a.length - 2) s.flapDepth = 25; });
  if (edit) edit(m);
  const r = M.analyze(m, project.profiles, { nCrit: 9 });
  return { m, res: S.analyze(m, project.profiles, r, { project }) };
}

test('Eigenfrequenzen: gleichförmiger Balken wie im Lehrbuch', () => {
  // EI 100 N·m², GJ 50 N·m², 0,5 kg/m, Länge 1 m, Tiefe 0,2 m, Schwerpunkt auf der elastischen Achse
  const rows = [0, 1000].map(y => ({ y, EI: 100e6, GJ: 50e6, massPerM: 500, chord: 200 }));
  const f = AE.frequencies(rows, 1, 0.3, 0.3);
  const fh = 1.8751 ** 2 / (2 * Math.PI) * Math.sqrt(100 / 0.5), I = 0.5 * 0.2 * 0.2 * 0.0625, ft = Math.sqrt(50 / I) / 4;
  assert.ok(Math.abs(f.fh / fh - 1) < 0.02, f.fh + ' vs ' + fh);
  assert.ok(Math.abs(f.ft / ft - 1) < 0.03, f.ft + ' vs ' + ft);
});

test('Klappenbeiwerte der dünnen Platte', () => {
  const d = AE.flapDerivs(0.25);
  assert.ok(Math.abs(d.cl - 3.83) < 0.02 && Math.abs(d.cm + 0.65) < 0.01);
  assert.ok(Math.abs(AE.flapDerivs(1).cl - 2 * Math.PI) < 1e-9);
});

test('Aeroelastik: Divergenz, Ruderumkehr, Flattern, Verwindung', () => {
  const { res } = setup();
  const A = res.aero;
  assert.ok(A && A.ok, JSON.stringify(A && A.notes));
  assert.ok(A.div.v > 5 && A.fh > 0 && A.ft > A.fh);
  assert.ok(A.flutter.v > 0);
  // Wirksamkeit beginnt bei 1 und fällt mit der Fahrt; Umkehr liegt unter der Divergenz
  const c = A.aileron.curve;
  assert.ok(Math.abs(c[0].eta - 1) < 1e-9 && c[5].eta < c[1].eta);
  if (A.aileron.rev) assert.ok(A.aileron.rev < A.div.v);
  // Verwindung wächst mit der Fahrt, mit Rückkopplung stärker als ohne (Holm hinter t/4, Profilmoment negativ)
  const sw = A.sweep.filter(q => !q.diverged);
  assert.ok(sw.length >= 3 && Math.abs(sw[2].phi) > Math.abs(sw[0].phi));
  assert.strictEqual(sw[0].theta.length, A.ys.length);
});

test('Aeroelastik: steifere Schale schiebt die Grenzen hinaus, Holm bei t/4 kennt keine Divergenz', () => {
  const base = setup().res.aero;
  const stiff = setup(m => { m.wing.struct = { shell: { layers: [{ mat: 'cfk-gewebe', g: 160, angle: 45 }, { mat: 'balsa', t: 1, angle: 0 }, { mat: 'cfk-gewebe', g: 160, angle: 45 }] } }; }).res.aero;
  assert.ok(stiff.div.v > 1.3 * base.div.v && stiff.ft > base.ft);
  const front = setup(m => { m.wing.struct = { spar: { pos: 25 } }; }).res.aero;
  assert.ok(front.ok && !front.div);
});

test('Eichung: gemessene Durchbiegung und Verdrehung skalieren EI und GJ', () => {
  const a = setup().res;
  const tip = a.wing.cases[0].tipW;
  const b = setup(m => { m.wing.struct = { aero: { bendMass: 500, bendW: 10, torsM: 20, torsPhi: 0.2 } }; }).res;
  const c = b.wing.calib;
  assert.ok(c.bend && c.tors && c.kEI > 0 && c.kGJ > 0);
  // Durchbiegung im Lastfall ändert sich um den Faktor, die Reserve nicht
  assert.ok(Math.abs(b.wing.cases[0].tipW * c.kEI / tip - 1) < 0.02);
  assert.ok(Math.abs(b.wing.cases[0].worst.reserve / a.wing.cases[0].worst.reserve - 1) < 1e-6);
  assert.ok(Math.abs(b.aero.div.v / a.aero.div.v - Math.sqrt(c.kGJ)) < 0.02 * Math.sqrt(c.kGJ));
  // Probe nachrechnen: Kragbalken mit Einzellast, w = P·L³ / (3·EI)
  const rows = [0, 1000].map(y => ({ y, EI: 100e6, GJ: 50e6 }));
  const k = S.calib(rows, { bendMass: 1000, bendW: 9.81e9 / (3 * 100e6), torsM: 100, torsPhi: 1000 * 1000 / 50e6 * 180 / Math.PI });
  assert.ok(Math.abs(k.kEI - 1) < 1e-3 && Math.abs(k.kGJ - 1) < 1e-3);
});
