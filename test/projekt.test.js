const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PR = require('../web/core/projekt.js');
const POL = require('../web/core/polare.js');
const P = require('../web/core/profil.js');

const datText = fs.readFileSync(path.join(__dirname, '..', 'web', 'profile', 'e374.dat'), 'utf8');

test('Projekt anlegen, speichern und wieder laden', () => {
  const pj = PR.createProject('Test');
  const e = PR.addProfile(pj, { datText });
  const aussen = PR.deriveProfile(pj, e, { thickness: 0.9, camber: 0.8 }, 'E374 aussen');
  assert.strictEqual(pj.profiles.length, 2);
  assert.ok(Math.abs(P.stats(PR.geometry(aussen)).thickness - 0.9 * P.stats(PR.geometry(e)).thickness) < 2e-3);
  const res = POL.compute(PR.geometry(e), { re: 200000, alphaFrom: 0, alphaTo: 4, alphaStep: 2 });
  const p1 = PR.storePolar(pj, e, null, res);
  const p2 = PR.storePolar(pj, e, null, res);
  assert.strictEqual(p1, p2, 'gleiche Polare wird nicht doppelt gespeichert');
  const back = PR.parse(PR.serialize(pj));
  assert.strictEqual(back.profiles.length, 2);
  assert.strictEqual(back.polars.length, 1);
  assert.strictEqual(back.profiles[1].mod.thickness, 0.9);
});

test('Fingerabdruck hängt von Klappe und Einstellungen ab', () => {
  const pj = PR.createProject();
  const e = PR.addProfile(pj, { datText });
  const o = { re: 200000 };
  const k0 = PR.polarKey(e, null, o);
  assert.notStrictEqual(k0, PR.polarKey(e, { deflection: 4, hingeX: 0.75 }, o));
  assert.notStrictEqual(k0, PR.polarKey(e, null, { re: 300000 }));
  assert.strictEqual(k0, PR.polarKey(e, null, { re: 200000 }));
});

test('Fremde Dateien werden abgelehnt', () => {
  assert.throws(() => PR.parse('{"a":1}'), /Keine Projektdatei/);
  assert.throws(() => PR.parse(JSON.stringify({ format: PR.FORMAT, version: 99 })), /neuer/);
});
