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
  assert.ok(Math.abs(r.sigma - 0.2) < 1e-9);
  // getrimmt: Auslegungs-Ca erreicht
  assert.ok(Math.abs(r.trim.CL - 0.4) < 1e-6);
  // Schwerpunkt weiter vorne braucht mehr EWD
  const r2 = M.analyze({ ...m, cg: { mode: 'sigma', sigma: 0.3 } }, pj.profiles);
  assert.ok(r2.trim.ewd > r.trim.ewd + 0.3, [r.trim.ewd, r2.trim.ewd]);
  // fester Schwerpunkt ergibt das passende Stabilitätsmass
  const r3 = M.analyze({ ...m, cg: { mode: 'x', x: r.xCG } }, pj.profiles);
  assert.ok(Math.abs(r3.sigma - 0.2) < 1e-9);
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

test('Trefftz: induzierter Widerstand eines Trapezflügels nahe Ca²/(π·Λ)', () => {
  const st = [{ y: 0, chord: 200 }, { y: 600, chord: 180 }, { y: 900, chord: 140 }, { y: 1000, chord: 80, offset: 60 }];
  const pf = V.planform(st), r = V.solve(V.build(V.panelize(st, { ny: 30, nx: 4 })), 4, { sRef: pf.area, cRef: pf.mac });
  const e = r.CL ** 2 / (Math.PI * pf.aspect * V.trefftz(r.strips, pf.area));
  assert.ok(e > 0.95 && e < 1.02, e);
});

test('Modell: Arbeitstabelle mit EWD je Stabilitätsmass, neutralem Leitwerk und Gleitzahl', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const r = M.analyze(m, pj.profiles);
  assert.deepStrictEqual(r.sigmas, [0.15, 0.2, 0.25]);
  const row = r.table.find(t => t.cl === 0.4);
  // bei σ 20 % (Modell) stimmt die Tabellen-EWD mit dem Trimm überein
  assert.ok(Math.abs(row.ewd[1] - r.trim.ewd) < 1e-6, [row.ewd[1], r.trim.ewd]);
  // mehr Stabilität braucht mehr EWD, mehr Ca auch
  assert.ok(row.ewd[2] > row.ewd[1] && row.ewd[1] > row.ewd[0]);
  assert.ok(r.table.find(t => t.cl === 0.6).ewd[1] > row.ewd[1]);
  // Schwerpunkt für unbelastetes Leitwerk: dort trägt das Leitwerk wirklich nichts
  const n = M.analyze({ ...m, clDesign: 0.4, cg: { mode: 'x', x: row.neutral.x } }, pj.profiles);
  assert.ok(Math.abs(n.trim.clTail) < 1e-3, n.trim.clTail);
  assert.ok(r.best && r.best.E > 15 && r.best.E < 60, r.best && r.best.E);
  assert.ok(r.minSink.cl >= r.best.cl);
});

test('Modell: Abrissstelle und Bewertung, Schränkung schiebt den Abriss nach innen', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  // stark zugespitzt, ohne Schränkung: Abriss aussen
  m.wing.stations = [PR.station(0, 250, 0, { profileId: e.id }), PR.station(1200, 90, 60, { profileId: e.id })];
  const a = M.analyze(m, pj.profiles);
  assert.ok(a.stallAt.eta > 0.6 && a.stallAt.rating !== 'gutmütig', JSON.stringify(a.stallAt));
  assert.ok(Math.abs(a.stallAt.ratio - a.stall) < 1e-12);
  // 4° Schränkung aussen: Abriss beginnt weiter innen und gutmütiger
  m.wing.stations[1].twist = -4;
  const b = M.analyze(m, pj.profiles);
  assert.ok(b.stallAt.eta < a.stallAt.eta, [a.stallAt.eta, b.stallAt.eta]);
});

test('Modell: gebaute EWD vorgeben ergibt Trimm-Ca, Bereich und Warnungen', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const r = M.analyze(m, pj.profiles);
  assert.strictEqual(r.trim.by, 'ca');
  // die EWD aus dem Trimm-Ca zurückgegeben trifft dasselbe Ca
  const q = M.analyze({ ...m, trimBy: 'ewd', ewd: r.trim.ewd }, pj.profiles);
  assert.strictEqual(q.trim.by, 'ewd');
  assert.ok(Math.abs(q.trim.CL - 0.4) < 0.005, q.trim.CL);
  assert.ok(Math.abs(q.trim.ewd - r.trim.ewd) < 1e-9);
  // mehr EWD: höheres Ca, langsamer
  const q2 = M.analyze({ ...m, trimBy: 'ewd', ewd: r.trim.ewd + 1 }, pj.profiles);
  assert.ok(q2.trim.CL > q.trim.CL + 0.1 && q2.trim.speed < q.trim.speed, [q.trim.CL, q2.trim.CL]);
  // viel zu viel EWD: Trimmpunkt über Ca max
  const hi = M.analyze({ ...m, trimBy: 'ewd', ewd: r.trim.ewd + 4 }, pj.profiles);
  assert.strictEqual(hi.trim.zone.key, 'abriss');
  // negative EWD: kein Gleichgewicht mit Auftrieb
  const lo = M.analyze({ ...m, trimBy: 'ewd', ewd: -3 }, pj.profiles);
  assert.strictEqual(lo.trim.zone.key, 'keine');
  assert.ok(lo.trim.byEwd.cl < 0.05);
  // Schwerpunkt hinter dem Neutralpunkt: nicht stabil trimmbar
  const un = M.analyze({ ...m, cg: { mode: 'sigma', sigma: -0.05 }, trimBy: 'ewd', ewd: 1 }, pj.profiles);
  assert.strictEqual(un.trim.zone.key, 'keine');
  assert.strictEqual(un.trim.byEwd.stable, false);
});

test('Modell: Endleistendicke in mm, je Station relativ zur Tiefe, Standard 0,7 mm, Station überschreibt', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  // alte Projektdatei ohne Angabe: 0,7 mm
  const rs = M.resolveTe(m);
  rs.wing.stations.forEach((s, i) => assert.ok(Math.abs(s.teGap - 0.7 / m.wing.stations[i].chord) < 1e-12));
  assert.ok(rs.wing.stations[3].teGap > rs.wing.stations[0].teGap, 'aussen relativ dicker');
  const geo = s => M.stationGeometry(s, pj.profiles).stats.teThickness;
  assert.ok(Math.abs(geo(rs.wing.stations[3]) - 0.7 / 100) < 1e-9);
  // Station überschreibt, Modellwert gilt sonst
  m.drag = { te: 0.5 }; m.wing.stations[3].te = 1;
  const r2 = M.resolveTe(m);
  assert.ok(Math.abs(r2.wing.stations[0].teGap - 0.5 / 220) < 1e-12 && Math.abs(r2.wing.stations[3].teGap - 1 / 100) < 1e-12);
  // das Original bleibt unverändert
  assert.strictEqual(m.wing.stations[0].teGap, undefined);
  // dickere Endleiste: schlechtere beste Gleitzahl, mehr Profilwiderstand im Gleitflug
  // (beim grossen Ca kann NeuralFoil mit offener Endleiste etwas mehr Auftrieb sehen, das Sinken bleibt dort fast gleich)
  const sharp = M.analyze(M.withTe(m, 0), pj.profiles), thick = M.analyze(M.withTe(m, 1), pj.profiles);
  assert.ok(thick.best.E < sharp.best.E, [thick.best.E, sharp.best.E]);
  const at = (r, cl) => r.table.find(t => Math.abs(t.cl - cl) < 1e-9);
  for (const cl of [0.2, 0.5]) assert.ok(at(thick, cl).cdw > at(sharp, cl).cdw * 1.02 && at(thick, cl).sink > at(sharp, cl).sink, `Ca ${cl}`);
  assert.strictEqual(M.withTe(m, 0).wing.stations[3].te, undefined);
});
