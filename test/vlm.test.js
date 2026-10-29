const test = require('node:test');
const assert = require('node:assert');
const V = require('../web/core/vlm.js');
const PR = require('../web/core/projekt.js');
const M = require('../web/core/modell.js');
const LIB = require('../web/core/bibliothek.js');

const slope = (st, o = {}) => {
  const pf = V.planform(st), sys = V.build(V.panelize(st, o));
  const ref = { sRef: pf.area, cRef: pf.mac, xRef: o.xRef || 0 };
  const a = V.solve(sys, 0, ref), b = V.solve(sys, 2, ref);
  return { CLa: (b.CL - a.CL) / (2 * V.RAD), a, b, pf };
};

test('Grundriss: Fläche, Streckung und mittlere Tiefe eines Trapezflügels', () => {
  const pf = V.planform([{ y: 0, chord: 200 }, { y: 1000, chord: 100, offset: 50 }]);
  assert.strictEqual(pf.area, 300000);
  assert.ok(Math.abs(pf.aspect - 2000 * 2000 / 300000) < 1e-9);
  // l_μ = 2/3·c0·(1+λ+λ²)/(1+λ)
  assert.ok(Math.abs(pf.mac - 2 / 3 * 200 * (1 + 0.5 + 0.25) / 1.5) < 1e-9);
  assert.ok(Math.abs(pf.yMac - 2000 / 6 * (1 + 2 * 0.5) / 1.5) < 1e-9);
});

test('VLM: Lehrbuchflügel nach Bertin (A = 5, 45° Pfeilung, 4×1 Panels) gibt CLα = 3,443', () => {
  const r = slope([{ y: 0, chord: 100 }, { y: 250, chord: 100, offset: 250 }], { ny: 4, nx: 1, tipDense: false });
  assert.ok(Math.abs(r.CLa - 3.443) < 0.005, r.CLa);
});

test('VLM: sehr gestreckter Flügel geht gegen 2π, Neutralpunkt bei l/4', () => {
  const r = slope([{ y: 0, chord: 100 }, { y: 100000, chord: 100 }], { ny: 60, nx: 4 });
  assert.ok(Math.abs(r.CLa - 2 * Math.PI) / (2 * Math.PI) < 0.01, r.CLa);
  const xnp = -(r.b.Cm - r.a.Cm) / (r.b.CL - r.a.CL) * 100;
  assert.ok(Math.abs(xnp - 25) < 0.5, xnp);
});

test('VLM: Wölbung gibt Nullauftriebswinkel und Moment wie die Profiltheorie', () => {
  const xs = Array.from({ length: 101 }, (_, i) => i / 100), zs = xs.map(x => 0.08 * x * (1 - x));
  const r = slope([{ y: 0, chord: 100 }, { y: 5000, chord: 100 }], { ny: 30, nx: 8, xRef: 25, camber: [{ xs, zs }, { xs, zs }] });
  const a0 = -r.a.CL / ((r.b.CL - r.a.CL) / 2);
  assert.ok(Math.abs(a0 - (-2 * 0.02 * 180 / Math.PI)) < 0.05, a0); // −2f
  assert.ok(Math.abs(r.a.Cm - (-Math.PI * 0.02)) < 0.004, r.a.Cm); // −π·f
});

test('Modell: Neutralpunkt, Trimm und Gegenprobe mit der Handrechnung', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const r = M.analyze(m, pj.profiles);
  // Leitwerk schiebt den Neutralpunkt deutlich hinter l/4 der mittleren Tiefe
  assert.ok(r.xNP > r.wing.xMac + 0.4 * r.wing.mac && r.xNP < r.wing.xMac + 0.8 * r.wing.mac, r.xNP);
  // VLM und Excel-Formel liegen beim Neutralpunkt nahe beieinander
  assert.ok(Math.abs(r.xNP - r.hand.xNP) < 0.05 * r.wing.mac, [r.xNP, r.hand.xNP]);
  assert.ok(Math.abs(r.sigma - 0.12) < 1e-9);
  // getrimmt: Auslegungs-Ca erreicht
  assert.ok(Math.abs(r.trim.CL - 0.4) < 1e-6);
  // Schwerpunkt weiter vorne braucht mehr EWD
  const r2 = M.analyze({ ...m, cg: { mode: 'sigma', sigma: 0.25 } }, pj.profiles);
  assert.ok(r2.trim.ewd > r.trim.ewd + 0.3, [r.trim.ewd, r2.trim.ewd]);
  // fester Schwerpunkt ergibt das passende Stabilitätsmass
  const r3 = M.analyze({ ...m, cg: { mode: 'x', x: r.xCG } }, pj.profiles);
  assert.ok(Math.abs(r3.sigma - 0.12) < 1e-9);
  // Wölbklappe positiv: bei gleichem Ca weniger Anstellwinkel
  const mf = JSON.parse(JSON.stringify(m)); mf.wing.stations.forEach(s => { s.flap = 5; });
  const r4 = M.analyze(mf, pj.profiles);
  assert.ok(r4.trim.alpha < r.trim.alpha - 1, [r.trim.alpha, r4.trim.alpha]);
});

test('Modell: andere Dicke und Wölbung an einer Station ändern die Rechnung', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 });
  const m = PR.createModel('Test', e.id, null);
  const r = M.analyze(m, pj.profiles);
  const m2 = JSON.parse(JSON.stringify(m)); m2.wing.stations.forEach(s => { s.camber = 0.035; });
  const r2 = M.analyze(m2, pj.profiles);
  assert.ok(r2.trim.alpha < r.trim.alpha - 0.5, 'mehr Wölbung, weniger Anstellwinkel');
  assert.ok(Math.abs(M.stationGeometry(m2.wing.stations[0], pj.profiles).stats.camber - 0.035) < 1e-3);
});
