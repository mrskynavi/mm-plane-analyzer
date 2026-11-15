const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const D3 = require('../web/core/modell3d.js');
const F = require('../web/core/rumpf.js');

function model() {
  const project = PR.createProject('t');
  const p = PR.addProfile(project, { datText: BIB.LIB ? Object.values(BIB.LIB)[0] : Object.values(BIB)[0], source: 'bibliothek' });
  const s = (y, chord, offset, dihedral = 0, extra = {}) => ({ y, chord, offset, dihedral, twist: 0, profileId: p.id, thickness: null, camber: null, xThickness: null, xCamber: null, flapDepth: 0, flap: 0, ...extra });
  const m = {
    name: 'Test', drag: { te: 0.7 },
    wing: { incidence: 2, stations: [s(0, 250, 0), s(500, 200, 10, 5), s(900, 120, 30, 5), s(960, 80, 45, 5)] },
    tail: { x: 900, z: 40, stations: [s(0, 120, 0), s(300, 50, 30)] },
    fuselage: { type: 'modern' },
  };
  return { project, m };
}

test('3D: Teile geschlossen, gleich orientiert, an der richtigen Stelle', () => {
  const { project, m } = model();
  const r = D3.build(m, project.profiles);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.parts.map(p => p.kind), ['wing', 'tail', 'fuse', 'fin']);
  for (const p of r.parts) {
    assert.ok(p.indices.length % 3 === 0 && Math.max(...p.indices) < p.positions.length / 3, p.name);
    // geschlossen (Punkte nach Lage zusammengefasst): jede Kante gleich oft in beide Richtungen (die Wurzeldeckel beider Hälften liegen aufeinander)
    const e = new Map();
    for (let i = 0; i < p.indices.length; i += 3) for (let k = 0; k < 3; k++) {
      const at = j => [0, 1, 2].map(q => p.positions[j * 3 + q].toFixed(3)).join(' ');
      const a = at(p.indices[i + k]), b = at(p.indices[i + (k + 1) % 3]), key = a + ',' + b;
      e.set(key, (e.get(key) || 0) + 1);
    }
    let open = 0;
    for (const [key, n] of e) { const [a, b] = key.split(','); if (e.get(b + ',' + a) !== n) open++; }
    assert.strictEqual(open, 0, p.name + ' offen');
  }
  const vol = Object.fromEntries(r.parts.map(p => [p.kind, D3.volume(p)]));
  // alle Normalen nach aussen (Volumen positiv)
  for (const k in vol) assert.ok(vol[k] > 0, k);
  // Spannweite und Leitwerkslage
  assert.ok(r.bounds.max[1] > 960 && Math.abs(r.bounds.max[1] + r.bounds.min[1]) < 1e-3);
  const t = r.parts[1].positions;
  let tx = Infinity, tz = -Infinity;
  for (let i = 0; i < t.length; i += 3) { tx = Math.min(tx, t[i]); tz = Math.max(tz, t[i + 2]); }
  assert.ok(Math.abs(tx - 900) < 1 && tz > 40);
  // Rumpf von der Nase bis zum Ende, Flügelwurzel sitzt auf dem Rumpf (Achse darunter)
  const sh = F.shape(m);
  assert.ok(Math.abs(r.bounds.min[0] - sh.x0) < 1e-3 && r.zAxis < 0);
  // Seitenleitwerk: Fläche wie gerechnet, Endkante am Rumpfende
  const A = F.finArea(m, require('../web/core/vlm.js').planform(m.tail.stations).area) * 1e4;
  assert.ok(Math.abs(r.fin.height * (r.fin.root + r.fin.tip) / 2 - A) < 1);
});

test('3D: Einstellwinkel hebt die Nase', () => {
  const { project, m } = model();
  const z = inc => { m.wing.incidence = inc; const p = D3.build(m, project.profiles).parts[0].positions; let te = 0; for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 1]) < 1e-6 && p[i] > 240) te = p[i + 2]; return te; };
  assert.ok(z(3) < z(0) - 10);
});

test('Randbogen gerade: Flügel endet an der letzten Station', () => {
  const PR = require('../web/core/projekt.js'), BIB = require('../web/core/bibliothek.js'), FX = require('../web/core/fusion.js');
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const st = m.wing.stations, yEnd = st[st.length - 1].y;
  st[st.length - 1].chord = 0.3 * st[0].chord;
  const rund = FX.sections(m, project.profiles, 'wing', { all: true, n: 24, passes: 1 });
  m.wing.tipShape = 'gerade';
  const ger = FX.sections(m, project.profiles, 'wing', { all: true, n: 24, passes: 1 });
  require('node:assert').ok(rund.tip && !ger.tip);
  require('node:assert').ok(Math.max(...ger.sections.map(s => s.y)) <= yEnd - st[0].y + 1e-6);
});
