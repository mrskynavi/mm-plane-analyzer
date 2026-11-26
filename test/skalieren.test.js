const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const M = require('../web/core/modell.js');
const SK = require('../web/core/skalieren.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

function setup() {
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  m.fuselage = { type: 'modern', nose: 400, diameter: 110, fin: 6, finGeo: { area: 6, root: 200, tip: 120, height: 250, x: 900, sweep: 20 } };
  m.cg = { mode: 'x', sigma: 0.2, x: 70 };
  m.wing.struct = {
    spar: { pos: 30, mat: 'cfk-roving', b: 20, input: 'roving', n0: 40, n1: 2, tex: 1600, t0: 1, t1: 0.2 },
    web: { mat: 'rohacell', t: 20, t1: 3 },
    shell: { box: 'voll', layers: [{ mat: 'abachi', t: 0.6, angle: 0 }, { mat: 'gfk-gewebe', g: 80, angle: 45, y1: 600 }] },
    joiners: [{ y: 0, mat: 'federstahl', form: 'rund', d: 8, len: 160, n: 1 }],
    link: { horn: 12, arm: 10, cuts: [870] },
  };
  m.drag = { te: 0.7, spinner: 40 };
  return { project, m };
}

test('Längen mit k, Flächen mit k², Winkel und Prozente bleiben', () => {
  const { m } = setup();
  const s = SK.scaleModel(m, 0.7, { mass: 'k3' });
  assert.notStrictEqual(s, m);
  assert.strictEqual(m.wing.stations[1].y, 600, 'Original bleibt');
  s.wing.stations.forEach((q, i) => { near(q.y, m.wing.stations[i].y * 0.7, 0.01); near(q.chord, m.wing.stations[i].chord * 0.7, 0.01); assert.strictEqual(q.dihedral, m.wing.stations[i].dihedral); assert.strictEqual(q.flapDepth, m.wing.stations[i].flapDepth); });
  near(s.tail.x, m.tail.x * 0.7, 0.01); near(s.tail.z, m.tail.z * 0.7, 0.01);
  s.tail.stations.forEach((q, i) => near(q.chord, m.tail.stations[i].chord * 0.7, 0.01));
  assert.strictEqual(s.fuselage.nose, 280); assert.strictEqual(s.fuselage.diameter, 77);
  near(s.fuselage.fin, 6 * 0.49, 0.01); assert.strictEqual(s.fuselage.finGeo.height, 175); assert.strictEqual(s.fuselage.finGeo.sweep, 20);
  assert.strictEqual(s.cg.x, 49); assert.strictEqual(s.cg.sigma, 0.2);
  assert.strictEqual(s.mass, Math.round(1800 * 0.343));
  assert.strictEqual(SK.scaleModel(m, 0.7, { mass: 'k2' }).mass, Math.round(1800 * 0.49));
  assert.strictEqual(SK.scaleModel(m, 0.7, { mass: 'keep' }).mass, 1800);
  assert.strictEqual(SK.scaleModel(m, 0.7, { mass: 950 }).mass, 950);
  // Aufbau: Holm geometrisch, Schale und Hardware bleiben
  const S = s.wing.struct;
  assert.strictEqual(S.spar.b, 14); assert.strictEqual(S.spar.n0, Math.round(40 * 0.49)); assert.strictEqual(S.spar.n1, 1); assert.strictEqual(S.spar.tex, 1600);
  assert.strictEqual(S.web.t, 14);
  assert.strictEqual(S.shell.layers[0].t, 0.6); assert.strictEqual(S.shell.layers[1].g, 80); assert.strictEqual(S.shell.layers[1].y1, 420);
  assert.strictEqual(S.joiners[0].d, 5.6); assert.strictEqual(S.joiners[0].len, 112);
  assert.strictEqual(S.link.horn, 12); assert.deepStrictEqual(S.link.cuts, [609]);
  assert.strictEqual(s.drag.te, 0.7); assert.strictEqual(s.drag.spinner, 28);
  assert.throws(() => SK.scaleModel(m, 0));
});

test('Rechnung: Spannweite und Neutralpunkt mit k, Flächenbelastung bei k³ mit k', () => {
  const { project, m } = setup();
  m.cg = { mode: 'sigma', sigma: 0.15, x: 60 };
  const k = 0.7, s = SK.scaleModel(m, k);
  const a = M.analyze(m, project.profiles, { nCrit: 9 }), b = M.analyze(s, project.profiles, { nCrit: 9 });
  near(b.wing.area / a.wing.area, k * k, 1e-3, 'Fläche');
  near(b.xNP / a.xNP, k, 0.02, 'Neutralpunkt');
  near(b.wingLoading / a.wingLoading, k, 0.01, 'Flächenbelastung');
});
