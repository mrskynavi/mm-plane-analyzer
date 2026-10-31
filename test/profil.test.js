const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../web/core/profil.js');

const text = name => fs.readFileSync(path.join(__dirname, '..', 'web', 'profile', name + '.dat'), 'utf8');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} statt ${b}`);

test('Selig-Datei einlesen', () => {
  const d = P.parseDat(text('e374'));
  assert.strictEqual(d.name, 'E374');
  assert.strictEqual(d.coords.length, 61);
  assert.deepStrictEqual(d.coords[0], [1, 0]);
});

test('Lednicer-Datei ergibt dieselbe Geometrie wie Selig', () => {
  const s = P.parseDat(text('e374')).coords;
  const i = P.leIndex(s);
  const up = s.slice(0, i + 1).reverse(), lo = s.slice(i);
  const led = ['E374 Lednicer', `${up.length}. ${lo.length}.`, '', ...up.map(p => p.join(' ')), '', ...lo.map(p => p.join(' '))].join('\n');
  const d = P.parseDat(led);
  assert.strictEqual(d.coords.length, s.length);
  d.coords.forEach((p, k) => { close(p[0], s[k][0], 1e-12, 'x'); close(p[1], s[k][1], 1e-12, 'y'); });
});

test('Dezimalkomma und Kopfzeilen werden toleriert', () => {
  const rows = P.naca4('2412', 20).map(([x, y]) => `${x.toFixed(5).replace('.', ',')}	${y.toFixed(5).replace('.', ',')}`);
  const d = P.parseDat('Mein Profil\n\n' + rows.join('\n') + '\n\n');
  assert.strictEqual(d.coords.length, 39);
  assert.ok(Math.abs(P.stats(d.coords).thickness - 0.12) < 0.005);
  assert.strictEqual(d.name, 'Mein Profil');
});

test('Kennwerte E374: Dicke und Wölbung', () => {
  const s = P.stats(P.normalize(P.parseDat(text('e374')).coords).coords);
  close(s.thickness, 0.109, 0.002, 'Dicke');
  close(s.camber, 0.023, 0.002, 'Wölbung');
});

test('NACA 0009 hat 9 % Dicke und keine Wölbung', () => {
  const s = P.stats(P.naca4('0009'));
  close(s.thickness, 0.09, 0.001, 'Dicke');
  close(s.camber, 0, 1e-9, 'Wölbung');
  close(s.xThickness, 0.3, 0.02, 'Dickenlage');
});

test('Neu verteilen erhält die Form', () => {
  const c = P.normalize(P.parseDat(text('hq309')).coords).coords;
  const r = P.repanel(c, 120);
  assert.strictEqual(r.length, 239);
  const a = P.stats(c), b = P.stats(r);
  close(b.thickness, a.thickness, 5e-4, 'Dicke');
  close(b.camber, a.camber, 5e-4, 'Wölbung');
});

test('Dicke und Wölbung skalieren und verschieben', () => {
  const c = P.parseDat(text('e374')).coords;
  const a = P.stats(P.normalize(c).coords);
  const m = P.stats(P.modify(c, { thickness: 0.9, camber: 0.8 }));
  close(m.thickness, 0.9 * a.thickness, 1e-3, 'Dicke 90 %');
  close(m.camber, 0.8 * a.camber, 1e-3, 'Wölbung 80 %');
  const sh = P.stats(P.modify(c, { xThickness: 0.28, xCamber: 0.45 }));
  close(sh.xThickness, 0.28, 0.011, 'Dickenlage');
  close(sh.xCamber, 0.45, 0.011, 'Wölbungslage');
  close(sh.thickness, a.thickness, 2e-3, 'Dicke bleibt');
});

test('Klappe nach unten erhöht die Wölbung, Drehpunkt bleibt', () => {
  const c = P.parseDat(text('e374')).coords;
  const a = P.stats(P.repanel(P.normalize(c).coords));
  const f = P.flap(c, 5, 0.75);
  const b = P.stats(P.normalize(f).coords);
  assert.ok(b.camber > a.camber + 0.005, 'Wölbung steigt: ' + b.camber);
  const te = [(f[0][0] + f[f.length - 1][0]) / 2, (f[0][1] + f[f.length - 1][1]) / 2];
  assert.ok(te[1] < -0.015, 'Hinterkante tiefer: ' + te[1]);
  const up = P.flap(c, -5, 0.75);
  assert.ok((up[0][1] + up[up.length - 1][1]) / 2 > 0.015, 'Klappe hoch hebt die Hinterkante');
});

test('toDat und wieder einlesen', () => {
  const c = P.naca4('2412', 40);
  const d = P.parseDat(P.toDat('NACA 2412', c));
  assert.strictEqual(d.name, 'NACA 2412');
  assert.strictEqual(d.coords.length, c.length);
});

test('Endleiste öffnen: Dicke an der Hinterkante wie verlangt, vorne und grösste Dicke unverändert', () => {
  const c = P.parseDat(text('e374')).coords;
  const a = P.modify(c, {}), b = P.modify(c, { teGap: 0.005 }), z = P.modify(P.modify(c, { teGap: 0.01 }), { teGap: 0 });
  close(P.stats(b).teThickness, 0.005, 1e-9, 'Endleiste');
  close(P.stats(z).teThickness, 0, 1e-9, 'wieder geschlossen');
  close(P.stats(b).thickness, P.stats(a).thickness, 1e-9, 'grösste Dicke');
  close(P.stats(b).camber, P.stats(a).camber, 1e-9, 'Wölbung');
  // vor 80 % der Tiefe gleich, dahinter dicker
  const x = [0.3, 0.79, 0.9, 0.97];
  const ta = P.thicknessCamber(a, x).t, tb = P.thicknessCamber(b, x).t;
  close(tb[0], ta[0], 1e-9, 'x 0.3'); close(tb[1], ta[1], 1e-9, 'x 0.79');
  assert.ok(tb[2] > ta[2] && tb[3] - ta[3] > tb[2] - ta[2], 'hinten zunehmend dicker');
  // skaliert: Dicke an der Hinterkante bleibt die verlangte
  close(P.stats(P.modify(c, { thickness: 0.8, teGap: 0.007 })).teThickness, 0.007, 1e-9, 'mit Dickenfaktor');
});
