const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(path.relative(WEB, p).split(path.sep).join('/'));
  }
  return out;
}

test('Service Worker kennt alle Dateien der App (sonst fehlen sie offline)', () => {
  const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  // Erst beim Gebrauch geladen: wasm; nicht von der App geladen: Lizenzen, Quell-.dat der Bibliothek
  const need = walk(WEB).filter(f => f !== 'sw.js' && !/\.wasm$|LICENSE|license|^profile\//.test(f));
  const missing = need.filter(f => !list.includes(f));
  assert.deepStrictEqual(missing, [], 'In web/sw.js unter FILES eintragen: ' + missing.join(', '));
  const gone = list.filter(f => !/^https:|^\.\/$/.test(f) && !fs.existsSync(path.join(WEB, f)));
  assert.deepStrictEqual(gone, [], 'In web/sw.js stehen Dateien, die es nicht gibt');
});

test('Manifest und Symbole vorhanden', () => {
  const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(WEB, i.src)), i.src);
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="manifest"'));
  assert.ok(html.includes("register('sw.js')"));
});

test('Desktop-App: Offline-Speicher bildet Adressen auf Dateien ab', () => {
  const D = require('../desktop/pfad.js');
  assert.strictEqual(D.fileOf('https://mrskynavi.github.io/mm-plane-analyzer/'), 'index.html');
  assert.strictEqual(D.fileOf('https://mrskynavi.github.io/mm-plane-analyzer/core/modell.js?v=73'), 'core/modell.js');
  assert.strictEqual(D.fileOf('https://mrskynavi.github.io/mm-plane-analyzer/core/../../x'), null);
  assert.strictEqual(D.fileOf('https://mrskynavi.github.io/anderes/index.html'), null);
  assert.strictEqual(D.fileOf('https://api.github.com/repos/x'), null);
  assert.strictEqual(D.mime('a/b.wasm'), 'application/wasm');
  assert.strictEqual(D.mime('index.html'), 'text/html; charset=utf-8');
});
