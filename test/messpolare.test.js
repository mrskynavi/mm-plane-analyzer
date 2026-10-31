const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const MP = require('../web/core/messpolare.js');
const PR = require('../web/core/projekt.js');

const lua = fs.readFileSync(__dirname + '/fixtures/polaren.lua', 'utf8');

test('polaren.lua aus dem Flight Analyzer: drei Einträge', () => {
  const e = MP.parseLua(lua);
  assert.deepStrictEqual(e.map(x => x.name), ['SB-10', 'Lak-17', 'Shark']);
  assert.deepStrictEqual(e[0], { name: 'SB-10', a: 0.0072013, b: -0.16246, c: 1.5137, vMin: 6.7, vMax: 18.9 });
});

test('SB-10: beste Gleitzahl 21,6 bei rund 52 km/h, plausibel', () => {
  const p = MP.parseLua(lua)[0], s = MP.summary(p);
  assert.ok(Math.abs(s.best.E - 21.6) < 0.2, `E ${s.best.E}`);
  assert.ok(Math.abs(s.best.v * 3.6 - 52) < 4, `v ${s.best.v * 3.6}`);
  assert.deepStrictEqual(MP.check(p).filter(w => w.level === 'err'), []);
});

test('Sinken negativ geschrieben (wie am Vario): wird umgedreht, gleiche Polare', () => {
  const sb = MP.parseLua(lua)[0];
  const neg = { ...sb, a: -sb.a, b: -sb.b, c: -sb.c };
  assert.strictEqual(MP.sign(neg), -1);
  assert.ok(Math.abs(MP.summary(neg).best.E - MP.summary(sb).best.E) < 1e-9);
  const w = MP.check(neg);
  assert.deepStrictEqual(w.filter(x => x.level === 'err'), []);
  assert.ok(w.some(x => /negativ geschrieben/.test(x.text)));
});

test('Physikalische Form A·v³ + B/v, auch negativ geschrieben', () => {
  // Sinken = A v³ + B/v mit E max 27 bei 60 km/h: v* = 16.67 m/s, A v⁴ = B, Sinken(v*) = v*/27
  const v = 60 / 3.6, s = v / 27, A = s / (2 * v ** 3), B = s * v / 2;
  const [p] = MP.parseLua(`return { ["Shark"] = { A = ${-A}, B = ${-B}, vMin = 6.7, vMax = 27.8 } }`);
  assert.strictEqual(p.form, 'cube');
  const r = MP.summary(p);
  assert.ok(Math.abs(r.best.E - 27) < 0.05, `E ${r.best.E}`);
  assert.ok(Math.abs(r.best.v * 3.6 - 60) < 0.5);
  assert.deepStrictEqual(MP.check(p).filter(x => x.level === 'err'), []);
});

test('Unbrauchbare Kurven werden erkannt', () => {
  const down = { name: 'x', a: -0.005, b: 0.3, c: -1, vMin: 10, vMax: 30 }; // positiv in der Mitte, nach unten offen
  assert.ok(MP.check(down).some(x => /nach unten gekrümmt/.test(x.text)));
  const part = { name: 'y', a: 0.01, b: -0.3, c: 1.5, vMin: 5, vMax: 30 }; // um 15 m/s negativ, Mitte positiv
  assert.strictEqual(MP.sign(part), 1);
  assert.ok(MP.check(part).some(x => /Steigen/.test(x.text)));
});

test('Import ins Projekt: Zuweisung über den Namen, erneuter Import ersetzt Werte', () => {
  const pj = PR.createProject();
  const sb = PR.createModel('SB-10 M1:5'), lak = PR.createModel('Lak 17a');
  pj.models.push(sb, lak);
  const r = MP.importInto(pj, MP.parseLua(lua), 'polaren.lua');
  assert.deepStrictEqual(r, { added: 3, updated: 0, assigned: 2 });
  assert.strictEqual(MP.forModel(pj, sb.id)[0].name, 'SB-10');
  assert.strictEqual(MP.forModel(pj, lak.id)[0].name, 'Lak-17');
  pj.measured[0].modelId = lak.id; // von Hand umgehängt
  const r2 = MP.importInto(pj, [{ name: 'SB-10', a: 0.007, b: -0.16, c: 1.5, vMin: 7, vMax: 19 }]);
  assert.strictEqual(r2.updated, 1);
  assert.strictEqual(pj.measured[0].modelId, lak.id, 'Zuweisung bleibt');
  assert.strictEqual(pj.measured[0].a, 0.007);
  const back = PR.parse(PR.serialize(pj));
  assert.strictEqual(back.measured.length, 3);
});

test('Lua mit anderer Feldreihenfolge, Kommentar und Name ohne Klammern', () => {
  const e = MP.parseLua('return { -- x\n Foo = { vMax = 20, vMin = 8, c = 1, b = -0.1, a = 5e-3 }, }');
  assert.deepStrictEqual(e, [{ name: 'Foo', a: 0.005, b: -0.1, c: 1, vMin: 8, vMax: 20 }]);
  assert.throws(() => MP.parseLua('return {}'));
});
