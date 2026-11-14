const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const IM = require('../web/core/import3d.js');

test('3D-Import: 3MF mit Einheit, Komponente und Transformation', async () => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures/keil.3mf'));
  const r = await IM.parse('Keil.3mf', buf);
  assert.strictEqual(r.unit, 10);
  assert.strictEqual(r.title, 'HLW Test');
  assert.strictEqual(r.meshes.length, 2);
  assert.strictEqual(IM.triangles(r.meshes), 8);
  // Komponente um 5 verschoben, dann Bauteil ×2 und z +10: Punkt (1,0,0) → (12, 0, 10)
  const P = r.meshes[0].positions;
  assert.deepStrictEqual(Array.from(P.slice(3, 6)), [12, 0, 10]);
  assert.deepStrictEqual(Array.from(r.meshes[1].positions.slice(3, 6)), [1, 0, 0]);
});

test('3D-Import: OBJ mit Vielecken, negativen Indizes und Gruppen', async () => {
  const obj = '# Würfelseite\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\no Platte\nf 1/1/1 2/2/1 3/3/1 4/4/1\no Zweite\nv 0 0 1\nf -1 1 2\n';
  const r = await IM.parse('a.obj', new TextEncoder().encode(obj));
  assert.deepStrictEqual(r.meshes.map(m => m.name), ['Platte', 'Zweite']);
  assert.deepStrictEqual(Array.from(r.meshes[0].indices), [0, 1, 2, 0, 2, 3]);
  assert.strictEqual(r.meshes[1].positions.length, 9);
});

test('3D-Import: STL binär und ASCII, Punkte zusammengelegt', async () => {
  const tri = [[0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0, 0, 1, 0]];
  const b = Buffer.alloc(84 + 50 * tri.length);
  b.writeUInt32LE(tri.length, 80);
  tri.forEach((t, i) => t.forEach((v, k) => b.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  const r = await IM.parse('x.STL', b);
  assert.strictEqual(r.meshes[0].positions.length, 12);
  const asc = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  const a = await IM.parse('y.stl', new TextEncoder().encode(asc));
  assert.strictEqual(IM.triangles(a.meshes), 1);
});

test('3D-Import: STEP über occt-Ergebnis, ohne Leser klare Meldung', async () => {
  await assert.rejects(IM.parse('a.step', new Uint8Array(4)), /STEP-Leser/);
  const fake = { success: true, meshes: [{ name: 'Holm', attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } }] };
  const r = await IM.parse('a.stp', new Uint8Array(4), { step: async () => fake });
  assert.strictEqual(r.meshes[0].name, 'Holm');
  assert.throws(() => IM.fromOcct({ success: false }), /nicht lesen/);
});

test('3D-Import: Lage wie Fusion (Y oben, Nase −Z), Halbflügel gespiegelt, HLW an Leitwerkslage', () => {
  // Halbflügel: Spannweite +X, Dicke Y, Tiefe +Z ab Nase
  const m = { name: 'W', positions: Float32Array.from([0, 0, 0, 1000, 0, 0, 0, 10, 200, 0, 0, 200]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
  const r = { meshes: [m], unit: 1, title: 'Flügel v4' };
  const p = IM.suggest(r, 'Flügel v4.3mf', null);
  assert.ok(p.mirror && p.part === 'wing');
  const out = IM.place(r.meshes, r.unit, p);
  assert.strictEqual(out.length, 2);
  // (0,10,200) → App x 200 (hinten), z 10 (oben), Spannweite y aus Datei-X
  assert.deepStrictEqual(Array.from(out[0].positions.slice(6, 9)), [200, 0, 10]);
  assert.deepStrictEqual(Array.from(out[0].positions.slice(3, 6)), [0, 1000, 0]);
  assert.deepStrictEqual(Array.from(out[1].positions.slice(3, 6)), [0, -1000, 0]);
  const b = IM.bounds(out);
  assert.deepStrictEqual(b.min, [0, -1000, 0]);
  const t = IM.suggest(r, 'HLW v10.3mf', { tail: { x: 900, z: 40 } });
  assert.ok(t.part === 'tail' && t.dx === 900 && t.dz === 40);
  assert.throws(() => IM.basis({ up: '+Y', nose: '-Y' }), /dieselbe Achse/);
});

test('3D-Import: Rhino 3DM über Worker-Ergebnis, Lage Z oben / Nase −Y, ganzes Modell Nase an Nase', async () => {
  await assert.rejects(IM.parse('a.3dm', new Uint8Array(4)), /3dm-Leser/);
  // Rumpf von y 0 (Nase) bis 1500, Flügel ±2500 bei y 600
  const res = { success: true, unit: 1, skipped: { Curve: 3 }, hidden: 2, meshes: [
    { name: 'Rumpf', layer: 'Rumpf', how: 'Render-Netz', positions: [0, 0, 0, 0, 1500, 0, 30, 700, 40], indices: [0, 1, 2] },
    { name: 'Wing', layer: 'Wing', how: 'abgetastet', positions: [-2500, 600, 50, 2500, 600, 50, 0, 840, 50], indices: [0, 1, 2] },
  ] };
  const r = await IM.parse('Shark.3dm', new Uint8Array(4), { rhino: async () => res });
  assert.ok(r.source === '3dm' && r.sampled && r.meshes.length === 2);
  const p = IM.suggest(r, 'Shark.3dm', { wing: { stations: [{ chord: 240 }] }, tail: { x: 1200, z: 0 } }, { noseX: -613 });
  assert.ok(p.up === '+Z' && p.nose === '-Y' && p.part === 'all' && !p.mirror);
  const b = IM.bounds(IM.place(r.meshes, r.unit, p));
  assert.ok(Math.abs(b.min[0] + 613) < 1e-3 && Math.abs(b.max[0] - 887) < 1e-3);
  assert.ok(Math.abs(b.max[1] - 2500) < 1e-3 && Math.abs(b.min[1] + 2500) < 1e-3);
  assert.throws(() => IM.fromRhino({ success: true, meshes: [], skipped: { Curve: 5 }, hidden: 1 }), /nur 5× Curve/);
});
