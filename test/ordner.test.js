const test = require('node:test');
const assert = require('node:assert');
const DIR = require('../web/core/ordner.js');

test('Dateiname aus dem Projektnamen', () => {
  assert.strictEqual(DIR.fileName('F5J Strak'), 'F5J Strak.mmpa.json');
  assert.strictEqual(DIR.fileName('a/b:c?'), 'a_b_c_.mmpa.json');
  assert.strictEqual(DIR.fileName('  '), 'Projekt.mmpa.json');
  assert.ok(DIR.isProjectFile('x.mmpa.json') && DIR.isProjectFile('x.json') && !DIR.isProjectFile('x.dat'));
});

test('Datei im Ordner löschen', async () => {
  const names = new Set(['A.mmpa.json']);
  const dir = { async removeEntry(n) { if (!names.delete(n)) { const e = new Error('weg'); e.name = 'NotFoundError'; throw e; } } };
  await DIR.removeInDir(dir, 'A.mmpa.json');
  assert.strictEqual(names.size, 0);
  await DIR.removeInDir(dir, 'A.mmpa.json'); // schon weg: kein Fehler
  const bad = { async removeEntry() { const e = new Error('nein'); e.name = 'NotAllowedError'; throw e; } };
  await assert.rejects(DIR.removeInDir(bad, 'B.mmpa.json'), /nein/);
});
