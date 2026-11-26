// Service Worker: macht die App offline nutzbar (Browser, iPad, als App installiert).
// Immer zuerst das Netz (damit nach jedem Push auf main die neue Fassung kommt), ohne Verbindung
// der zuletzt geladene Stand aus dem Zwischenspeicher. GitHub- und Claude-API gehen nie über den Speicher.
// Neue Dateien in web/ hier in FILES eintragen (test/offline.test.js prüft das).
'use strict';
const CACHE = 'mmpa-app-2';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'maskable-512.png',
  'cloud-ui.js', 'drei-ui.js', 'dreiseiten-ui.js', 'festigkeit-ui.js', 'frage-ui.js', 'sfw-ui.js', 'verlauf-ui.js',
  'core/aeroelastik.js', 'core/bauteile3d.js', 'core/bibliothek.js', 'core/cloud.js', 'core/dreiseiten.js',
  'core/druckbild.js', 'core/excel.js', 'core/frage.js', 'core/fusion.js', 'core/import3d.js', 'core/kanal.js',
  'core/messpolare.js', 'core/modell-worker.js', 'core/modell.js', 'core/modell3d.js', 'core/nachlauf.js',
  'core/neuralfoil.js', 'core/nf-gewichte.js', 'core/ordner.js', 'core/polare.js', 'core/profil.js',
  'core/projekt.js', 'core/rumpf.js', 'core/sfw.js', 'core/skalieren.js', 'core/strak-worker.js', 'core/strak.js', 'core/struktur.js',
  'core/verlauf.js', 'core/vlm.js',
  'vendor/OrbitControls.js', 'vendor/three.module.min.js', 'vendor/chart.umd.min.js',
  'vendor/occt/occt-import-js.js', 'vendor/occt/step-worker.js',
  'vendor/rhino3dm/rhino-worker.js', 'vendor/rhino3dm/rhino3dm.min.js',
];
// Grosse Teile (STEP- und 3DM-Leser, je einige MB) kommen erst beim ersten Gebrauch in den Speicher.
const EXTERN = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const WAIT = 5000;

// Schlüssel ohne ?v=… : die Seite hängt Fassungsnummern an, offline soll trotzdem die Datei kommen
const keyOf = url => { const u = new URL(url); if (u.origin === self.location.origin) u.search = ''; return u.href; };

async function refresh(all) {
  const c = await caches.open(CACHE);
  await Promise.all(FILES.map(async f => {
    try {
      const r = await fetch(new Request(f, { cache: 'no-cache' }));
      if (r.ok) await c.put(keyOf(new URL(f, self.location.href).href), r);
    } catch (e) { if (all) throw e; }
  }));
}

self.addEventListener('install', e => { e.waitUntil(refresh(false).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('mmpa-app-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Die Seite meldet sich nach dem Laden: dann alle Dateien im Hintergrund auffrischen,
// damit offline Seite und Rechenkerne (Worker) zur selben Fassung gehören.
self.addEventListener('message', e => { if (e.data === 'auffrischen') e.waitUntil(refresh(false)); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === self.location.origin;
  if (!mine && !EXTERN.test(req.url)) return;
  e.respondWith(netFirst(req, req.mode === 'navigate'));
});

async function netFirst(req, nav) {
  const c = await caches.open(CACHE);
  const key = nav ? keyOf(new URL('./', self.location.href).href) : keyOf(req.url);
  const net = fetch(req).then(r => {
    if (r && (r.ok || r.type === 'opaque')) c.put(key, r.clone()).catch(() => {});
    return r;
  });
  // Bei langsamer Verbindung nicht ewig warten, wenn es einen gespeicherten Stand gibt
  const slow = new Promise(res => setTimeout(res, WAIT));
  try {
    const r = await Promise.race([net, slow.then(() => null)]);
    if (r) return r;
    const hit = await c.match(key);
    return hit || await net;
  } catch (err) {
    const hit = await c.match(key) || (nav ? await c.match(keyOf(new URL('index.html', self.location.href).href)) : null);
    if (hit) return hit;
    throw err;
  }
}
