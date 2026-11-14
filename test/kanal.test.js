// Digitaler Windkanal (Profil): Panelverfahren gegen bekannte Werte, Grenzschicht-Auswertung
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PF = require('../web/core/profil.js');
const NF = require('../web/core/neuralfoil.js');
const K = require('../web/core/kanal.js');

const naca = code => PF.normalize(PF.naca4(code, 100)).coords;
const dat = name => PF.parseDat(fs.readFileSync(path.join(__dirname, '..', 'web', 'profile', name + '.dat'), 'utf8')).coords;

test('NACA 0012 bei α 0: kein Auftrieb, Cp min −0,41, Staupunkt Cp 1', () => {
  const s = K.solve(naca('0012'), 0);
  assert.ok(Math.abs(s.cl) < 1e-6, 'Ca ' + s.cl);
  const cps = s.surf.map(q => q.cp);
  assert.ok(Math.abs(Math.min(...cps) + 0.41) < 0.02, 'Cp min ' + Math.min(...cps));
  assert.ok(Math.max(...cps) > 0.99);
});

test('NACA 0012 bei α 5: Ca wie reibungsfreie Theorie mit Dickeneinfluss (≈ 0,60)', () => {
  const s = K.solve(naca('0012'), 5);
  const thin = 2 * Math.PI * Math.sin(5 * Math.PI / 180) * (1 + 0.77 * 0.12);
  assert.ok(Math.abs(s.cl - thin) < 0.015, `Ca ${s.cl} statt ${thin}`);
  // Zirkulation (Kutta-Joukowski) passt zum Druckintegral
  const perim = s.panels.reduce((a, p) => a + p.L, 0);
  assert.ok(Math.abs(-2 * s.gamma * perim - s.cl) < 0.01);
});

test('Gewölbtes Profil trägt bei α 0, Feld weit weg ist Anströmung', () => {
  const s = K.solve(naca('2412'), 0);
  assert.ok(s.cl > 0.2 && s.cl < 0.32, 'Ca ' + s.cl);
  const [u, v] = s.vel(40, 0);
  assert.ok(Math.abs(u - 1) < 0.01 && Math.abs(v) < 0.01);
});

test('Keine Strömung durch die Wand, Feldformel gleich Panel-Einflüssen', () => {
  const s = K.solve(naca('2412'), 6);
  for (const p of s.panels.filter((_, i) => i % 9 === 4)) {
    const [u, v] = s.vel(p.xm + p.nx * 1e-9, p.ym + p.ny * 1e-9);
    assert.ok(Math.abs(u * p.nx + v * p.ny) < 1e-6, 'Normalgeschwindigkeit');
  }
  const a = 6 * Math.PI / 180;
  for (const [x, y] of [[0.3, 0.1], [-0.2, -0.05], [1.3, 0.02]]) {
    let u = Math.cos(a), v = Math.sin(a);
    s.panels.forEach((q, j) => { const f = K.induced(x, y, q.x1, q.y1, q.x2, q.y2); u += s.sigma[j] * f[0] + s.gamma * f[2]; v += s.sigma[j] * f[1] + s.gamma * f[3]; });
    const [u2, v2] = s.vel(x, y);
    assert.ok(Math.abs(u - u2) < 1e-10 && Math.abs(v - v2) < 1e-10);
  }
});

test('Feld und Stromlinien: im Profil leer, Linien laufen am Profil vorbei', () => {
  const s = K.solve(naca('2412'), 4);
  const f = K.field(s, { nx: 40, ny: 20 });
  const k = 10 * 40 + Math.round((0.3 + 0.4) / 2 * 40);
  assert.ok(Number.isNaN(f.cp[k]) || Number.isFinite(f.cp[k]));
  assert.ok([...f.speed].some(Number.isNaN), 'Punkte im Profil');
  const lines = K.streamlines(s);
  assert.ok(lines.filter(l => l[l.length - 1][0] > 1.5).length >= 12);
});

test('E 374 bei Re 100 000: Blase oben bei α 0, Ablösung an der Endleiste bei α 12', () => {
  const at = NF.prepare(dat('e374'));
  const b0 = K.boundaryLayer(at(0, 1e5, 9, 1, 1, true));
  assert.ok(b0.upper.bubble, 'Blase oben');
  assert.ok(b0.upper.bubble.from > 0.4 && b0.upper.bubble.from < 0.65, 'Blase ab ' + b0.upper.bubble.from);
  assert.ok(b0.upper.bubble.to > b0.upper.xtr, 'Blase endet hinter dem Umschlag');
  assert.strictEqual(b0.upper.sep, null);
  const b12 = K.boundaryLayer(at(12, 1e5, 9, 1, 1, true));
  assert.ok(b12.upper.sep != null && b12.upper.sep > 0.7, 'Ablösung oben ab ' + b12.upper.sep);
  assert.ok(b12.upper.pts.at(-1).state === 'abgeloest');
  // Cp mit Grenzschicht = 1 − (ue/V)², Saugspitze oben bei α 12
  assert.ok(Math.min(...b12.upper.pts.map(p => p.cp)) < -2);
});

test('Ablauf über α: Umschlag oben wandert nach vorn', () => {
  const at = NF.prepare(dat('e374'));
  const pts = [0, 4, 8, 12].map(alpha => ({ alpha, re: 1e5, cl: 0 }));
  const sw = K.sweep(at, pts);
  assert.ok(sw[0].upper.xtr > sw[3].upper.xtr);
  assert.strictEqual(sw.length, 4);
});

test('analyze: normiert wie NeuralFoil und liefert beides', () => {
  const r = K.analyze(dat('rg15'), 3, 2e5);
  assert.ok(r.sys.cl > r.bl.cl, 'reibungsfrei trägt mehr');
  assert.strictEqual(r.bl.upper.pts.length, 32);
});
