// Welche Datei der App gehört zu einer Adresse? Gemeinsam für main.js und die Tests.
'use strict';
const path = require('node:path');

const ORIGIN = 'https://mrskynavi.github.io';
const BASE = '/mm-plane-analyzer/';
const SCHEME = 'mmpa';
const HOST = 'app';
const START = `${SCHEME}://${HOST}/`;

// Pfad relativ zu web/ (ohne ?v=…), oder null, wenn die Adresse nicht zur App gehört
function fileOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let p;
  if (u.protocol === SCHEME + ':' && u.host === HOST) p = u.pathname;
  else if (u.origin === ORIGIN && u.pathname.startsWith(BASE)) p = '/' + u.pathname.slice(BASE.length);
  else return null;
  p = decodeURIComponent(p);
  if (p.endsWith('/')) p += 'index.html';
  const n = path.posix.normalize(p);
  if (n.startsWith('/..') || n.includes('/../') || n.includes('\0')) return null;
  return n.replace(/^\/+/, '');
}

// Adresse der Datei auf GitHub Pages (immer die neueste Fassung); MMPA_ONLINE nur zum Testen
const ONLINE = process.env.MMPA_ONLINE || ORIGIN + BASE;
const onlineOf = (file, search) => ONLINE + file + (search || '');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.dat': 'text/plain; charset=utf-8',
};
const mime = file => TYPES[path.posix.extname(file).toLowerCase()] || 'application/octet-stream';

module.exports = { ORIGIN, BASE, SCHEME, HOST, START, fileOf, onlineOf, mime };
