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
  // Trennstelle: zwei Ruder, zusammen das Ganze, das innere (tiefere) trägt mehr je Länge
  m.wing.struct = { link: { cuts: [m.wing.stations[1].y] } };
  const two = S.analyze(m, project.profiles, r, { project }).servo.filter(q => q.part === 'wing');
  assert.strictEqual(two.length, 2);
  near(two[0].momentDown + two[1].momentDown, s.momentDown, 1e-9, 'Summe der Stücke');
  assert.ok(two[0].momentDown / (two[0].y1 - two[0].y0) > two[1].momentDown / (two[1].y1 - two[1].y0));
  delete m.wing.struct;
  m.loads.vMax = 80;
  const s2 = S.analyze(m, project.profiles, r, { project }).servo[0];
  assert.ok(Math.abs(s2.moment) > 3 * Math.abs(s.moment));
});

test('Klappengruppen', () => {
  const st = [{ y: 0, flapDepth: 25 }, { y: 100, flapDepth: 25 }, { y: 200, flapDepth: 0 }, { y: 300, flapDepth: 20 }, { y: 400 }];
  const g = S.flapGroups(st);
  assert.deepStrictEqual(g.map(q => [q.y0, q.y1]), [[0, 200], [300, 400]]);
});

test('F2: EI und GJ, Balken gegen die Handrechnung, Reserve', () => {
  const { project, m, r } = setup();
  const mats = S.materials(project), rows = S.stations(m, project.profiles, 'wing', mats);
  // EI an der Wurzel mindestens der Steiner-Anteil der Gurte, GJ > 0, beide fallen nach aussen
  const st = S.structOf(m, 'wing'), q = rows[0], z = q.hOut / 2 - q.tCap / 2;
  assert.ok(q.EI >= mats[st.spar.mat].E * 2 * q.aCap * z * z * 0.9, 'EI ' + q.EI);
  assert.ok(q.GJ > 0 && rows[rows.length - 1].EI < q.EI && rows[rows.length - 1].GJ < q.GJ);
  // Kragbalken mit konstantem EI und Einzellast am Ende: w = F·L³ / (3·EI), Randdehnung = M·z / EI
  const L = 1000, F = 10, EI = 1e9, GJ = 5e8, n = 200;
  const flat = [0, L].map(y => ({ y, EI, GJ, aCap: 10, zCapT: 10, zCapB: -10, zTop: 12, zBot: -12, hShear: 18, aCell: 2000, gtShell: 500 }));
  const ys = Array.from({ length: n + 1 }, (_, i) => L * i / n);
  const c = { label: 't', M: ys.map(y => F * (L - y) / 1000), Q: ys.map(() => F), T: ys.map(() => 2) };
  const res = S.stress(flat, { spar: { mat: 'cfk-roving' }, web: { mat: 'balsa', t: 2 }, shell: { layers: [{ mat: 'gfk-gewebe', t: 0.1, angle: 45 }] } }, mats, ys, c);
  near(res.tipW, F * L ** 3 / (3 * EI), 1e-3 * F * L ** 3 / (3 * EI), 'Durchbiegung');
  near(res.tipPhi, 2000 * L / GJ * 180 / Math.PI, 1e-6, 'Verwindung');
  near(res.eps[0], F * L * 10 / EI * 100, 1e-9, 'Dehnung');
  // Druckgurt oben: Reserve = σ Druck / (E · ε)
  near(res.rCap[0], mats['cfk-roving'].sigC / (mats['cfk-roving'].E * F * L * 10 / EI), 1e-6, 'Gurt');
  near(res.rWeb[0], mats.balsa.tau / (F / (2 * 18)), 1e-9, 'Steg');
  // ganzes Modell: mehr Gurt gibt mehr Reserve und weniger Durchbiegung
  const a = S.analyze(m, project.profiles, r, { project });
  m.wing.struct = { spar: { t0: 3, t1: 1, b: 20 } };
  const b = S.analyze(m, project.profiles, r, { project });
  const ca = a.wing.cases[0], cb = b.wing.cases[0];
  assert.ok(cb.tipW < ca.tipW && cb.tipW > 0, `Durchbiegung ${ca.tipW} → ${cb.tipW}`);
  assert.ok(b.wing.use[0].reserve > a.wing.use[0].reserve);
  assert.ok(Number.isFinite(a.wing.worst.reserve) && a.wing.worst.what);
});

test('Gewebe: Flächengewicht statt Dicke', () => {
  // 49 g/m² Glas, Faserdichte 2550, Faservolumenanteil 0,38 → 0,0506 mm
  assert.ok(Math.abs(S.fabricT('gfk-gewebe', 49) - 49 / (2550 * 0.38)) < 1e-9);
  assert.ok(Math.abs(S.fabricT('cfk-gewebe', 160) - 0.214) < 0.002);
  assert.equal(S.fabricT('balsa', 100), 0);
  const m = { wing: { struct: { shell: { layers: [{ mat: 'cfk-gewebe', g: 160, angle: 45 }, { mat: 'balsa', t: 1.2, angle: 0 }, { mat: 'gfk-gewebe', t: 0.05, angle: 45 }] } } } };
  const L = S.structOf(m, 'wing').shell.layers;
  assert.ok(Math.abs(L[0].t - 0.214) < 0.002);
  assert.equal(L[1].t, 1.2); assert.equal(L[1].g, undefined);
  assert.equal(L[2].g, 48);                       // alte Projekte mit Dicke: Gewicht wird daraus bestimmt
  assert.ok(Math.abs(L[2].t - 0.05) < 0.002);
});

test('Holmgurt aus Rovings: Anzahl × tex, linear oder elliptisch', () => {
  const { project, m, r } = setup();
  m.loads = { n: 20, vMax: 50 };
  // 24k-Roving 1600 tex bei 50 % Faser: 1600 / 1780 / 0,5 = 1,80 mm² Laminat
  const sp = S.sparOf(S.TEMPLATES.schale.spar, { input: 'roving', tex: 1600, phi: 50 });
  assert.ok(Math.abs(S.rovOf(sp).a1 - 1600 / 1780 / 0.5) < 1e-9);
  assert.strictEqual(sp.n0, Math.round(12 * 1.2 / S.rovOf(sp).a1)); // aus der bisherigen Gurtdicke
  assert.strictEqual(S.texList('gfk-roving'), S.TEX.glas);
  const res = {};
  for (const taper of ['linear', 'ellipse']) {
    m.wing.struct = { spar: { input: 'roving', tex: 800, phi: 50, taper, n0: 24, n1: 2 } };
    const a = S.analyze(m, project.profiles, r, { project }), P = a.wing, pl = P.plan;
    assert.strictEqual(pl.mode, taper);
    assert.strictEqual(pl.ends.length, 22);
    // Stationen tragen die Anzahl, nach aussen nie mehr, an der Wurzel n0, am Rand n1
    const ns = P.stations.map(q => q.n);
    for (let i = 1; i < ns.length; i++) assert.ok(ns[i] <= ns[i - 1]);
    assert.strictEqual(ns[0], 24); assert.strictEqual(ns[ns.length - 1], 2);
    assert.strictEqual(S.countAt(pl, 0), 24);
    // Gurtfläche = n · Roving, solange er in die Profilhöhe passt
    const q = P.stations[0]; if (!q.capCut) near(q.aCap, 24 * 800 / 1780 / 0.5, 1e-6);
    assert.ok(P.rov && P.rov.w.length === P.ys.length && P.rov.fiber.g > 0);
    assert.strictEqual(P.stations.filter(x => x.st).length, m.wing.stations.length);
    res[taper] = { P, n: P.ys.length };
  }
  // linear biegt sich innen stärker, elliptisch mehr nach aussen hin und spart Rovings
  const mid = x => x.P.rov.w[x.n >> 1] / x.P.rov.w[x.n - 1];
  assert.ok(mid(res.ellipse) < mid(res.linear), `${mid(res.ellipse)} < ${mid(res.linear)}`);
  assert.ok(res.ellipse.P.rov.fiber.g < res.linear.P.rov.fiber.g);
  // elliptisch: kein Gurt stärker gedehnt als an der Wurzel (2 % Rundung), Biegelinie nahe am Ellipsenbogen
  const P = res.ellipse.P, c = P.cases.find(x => x.key === P.rov.caseKey);
  c.eps.forEach(e => assert.ok(e <= c.eps[0] * 1.05, `Dehnung ${e} > ${c.eps[0]}`));
  const tip = P.rov.target[res.ellipse.n - 1];
  assert.ok(Math.abs(P.rov.w[res.ellipse.n - 1] - tip) < 0.25 * tip, `Rand ${P.rov.w[res.ellipse.n - 1]} vs Ellipse ${tip}`);
  // Dickenangabe bleibt wie bisher
  m.wing.struct = { spar: { t0: 1.2, t1: 0.3 } };
  const d = S.analyze(m, project.profiles, r, { project });
  assert.ok(!d.wing.plan && !d.wing.rov && d.wing.stations.length === m.wing.stations.length);
});
