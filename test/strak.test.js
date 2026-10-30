const test = require('node:test');
const assert = require('node:assert');
const S = require('../web/core/strak.js');
const P = require('../web/core/profil.js');
const NF = require('../web/core/neuralfoil.js');
const PR = require('../web/core/projekt.js');
const M = require('../web/core/modell.js');
const LIB = require('../web/core/bibliothek.js');

const setup = () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  return { pj, e, m: PR.createModel('Test', e.id, h.id) };
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} statt ${b}`);

test('Schnelles Profil: ohne Klappe gleich wie profil.modify mit NeuralFoil, mit Klappe nahe an der gedrehten Klappe', () => {
  const { e } = setup();
  const B = S.prepareBase(e);
  const mod = { thickness: 0.85, camber: 1.2, xThickness: B.stats.xThickness + 0.04, xCamber: B.stats.xCamber - 0.06 };
  const q = { thickness: mod.thickness * B.raw.thickness, camber: mod.camber * B.raw.camber, xThickness: mod.xThickness, xCamber: mod.xCamber };
  const geo = P.modify(e.coords, mod);
  for (const flap of [0, 5, -3]) {
    const slow = NF.prepare(flap ? P.flap(geo, flap, 0.75) : geo), a = S.aeroShape(S.shape(B, q), flap, 0.75);
    for (const al of [-2, 2, 6]) {
      const r1 = slow(al, 150000), r2 = NF.fromKulfan(a.k, al + a.da, 150000 * a.reK);
      if (!flap) { near(r2.cl, r1.cl, 1e-6, 'Ca'); near(r2.cd, r1.cd, 1e-7, 'Cw'); }
      else { near(r2.cl, r1.cl, 0.012, `Ca Klappe ${flap}°`); near(r2.cd / r1.cd, 1, 0.04, `Cw Klappe ${flap}°`); }
    }
  }
});

test('CMA-ES findet das Minimum einer gedrehten Parabel', () => {
  const es = S.cmaes([0.9, 0.1, 0.8, 0.2, 0.5], 0.3, 3);
  const f = x => (x[0] - 0.3) ** 2 + 10 * (x[1] - 0.6 + 0.5 * (x[0] - 0.3)) ** 2 + (x[2] - 0.5) ** 2 + 4 * (x[3] - 0.4) ** 2 + (x[4] - 0.7) ** 2;
  for (let g = 0; g < 150; g++) { const xs = es.ask(); es.tell(xs, xs.map(f)); }
  assert.ok(f(es.mean) < 1e-8, f(es.mean));
});

test('Schnelle Bewertung trifft die normale Modellrechnung, auch mit Klappe', () => {
  const { pj, m } = setup();
  const points = [{ name: 'Speed', cl: 0.15 }, { name: 'Gleiten', cl: 0.45 }, { name: 'Thermik', cl: 0.8 }];
  const ctx = S.context(m, pj.profiles, { points });
  const design = m.wing.stations.map(s => S.designOf(s, pj.profiles));
  for (const flap of [0, 4]) {
    const ev = S.evaluate(ctx, design, points.map(() => flap));
    const r = M.analyze(M.withFlap(m, flap), pj.profiles);
    ev.points.forEach(p => {
      const t = r.table.find(q => Math.abs(q.cl - p.cl) < 1e-9);
      near(p.E / t.E, 1, 0.03, `Gleitzahl ${p.name} Klappe ${flap}°`);
      near(p.ewd, t.ewdCur, 0.2, `EWD ${p.name} Klappe ${flap}°`);
    });
  }
});

test('Klappe in den Stationspolaren: positive Klappe hebt Ca max, Modell mit Wölbanteil', () => {
  const { pj, m } = setup();
  m.wing.stations[2].flapMix = 0.5;
  const mf = M.withFlap(m, 6);
  assert.deepStrictEqual(mf.wing.stations.map(s => s.flap), [6, 6, 3, 0]);
  const r0 = M.analyze(m, pj.profiles), r1 = M.analyze(mf, pj.profiles);
  assert.ok(r1.segments[0][0].clMax > r0.segments[0][0].clMax + 0.1, [r0.segments[0][0].clMax, r1.segments[0][0].clMax]);
  assert.strictEqual(r1.segments[0][0].flap, 6);
  assert.strictEqual(r1.segments[2][0].flap, 3, 'Wölbanteil 50 %');
  // Rücklagen der Station gehen in das Profil ein
  const st = { ...m.wing.stations[1], xThickness: 0.25 };
  near(M.stationGeometry(st, pj.profiles).stats.xThickness, 0.25, 0.02, 'Dickenrücklage');
});

test('Strak-Optimierer: weniger Widerstand, Randbedingungen eingehalten, Übernahme ins Modell', () => {
  const { pj, m, e } = setup();
  const opt = S.optimizer(m, pj.profiles, { maxEvals: 150, minThick: 0.08, seed: 2, stallMode: 'aus', vars: { twist: false } });
  assert.strictEqual(opt.dims, 3 * 4 + 3);
  while (!opt.done) opt.step();
  const r = opt.result();
  assert.ok(r.gain > 0.02, r.gain);
  r.after.stations.slice(1).forEach(s => assert.ok(s.thickness >= 0.08 - 1e-9, s.thickness));
  near(r.after.stations[0].thickness, r.before.stations[0].thickness, 1e-12, 'Wurzel bleibt');
  const crit = r.after.points[2];
  assert.ok(crit.stall <= r.limits.stallLimit + 0.02, crit.stall);
  r.after.stations.slice(1).forEach(s => assert.ok(s.cm0 >= r.limits.cm0Min - 0.005, s.cm0));
  // Übernahme: Stationen mit Wurzelprofil und neuen Kennwerten, Klappenwinkel als Flugzustände
  const m2 = S.apply(m, r);
  assert.ok(m2.wing.stations.every(s => s.profileId === e.id));
  near(m2.wing.stations[2].thickness, r.after.stations[2].thickness, 1e-5, 'Dicke übernommen');
  assert.deepStrictEqual(m2.flaps.modes.map(q => q.name), ['Speed', 'Gleiten', 'Thermik']);
  assert.strictEqual(m.wing.stations[2].thickness, null, 'Original bleibt unverändert');
  // Gegenprobe mit der normalen Modellrechnung beim Gleiten
  const g = r.after.points[1], b = r.before.points[1];
  const at = (mm, flap) => M.analyze(M.withFlap(mm, flap), pj.profiles).table.find(t => Math.abs(t.cl - 0.45) < 1e-9).E;
  assert.ok(at(m2, g.flap) > at(m, b.flap), 'normale Rechnung bestätigt den Gewinn');
});

test('Klappenschar: Hüllkurve nimmt je Ca die beste Stellung', () => {
  const { pj, m } = setup();
  const fs = S.flapSeries(m, pj.profiles, [-2, 0, 4]);
  while (!fs.done) fs.next();
  const env = fs.envelope();
  assert.ok(env.length > 10);
  for (const t of env.filter((_, i) => i % 4 === 0)) {
    const all = fs.results.map(q => q.r.table.find(x => Math.abs(x.cl - t.cl) < 1e-9)).filter(x => x && !x.stall);
    assert.strictEqual(t.E, Math.max(...all.map(x => x.E)));
  }
  // Mischer-Plan: Klappe steigt mit Ca, kaum schlechter als die Hüllkurve
  const mono = fs.envelope({ monotone: true });
  assert.strictEqual(mono.length, env.length);
  mono.slice(1).forEach((t, i) => assert.ok(t.flap >= mono[i].flap, [mono[i].flap, t.flap]));
  mono.forEach((t, i) => assert.ok(t.E >= env[i].E * 0.97, [t.cl, t.E, env[i].E]));
});

test('Kreisflug: enger Kreis sinkt mehr, Innenflügel bleibt unter der Grenze, Querneigung aus Radius und Fahrt', () => {
  const { pj, m } = setup();
  const fs = S.flapSeries(m, pj.profiles, [0, 4]);
  while (!fs.done) fs.next();
  const rows = S.circling(fs.results, [12, 20, 40], { margin: 0.1 });
  const b = rows.map(q => q.best);
  b.forEach(q => assert.ok(q && q.inner <= 0.9 + 1e-9, q && q.inner));
  assert.ok(b[0].sink > b[1].sink && b[1].sink > b[2].sink, b.map(q => q.sink));
  assert.ok(b[0].bank > b[1].bank && b[1].bank > b[2].bank, b.map(q => q.bank));
  for (const q of b) {
    const phi = q.bank * Math.PI / 180;
    near(q.R, q.v * q.v / (9.81 * Math.tan(phi)), 1e-6 * q.R, 'Radius = V²/(g·tan φ)');
    near(q.n, 1 / Math.cos(phi), 1e-9, 'n');
  }
  // engster Kreis: nicht möglich, weil der Innenflügel abreisst
  assert.strictEqual(S.circling(fs.results, [2])[0].best, null);
});

test('Höhenruder: Wirksamkeit wie dünne Profiltheorie, Ausschlag gedämpft und Pendel', () => {
  const { m } = setup();
  m.tail.stations.forEach(s => { s.flapDepth = 30; });
  const tau = M.elevatorTau(m.tail.stations);
  near(tau, 1 - (Math.acos(-0.4) - Math.sin(Math.acos(-0.4))) / Math.PI, 0.03, 'τ bei 30 % Rudertiefe');
  near(M.elevatorDeflection(m, 1, 2), 1 / tau, 1e-9, 'gedämpft: weniger EWD heisst Ruder nach unten');
  m.tail.elevator = { type: 'pendel', ewd: 1.5 };
  near(M.elevatorDeflection(m, 1, 2), 0.5, 1e-9, 'Pendel mit eigener Bezugs-EWD');
  m.tail.elevator = { type: 'gedaempft' };
  m.tail.stations.forEach(s => { s.flapDepth = 0; });
  assert.strictEqual(M.elevatorDeflection(m, 1, 2), null, 'ohne Ruder kein Ausschlag');
});

test('Abrissverhalten: stark zugespitzter Flügel reisst aussen ab, der Optimierer macht ihn gutmütig', () => {
  const { pj, m } = setup();
  Object.assign(m.wing.stations[2], { chord: 150 }); Object.assign(m.wing.stations[3], { chord: 70, offset: 60 });
  const opt = S.optimizer(m, pj.profiles, { maxEvals: 250, stallMode: 'gutmuetig', seed: 2 });
  while (!opt.done) opt.step();
  const r = opt.result();
  assert.strictEqual(r.before.points[2].stallAt.rating, 'kritisch');
  assert.strictEqual(r.after.points[2].stallAt.rating, 'gutmütig');
  // Gegenprobe mit der normalen Modellrechnung beim Thermik-Ca
  const full = (mm, flap) => { const q = M.withFlap(mm, flap); q.clDesign = 0.8; return M.analyze(q, pj.profiles).stallAt; };
  assert.strictEqual(full(m, r.before.points[2].flap).rating, 'kritisch');
  assert.notStrictEqual(full(S.apply(m, r), r.after.points[2].flap).rating, 'kritisch');
  assert.ok(S.apply(m, r).wing.stations[3].twist < r.before.stations[3].twist + 1e-9, 'Schränkung aussen nicht positiver');
});

test('Strak-Optimierer: nie schlechter als vorher, auch nicht in einem einzelnen Arbeitspunkt', () => {
  const { pj, m } = setup();
  const opt = S.optimizer(m, pj.profiles, { maxEvals: 200, seed: 3 });
  while (!opt.done) opt.step();
  const r = opt.result(), total = R => R.score + R.penalties.sum;
  assert.ok(total(r.after) <= total(r.before) + 1e-9, [total(r.after), total(r.before)]);
  r.after.points.forEach((p, k) => assert.ok(p.cd <= r.before.points[k].cd * 1.002, `${p.name}: ${p.cd} statt ${r.before.points[k].cd}`));
  // findet die Suche nichts (keine Bewertung), bleibt das Modell unverändert
  const none = S.optimizer(m, pj.profiles, { maxEvals: 1, seed: 3 });
  const r0 = none.result();
  assert.strictEqual(r0.kept, true);
  assert.deepStrictEqual(S.apply(m, r0), JSON.parse(JSON.stringify(m)));
});
