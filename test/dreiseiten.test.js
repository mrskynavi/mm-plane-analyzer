const test = require('node:test');
const assert = require('node:assert');
const TS = require('../web/core/dreiseiten.js');
const F = require('../web/core/rumpf.js');
const PR = require('../web/core/projekt.js');
const LIB = require('../web/core/bibliothek.js');

// Strichzeichnung von oben: spindelförmiger Rumpf (Nase oben), Rechteckflügel; Seitenansicht daneben
function drawing() {
  const W = 800, H = 500, gray = new Uint8Array(W * H).fill(240);
  const dot = (x, y) => { for (let a = -1; a <= 0; a++) for (let b = -1; b <= 0; b++) { const i = (Math.round(y) + b) * W + Math.round(x) + a; if (i >= 0 && i < gray.length) gray[i] = 30; } };
  const line = (x1, y1, x2, y2) => { const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1)); for (let i = 0; i <= n; i++) dot(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n); };
  const half = y => 20 * Math.sin(Math.PI * Math.min(1, (y - 50) / 300)) ** 0.7; // Rumpf von y 50 bis 350, Mitte x 200
  for (let y = 50; y < 350; y += 0.5) { dot(200 + half(y), y); dot(200 - half(y), y); }
  // Flügel: Nasenleiste y 150, Endleiste y 190, Spitze bei x 200 ± 180 (Halbspannweite 180 px)
  for (const s of [1, -1]) { line(200 + s * half(150), 150, 200 + s * 180, 150); line(200 + s * half(190), 190, 200 + s * 180, 190); line(200 + s * 180, 150, 200 + s * 180, 190); }
  // Seitenansicht: Ober- und Unterkante 24 bzw. 16 px über/unter der Linie y 300, x 450..750
  const hz = x => Math.sin(Math.PI * Math.min(1, (x - 450) / 300)) ** 0.7;
  for (let x = 450; x < 750; x += 0.5) { dot(x, 300 - 24 * hz(x)); dot(x, 300 + 16 * hz(x)); }
  return { width: W, height: H, gray };
}
const P = { nose: [200, 50], tail: [200, 350], rootLE: [200, 150], rootTE: [200, 190], tipLE: [380, 150], maxHalf: 20, side: { nose: [450, 300], tail: [750, 300], maxHeight: 40 } };

test('3-Seitenansicht: Rumpf und Flügel werden aus den Linien gelesen und auf das Modell skaliert', () => {
  const M = TS.maskOf(drawing());
  const span = 3600; // 2·180 px → 10 mm je px
  assert.ok(Math.abs(TS.scaleOf(P, span) - 10) < 1e-9);
  const fus = TS.fuselage(M, P, span, 20);
  assert.strictEqual(fus[0].x, -1000); // Nase 100 px vor der Nasenleiste
  assert.ok(Math.abs(fus.at(-1).x - 2000) < 15, fus.at(-1).x);
  const mid = fus.reduce((a, r) => Math.abs(r.x - 500) < Math.abs(a.x - 500) ? r : a); // Rumpfmitte y 200
  assert.ok(Math.abs(mid.w - 400) < 40, mid.w);
  assert.ok(Math.abs(mid.h - 400) < 40 && mid.zt > mid.zb, [mid.h, mid.zt, mid.zb]);
  const wing = TS.wing(M, P, span);
  assert.ok(wing.length >= 2 && wing.length <= 4, JSON.stringify(wing));
  assert.ok(Math.abs(wing[0].chord - 400) < 30 && Math.abs(wing.at(-1).y - 1800) < 40, JSON.stringify(wing));
  for (const r of wing) assert.ok(Math.abs(r.offset) < 20);
});

test('3-Seitenansicht: Antwort von Claude lesen, Flügel übernimmt Profile der ähnlichsten Station', () => {
  const p = TS.parsePoints('Hier: {"top":{"nose":[1,2],"tail":[1,90],"rootLE":[1,30],"rootTE":[1,40],"tipLE":[80,32],"maxHalf":5},"side":null,"span_m":15,"note":"ok"}');
  assert.deepStrictEqual(p.tipLE, [80, 32]); assert.strictEqual(p.side, null); assert.strictEqual(p.span_m, 15);
  assert.throws(() => TS.parsePoints('{"top":{"nose":[1,2]}}'));
  const old = [{ y: 0, chord: 200, offset: 0, profile: 'a', flapDepth: 25 }, { y: 1000, chord: 100, offset: 50, profile: 'b', flapDepth: 0 }];
  const neu = TS.applyWing(old, [{ y: 0, chord: 300, offset: 0 }, { y: 600, chord: 250, offset: 20 }, { y: 2000, chord: 120, offset: 90 }]);
  assert.deepStrictEqual(neu.map(s => s.profile), ['a', 'a', 'b']);
  assert.strictEqual(neu[1].chord, 250); assert.strictEqual(neu[0].flapDepth, 25);
});

test('Rumpf als Kontur: Ellipsenquerschnitt, benetzte Fläche und Widerstand wie ein Rotationskörper gleicher Grösse', () => {
  const pj = PR.createProject(), e = PR.addProfile(pj, { datText: LIB.e374 }), h = PR.addProfile(pj, { datText: LIB.ht14 });
  const m = PR.createModel('T', e.id, h.id);
  const table = []; for (let i = 0; i <= 40; i++) { const x = -400 + 1500 * i / 40, r = 60 * Math.sin(Math.PI * i / 40) ** 0.7; table.push({ x, w: 2 * r, h: 2 * r }); }
  m.fuselage = { type: 'kontur', table };
  const s = F.shape(m);
  assert.strictEqual(s.type, 'kontur'); assert.strictEqual(s.x0, -400); assert.ok(Math.abs(s.D - 120) < 1);
  let ref = 0; for (let i = 1; i < s.pts.length; i++) { const a = s.pts[i - 1], b = s.pts[i]; ref += Math.PI * (a.r + b.r) * Math.hypot(b.x - a.x, b.r - a.r); }
  assert.ok(Math.abs(s.swet - ref) / ref < 0.01, [s.swet, ref]);
  // flach gedrückt bei gleicher Fläche: mehr Umfang, mehr benetzte Fläche
  m.fuselage = { type: 'kontur', table: table.map(q => ({ ...q, w: q.w * 1.6, h: q.h / 1.6 })) };
  assert.ok(F.shape(m).swet > s.swet * 1.03);
  // Oldtimer-Oberfläche bremst mehr; ohne Tabelle fällt die Form auf den modernen Segler zurück
  const cd = finish => { m.fuselage = { type: 'kontur', table, finish }; return F.drag(F.shape(m), 15, 4.7e5); };
  assert.ok(cd('oldtimer') > 1.3 * cd('modern'));
  m.fuselage = { type: 'kontur' }; assert.strictEqual(F.of(m).type, 'modern');
});

test('3-Seitenansicht: Mast, Rad und Leitwerk über der Rumpflinie werden abgeschnitten, die Haube bleibt', () => {
  const body = Array.from({ length: 100 }, (_, i) => 20 * Math.max(0, Math.sin(Math.PI * Math.min(1, i / 99) ** 0.7)) ** 0.6); // Gipfel vorne (Haube)
  const raw = body.map((v, i) => v + (i >= 55 && i <= 60 ? 15 : 0) + (i >= 92 ? 30 : 0)); // Mast und Seitenleitwerk
  const g = TS.unimodal(raw);
  for (let i = 0; i < 100; i++) assert.ok(g[i] <= raw[i] + 1e-9);
  for (let i = 54; i <= 61; i++) assert.ok(g[i] <= body[54] + 1e-9, i); // über den Mast hinweg höchstens flach
  for (let i = 91; i < 100; i++) assert.ok(g[i] <= body[91] + 1e-9, i);
  const top = g.indexOf(Math.max(...g)); assert.ok(top > 20 && top < 50, top);
});
