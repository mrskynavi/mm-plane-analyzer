const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const D3 = require('../web/core/modell3d.js');
const F = require('../web/core/rumpf.js');
const V = require('../web/core/vlm.js');
const B = require('../web/core/bauteile3d.js');

// Modell bauen, als 3D-Netz zeichnen, dann aus dem Netz wieder auslesen: muss wieder das Modell ergeben
function model() {
  const project = PR.createProject('t');
  const p = PR.addProfile(project, { datText: BIB.LIB ? Object.values(BIB.LIB)[0] : Object.values(BIB)[0], source: 'bibliothek' });
  const s = (y, chord, offset, dihedral = 0, extra = {}) => ({ y, chord, offset, dihedral, twist: 0, profileId: p.id, thickness: null, camber: null, xThickness: null, xCamber: null, flapDepth: 25, flap: 0, ...extra });
  const m = {
    name: 'Test', drag: { te: 0.7 },
    wing: { incidence: 0, tipShape: 'gerade', stations: [s(0, 250, 0), s(500, 200, 10, 5), s(900, 120, 30, 5, { twist: -2 }), s(960, 100, 45, 5, { twist: -2 })] },
    tail: { x: 900, z: 40, tipShape: 'gerade', stations: [s(0, 120, 0), s(300, 60, 30)] },
    fuselage: { type: 'modern', fin: 4 },
  };
  return { project, m };
}
const at = (st, y, k) => { for (let i = 1; i < st.length; i++) if (st[i].y >= y) { const t = (y - st[i - 1].y) / (st[i].y - st[i - 1].y); return st[i - 1][k] + (st[i][k] - st[i - 1][k]) * t; } return st[st.length - 1][k]; };

test('Bauteile: Teile nach Namen und Form zugeordnet', () => {
  const { project, m } = model();
  const g = D3.build(m, project.profiles);
  const ps = B.pieces(g.parts);
  const k = B.classify(ps, 'all');
  // jedes Teil von D3 ist eine Schale (Flügel: zwei Hälften, beide Flügel)
  assert.deepStrictEqual([...new Set(k)].sort(), ['fin', 'fuse', 'tail', 'wing']);
  // ohne Namen: aus der Form
  const anon = ps.map(p => ({ ...p, name: 'Körper' }));
  const k2 = B.classify(anon, 'all');
  assert.deepStrictEqual(k2, k);
});

test('Bauteile: Flügel, HLW, Rumpf und SLW aus dem Netz zurückgelesen', () => {
  const { project, m } = model();
  const g = D3.build(m, project.profiles);
  const ps = B.pieces(g.parts), k = B.classify(ps, 'all');
  const ex = B.extract(ps, k);
  assert.ok(Math.abs(ex.ref.x) < 1 && Math.abs(ex.ref.z) < 1.5, 'Bezug Flügelnase');
  const { model: n } = B.apply(m, ex, { wing: true, tail: true, fuse: true, fin: true }, { wingMode: 'dicke', tailMode: 'keep' });
  const W = n.wing.stations;
  for (const y of [0, 250, 500, 700, 900, 950]) {
    assert.ok(Math.abs(at(W, y, 'chord') - at(m.wing.stations, y, 'chord')) < 2.5, 'Tiefe bei ' + y + ': ' + at(W, y, 'chord'));
    assert.ok(Math.abs(at(W, y, 'offset') - at(m.wing.stations, y, 'offset')) < 2.5, 'Pfeilung bei ' + y);
  }
  // V-Form 5° aussen, Schränkung −2° an der Spitze
  assert.ok(W.slice(0, -1).filter(s => s.y >= 500).every(s => Math.abs(s.dihedral - 5) < 0.5), 'V-Form ' + W.map(s => s.dihedral));
  assert.ok(Math.abs(W.at(-1).twist + 2) < 0.4, 'Schränkung ' + W.at(-1).twist);
  assert.ok(Math.abs(V.planform(W).area - V.planform(m.wing.stations).area) / V.planform(m.wing.stations).area < 0.02);
  // Dicke gemessen wie das Profil
  const prof = project.profiles[0], t0 = require('../web/core/profil.js').stats(prof.coords).thickness;
  assert.ok(Math.abs(W[2].thickness - t0) < 0.004, 'Dicke ' + W[2].thickness + ' statt ' + t0);
  // HLW an seiner Stelle
  assert.ok(Math.abs(n.tail.x - 900) < 2 && Math.abs(n.tail.z - 40) < 2, `HLW bei ${n.tail.x}/${n.tail.z}`);
  assert.ok(Math.abs(at(n.tail.stations, 150, 'chord') - 90) < 3);
  // Rumpf als Kontur, gleiche Länge und Dicke wie gezeichnet
  const s0 = F.shape(m), s1 = F.shape(n);
  assert.strictEqual(n.fuselage.type, 'kontur');
  assert.ok(Math.abs(s1.x0 - s0.x0) < 3, 'Nase ' + s1.x0 + ' / ' + s0.x0);
  assert.ok(Math.abs(s1.D - s0.D) / s0.D < 0.08, 'Durchmesser ' + s1.D + ' / ' + s0.D);
  // Seitenleitwerk: Fläche über dem Rumpfrücken etwa wie eingegeben
  assert.ok(Math.abs(n.fuselage.fin - 4) < 0.6, 'SLW ' + n.fuselage.fin);
  assert.ok(n.fuselage.finGeo.height > 100);
});

test('Bauteile: nur gewählte Teile ändern sich, Profil aus dem Schnitt', () => {
  const { project, m } = model();
  const g = D3.build(m, project.profiles);
  const ps = B.pieces(g.parts), k = B.classify(ps, 'all');
  const ex = B.extract(ps, k);
  const made = [];
  const { model: n } = B.apply(m, ex, { wing: true }, { wingMode: 'neu', profileFor: (sh, part, y) => { made.push(sh); return 'neu' + made.length; } });
  assert.deepStrictEqual(n.tail, m.tail);
  assert.deepStrictEqual(n.fuselage, m.fuselage);
  assert.ok(made.length >= 3 && n.wing.stations.every(s => /^neu/.test(s.profileId)));
  const c = B.profileCoords(made[1]);
  assert.strictEqual(c[0][0], 1); assert.strictEqual(c[c.length - 1][0], 1);
  assert.ok(B.sameShape(c, B.profileCoords(made[2]), 0.008), 'gleiches Profil an zwei Stationen');
});
