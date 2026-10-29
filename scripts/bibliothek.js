// Mitgelieferte Profile (web/profile/*.dat, aus der UIUC-Profildatenbank) nach web/core/bibliothek.js packen,
// damit die Seite sie auch ohne Server (file://) laden kann. Aufruf: node scripts/bibliothek.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'web', 'profile');
const lib = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.dat')).sort()) lib[f.replace(/\.dat$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
const out = path.join(__dirname, '..', 'web', 'core', 'bibliothek.js');
fs.writeFileSync(out, '// Erzeugt von scripts/bibliothek.js aus web/profile/*.dat. Nicht von Hand ändern.\n' +
  '(function (root) {\n  const L = ' + JSON.stringify(lib) + ';\n' +
  "  if (typeof module !== 'undefined' && module.exports) module.exports = L;\n  else (root.MMPA = root.MMPA || {}).bibliothek = L;\n" +
  "})(typeof self !== 'undefined' ? self : this);\n");
console.log(out, Object.keys(lib).length, 'Profile');
