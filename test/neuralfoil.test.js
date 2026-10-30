// Vergleich mit dem Python-Original (test/fixtures/nf-referenz.json, erzeugt mit scripts/nf-referenz.py)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../web/core/profil.js');
const NF = require('../web/core/neuralfoil.js');

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nf-referenz.json'), 'utf8'));
const dat = name => P.parseDat(fs.readFileSync(path.join(__dirname, '..', 'web', 'profile', name + '.dat'), 'utf8')).coords;

test('Kulfan-Parameter wie AeroSandbox', () => {
  for (const c of ref.filter(c => c.kulfan)) {
    const k = NF.kulfanFit(dat(c.kulfan_profil));
    k.upper.forEach((v, i) => assert.ok(Math.abs(v - c.kulfan.upper_weights[i]) < 1e-9, c.kulfan_profil + ' oben ' + i));
    k.lower.forEach((v, i) => assert.ok(Math.abs(v - c.kulfan.lower_weights[i]) < 1e-9, c.kulfan_profil + ' unten ' + i));
    assert.ok(Math.abs(k.leWeight - c.kulfan.leading_edge_weight) < 1e-9);
    assert.ok(Math.abs(k.teThickness - c.kulfan.TE_thickness) < 1e-9);
  }
});

test('Ca, Cw, Cm, Umschlag und Konfidenz wie NeuralFoil in Python', () => {
  for (const c of ref) {
    const at = NF.prepare(dat(c.profil));
    c.alpha.forEach((a, i) => {
      const r = at(a, c.Re, c.ncrit);
      const tag = `${c.profil} Re ${c.Re} α ${a}`;
      assert.ok(Math.abs(r.cl - c.CL[i]) < 1e-9, tag + ' Ca');
      assert.ok(Math.abs(r.cd - c.CD[i]) / c.CD[i] < 1e-9, tag + ' Cw');
      assert.ok(Math.abs(r.cm - c.CM[i]) < 1e-9, tag + ' Cm');
      assert.ok(Math.abs(r.xtrTop - c.Top_Xtr[i]) < 1e-9, tag + ' Umschlag oben');
      assert.ok(Math.abs(r.xtrBot - c.Bot_Xtr[i]) < 1e-9, tag + ' Umschlag unten');
      assert.ok(Math.abs(r.conf - c.conf[i]) < 1e-9, tag + ' Konfidenz');
    });
  }
});

test('lstsq löst ein überbestimmtes System', () => {
  const A = [[1, 0], [0, 1], [1, 1]], b = [1, 2, 3];
  const x = NF.lstsq(A, b);
  assert.ok(Math.abs(x[0] - 1) < 1e-12 && Math.abs(x[1] - 2) < 1e-12);
});
