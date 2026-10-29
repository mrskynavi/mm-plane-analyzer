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
