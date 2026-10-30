const test = require('node:test');
const assert = require('node:assert');
const E = require('../web/core/excel.js');
const PR = require('../web/core/projekt.js');
const M = require('../web/core/modell.js');
const LIB = require('../web/core/bibliothek.js');

// Zellwerte aus SB10 M1_5.xls und lak19_15m.xls, Blatt „Masse, SP“ (Formeln mit ihrem Ergebnis)
const sheet = name => { const c = require(`./fixtures/excel-${name}.json`); return a => c[a]; };

test('Excel-Import SB-10: Geometrie, Gewicht und Schwerpunkt wie im Blatt', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText: LIB.hq309 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const { model } = E.modelFromSheet(sheet('sb10'), { wingProfileId: e.id, tailProfileId: h.id });
  assert.strictEqual(model.name, 'SB-10 M1:5');
  assert.strictEqual(model.mass, 7500);
  assert.deepStrictEqual(model.cg, { mode: 'sigma', sigma: 0.2, x: 106 });
  assert.strictEqual(model.wing.stations.length, 6);
  assert.strictEqual(model.wing.stations[1].dihedral, 2.25, 'V-Form D21 gehört zum Trapez von Station 1 nach 2');
  // C12 = 9.1 dm ab Endleiste Wurzel (207.58 mm) → Nasenleiste HLW bei 1117.6 mm
  assert.strictEqual(model.tail.x, 1118);
  const r = M.analyze(model, pj.profiles);
  assert.ok(Math.abs(r.wing.area / 1e4 - 97.9079688) < 0.01, r.wing.area);       // B5
  assert.strictEqual(r.wing.span, 5800);                                          // B4
  assert.ok(Math.abs(r.tail.area / 1e4 - 7.1156899) < 0.01, r.tail.area);         // C5
  // Handrechnung trifft den Neutralpunkt des Blatts: (B51 + F49·B49)·10 = 81.8 mm
  assert.ok(Math.abs(r.hand.xNP - 81.8) < 0.3, r.hand.xNP);
  assert.ok(Math.abs(r.xNP0 - r.hand.xNP) < 3, [r.xNP0, r.hand.xNP]); // Blatt ohne Rumpf
  assert.ok(r.xNP < r.xNP0, 'Rumpf schiebt den Neutralpunkt nach vorn');
});

test('Excel-Import Lak 19: Randbogen wird zur letzten Station, leere Spalten fallen weg', () => {
  const { model } = E.modelFromSheet(sheet('lak19'));
  const st = model.wing.stations;
  assert.deepStrictEqual(st.map(s => s.y), [0, 100, 1480, 2450, 2500]);
  assert.strictEqual(st[4].chord, 20);
  assert.strictEqual(model.mass, 9000);
  assert.strictEqual(model.tail.stations.length, 3);
});

test('Excel-Import: Blatt ohne Flügeldaten gibt eine verständliche Meldung', () => {
  assert.throws(() => E.modelFromSheet(() => undefined), /Flügeldaten/);
});
