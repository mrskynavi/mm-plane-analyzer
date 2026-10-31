const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../web/core/profil.js');
const POL = require('../web/core/polare.js');

const e374 = P.parseDat(fs.readFileSync(path.join(__dirname, '..', 'web', 'profile', 'e374.dat'), 'utf8')).coords;

test('Typ-1-Polare E374 bei Re 200 000 ist plausibel', () => {
  const r = POL.compute(e374, { re: 200000, alphaFrom: -4, alphaTo: 10, alphaStep: 1 });
  const s = r.summary;
  assert.strictEqual(r.points.length, 15);
  assert.ok(s.alpha0 < -1 && s.alpha0 > -4, 'Nullauftriebswinkel ' + s.alpha0);
  assert.ok(s.cm0 < -0.02 && s.cm0 > -0.08, 'Cm0 ' + s.cm0);
  assert.ok(s.slopePerDeg > 0.09 && s.slopePerDeg < 0.12, 'Anstieg ' + s.slopePerDeg);
  assert.ok(s.cdMin > 0.005 && s.cdMin < 0.015, 'Cw min ' + s.cdMin);
  assert.ok(s.ldMax > 50 && s.ldMax < 120, 'Gleitzahl ' + s.ldMax);
});

test('Typ-2-Polare: Re·√Ca bleibt konstant', () => {
  const K = 150000;
  const r = POL.compute(e374, { type: 2, re: K, alphaFrom: 0, alphaTo: 8, alphaStep: 2 });
  for (const p of r.points) if (p.cl > 0.05) assert.ok(Math.abs(p.re * Math.sqrt(p.cl) - K) / K < 0.01, `α ${p.alpha}: Re ${p.re}`);
});

test('Hüllkurve wählt pro Ca die beste Klappe', () => {
  const flaps = [-4, 0, 6].map(d => ({ flap: d, points: POL.compute(P.flap(e374, d, 0.78), { re: 200000, alphaFrom: -6, alphaTo: 10, alphaStep: 0.5 }).points }));
  const env = POL.envelope(flaps, 0, 1.2, 0.1);
  const at = cl => env.find(e => Math.abs(e.cl - cl) < 1e-6);
  assert.ok(at(0.1).flap <= 0, 'Speed: Klappe hoch oder neutral bei Ca 0.1');
  assert.ok(at(1.1).flap === 6, 'Thermik: Klappe unten bei Ca 1.1');
  for (const e of env) for (const f of flaps) {
    const cd = POL.cdAtCl(f.points, e.cl);
    if (Number.isFinite(cd)) assert.ok(e.cd <= cd + 1e-12);
  }
});

test('Re·√Ca aus Flächenbelastung und Tiefe', () => {
  // 77 g/dm², 170 mm: V(Ca=1) = √(2·75.5/1.225) = 11.1 m/s → Re√Ca ≈ 126 000
  const k = POL.reSqrtCl(77, 170);
  assert.ok(Math.abs(k - 125800) < 1500, String(k));
});

test('Kennzahlen: dünneres Profil hat im Speedbereich weniger Widerstand', () => {
  const o = { type: 2, re: 120000, alphaFrom: -4, alphaTo: 10, alphaStep: 0.5 };
  const a = POL.metrics(POL.compute(P.modify(e374, {}), o).points, 0.05, 0.4);
  const b = POL.metrics(POL.compute(P.modify(e374, { thickness: 0.8, camber: 0.7 }), o).points, 0.05, 0.4);
  assert.strictEqual(a.covered, 1);
  assert.ok(b.cdMean < a.cdMean, `${b.cdMean} < ${a.cdMean}`);
  assert.ok(a.climbMax > 0 && a.ldMax > 30);
  assert.ok(Number.isNaN(POL.metrics(POL.compute(e374, o).points, 0.2, 3).cdMean), 'Bereich über Ca max ist nicht bewertbar');
});

test('Typ 2: symmetrisches Profil gibt eine punktsymmetrische Polare (Re aus dem Betrag von Ca)', () => {
  const r = POL.compute(P.naca4('0009'), { type: 2, re: 120000, alphaFrom: -6, alphaTo: 6, alphaStep: 2 });
  const at = a => r.points.find(p => p.alpha === a);
  for (const a of [2, 4, 6]) {
    assert.ok(Math.abs(at(a).cl + at(-a).cl) < 0.01, [at(a).cl, at(-a).cl]);
    assert.ok(Math.abs(at(a).cd - at(-a).cd) < 2e-4, [at(a).cd, at(-a).cd]);
    assert.ok(Math.abs(at(a).re - at(-a).re) < 50, [at(a).re, at(-a).re]);
  }
});

test('Basiswiderstand der stumpfen Endleiste nach Hoerner', () => {
  // h/l = 0,5 %, Cw 0,01: 0,135·0,005^(4/3)/∛0,01 ≈ 0,00054
  assert.ok(Math.abs(POL.baseDrag(0.01, 0.005) - 0.135 * Math.pow(0.005, 4 / 3) / Math.cbrt(0.01)) < 1e-12);
  assert.ok(POL.baseDrag(0.01, 0.005) > 0.0005 && POL.baseDrag(0.01, 0.005) < 0.0006);
  assert.strictEqual(POL.baseDrag(0.01, 0), 0);
  assert.strictEqual(POL.baseDrag(0.01, null), 0);
});
