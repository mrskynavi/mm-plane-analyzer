const test = require('node:test');
const assert = require('node:assert');
const DIR = require('../web/core/ordner.js');

test('Dateiname aus dem Projektnamen', () => {
  assert.strictEqual(DIR.fileName('F5J Strak'), 'F5J Strak.mmpa.json');
  assert.strictEqual(DIR.fileName('a/b:c?'), 'a_b_c_.mmpa.json');
  assert.strictEqual(DIR.fileName('  '), 'Projekt.mmpa.json');
  assert.ok(DIR.isProjectFile('x.mmpa.json') && DIR.isProjectFile('x.json') && !DIR.isProjectFile('x.dat'));
});
