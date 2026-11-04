const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const FU = require('../web/core/fusion.js');

function wing() {
  const project = PR.createProject('t');
  const p = PR.addProfile(project, { datText: BIB.LIB ? Object.values(BIB.LIB)[0] : Object.values(BIB)[0], source: 'bibliothek' });
  const s = (y, chord, offset, dihedral = 0, extra = {}) => ({ y, chord, offset, dihedral, twist: 0, profileId: p.id, thickness: null, camber: null, xThickness: null, xCamber: null, flapDepth: 0, flap: 0, ...extra });
  const model = {
    name: 'Test', drag: { te: 0.7 },
    wing: { incidence: 0, stations: [s(0, 250, 0), s(60, 250, 0), s(500, 200, 10, 5), s(900, 120, 30, 5), s(960, 80, 45, 5)] },
    tail: { x: 900, z: 0, stations: [s(0, 120, 0), s(300, 50, 30)] },
  };
  return { project, model };
}

test('Fusion: Rumpfstation weggelassen, Knick, Zwischenschnitte, Randspitze', () => {
  const { project, model } = wing();
  const r = FU.sections(model, project.profiles, 'wing');
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.start, 60);
  const real = r.sections.filter(s => !s.between);
  assert.deepStrictEqual(real.map(s => s.name), ['WG_Y0000', 'WG_Y0440', 'WG_Y0840', 'WG_Y0900']);
  assert.ok(real[1].kink && !real[2].kink);
  // Abstand höchstens 100 mm
  for (let i = 1; i < r.sections.length; i++) assert.ok(r.sections[i].y - r.sections[i - 1].y <= 100 + 1e-9);
  // Nullpunkt an der Nasenleiste der ersten Station, Endleiste offen mit 0,7 mm
  const s0 = r.sections[0], n = s0.pts.length;
  const le = s0.pts.reduce((a, p) => (p[0] < a[0] ? p : a));
  assert.ok(Math.abs(le[0]) < 1e-6 && Math.abs(le[1]) < 1e-9);
  assert.ok(Math.abs(s0.pts[0][2] - s0.pts[n - 1][2] - 0.7) < 1e-3);
  assert.ok(Math.abs(s0.pts[0][0] - 250) < 1e-6);
  // V-Form: aussen höher
  assert.ok(real[3].pts[0][2] > 30);
  // Randspitze ausserhalb der letzten Station, c² linear: 80²/((120²-80²)/60) = 48 mm
  assert.ok(r.tip && Math.abs(r.tip.dist - 48) < 1e-6);
  assert.ok(r.tip.pt[1] > real[3].pts[0][1]);
});

test('Fusion: Skript enthält Daten und Loft', () => {
  const { project, model } = wing();
  const py = FU.script(model, project.profiles, 'tail');
  assert.match(py, /^# HLW Test für Autodesk Fusion/);
  assert.match(py, /\('HLW_Y0000', False, \[/);
  assert.match(py, /loftFeatures/);
  assert.match(py, /RANDSPITZE = True/);
  assert.strictEqual(FU.fileName({ name: 'Flügel v4' }, 'wing'), 'Fluegel_v4_Fluegel_Fusion.py');
});

test('Fusion: scharfe Endleiste wird minimal geöffnet', () => {
  const { project, model } = wing();
  model.drag.te = 0;
  const s0 = FU.sections(model, project.profiles, 'wing').sections[0], n = s0.pts.length;
  assert.ok(Math.abs(s0.pts[0][2] - s0.pts[n - 1][2] - FU.MIN_TE) < 1e-3);
});

test('Fusion: ZIP mit Skriptordner, von unzip lesbar', () => {
  const { project, model } = wing();
  const z = FU.scriptZip(model, project.profiles, 'wing');
  assert.strictEqual(z.name, 'Test_Fluegel_Fusion.zip');
  assert.strictEqual(FU.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fz-'));
  fs.writeFileSync(path.join(dir, z.name), z.bytes);
  try { cp.execSync('unzip -q ' + z.name, { cwd: dir }); } catch (e) { return; } // ohne unzip nur die Prüfsumme
  const py = fs.readFileSync(path.join(dir, 'Test_Fluegel_Fusion', 'Test_Fluegel_Fusion.py'), 'utf8');
  assert.match(py, /Für Autodesk Fusion|für Autodesk Fusion/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'Test_Fluegel_Fusion', 'Test_Fluegel_Fusion.manifest'), 'utf8')).type, 'script');
});

test('Fusion: Ellipsenschnitte am Randbogen', () => {
  const { project, model } = wing();
  const r = FU.sections(model, project.profiles, 'wing');
  const tipS = r.sections.filter(s => s.tipSection);
  assert.deepStrictEqual(tipS.map(s => s.name), ['WG_Y0900_Rand1', 'WG_Y0900_Rand2', 'WG_Y0900_Rand3', 'WG_Y0900_Rand4']);
  // c² linear: Abstand zur Spitze ∝ f²
  const last = r.sections[r.sections.length - 5];
  tipS.forEach(s => { const f = s.chord / last.chord; assert.ok(Math.abs((r.tip.dist - (s.y - last.y)) / r.tip.dist - f * f) < 1e-9); });
  assert.ok(tipS.every((s, i) => i === 0 || s.y > tipS[i - 1].y));
});

test('Fusion: Start ab gewählter Station', () => {
  const { project, model } = wing();
  assert.strictEqual(FU.sections(model, project.profiles, 'wing', { fromY: 0 }).skipped, 0);
  const r = FU.sections(model, project.profiles, 'wing', { fromY: 500 });
  assert.strictEqual(r.start, 500);
  assert.strictEqual(r.stations[0].name, 'WG_Y0000');
  assert.strictEqual(FU.startIndex(model.wing.stations, { fromY: 960 }), 3); // letzte Station geht nicht, eine davor
  assert.strictEqual(FU.startIndex(model.wing.stations, {}), 1);
});
