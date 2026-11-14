const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const M = require('../web/core/modell.js');
const S = require('../web/core/struktur.js');

function setup() {
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  m.wing.stations[0].flapDepth = 25; m.wing.stations[1].flapDepth = 25;
  m.loads = { n: 10, vMax: 40 };
  const r = M.analyze(m, project.profiles, { nCrit: 9 });
  return { project, m, r };
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('Querschnitte der Halbfabrikate', () => {
  near(S.section({ form: 'rund', d: 10 }).W, Math.PI * 1000 / 32, 1e-9);
  const rohr = S.section({ form: 'rohr', d: 10, di: 8 });
  near(rohr.A, Math.PI * (100 - 64) / 4, 1e-9); near(rohr.I, Math.PI * (1e4 - 4096) / 64, 1e-9);
  near(S.section({ form: 'vierkant', b: 4, h: 6 }).W, 4 * 36 / 6, 1e-9);
  const vr = S.section({ form: 'vierkantrohr', b: 10, h: 10, t: 1 });
  near(vr.A, 100 - 64, 1e-9); near(vr.I, (1e4 - 4096) / 12, 1e-9);
  near(S.rovingArea(10, 1600, 0.5), 10 * 1.6e-3 / 1.78e-3 / 0.5, 1e-9);
});

test('Materialien: Bibliothek, Änderung und eigenes Material im Projekt', () => {
  const mats = S.materials({ materials: { balsa: { rho: 120 }, 'eigen-1': { name: 'Mein Stab', E: 1, G: 1, sigT: 1, sigC: 1, tau: 1, rho: 1 } } });
  assert.strictEqual(mats.balsa.rho, 120); assert.ok(mats.balsa.changed); assert.strictEqual(mats.balsa.E, S.MATERIALS.balsa.E);
  assert.ok(mats['eigen-1'].own); assert.strictEqual(mats['cfk-stab'].group, 'Halbfabrikat');
});

test('Aufbau: Vorlage, Überschreibungen, Masse', () => {
  const { project, m } = setup();
  assert.strictEqual(S.structOf(m, 'wing').template, 'schale');
  m.wing.build = { type: 'rippen' }; assert.strictEqual(S.structOf(m, 'wing').template, 'rippen'); delete m.wing.build;
  m.wing.struct = { spar: { b: 20 } };
  const st = S.structOf(m, 'wing'); assert.strictEqual(st.spar.b, 20); assert.strictEqual(st.spar.pos, 30);
  const rows = S.stations(m, project.profiles, 'wing', S.materials(project));
  assert.strictEqual(rows.length, m.wing.stations.length);
  assert.ok(rows[0].hOut > 10 && rows[0].hOut < 0.2 * m.wing.stations[0].chord);
  assert.ok(rows[0].massPerM > rows[rows.length - 1].massPerM);
  const mass = S.massOf(rows); assert.ok(mass > 100 && mass < 1500, 'Masse ' + mass);
});

test('Balken: Einzellast', () => {
  const b = S.beam([{ y: 1000, width: 10, lift: 10, weight: 0, torque: 0.5 }], [0, 500, 1200]);
  near(b.Q[0], 10, 1e-9); near(b.M[0], 10, 1e-9); near(b.M[1], 5, 1e-9); near(b.T[0], 0.5, 1e-9);
  assert.strictEqual(b.Q[2], 0); assert.strictEqual(b.M[2], 0);
});

test('Lastfälle: Auftrieb = n · Gewicht, Momente plausibel, Verbinder, Anlenkung', () => {
  const { project, m, r } = setup();
  const a = S.analyze(m, project.profiles, r, { project });
  const mg = m.mass / 1000 * 9.81;
  const ab = a.wing.cases.find(c => c.key === 'abfangen');
  near(ab.n, Math.min(10, a.meta.nReach), 1e-9);
  // Flügel plus Leitwerk tragen n · G
  const tail = a.tail.cases.find(c => c.key === 'abfangen');
  near(ab.lift + tail.lift, ab.n * mg, 0.06 * ab.n * mg, 'Auftrieb');
  // Biegemoment an der Wurzel: Kraft der Hälfte mal Hebel zwischen 30 und 50 % der Halbspannweite
  const b2 = m.wing.stations[m.wing.stations.length - 1].y / 1000, arm = ab.rootM / ab.rootQ;
  assert.ok(arm > 0.3 * b2 && arm < 0.5 * b2, 'Hebel ' + arm);
  for (let i = 1; i < ab.M.length; i++) assert.ok(ab.M[i] <= ab.M[i - 1] + 1e-9);
  near(ab.M[ab.M.length - 1], 0, 1e-9);
  // Landung drückt nach unten, Schnellflug dreht die Nase runter (gewölbtes Profil)
  assert.ok(a.wing.cases.find(c => c.key === 'landung').rootM < 0);
  assert.ok(a.wing.cases.find(c => c.key === 'speed').rootT < 0);
  // Verbinder: σ = M / W
  const j = a.wing.joiner; near(j.sigma, j.M * 1000 / j.W, 1e-6); near(j.reserve, j.allow / j.sigma, 1e-9);
  // Anlenkung: eine Klappe, Kraft = Moment / Horn, wächst mit V²
  assert.strictEqual(a.servo.filter(s => s.part === 'wing').length, 1);
  const s = a.servo[0]; assert.ok(Math.abs(s.moment) > 0); near(s.force, Math.abs(s.moment) * 1000 / s.horn, 1e-9); near(s.torque, s.force * s.arm / 10, 1e-9);
  assert.ok(s.momentDown > 0 && s.momentUp < s.momentDown, 'Klappe nach unten wird nach oben gedrückt');
  m.loads.vMax = 80;
  const s2 = S.analyze(m, project.profiles, r, { project }).servo[0];
  assert.ok(Math.abs(s2.moment) > 3 * Math.abs(s.moment));
});

test('Klappengruppen', () => {
  const st = [{ y: 0, flapDepth: 25 }, { y: 100, flapDepth: 25 }, { y: 200, flapDepth: 0 }, { y: 300, flapDepth: 20 }, { y: 400 }];
  const g = S.flapGroups(st);
  assert.deepStrictEqual(g.map(q => [q.y0, q.y1]), [[0, 200], [300, 400]]);
});
