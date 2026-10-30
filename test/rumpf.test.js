const test = require('node:test');
const assert = require('node:assert');
const F = require('../web/core/rumpf.js');
const PR = require('../web/core/projekt.js');
const M = require('../web/core/modell.js');
const V = require('../web/core/vlm.js');
const LIB = require('../web/core/bibliothek.js');

const setup = () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  return { pj, m: PR.createModel('Test', e.id, h.id) };
};

test('Rumpf: Form reicht von der Nase bis zum Leitwerk, dicke Keule hat mehr Fläche und Widerstand', () => {
  const { m } = setup();
  const S = V.planform(m.wing.stations).area, out = {};
  for (const type of Object.keys(F.TYPES)) {
    m.fuselage = { type, nose: 400 };
    const s = F.shape(m);
    assert.strictEqual(s.x0, -400);
    assert.ok(s.x3 >= m.tail.x + m.tail.stations[0].chord);
    assert.ok(Math.max(...s.pts.map(p => p.r)) <= s.D / 2 + 1e-9);
    out[type] = { swet: s.swet, cd: F.drag(s, 12, S) };
  }
  assert.ok(out.stab.swet < out['keule-klein'].swet && out['keule-klein'].swet < out['keule-gross'].swet);
  assert.ok(out.stab.cd < out['keule-klein'].cd && out['keule-klein'].cd < out['keule-gross'].cd);
  // Grössenordnung: Rumpf eines 2,5-m-Seglers Cw 0,0005 … 0,005 auf die Flügelfläche
  for (const o of Object.values(out)) assert.ok(o.cd > 5e-4 && o.cd < 5e-3, o.cd);
});

test('Rumpf: schiebt den Neutralpunkt nach vorn, mehr bei dicker und langer Nase (Grössenordnung wie Raymer)', () => {
  const { pj, m } = setup();
  const np = f => { m.fuselage = f; return M.analyze(m, pj.profiles); };
  const a = np({ type: 'stab', nose: 400 }), b = np({ type: 'keule-gross', nose: 400 }), c = np({ type: 'keule-gross', nose: 700 });
  assert.ok(a.fuselage.dNP < 0 && b.fuselage.dNP < a.fuselage.dNP && c.fuselage.dNP < b.fuselage.dNP, [a.fuselage.dNP, b.fuselage.dNP, c.fuselage.dNP]);
  assert.ok(Math.abs(a.xNP0 - b.xNP0) < 1e-6, 'ohne Rumpf gleich');
  // Raymer: dCm/dα = K·W²·L/(c·S) je Grad, K ≈ 0,011 bei Flügel auf 30 % der Rumpflänge
  const W = b.fuselage.D, L = b.fuselage.length, raymer = 0.011 * W * W * L / (b.wing.mac * b.wing.area) / (b.CLalpha * Math.PI / 180) * b.wing.mac;
  assert.ok(Math.abs(-b.fuselage.dNP - raymer) < 0.6 * raymer, [b.fuselage.dNP, raymer]);
});

test('Gesamtpolare: Rumpf und Seitenleitwerk machen die Gleitzahl kleiner', () => {
  const { pj, m } = setup();
  m.fuselage = { type: 'stab', nose: 300, fin: 0 };
  const a = M.analyze(m, pj.profiles);
  m.fuselage = { type: 'keule-gross', nose: 300, fin: 5 };
  const b = M.analyze(m, pj.profiles);
  assert.ok(b.best.E < a.best.E, [a.best.E, b.best.E]);
  const t = b.table.find(q => q.cl === 0.5);
  assert.ok(Math.abs(t.cd - (t.cdi + t.cdw + t.cdt + t.cdf + t.cdv)) < 1e-12 && t.cdv > 0);
  assert.strictEqual(F.finArea({ ...m, fuselage: { fin: null }, tail: { ...m.tail, stations: m.tail.stations.map(s => ({ ...s, dihedral: 40 })) } }, 1e5), 0, 'V-Leitwerk ohne SLW');
});

test('Zusatzwiderstände: ohne Eingaben unverändert, jeder Zuschlag senkt die Gleitzahl', () => {
  const { pj, m } = setup();
  const best = d => { m.drag = d; return M.analyze(m, pj.profiles).best; };
  const a = best(undefined);
  assert.ok(Math.abs(a.cd - a.cdBase) < 1e-12 && a.cdx === 0);
  for (const d of [{ profile: 1.2 }, { other: 10 }, { drive: 'klapp' }, { drive: 'starr' }, { horns: 4 }, { gaps: 'offen' }]) {
    const b = best(d);
    assert.ok(b.E < a.E - 0.05, JSON.stringify(d) + ' ' + b.E + ' ' + a.E);
  }
  // starre Luftschraube bremst viel mehr als die angeklappte
  assert.ok(best({ drive: 'starr' }).E < best({ drive: 'klapp' }).E - 1);
  // Faktor wirkt genau auf die Profile
  const S = V.planform(m.wing.stations).area, x = F.withExtras({ ...m, drag: { profile: 1.5 } }, S, { cdi: 0.003, cdw: 0.01, cdt: 0.001, cdf: 0.001, cdv: 0.0005 });
  assert.ok(Math.abs(x.cd - (0.003 + 0.015 + 0.0015 + 0.001 + 0.00075)) < 1e-12);
  // Anlenkung: 0,4 cm² je Stück
  const h = F.extraFixed({ ...m, drag: { horns: 2 } }, S);
  assert.ok(Math.abs(h.horns * S - 80) < 1e-9);
});
