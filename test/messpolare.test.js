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

test('Shark: nach unten offene Parabel und Steigen werden erkannt', () => {
  const p = MP.parseLua(lua)[2], w = MP.check(p);
  assert.ok(w.some(x => /nach unten offen/.test(x.text)));
  assert.ok(w.some(x => /ganzen Bereich/.test(x.text)));
  assert.strictEqual(MP.summary(p).best, null);
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
