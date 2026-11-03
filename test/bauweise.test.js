const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const M = require('../web/core/modell.js');
const S = require('../web/core/strak.js');
const LIB = require('../web/core/bibliothek.js');

const setup = () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  return { pj, m: PR.createModel('Test', e.id, h.id) };
};
const rib = { type: 'rippen', top: 30, bot: 30, ribs: 50, cover: 'folie' };

test('Bauweise: vollbeplankt ändert nichts, Rippen setzen Umschlag und Bespannungszuschlag', () => {
  assert.deepStrictEqual(M.buildEffect(M.buildOf({}), 200), { xtrTop: 1, xtrBot: 1, cdCover: 0 });
  const a = M.buildEffect(M.buildOf({ build: rib }), 200), b = M.buildEffect(M.buildOf({ build: rib }), 100);
  assert.strictEqual(a.xtrTop, 0.3); assert.strictEqual(a.xtrBot, 0.3);
  // k · s/l · bespannter Anteil = 0,003 · 0,25 · 0,7
  assert.ok(Math.abs(a.cdCover - 0.000525) < 1e-9, a.cdCover);
  assert.ok(b.cdCover > a.cdCover, 'kleine Tiefe: mehr Zuschlag');
  assert.strictEqual(M.buildEffect(M.buildOf({ build: { ...rib, bot: 0 } }), 200).xtrBot, 0.03);
  const g = M.buildEffect(M.buildOf({ build: { ...rib, cover: 'gewebe' } }), 200);
  assert.ok(g.cdCover > a.cdCover);
});

test('Rippenflügel mit Nasenbeplankung: mehr Profilwiderstand, schlechtere Gleitzahl, Optimierer rechnet gleich', () => {
  const { pj, m } = setup();
  const full = M.analyze(m, pj.profiles);
  const r = JSON.parse(JSON.stringify(m)); r.wing.build = rib; r.tail.build = rib;
  const ribbed = M.analyze(r, pj.profiles);
  const at = (res, cl) => res.table.find(t => Math.abs(t.cl - cl) < 1e-6);
  for (const cl of [0.3, 0.6]) {
    assert.ok(at(ribbed, cl).cdw > at(full, cl).cdw * 1.05, `Flügel bei Ca ${cl}`);
    assert.ok(at(ribbed, cl).cdt > at(full, cl).cdt, `Leitwerk bei Ca ${cl}`);
  }
  assert.ok(ribbed.best.E < full.best.E);
  // Gleichgewicht und Neutralpunkt hängen nicht von der Bauweise ab
  assert.ok(Math.abs(ribbed.xNP - full.xNP) < 1e-9);
  // schnelle Bewertung des Optimierers sieht die Bauweise auch und trifft die Modellrechnung
  const points = [{ name: 'Speed', cl: 0.2 }, { name: 'Thermik', cl: 0.8 }];
  const ctx = S.context(r, pj.profiles, { points });
  const ev = S.evaluate(ctx, M.resolveTe(r).wing.stations.map(s => S.designOf(s, pj.profiles)), points.map(() => 0));
  ev.points.forEach(p => {
    const t = ribbed.table.find(q => Math.abs(q.cl - p.cl) < 1e-9);
    assert.ok(Math.abs(p.E / t.E - 1) < 0.03, `Gleitzahl ${p.name}: ${p.E} statt ${t.E}`);
  });
});
