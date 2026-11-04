const test = require('node:test');
const assert = require('node:assert');
const VL = require('../web/core/verlauf.js');

test('Rückgängig und Wiederholen', () => {
  const h = VL.createHistory('a', 3);
  assert.strictEqual(h.canUndo(), false);
  assert.strictEqual(h.record('a'), false, 'gleicher Stand ist kein Schritt');
  h.record('b'); h.record('c');
  assert.strictEqual(h.undo(), 'b');
  assert.strictEqual(h.undo(), 'a');
  assert.strictEqual(h.undo(), null);
  assert.strictEqual(h.redo(), 'b');
  h.record('x');
  assert.strictEqual(h.canRedo(), false, 'neue Änderung verwirft Wiederholen');
  h.record('y'); h.record('z'); h.record('w');
  assert.deepStrictEqual(h.sizes, { undo: 3, redo: 0 }, 'Grenze');
  h.reset('n');
  assert.strictEqual(h.current, 'n'); assert.strictEqual(h.canUndo(), false);
});

test('Änderungen lesbar beschreiben', () => {
  const m = { id: 'm1', name: 'Shark', mass: 8500, wing: { stations: [{ y: 0, chord: 250 }, { y: 1000, chord: 200 }] } };
  const a = { name: 'P', models: [m], profiles: [] };
  const b = JSON.parse(JSON.stringify(a)); b.models[0].mass = 9000;
  assert.strictEqual(VL.describe(a, b), 'Shark: Masse');
  const c = JSON.parse(JSON.stringify(a)); c.models[0].wing.stations[1].chord = 190;
  assert.strictEqual(VL.describe(JSON.stringify(a), JSON.stringify(c)), 'Shark: Flügel Station 2 Tiefe');
  const d = JSON.parse(JSON.stringify(a)); d.models.push({ id: 'm2', name: 'Shark Strak' });
  assert.strictEqual(VL.describe(a, d), 'Modell neu');
  const e = JSON.parse(JSON.stringify(a)); e.models[0].mass = 1; e.models[0].name = 'S2'; e.name = 'Q';
  assert.match(VL.describe(a, e), /und 1 weitere$/);
  assert.strictEqual(VL.describe(a, a), 'keine Änderung');
});

test('automatische Stände ausdünnen, benannte behalten', () => {
  const now = 100 * 864e5, list = [];
  for (let i = 0; i < 200; i++) list.push({ id: 'a' + i, kind: 'auto', time: now - i * 10 * 60e3 });
  list.push({ id: 'n1', kind: 'named', time: now - 300 * 864e5 });
  const kept = VL.prune(list, now);
  assert.ok(kept.some(s => s.id === 'n1'));
  for (let i = 0; i < 20; i++) assert.ok(kept.some(s => s.id === 'a' + i), 'die letzten 20 bleiben');
  const auto = kept.filter(s => s.kind === 'auto');
  assert.ok(auto.length <= 60 && auto.length > 20);
  const hours = new Set(auto.slice(20).map(s => Math.floor(s.time / 36e5)));
  assert.strictEqual(hours.size, auto.length - 20, 'ältere: einer pro Stunde');
});
