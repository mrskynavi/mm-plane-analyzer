// 3D-Ansicht des Modells im Grundriss: Netze aus core/modell3d.js, gezeichnet mit three.js (lokal in vendor/,
// läuft ohne Internet). Gezeichnet wird nur bei Änderungen (Drehen, Zoomen, neues Modell), nicht dauernd.
// App-Achsen x nach hinten, y Spannweite, z oben → three.js: X = y, Y = z, Z = x (Drehung der Achsen, Umlauf bleibt).
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const D3 = window.MMPA.modell3d, IM = window.MMPA.import3d;
const $id = id => document.getElementById(id);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const host = $id('p3host');
let renderer = null, scene, camera, controls, group, markers, ro, fitted = false, radius = 1, center = new THREE.Vector3(), bbox = new THREE.Box3(), pts = null, aspect = 1, half = 1;
let view = 'iso', impGroup = null, showModel = true, lastArgs = null;

function init() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    host.innerHTML = '<div class="p3msg">3D braucht WebGL, das in diesem Browser nicht verfügbar ist.</div>';
    return false;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  host.append(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e6); // ohne Fluchtpunkt: Seite und Vorne wie im Plan
  scene.add(new THREE.HemisphereLight(0xffffff, 0x708090, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.6, 1, -0.5);
  camera.add(sun); // Licht wandert mit der Kamera: die sichtbare Seite ist immer beleuchtet
  scene.add(camera);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minZoom = 0.3; controls.maxZoom = 40;
  controls.addEventListener('change', render);
  ro = new ResizeObserver(() => { resize(); render(); });
  ro.observe(host);
  return true;
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  aspect = w / h;
  camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
}

function render() { if (renderer) renderer.render(scene, camera); }

const toThree = (P) => {
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) { out[i] = P[i + 1]; out[i + 1] = P[i + 2]; out[i + 2] = P[i]; }
  return out;
};

function colors() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
  return dark
    ? { wing: 0xc4ccd6, tail: 0xb9c3cf, fuse: 0x9eaab8, fin: 0xb9c3cf }
    : { wing: 0xd3dbe4, tail: 0xc6d0dc, fuse: 0xaab5c2, fin: 0xc6d0dc };
}

function build(m, r) {
  const g = D3.build(m, project.profiles, { finArea: r?.fuselage?.fin });
  if (group) { scene.remove(group); group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  group = new THREE.Group();
  const C = colors();
  g.parts.forEach(p => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(toThree(p.positions), 3));
    geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
    geo.computeVertexNormals();
    const see = imports.some(q => q.visible && q.out); // mit Importen durchscheinend, damit beide zu sehen sind
    const mat = new THREE.MeshStandardMaterial({ color: C[p.kind] ?? 0xcccccc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, transparent: see, opacity: see ? 0.45 : 1, depthWrite: !see });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = p.name;
    group.add(mesh);
  });
  group.visible = showModel;
  scene.add(group);
  const b = g.bounds;
  // Importe zählen für den Ausschnitt mit
  imports.forEach(q => { if (q.visible && q.out) { const ib = IM.bounds(q.out); for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], ib.min[k]); b.max[k] = Math.max(b.max[k], ib.max[k]); } } });
  const box = new THREE.Box3(new THREE.Vector3(b.min[1], b.min[2], b.min[0]), new THREE.Vector3(b.max[1], b.max[2], b.max[0]));
  const c = box.getCenter(new THREE.Vector3()), rad = box.getSize(new THREE.Vector3()).length() / 2;
  // Ausschnitt nur neu setzen, wenn sich die Grösse merklich ändert, sonst springt die Ansicht bei jeder Eingabe
  if (!fitted || Math.abs(rad - radius) > 0.15 * radius) { center.copy(c); radius = rad; bbox.copy(box); fitted = false; }
  // Punkte für den Ausschnitt (jeder vierte genügt)
  const all = [];
  [...group.children, ...(impGroup ? impGroup.children : [])].forEach(o => { const a = o.geometry.attributes.position.array, st = Math.max(12, 3 * Math.ceil(a.length / 3 / 4000) * 3); for (let i = 0; i < a.length; i += st) all.push(a[i], a[i + 1], a[i + 2]); });
  pts = Float32Array.from(all);
  markersFor(r);
  $id('p3hint').textContent = g.missing.length ? 'Nicht gezeichnet: ' + g.missing.join(' · ') : 'Ziehen dreht · Mausrad oder zwei Finger zoomen · rechte Maustaste oder zwei Finger verschieben';
}

// Schwerpunkt (rot) und Neutralpunkt (grün) auf der Mittellinie, immer sichtbar (auch durch den Rumpf)
function markersFor(r) {
  if (markers) { scene.remove(markers); markers.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  markers = new THREE.Group();
  if (r) {
    const s = Math.max(4, radius * 0.01);
    [[r.xCG, '--bad'], [r.xNP, '--good']].forEach(([x, v]) => {
      if (!Number.isFinite(x)) return;
      const mk = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(cssVar(v) || '#888'), depthTest: false }));
      mk.position.set(0, s * 1.5, x);
      mk.renderOrder = 10;
      markers.add(mk);
    });
  }
  scene.add(markers);
}

const DIRS = {
  iso: [-0.9, 0.55, -0.95],
  top: [0, 1, 0.0005],
  front: [0, 0, -1],
  side: [-1, 0, 0],
};
function setView(v) {
  view = DIRS[v] ? v : 'iso';
  document.querySelectorAll('#p3view button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
  const d = new THREE.Vector3(...DIRS[view]).normalize();
  // Ausschnitt so, dass alle Punkte ins Bild passen (lange schlanke Flügel füllen die Breite)
  camera.position.copy(center).add(d); camera.lookAt(center); camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let hx = 1, hy = 1;
  const q = new THREE.Vector3();
  if (pts) for (let i = 0; i < pts.length; i += 3) {
    q.set(pts[i], pts[i + 1], pts[i + 2]).sub(center);
    hx = Math.max(hx, Math.abs(q.dot(right))); hy = Math.max(hy, Math.abs(q.dot(up)));
  }
  half = Math.max(hy, hx / aspect) * 1.08;
  camera.zoom = 1;
  camera.near = radius * 0.05; camera.far = radius * 10;
  camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(d, radius * 4);
  camera.lookAt(center);
  controls.update();
  fitted = true;
  render();
}

function draw(m, r) {
  lastArgs = [m, r];
  if (!renderer && !init()) return;
  resize();
  if (impModel !== m.id) impReady = loadImports(m);
  try { build(m, r); } catch (e) { $id('p3hint').textContent = '3D nicht möglich: ' + e.message; }
  if (!fitted) setView(view); else render();
}
const redraw = refit => { if (refit) fitted = false; if (lastArgs) draw(...lastArgs); };

// ---------- Importierte 3D-Dateien (3MF, OBJ, STL, STEP) ----------
// Je Modell gespeichert in IndexedDB „mmpa-3d“ (nur dieses Gerät): Datei als Bytes und die gewählte Lage.
let imports = [], impModel = null, impReady = Promise.resolve();
const DB = 'mmpa-3d', STORE = 'files';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('kein IndexedDB')); return; }
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('model', 'model');
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const db = rq.result, tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
      let out; Promise.resolve(fn(st)).then(v => { out = v; });
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('abgebrochen')); };
    };
  });
}
const req = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
const saveImp = q => idb('readwrite', st => st.put({ id: q.id, model: q.model, name: q.name, buf: q.buf, place: q.place, visible: q.visible })).catch(() => {});

// STEP: OpenCascade im Worker, erst beim ersten STEP geladen
let stepWorker = null;
function readStep(u8) {
  return new Promise((resolve, reject) => {
    stepWorker = stepWorker || new Worker('vendor/occt/step-worker.js');
    stepWorker.onmessage = e => resolve(e.data);
    stepWorker.onerror = e => { e.preventDefault(); stepWorker.terminate(); stepWorker = null; reject(new Error('STEP-Leser liess sich nicht laden')); };
    stepWorker.postMessage({ buffer: u8, params: IM.OCCT_PARAMS });
  });
}

async function parseImp(q) {
  q.err = ''; q.busy = true; renderImpList();
  try { q.raw = await IM.parse(q.name, q.buf.slice(0), { step: readStep }); } catch (e) { q.raw = null; q.err = e.message; }
  q.busy = false;
  placeImp(q);
}
function placeImp(q) {
  q.out = null;
  if (q.raw) { try { q.out = IM.place(q.raw.meshes, q.raw.unit, q.place); q.err = ''; } catch (e) { q.err = e.message; } }
  buildImpGroup(); renderImpList();
}
function buildImpGroup() {
  if (!scene) return;
  if (impGroup) { scene.remove(impGroup); impGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  impGroup = new THREE.Group();
  const col = new THREE.Color(cssVar('--violet') || '#7a45c4');
  imports.forEach(q => {
    if (!q.visible || !q.out) return;
    q.out.forEach(p => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(toThree(p.positions), 3));
      geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geo.computeVertexNormals();
      impGroup.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide })));
    });
  });
  scene.add(impGroup);
  redraw();
}

async function loadImports(m) {
  impModel = m.id; imports = [];
  renderImpList(); buildImpGroup();
  let rows = [];
  try { rows = await idb('readonly', st => req(st.index('model').getAll(m.id))); } catch (e) { rows = []; }
  if (impModel !== m.id) return;
  imports = (rows || []).map(r => ({ ...r, raw: null, out: null, err: '', busy: false }));
  for (const q of imports) await parseImp(q);
  redraw(true);
}

async function addFiles(files) {
  const m = curModel();
  if (impModel !== m.id) impReady = loadImports(m);
  await impReady; // gespeicherte Importe zuerst, sonst überschreiben sie die neuen
  for (const f of files) {
    if (!IM.kindOf(f.name)) { toast?.('Nicht unterstützt: ' + f.name + ' (3MF, OBJ, STL, STEP)'); continue; }
    const q = { id: m.id + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), model: m.id, name: f.name, buf: await f.arrayBuffer(), place: null, visible: true, raw: null, out: null, err: '' };
    imports.push(q);
    await parseImp(q);
    if (q.raw) { q.place = IM.suggest(q.raw, f.name, m); placeImp(q); }
    else q.place = { ...IM.DEFAULT_PLACE, part: 'free' };
    saveImp(q);
  }
  redraw(true);
}

const AXES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const opt = (list, v) => list.map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function renderImpList() {
  const box = $id('p3imp'); if (!box) return;
  box.innerHTML = imports.map(q => {
    const p = q.place || IM.DEFAULT_PLACE;
    const info = q.busy ? 'liest …' : q.err ? `<span class="err">${esc(q.err)}</span>` : q.raw ? `${(n => n < 10000 ? n : Math.round(n / 1000) + 'k')(IM.triangles(q.raw.meshes))} Dreiecke · ${q.raw.meshes.length} Körper` : '';
    const unitKnown = q.raw && (q.raw.source === '3mf' || q.raw.source === 'step');
    return `<div class="p3row" data-id="${esc(q.id)}">
      <label title="zeigen"><input type="checkbox" data-k="visible"${q.visible ? ' checked' : ''}></label><b>${esc(q.name)}</b><small>${info}</small>
      <label>Teil <select data-k="part">${opt([['wing', 'Flügel'], ['tail', 'Höhenleitwerk'], ['fuse', 'Rumpf'], ['free', 'frei']], p.part || 'free')}</select></label>
      <label>oben <select data-k="up">${opt(AXES.map(a => [a, a]), p.up)}</select></label>
      <label>Nase <select data-k="nose">${opt(AXES.map(a => [a, a]), p.nose)}</select></label>
      ${unitKnown ? '' : `<label>Einheit <select data-k="scale">${opt([['1', 'mm'], ['10', 'cm'], ['1000', 'm'], ['25.4', 'Zoll']], String(p.scale || 1))}</select></label>`}
      <label><input type="checkbox" data-k="mirror"${p.mirror ? ' checked' : ''}> spiegeln</label>
      <label>x <input type="number" step="1" data-k="dx" value="${+(p.dx || 0).toFixed(1)}"></label>
      <label>y <input type="number" step="1" data-k="dy" value="${+(p.dy || 0).toFixed(1)}"></label>
      <label>z <input type="number" step="1" data-k="dz" value="${+(p.dz || 0).toFixed(1)}"></label>
      <button type="button" class="x" data-k="del" title="entfernen" aria-label="${esc(q.name)} entfernen">×</button></div>`;
  }).join('');
}

$id('p3imp').addEventListener('change', e => {
  const row = e.target.closest('.p3row'), k = e.target.dataset.k; if (!row || !k) return;
  const q = imports.find(i => i.id === row.dataset.id); if (!q) return;
  const p = q.place = { ...(q.place || IM.DEFAULT_PLACE) };
  if (k === 'visible') q.visible = e.target.checked;
  else if (k === 'mirror') p.mirror = e.target.checked;
  else if (k === 'up' || k === 'nose') p[k] = e.target.value;
  else if (k === 'scale') p.scale = +e.target.value || 1;
  else if (k === 'part') {
    // Lage aus dem Modell: Flügel an der Wurzelnase, HLW an der Leitwerkslage, sonst wie gesetzt
    p.part = e.target.value; const m = curModel();
    if (p.part === 'wing') { p.dx = 0; p.dz = 0; } else if (p.part === 'tail') { p.dx = m.tail.x || 0; p.dz = m.tail.z || 0; }
  } else if (/^d[xyz]$/.test(k)) p[k] = parseFloat(e.target.value) || 0;
  placeImp(q); saveImp(q);
});
$id('p3imp').addEventListener('click', e => {
  const b = e.target.closest('button[data-k="del"]'), row = e.target.closest('.p3row'); if (!b || !row) return;
  imports = imports.filter(i => i.id !== row.dataset.id);
  idb('readwrite', st => st.delete(row.dataset.id)).catch(() => {});
  buildImpGroup(); renderImpList(); redraw(true);
});
$id('p3load').addEventListener('click', () => $id('p3file').click());
$id('p3file').addEventListener('change', () => { const f = [...$id('p3file').files]; $id('p3file').value = ''; if (f.length) addFiles(f).catch(err => { console.error(err); toast('3D-Datei: ' + err.message); }); });
$id('p3model').addEventListener('change', e => { showModel = e.target.checked; redraw(); });
// Dateien auch per Ziehen auf die 3D-Fläche
host.addEventListener('dragover', e => { e.preventDefault(); });
host.addEventListener('drop', e => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f).catch(err => { console.error(err); toast('3D-Datei: ' + err.message); }); });

$id('p3view').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setView(b.dataset.v); });

window.MMPA3D = { draw, setView };
// Der Grundriss stand schon auf 3D, bevor dieses Modul geladen war
if (window.MMPA3D_pending || !$id('plan3d').hidden) { window.MMPA3D_pending = false; draw(curModel(), lastModel); }
