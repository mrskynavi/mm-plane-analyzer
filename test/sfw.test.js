const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../web/core/sfw.js');
const PR = require('../web/core/projekt.js');
const LIB = require('../web/core/bibliothek.js');

// StepFour-Dateien der SB-10 M1:5 (5A Innenflügel, 5B Aussenflügel, 5H Höhenleitwerk)
const read = n => S.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'latin1'));

test('SFW: ein Teil mit einem Trapez', () => {
  const a = read('SB10_5A.SFW');
  assert.strictEqual(a.name, 'SB10 M1:5');
  assert.strictEqual(a.profiles.length, 2);
  assert.deepStrictEqual(a.segments.map(s => [s.len, s.offset]), [[870, -10]]);
  assert.deepStrictEqual(a.profiles.map(p => [p.name, p.chord, p.thickness, p.camber]), [['MH-32', 208, 9.5, 1.9], ['MH-32', 203, 8.4, 1.9]]);
});

test('SFW: Innen- und Aussenflügel aneinander wie im Excel-Blatt der SB-10', () => {
  const { rows, notes } = S.combine([read('SB10_5A.SFW'), read('SB10_5B.SFW')]);
  assert.deepStrictEqual(notes, []);
  assert.deepStrictEqual(rows.map(r => r.y), [0, 870, 1406, 1942, 2512, 2900]);
  assert.deepStrictEqual(rows.map(r => r.chord), [208, 203, 185, 166, 109, 70]);
  // Pfeilung aus dem Excel-Blatt, Zeile 18: 0, −10, −18, −26, −37, −45
  assert.deepStrictEqual(rows.map(r => r.offset), [0, -10, -18, -26, -37, -45]);
  assert.deepStrictEqual(rows.map(r => r.thickness), [9.5, 8.4, 8.6, 9, 10, 8.5]);
});

test('SFW: Stationen fürs Modell, Profil aus der Bibliothek, V-Form bleibt an gleicher Stelle', () => {
  const pj = PR.createProject(), m = PR.createModel('t');
  m.wing.stations[1].y = 870; m.wing.stations[1].dihedral = 2.25;
  const { rows } = S.combine([read('SB10_5A.SFW'), read('SB10_5B.SFW')]);
  const st = S.toStations(rows, m.wing.stations, { profileId: n => { const r = S.matchProfile(n, pj.profiles, Object.keys(LIB)); return r?.lib ? PR.addProfile(pj, { datText: LIB[r.lib] }).id : null; } });
  assert.strictEqual(st.length, 6);
  assert.strictEqual(st[1].dihedral, 2.25);
  assert.strictEqual(st[2].dihedral, 0);
  assert.strictEqual(st[0].thickness, 0.095);
  assert.strictEqual(st[0].camber, 0.019);
  assert.match(pj.profiles.find(p => p.id === st[0].profileId).name, /MH 32/);
});

test('SFW: Höhenleitwerk mit Wurzelrippe 13 mm ab Mitte', () => {
  const pj = PR.createProject(), sd = PR.addProfile(pj, { datText: LIB.sd8020 }), m = PR.createModel('t');
  const { rows } = S.combine([read('SB10_5H.SFW')]);
  const st = S.toStations(rows, m.tail.stations, { rootY: 13, profileId: n => S.matchProfile(n, pj.profiles)?.profile?.id ?? null });
  assert.deepStrictEqual(st.map(s => [s.y, s.chord, s.offset]), [[0, 150, 0], [13, 150, 0], [330, 62, 55]]);
  assert.ok(st.every(s => s.profileId === sd.id));
  assert.strictEqual(st[2].thickness, 0.103);
  assert.strictEqual(st[2].camber, null, 'Wölbung 0 = wie das Profil');
});

test('SFW: falsche Datei', () => {
  assert.throws(() => S.parse('hallo'), /StepFour/);
});
