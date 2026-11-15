// 3D-Ansicht des Modells im Grundriss: Netze aus core/modell3d.js, gezeichnet mit three.js (lokal in vendor/,
// läuft ohne Internet). Gezeichnet wird nur bei Änderungen (Drehen, Zoomen, neues Modell), nicht dauernd.
// App-Achsen x nach hinten, y Spannweite, z oben → three.js: X = y, Y = z, Z = x (Drehung der Achsen, Umlauf bleibt).
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const D3 = window.MMPA.modell3d, IM = window.MMPA.import3d, DBild = window.MMPA.druckbild, VL = window.MMPA.vlm;
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
    // mit Importen durchscheinend, damit beide zu sehen sind; mit Druck/Grenzschicht scheint der Import durch
    const see = layer === 'form' && imports.some(q => q.visible && q.out);
    const mat = new THREE.MeshStandardMaterial({ color: C[p.kind] ?? 0xcccccc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, transparent: see, opacity: see ? 0.45 : 1, depthWrite: !see });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = p.name;
    mesh.userData = { kind: p.kind, app: p.positions, surface: p.surface, base: C[p.kind] ?? 0xcccccc };
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
  syncWk(m, r);
  paint();
  loadBands(m, r);
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

// ---------- Druckbild, Ablösekarte, Abriss-Film, Lastverteilung (W2) ----------
// Gerechnet in einem eigenen Worker (core/modell-worker.js, Nachricht kind 'druck'); je Flugzustand ein Bild,
// zwischengespeichert, bis sich die Modellrechnung ändert.
let layer = 'form', wkR = null, wkStates = [], wkKey = 'trim', frames = new Map(), pending = new Set();
let druckWorker = null, druckSeq = 0, filmTimer = null, filmIdx = -1, showBands = false, bands = null;
try { const v = localStorage.getItem('mmpa.p3layer'); if (v === 'cp' || v === 'bl') layer = v; } catch (e) {}
// Biegung (F2): Ergebnis aus dem Reiter Festigkeit, Lastfall und Überhöhung
let festRes = null, defCase = '', defScale = 1, defN = null, ghost = null;
// Lastvielfaches am Schieber: Lasten und Verformung wachsen linear mit n (Auftrieb und Massenkräfte), die Reserve fällt mit 1/n
const nFactor = c => (defN == null || !(c.n > 0) ? 1 : Math.min(defN, c.n) / c.n);
const STATE_COL = ['--accent', '--good', '--warn', '--bad'];
const STATE_TXT = ['laminar', 'turbulent', 'Ablöseblase', 'abgelöst'];
const CP_MIN = -1.5, CP_MAX = 1;

function syncWk(m, r) {
  if (r !== wkR) {
    wkR = r; frames.clear(); pending.clear(); druckSeq++; flowGen++;
    wkStates = r && r.load ? DBild.states(m, r) : [];
    if (!wkStates.some(q => q.key === wkKey)) wkKey = 'trim';
    stateUi();
    if (filmTimer) stopFilm();
  }
  document.querySelectorAll('#p3layer button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.l === layer)));
  if (layer === 'def') needFest(); else if (layer !== 'form') need([wkKey]);
  needFlow();
}
// Schieber für den Flugzustand: Trimm, dann die Arbeitstabelle nach Ca, dann α darüber hinaus
function stateUi() {
  const sl = $id('p3state'), i = Math.max(0, wkStates.findIndex(q => q.key === wkKey)), q = wkStates[i];
  sl.max = String(Math.max(0, wkStates.length - 1)); sl.value = String(i); sl.disabled = wkStates.length < 2;
  $id('p3stateo').textContent = q ? q.label + (q.v ? ' · ' + Math.round(q.v * 3.6) + ' km/h' : '') : '';
  sl.setAttribute('aria-valuetext', $id('p3stateo').textContent);
}
function need(keys) {
  const m = lastArgs && lastArgs[0];
  const want = keys.filter(k => !frames.has(k) && !pending.has(k));
  if (!want.length || !wkR || !m) return;
  const list = want.map(k => wkStates.find(q => q.key === k)).filter(Boolean);
  if (!druckWorker) {
    try {
      druckWorker = new Worker('core/modell-worker.js?v=' + (window.MMPA_BUILD || ''));
      druckWorker.onmessage = onFrame;
      druckWorker.onerror = e => { e.preventDefault(); druckWorker.terminate(); druckWorker = null; pending.clear(); keyInfo('Druckbild konnte nicht gerechnet werden.'); };
    } catch (e) { keyInfo('Druckbild braucht Web Worker.'); return; }
  }
  // offene Anfragen gehen in der neuen auf (der Worker bricht die alte nach dem laufenden Zustand ab)
  const all = [...pending].map(k => wkStates.find(q => q.key === k)).filter(Boolean).concat(list);
  all.forEach(q => pending.add(q.key));
  druckSeq++;
  druckWorker.seqStates = all;
  druckWorker.postMessage({ kind: 'druck', seq: druckSeq, model: m, profiles: project.profiles, r: wkR, states: all, nCrit: lab.nCrit });
  keyInfo('rechnet …');
}
function onFrame(e) {
  const d = e.data;
  if (d.seq !== druckSeq) return;
  if (d.kind === 'done') return;
  const st = druckWorker.seqStates[d.i];
  if (!st) return;
  pending.delete(st.key);
  if (d.error) { keyInfo('Druckbild: ' + d.error); return; }
  frames.set(st.key, d.frame);
  if (st.key === wkKey) { paint(); render(); }
}

const lerpCol = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const CP_LO = [0.12, 0.33, 0.85], CP_MID = [0.93, 0.93, 0.92], CP_HI = [0.85, 0.25, 0.2];
function cpColor(cp) {
  if (!Number.isFinite(cp)) return CP_MID;
  // Wurzel macht kleine Unterschiede sichtbar (Cp −0,3 … −0,7 im Reiseflug)
  if (cp < 0) return lerpCol(CP_MID, CP_LO, Math.sqrt(Math.min(1, cp / CP_MIN)));
  return lerpCol(CP_MID, CP_HI, Math.sqrt(Math.min(1, cp / CP_MAX)));
}
let stateRgb = null;
const rgbOf = v => { const c = new THREE.Color(cssVar(v) || '#888'); return [c.r, c.g, c.b]; };

// Farben je Punkt der Flügel- und HLW-Netze aus den Streifen des Bildes
function paint() {
  if (!group) return;
  deform();
  const f = layer === 'form' || layer === 'def' ? null : frames.get(wkKey);
  stateRgb = STATE_COL.map(rgbOf);
  group.children.forEach(o => {
    const u = o.userData;
    if (u.kind !== 'wing' && u.kind !== 'tail') return;
    const strips = f ? (u.kind === 'wing' ? f.wing : f.tail) : null;
    if (u.def) return; // Biegung färbt selbst
    if (!strips || !strips.length) {
      if (o.geometry.attributes.color) { o.geometry.deleteAttribute('color'); o.material.vertexColors = false; o.material.color.set(u.base); o.material.needsUpdate = true; }
      return;
    }
    const P = u.app, A = u.surface, n = P.length / 3, col = new Float32Array(n * 3), xs = f.x, base = new THREE.Color(u.base);
    const ys = strips.map(q => q.y);
    for (let i = 0; i < n; i++) {
      const side = A[i * 2 + 1], xc = A[i * 2];
      let c;
      if (!side) c = [base.r, base.g, base.b];
      else {
        const y = Math.abs(P[i * 3 + 1]);
        let k = 1; while (k < ys.length - 1 && y > ys[k]) k++;
        const a = strips[Math.max(0, k - 1)], b = strips[Math.min(strips.length - 1, k)];
        const t = ys.length < 2 ? 0 : Math.min(1, Math.max(0, (y - a.y) / ((b.y - a.y) || 1)));
        const sa = side > 0 ? a.upper : a.lower, sb = side > 0 ? b.upper : b.lower;
        if (layer === 'cp') c = cpColor(DBild.at(xs, sa.cp, xc) * (1 - t) + DBild.at(xs, sb.cp, xc) * t);
        else c = stateRgb[DBild.stateAt(xs, (t < 0.5 ? sa : sb).st, xc)];
      }
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    o.material.vertexColors = true; o.material.color.set(0xffffff); o.material.needsUpdate = true;
  });
  if (layer === 'def') keyDef(); else key(f);
}

// ---------- Biegung: verformter Flügel mit Reserve als Farbe ----------
function needFest() {
  if (!window.MMPAFest) { keyInfo('Festigkeit ist nicht geladen.'); return; }
  keyInfo('rechnet …');
  window.MMPAFest.need(res => {
    festRes = res;
    const sel = $id('p3case'), cs = res ? res.wing.cases : [];
    if (!cs.some(c => c.key === defCase)) defCase = cs[0] ? cs[0].key : '';
    sel.innerHTML = cs.map(c => `<option value="${c.key}"${c.key === defCase ? ' selected' : ''}>${c.label} · n ${c.n.toFixed(1)}</option>`).join('');
    nUi();
    if (layer === 'def') { paint(); render(); }
  });
}
// wie lin, aber über das letzte Stück hinaus mit dessen Steigung weiter (Randbogen ausserhalb der letzten Station)
const linX = (xs, arr, x) => { const n = xs.length; if (n > 1 && x > xs[n - 1]) return arr[n - 1] + (arr[n - 1] - arr[n - 2]) / ((xs[n - 1] - xs[n - 2]) || 1) * (x - xs[n - 1]); return lin(xs, arr, x); };
const lin = (xs, arr, x) => { if (x <= xs[0]) return arr[0]; for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return arr[i - 1] + (arr[i] - arr[i - 1]) * t; } return arr[arr.length - 1]; };
function reserveColor(r) {
  const t = Math.min(1, Math.max(0, r - 1)); // 1 → rot, 2 → grün
  const bad = [0.84, 0.22, 0.2], mid = [0.93, 0.72, 0.2], good = [0.22, 0.66, 0.38];
  return t < 0.5 ? lerpCol(bad, mid, t * 2) : lerpCol(mid, good, t * 2 - 1);
}
function deform() {
  const m = lastArgs && lastArgs[0], on = layer === 'def' && festRes && m;
  if (ghost) { scene.remove(ghost); ghost.traverse(o => { o.material?.dispose(); }); ghost = null; }
  if (on) ghost = new THREE.Group();
  group.children.forEach(o => {
    const u = o.userData;
    if (u.kind !== 'wing' && u.kind !== 'tail') return;
    const Pt = on ? festRes[u.kind] : null, c = Pt && (Pt.cases.find(q => q.key === defCase) || Pt.cases[0]);
    if (!c) {
      if (u.def) { o.geometry.setAttribute('position', new THREE.BufferAttribute(toThree(u.app), 3)); o.geometry.computeVertexNormals(); u.def = false; }
      return;
    }
    // Holmachse: Nasenleiste + Holmlage · Tiefe an jeder Station
    const tail = u.kind === 'tail', S = m[u.kind], pos = Pt.struct.spar.pos / 100;
    const SP = tail ? VL.stationPoints(S.stations, m.tail.x, m.tail.z || 0) : VL.stationPoints(S.stations);
    const yS = SP.map(p => p.le[1]), xS = SP.map((p, i) => p.le[0] + pos * S.stations[i].chord);
    const A = u.app, n = A.length / 3, out = new Float32Array(A.length), col = new Float32Array(A.length);
    const fN = nFactor(festRes.wing.cases.find(q => q.key === c.key) || c);
    const res = Pt.ys.map((_, i) => Math.min(c.rCap[i], c.rWeb[i], c.rShell[i], c.rTors[i]) / fN);
    for (let i = 0; i < n; i++) {
      const x = A[i * 3], y = A[i * 3 + 1], z = A[i * 3 + 2], ya = Math.abs(y);
      const w = linX(Pt.ys, c.w, ya) * defScale * fN, ph = linX(Pt.ys, c.phi, ya) * defScale * fN * Math.PI / 180, xs = lin(yS, xS, ya);
      // Verwindung um die Holmachse (Nase hoch positiv), dann Durchbiegung nach oben
      out[i * 3] = xs + (x - xs) * Math.cos(ph); out[i * 3 + 1] = y; out[i * 3 + 2] = z - (x - xs) * Math.sin(ph) + w;
      const cc = reserveColor(lin(Pt.ys, res, ya));
      col[i * 3] = cc[0]; col[i * 3 + 1] = cc[1]; col[i * 3 + 2] = cc[2];
    }
    // Geisterbild der unverformten Form
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(toThree(A), 3)); gg.setIndex(o.geometry.index); gg.computeVertexNormals();
    ghost.add(new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ color: u.base, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })));
    o.geometry.setAttribute('position', new THREE.BufferAttribute(toThree(out), 3)); o.geometry.computeVertexNormals();
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    o.material.vertexColors = true; o.material.color.set(0xffffff); o.material.needsUpdate = true;
    u.def = true;
  });
  if (ghost) scene.add(ghost);
}
function keyDef() {
  const k = $id('p3key'); k.hidden = false;
  if (!festRes) { k.innerHTML = 'rechnet …'; return; }
  const P = festRes.wing, c = P.cases.find(q => q.key === defCase) || P.cases[0];
  if (!c) { k.innerHTML = ''; return; }
  const f = nFactor(c), n = c.n * f, w = { ...c.worst, reserve: c.worst.reserve / f }, bar = 'linear-gradient(90deg,rgb(214,56,51),rgb(237,184,51),rgb(56,168,97))';
  k.innerHTML = `<div><b>${c.label}</b> · n ${n.toFixed(1)}${f < 1 ? ' von ' + c.n.toFixed(1) : ''} · Rand ${Math.round(c.tipW * f)} mm · Verwindung ${(c.tipPhi * f).toFixed(1)}°${defScale > 1 ? ' · ' + defScale + '-fach überhöht' : ''}${Number.isFinite(w.reserve) ? ` · <span class="${w.reserve < 1 ? 'warn' : ''}">kleinste Reserve ${w.reserve.toFixed(2)} (${w.what}, y ${Math.round(w.y)} mm)</span>` : ''}</div><div class="leg"><span>Reserve 1 <span class="bar" style="background:${bar}"></span> 2 und mehr</span><span>Aufbau und Lasten im Reiter Festigkeit</span></div>`;
}

function keyInfo(t) { const k = $id('p3key'); k.hidden = false; k.innerHTML = t; }
function key(f) {
  const k = $id('p3key');
  if (layer === 'form' && !showBands) { k.hidden = true; return; }
  const st = wkStates.find(q => q.key === wkKey);
  const head = st ? `<b>${st.label}</b>${st.v ? ' · ' + Math.round(st.v * 3.6) + ' km/h' : ''} · Ca ${st.cl.toFixed(2)}` : '';
  let leg = '';
  if (layer === 'cp') leg = `<span>Sog <span class="bar" style="background:linear-gradient(90deg,rgb(31,84,217),rgb(237,237,235) 60%,rgb(217,64,51))"></span> Druck</span><span>Cp ${CP_MIN.toLocaleString('de-CH')} … 0 … +${CP_MAX}</span>`;
  if (layer === 'bl') leg = STATE_TXT.map((t, i) => `<span><i style="background:${cssVar(STATE_COL[i])}"></i>${t}</span>`).join('');
  let stall = '';
  // Wo der Abriss beginnt: erster Zustand (nach Ca geordnet) mit abgelösten Streifen
  const onset = wkStates.filter(q => q.film).map(q => [q, frames.get(q.key)]).find(([, g]) => g && g.stall.first && g.stall.stalled >= 0.05);
  if (f && layer !== 'form') {
    const s = f.stall;
    if (s.first) {
      const where = s.first.eta < 0.5 ? 'innen, gutmütig' : s.first.eta > 0.75 ? 'aussen, kritisch' : 'Mitte';
      stall = ` · <span class="warn">Ablösung bei ${Math.round(s.first.eta * 100)} % Halbspannweite (${where}), ${Math.round(s.stalled * 100)} % des Flügels</span>`;
    } else stall = ' · Strömung liegt an';
    if (onset && onset[0].key !== wkKey) stall += ` · Abriss beginnt bei ${onset[0].label} (${Math.round(onset[1].stall.first.eta * 100)} % Halbspannweite)`;
  } else if (layer !== 'form') stall = ' · rechnet …';
  k.hidden = false;
  k.innerHTML = `<div>${head}${stall}</div>${leg ? '<div class="leg">' + leg + '</div>' : ''}`;
}

// Auftrieb je Streifen (Ca · Tiefe) als Band über dem Flügel, elliptisch gestrichelt zum Vergleich
function loadBands(m, r) {
  if (bands) { scene.remove(bands); bands.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); bands = null; }
  if (!showBands || !r || !r.load) return;
  const st = wkStates.find(q => q.key === wkKey) || wkStates[0]; if (!st) return;
  const L = r.load, P = VL.stationPoints(m.wing.stations), yS = P.map(p => p.le[1]);
  const leX = y => { let k = 1; while (k < yS.length - 1 && y > yS[k]) k++; const t = Math.min(1, Math.max(0, (y - yS[k - 1]) / ((yS[k] - yS[k - 1]) || 1))); return P[k - 1].le[0] + (P[k].le[0] - P[k - 1].le[0]) * t; };
  const W = [];
  for (let i = 0; i < L.surf.length; i++) if (L.surf[i] === 0) W.push({ y: L.y[i], z: L.z[i], c: L.chord[i], w: L.width[i], g: (L.c0[i] + st.alpha * L.ca[i] + st.it * L.ci[i]) * L.chord[i] });
  if (!W.length) return;
  W.sort((a, b) => a.y - b.y);
  const b2 = r.wing.projSpan / 2, gMax = Math.max(...W.map(q => Math.abs(q.g)), 1e-6), h = 0.12 * b2 / gMax;
  // elliptisch mit gleichem Gesamtauftrieb: ∫ g dy = π/4 · g0 · b/2
  const area = W.reduce((s, q) => s + q.g * q.w, 0), g0 = area / (Math.PI / 4 * b2);
  bands = new THREE.Group();
  const acc = new THREE.Color(cssVar('--accent') || '#0b6bcb'), mut = new THREE.Color(cssVar('--muted') || '#888');
  [1, -1].forEach(sd => {
    const top = [], ell = [], seg = [];
    W.forEach(q => {
      const x = leX(q.y) + q.c / 4, base = new THREE.Vector3(q.y * sd, q.z, x), tip = new THREE.Vector3(q.y * sd, q.z + q.g * h, x);
      top.push(tip); seg.push(base, tip);
      ell.push(new THREE.Vector3(q.y * sd, q.z + g0 * Math.sqrt(Math.max(0, 1 - (q.y / b2) ** 2)) * h, x));
    });
    bands.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: acc })));
    bands.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: acc, transparent: true, opacity: 0.45 })));
    const e = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ell), new THREE.LineDashedMaterial({ color: mut, dashSize: b2 / 60, gapSize: b2 / 90 }));
    e.computeLineDistances(); bands.add(e);
  });
  scene.add(bands);
}

function setLayer(l) {
  const was = layer;
  layer = l; try { localStorage.setItem('mmpa.p3layer', l); } catch (e) {}
  // Farben liegen auf dem gerechneten Modell: einschalten, Importe durchscheinend
  if (l !== 'form' && !showModel) { showModel = true; $id('p3model').checked = true; }
  if ((was === 'form') !== (l === 'form') && imports.some(q => q.visible && q.out)) buildImpGroup();
  else redraw();
  document.querySelectorAll('#p3layer button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.l === layer)));
  $id('p3def').hidden = layer !== 'def'; $id('p3wkc').hidden = layer === 'def';
  if (layer === 'def') { if (filmTimer) stopFilm(); needFest(); } else if (layer !== 'form') need([wkKey]);
}
function setState(k) {
  wkKey = k; stateUi();
  if (layer !== 'form') need([k]);
  paint();
  if (lastArgs) loadBands(lastArgs[0], lastArgs[1]);
  needFlow(); // kurz warten: beim Ziehen am Schieber nur den letzten Zustand rechnen
  render();
}
function stopFilm() {
  clearInterval(filmTimer); filmTimer = null;
  $id('p3film').textContent = '▶ Abriss-Film';
}
function playFilm() {
  if (filmTimer) { stopFilm(); return; }
  if (layer === 'form') setLayer('bl');
  const list = wkStates.filter(q => q.film);
  if (!list.length) return;
  need(list.map(q => q.key));
  filmIdx = 0;
  $id('p3film').textContent = '■ Stopp';
  setState(list[0].key);
  filmTimer = setInterval(() => {
    if (!frames.has(list[filmIdx].key)) return; // warten, bis das Bild gerechnet ist
    filmIdx++;
    if (filmIdx >= list.length) { stopFilm(); return; }
    setState(list[filmIdx].key);
  }, 450);
}
$id('p3layer').addEventListener('click', e => { const b = e.target.closest('button[data-l]'); if (b) setLayer(b.dataset.l); });
$id('p3state').addEventListener('input', e => { if (filmTimer) stopFilm(); const q = wkStates[+e.target.value]; if (q) setState(q.key); });
$id('p3film').addEventListener('click', playFilm);
function nUi() {
  const sl = $id('p3n'), c = festRes && (festRes.wing.cases.find(q => q.key === defCase) || festRes.wing.cases[0]);
  if (!c) return;
  const lo = Math.min(1, c.n), hi = c.n;
  sl.min = String(lo); sl.max = String(hi); sl.step = String(Math.max(0.1, Math.round((hi - lo) / 60 * 10) / 10) || 0.1);
  const n = defN == null ? hi : Math.min(Math.max(defN, lo), hi);
  sl.value = String(n); sl.disabled = hi <= lo;
  $id('p3no').textContent = 'n ' + n.toFixed(1) + ' g';
}
$id('p3case').addEventListener('change', e => { defCase = e.target.value; defN = null; nUi(); paint(); render(); });
$id('p3n').addEventListener('input', e => {
  const c = festRes && (festRes.wing.cases.find(q => q.key === defCase) || festRes.wing.cases[0]); if (!c) return;
  const v = +e.target.value; defN = v >= c.n - 1e-9 ? null : v; $id('p3no').textContent = 'n ' + v.toFixed(1) + ' g';
  paint(); render();
});
$id('p3scale').addEventListener('click', e => { const b = e.target.closest('button[data-s]'); if (!b) return; defScale = +b.dataset.s; document.querySelectorAll('#p3scale button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paint(); render(); });
$id('p3lastv').addEventListener('change', e => { showBands = e.target.checked; if (lastArgs) loadBands(lastArgs[0], lastArgs[1]); key(frames.get(wkKey)); render(); });

// ---------- Strömung (W3): freier Nachlauf, Rauchfäden, Abwind-Ebene ----------
// Gerechnet im eigenen Worker (core/modell-worker.js, Nachricht kind 'nachlauf'). Der Nachlauf bleibt dort je
// Modellrechnung und Flugzustand stehen; Rechen und Ebene verschieben rechnet nur diese neu.
const flow = { wake: false, smoke: false, plane: false, rake: 'quer', h: 6, eta: 50, px: null };
let flowRes = null, flowGroup = null, flowWorker = null, flowSeq = 0, flowGen = 0, flowReq = '', flowTimer = null;
const flowOn = () => flow.wake || flow.smoke || flow.plane;
function planeRange() {
  const m = lastArgs && lastArgs[0]; if (!m) return [0, 1];
  const x0 = m.wing.stations[0].chord * 1.05, b2 = wkR ? wkR.wing.projSpan / 2 : 1000;
  return [x0, Math.max((flowRes ? flowRes.xEnd : (m.tail.x || 0) + 200) + 0.6 * b2, x0 + b2)];
}
function needFlow(now) {
  const m = lastArgs && lastArgs[0], st = wkStates.find(q => q.key === wkKey);
  if (!flowOn() || !m || !wkR || !st) { flowReq = ''; flowRes = flowOn() ? flowRes : null; drawFlow(); return; }
  const opts = { want: { wake: flow.wake, smoke: flow.smoke, plane: flow.plane }, rake: { mode: flow.rake, h: flow.h, eta: flow.eta / 100 }, planeX: flow.px };
  const key = flowGen + ':' + wkKey, req = key + JSON.stringify(opts);
  if (req === flowReq) return;
  flowReq = req;
  clearTimeout(flowTimer);
  flowTimer = setTimeout(() => {
    if (!flowWorker) {
      try {
        flowWorker = new Worker('core/modell-worker.js?v=' + (window.MMPA_BUILD || ''));
        flowWorker.onmessage = e => {
          const d = e.data; if (d.kind !== 'nachlauf' || d.seq !== flowSeq) return;
          if (d.error) { flowKey('Strömung: ' + d.error); return; }
          flowRes = d.result; drawFlow(); render();
        };
        flowWorker.onerror = e => { e.preventDefault(); flowWorker.terminate(); flowWorker = null; flowReq = ''; flowKey('Strömung konnte nicht gerechnet werden.'); };
      } catch (e) { flowKey('Strömung braucht Web Worker.'); return; }
    }
    if (!flowRes) flowKey('Strömung rechnet …');
    flowWorker.postMessage({ kind: 'nachlauf', seq: ++flowSeq, key, model: m, profiles: project.profiles, r: wkR, state: { key: st.key, alpha: st.alpha, it: st.it }, opts });
  }, now ? 0 : 80);
}
function flowKey(t) { const k = $id('p3fkey'); k.hidden = !t; k.innerHTML = t || ''; }
const epsColor = (e, s) => { const t = Math.max(-1, Math.min(1, e / s)); return t >= 0 ? lerpCol(CP_MID, CP_LO, Math.sqrt(t)) : lerpCol(CP_MID, CP_HI, Math.sqrt(-t)); };
function drawFlow() {
  if (flowGroup) { scene.remove(flowGroup); flowGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); flowGroup = null; }
  const R = flowRes;
  if (!scene || !R || !flowOn()) { flowKey(''); return; }
  flowGroup = new THREE.Group();
  const acc = new THREE.Color(cssVar('--accent') || '#0b6bcb'), fg = new THREE.Color(cssVar('--fg') || '#222');
  const lineOf = (pts, sd, mat) => {
    const a = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 3) { a[i] = pts[i + 1] * sd; a[i + 1] = pts[i + 2]; a[i + 2] = pts[i]; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    return new THREE.Line(g, mat);
  };
  if (flow.wake && R.wake) {
    const gMax = Math.max(...R.wake.map(f => Math.abs(f.g)), 1e-9);
    R.wake.forEach(f => {
      const mat = new THREE.LineBasicMaterial({ color: acc, transparent: true, opacity: 0.18 + 0.82 * Math.sqrt(Math.abs(f.g) / gMax) });
      flowGroup.add(lineOf(f.pts, 1, mat), lineOf(f.pts, -1, mat.clone()));
    });
  }
  if (flow.smoke && R.smoke) {
    const mat = new THREE.LineBasicMaterial({ color: fg, transparent: true, opacity: 0.8 });
    R.smoke.forEach(p => { flowGroup.add(lineOf(p, 1, mat.clone())); if (flow.rake === 'quer') flowGroup.add(lineOf(p, -1, mat.clone())); });
  }
  let scale = 1;
  if (flow.plane && R.plane) {
    const P = R.plane, ny = P.ys.length, nz = P.zs.length;
    scale = Math.max(1, Math.ceil(2 * Math.abs(R.info.epsTail || 0)));
    [1, -1].forEach(sd => {
      const pos = new Float32Array(ny * nz * 3), col = new Float32Array(ny * nz * 3), idx = [];
      for (let j = 0; j < nz; j++) for (let i = 0; i < ny; i++) {
        const k = j * ny + i, c = epsColor(P.eps[k], scale);
        pos[k * 3] = P.ys[i] * sd; pos[k * 3 + 1] = P.zs[j]; pos[k * 3 + 2] = P.x;
        col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
        if (i && j) idx.push(k - ny - 1, k - ny, k, k - ny - 1, k, k - 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx);
      flowGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false })));
      // Querströmung als Striche: Länge nach der Geschwindigkeit, bei schneller Strömung am Wirbelkern gekappt
      const dy = P.ys[2] - P.ys[0], cap = 0.12, seg = [];
      for (let j = 0; j < nz; j += 2) for (let i = 0; i < ny; i += 2) {
        const k = j * ny + i, v = Math.hypot(P.vy[k], P.vz[k]), f = dy * 0.9 / cap * (v > cap ? cap / v : 1);
        const y = P.ys[i] * sd, z = P.zs[j];
        seg.push(y, z, P.x, y + P.vy[k] * f * sd, z + P.vz[k] * f, P.x);
      }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(seg), 3));
      flowGroup.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: fg, transparent: true, opacity: 0.55 })));
      const dots = new THREE.BufferGeometry(); dots.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(seg.filter((_, q) => q % 6 < 3)), 3));
      flowGroup.add(new THREE.Points(dots, new THREE.PointsMaterial({ color: fg, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.7 })));
    });
  }
  scene.add(flowGroup);
  // Erklärung
  const I = R.info, de = n => n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const st = wkStates.find(q => q.key === R.state.key);
  let t = `<div><b>Strömung${st ? ' · ' + st.label : ''}</b> · Abwind am Höhenleitwerk ${de(I.epsTail)}° (gerader Nachlauf ${de(I.epsStraight)}°)`;
  if (I.core) t += ` · Randwirbel am HLW bei ${Math.round(100 * I.core.y / R.semi)} % der Halbspannweite`;
  t += '</div><div class="leg">';
  if (flow.plane && R.plane) t += `<span>Aufwind −${scale}° <span class="bar" style="background:linear-gradient(90deg,rgb(217,64,51),rgb(237,237,235),rgb(31,84,217))"></span> +${scale}° Abwind</span><span>Ebene ${Math.round(R.plane.x)} mm hinter der Flügelnase, Striche = Querströmung</span>`;
  t += '<span>reibungsfrei, ohne Rumpf und ohne Ablösung</span></div>';
  flowKey(t);
  const [x0, x1] = planeRange(), px = flow.px ?? R.tailX;
  $id('p3planex').value = String(Math.round(100 * (px - x0) / (x1 - x0)));
  $id('p3planeo').textContent = Math.round(px) + ' mm';
}
function flowUi() {
  $id('p3smokec').hidden = !flow.smoke; $id('p3planec').hidden = !flow.plane;
  const hoch = flow.rake === 'hoch', sl = $id('p3rakev');
  $id('p3rakel').textContent = hoch ? 'bei' : 'Höhe';
  sl.min = hoch ? 0 : -60; sl.max = hoch ? 110 : 60; sl.step = hoch ? 5 : 2; sl.value = hoch ? flow.eta : flow.h;
  $id('p3rakeo').textContent = hoch ? flow.eta + ' % Halbspannweite' : (flow.h > 0 ? '+' : '') + flow.h + ' mm';
  document.querySelectorAll('#p3rake button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === flow.rake)));
}
[['p3wake', 'wake'], ['p3smoke', 'smoke'], ['p3plane', 'plane']].forEach(([id, k]) => $id(id).addEventListener('change', e => {
  flow[k] = e.target.checked;
  if (flowOn() && !showModel) { showModel = true; $id('p3model').checked = true; redraw(); }
  flowUi(); needFlow(true); render();
}));
$id('p3rake').addEventListener('click', e => { const b = e.target.closest('button[data-r]'); if (!b) return; flow.rake = b.dataset.r; flowUi(); needFlow(true); });
$id('p3rakev').addEventListener('input', e => { if (flow.rake === 'hoch') flow.eta = +e.target.value; else flow.h = +e.target.value; flowUi(); needFlow(); });
$id('p3planex').addEventListener('input', e => { const [x0, x1] = planeRange(); flow.px = x0 + (x1 - x0) * e.target.value / 100; $id('p3planeo').textContent = Math.round(flow.px) + ' mm'; needFlow(); });
$id('p3planet').addEventListener('click', () => { flow.px = null; needFlow(true); });
flowUi();

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
const saveImp = q => idb('readwrite', st => st.put({ id: q.id, model: q.model, name: q.name, buf: q.buf, place: q.place, visible: q.visible, assign: q.assign || null })).catch(() => {});

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

// Rhino 3DM: rhino3dm im Worker, erst beim ersten 3DM geladen (2,7 MB)
let rhinoWorker = null;
function readRhino(u8) {
  return new Promise((resolve, reject) => {
    rhinoWorker = rhinoWorker || new Worker('vendor/rhino3dm/rhino-worker.js');
    rhinoWorker.onmessage = e => resolve(e.data);
    rhinoWorker.onerror = e => { e.preventDefault(); rhinoWorker.terminate(); rhinoWorker = null; reject(new Error('3dm-Leser liess sich nicht laden')); };
    rhinoWorker.postMessage({ buffer: u8 });
  });
}

async function parseImp(q) {
  q.err = ''; q.busy = true; renderImpList();
  try { q.raw = await IM.parse(q.name, q.buf.slice(0), { step: readStep, rhino: readRhino }); } catch (e) { q.raw = null; q.err = e.message; }
  q.busy = false;
  placeImp(q);
}
function placeImp(q) {
  q.out = null;
  if (q.raw) { try { q.out = IM.place(q.raw.meshes, q.raw.unit, q.place); q.err = ''; } catch (e) { q.err = e.message; } }
  if (take && take.id === q.id) { if (q.out) prepTake(q); else take = null; renderTake(); }
  buildImpGroup(); renderImpList();
}
function buildImpGroup() {
  if (!scene) return;
  if (impGroup) { scene.remove(impGroup); impGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); }
  impGroup = new THREE.Group();
  const col = new THREE.Color(cssVar('--violet') || '#7a45c4');
  imports.forEach(q => {
    if (!q.visible || !q.out) return;
    if (take && take.id === q.id) { takeMeshes(q); return; }
    q.out.forEach(p => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(toThree(p.positions), 3));
      geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geo.computeVertexNormals();
      const ghost = layer !== 'form';
      impGroup.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide, transparent: ghost, opacity: ghost ? 0.25 : 1, depthWrite: !ghost })));
    });
  });
  scene.add(impGroup);
  redraw();
}

async function loadImports(m) {
  impModel = m.id; imports = []; take = null; renderTake();
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
    if (!IM.kindOf(f.name)) { toast?.('Nicht unterstützt: ' + f.name + ' (3MF, OBJ, STL, STEP, 3DM)'); continue; }
    const q = { id: m.id + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), model: m.id, name: f.name, buf: await f.arrayBuffer(), place: null, visible: true, raw: null, out: null, err: '' };
    imports.push(q);
    await parseImp(q);
    if (q.raw) { q.place = IM.suggest(q.raw, f.name, m, { noseX: noseOf(m) }); placeImp(q); }
    else q.place = { ...IM.DEFAULT_PLACE, part: 'free' };
    saveImp(q);
  }
  redraw(true);
}

const noseOf = m => { try { return window.MMPA.rumpf.shape(m).x0; } catch (e) { return NaN; } };
const AXES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const opt = (list, v) => list.map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function renderImpList() {
  const box = $id('p3imp'); if (!box) return;
  box.innerHTML = imports.map(q => {
    const p = q.place || IM.DEFAULT_PLACE;
    const note = q.raw && q.raw.sampled ? ' · ohne Render-Netz: Flächen abgetastet, Trimmung fehlt' : '';
    const info = q.busy ? 'liest …' : q.err ? `<span class="err">${esc(q.err)}</span>` : q.raw ? `${(n => n < 10000 ? n : Math.round(n / 1000) + 'k')(IM.triangles(q.raw.meshes))} Dreiecke · ${q.raw.meshes.length} Körper${note}` : '';
    const unitKnown = q.raw && (q.raw.source === '3mf' || q.raw.source === 'step' || q.raw.source === '3dm');
    return `<div class="p3row" data-id="${esc(q.id)}">
      <label title="zeigen"><input type="checkbox" data-k="visible"${q.visible ? ' checked' : ''}></label><b>${esc(q.name)}</b><small>${info}</small>
      <label>Teil <select data-k="part">${opt([['all', 'ganzes Modell'], ['wing', 'Flügel'], ['tail', 'Höhenleitwerk'], ['fuse', 'Rumpf'], ['free', 'frei']], p.part || 'free')}</select></label>
      <label>oben <select data-k="up">${opt(AXES.map(a => [a, a]), p.up)}</select></label>
      <label>Nase <select data-k="nose">${opt(AXES.map(a => [a, a]), p.nose)}</select></label>
      ${unitKnown ? '' : `<label>Einheit <select data-k="scale">${opt([['1', 'mm'], ['10', 'cm'], ['1000', 'm'], ['25.4', 'Zoll']], String(p.scale || 1))}</select></label>`}
      <label><input type="checkbox" data-k="mirror"${p.mirror ? ' checked' : ''}> spiegeln</label>
      <label>x <input type="number" step="1" data-k="dx" value="${+(p.dx || 0).toFixed(1)}"></label>
      <label>y <input type="number" step="1" data-k="dy" value="${+(p.dy || 0).toFixed(1)}"></label>
      <label>z <input type="number" step="1" data-k="dz" value="${+(p.dz || 0).toFixed(1)}"></label>
      ${q.out ? `<button type="button" class="btn ghost sm" data-k="take" title="Rumpf, Flügel, HLW und SLW aus dieser Datei in die Rechnung übernehmen (jedes Bauteil einzeln)">Bauteile übernehmen …</button>` : ''}
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
    else if ((p.part === 'all' || p.part === 'fuse') && q.raw) {
      // Nase an Nase: vordersten Punkt der Datei (ohne Verschiebung) an die Rumpfspitze des Modells
      const b = IM.bounds(IM.place(q.raw.meshes, q.raw.unit, { ...p, dx: 0, dy: 0, dz: 0, mirror: false }));
      const nx = noseOf(m); if (Number.isFinite(nx)) p.dx = nx - b.min[0];
    }
  } else if (/^d[xyz]$/.test(k)) p[k] = parseFloat(e.target.value) || 0;
  placeImp(q); saveImp(q);
});
$id('p3imp').addEventListener('click', e => {
  const tk = e.target.closest('button[data-k="take"]'), rw = e.target.closest('.p3row');
  if (tk && rw) { const q = imports.find(i => i.id === rw.dataset.id); if (q) openTake(q); return; }
  const b = e.target.closest('button[data-k="del"]'), row = e.target.closest('.p3row'); if (!b || !row) return;
  if (take && take.id === row.dataset.id) closeTake();
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

// ---------- Bauteile aus dem Import übernehmen (Rumpf, Flügel, HLW, SLW je einzeln) ----------
// Die Datei wird in Teile zerlegt (Körper, Schalen), jedes Teil einem Bauteil zugeordnet (Name, Form; im 3D antippen
// wechselt), dann geschnitten (core/bauteile3d.js). Vergleich jetzt/neu je Bauteil, Übernahme in einem Schritt
// (davor ein Zwischenstand im Verlauf, Rückgängig mit ↶).
const B3 = window.MMPA.bauteile3d, FU = window.MMPA.rumpf;
const KIND_COL = { fuse: '#e0863a', wing: '#3b82f6', tail: '#1f9d62', fin: '#a05bd6', none: '#9aa3ad' };
const KIND_ORDER = ['fuse', 'wing', 'tail', 'fin', 'none'];
const PART_NAME = { fuse: 'Rumpf', wing: 'Flügel', tail: 'Höhenleitwerk', fin: 'Seitenleitwerk' };
const PROF_MODES = [['keep', 'Profil behalten'], ['dicke', 'Dicke + Wölbung'], ['neu', 'Profil aus Schnitt']];
let take = null;
const de = (v, d = 0) => Number.isFinite(v) ? v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';

function prepTake(q) {
  const keep = take && take.id === q.id ? take : null;
  const pieces = B3.pieces(IM.place(q.raw.meshes, q.raw.unit, { ...q.place, mirror: false }));
  const auto = B3.classify(pieces, (q.place || {}).part);
  const kinds = auto.map((k, i) => (q.assign && q.assign[i]) || k);
  take = { id: q.id, q, pieces, auto, kinds, ex: null, use: keep ? keep.use : null, mode: keep ? keep.mode : { wing: 'dicke', tail: 'dicke' } };
  calcTake();
}
function calcTake() {
  const t = take;
  try { t.ex = B3.extract(t.pieces, t.kinds); t.err = ''; } catch (e) { t.ex = null; t.err = e.message; console.error(e); }
  const has = { fuse: !!t.ex?.fus, wing: !!t.ex?.wing, tail: !!t.ex?.tail, fin: !!t.ex?.fin };
  t.use = Object.fromEntries(Object.keys(has).map(k => [k, has[k] && (t.use ? t.use[k] !== false : true)]));
  t.has = has;
}
function openTake(q) {
  if (!q.out || !q.raw) { toast('Die Datei ist noch nicht gelesen.'); return; }
  if (!q.visible) { q.visible = true; saveImp(q); }
  try { prepTake(q); } catch (e) { console.error(e); toast('3D-Datei: ' + e.message); return; }
  renderTake(); buildImpGroup(); renderImpList();
  $id('p3take').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function closeTake() { take = null; renderTake(); buildImpGroup(); }

// Teile farbig nach Bauteil, gespiegelt wie die Lage es will; userData.piece für das Antippen
function takeMeshes(q) {
  const mirror = (q.place || {}).mirror;
  take.pieces.forEach((p, i) => {
    [1, mirror ? -1 : 0].forEach(sd => {
      if (!sd) return;
      let P = p.positions, I = p.indices;
      if (sd < 0) { P = P.slice(); for (let k = 1; k < P.length; k += 3) P[k] = -P[k]; I = I.slice(); for (let k = 0; k < I.length; k += 3) { const x = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = x; } }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(toThree(P), 3));
      geo.setIndex(new THREE.BufferAttribute(I, 1));
      geo.computeVertexNormals();
      const k = take.kinds[i], ghost = k === 'none';
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(KIND_COL[k]), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide, transparent: ghost, opacity: ghost ? 0.35 : 1, depthWrite: !ghost }));
      mesh.userData = { piece: i };
      impGroup.add(mesh);
    });
  });
}
function setKind(idx, k) {
  const q = take.q; q.assign = q.assign || {};
  idx.forEach(i => { take.kinds[i] = k; if (k === take.auto[i]) delete q.assign[i]; else q.assign[i] = k; });
  saveImp(q); calcTake(); renderTake(); buildImpGroup();
}
// Antippen eines Teils im 3D wechselt sein Bauteil (nur wenn kaum bewegt, sonst war es Drehen)
let tapAt = null;
host.addEventListener('pointerdown', e => { tapAt = take ? [e.clientX, e.clientY] : null; });
host.addEventListener('pointerup', e => {
  if (!take || !tapAt || !impGroup || Math.hypot(e.clientX - tapAt[0], e.clientY - tapAt[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObjects(impGroup.children, false).find(h => h.object.userData.piece != null);
  if (!hit) return;
  const i = hit.object.userData.piece, k = take.kinds[i];
  setKind([i], KIND_ORDER[(KIND_ORDER.indexOf(k) + 1) % KIND_ORDER.length]);
  toast(`${take.pieces[i].name || 'Teil'}: ${B3.LABEL[take.kinds[i]]}`);
});

// Kleine Skizzen: alt gestrichelt, neu ausgefüllt
const svgWrap = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${body}</svg>`;
function planSvg(oldSt, newSt) {
  const outline = st => {
    const P = VL.stationPoints(st);
    return [...P.map(p => [p.le[1], p.le[0]]), ...P.slice().reverse().map(p => [p.le[1], p.le[0] + p.chord])];
  };
  const A = outline(oldSt), Bn = newSt ? outline(newSt) : [];
  const all = A.concat(Bn), x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0])), y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  const W = 300, s = (W - 12) / Math.max(1, x1 - x0), H = Math.max(40, (y1 - y0) * s + 12);
  const pts = L => L.map(p => `${(6 + (p[0] - x0) * s).toFixed(1)},${(6 + (p[1] - y0) * s).toFixed(1)}`).join(' ');
  return svgWrap(W, H, `<polygon points="${pts(A)}" fill="none" stroke="var(--muted)" stroke-dasharray="4 3" stroke-width="1.2"/>` + (Bn.length ? `<polygon points="${pts(Bn)}" fill="var(--accent-soft)" fill-opacity=".7" stroke="var(--accent)" stroke-width="1.5"/>` : ''));
}
function fuseOutline(m) {
  try {
    const sh = FU.shape(m), k = Math.sqrt(sh.width || 1);
    return sh.pts.map(p => ({ x: p.x, w: 2 * (p.w ?? p.r * k), h: 2 * (p.h ?? p.r / k) }));
  } catch (e) { return []; }
}
function fuseSvg(oldM, newM) {
  const A = fuseOutline(oldM), Bn = newM ? fuseOutline(newM) : [];
  const all = A.concat(Bn); if (!all.length) return '';
  const x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x)), hm = Math.max(...all.map(p => Math.max(p.h, p.w))) / 2;
  const W = 300, s = (W - 12) / Math.max(1, x1 - x0), H = 2 * (hm * s) + 2 * hm * s + 24, cy1 = 6 + hm * s, cy2 = H - 6 - hm * s;
  // oben Seitenansicht (Höhe), unten Draufsicht (Breite)
  const poly = (L, key, cy) => [...L.map(p => [p.x, -p[key] / 2]), ...L.slice().reverse().map(p => [p.x, p[key] / 2])].map(([x, y]) => `${(6 + (x - x0) * s).toFixed(1)},${(cy + y * s).toFixed(1)}`).join(' ');
  let b = '';
  [['h', cy1], ['w', cy2]].forEach(([key, cy]) => {
    b += `<polygon points="${poly(A, key, cy)}" fill="none" stroke="var(--muted)" stroke-dasharray="4 3" stroke-width="1.2"/>`;
    if (Bn.length) b += `<polygon points="${poly(Bn, key, cy)}" fill="var(--accent-soft)" fill-opacity=".7" stroke="var(--accent)" stroke-width="1.5"/>`;
  });
  const c = (oldM.wing.stations[0] || {}).chord || 0, wx = 6 + (0 - x0) * s;
  b += `<rect x="${wx.toFixed(1)}" y="${(cy2 - 2).toFixed(1)}" width="${(c * s).toFixed(1)}" height="4" fill="var(--muted)" opacity=".5"><title>Flügelwurzel</title></rect>`;
  return svgWrap(W, H, b);
}
function finShape(m, tailArea) {
  const f = (m.fuselage || {}), area = FU.finArea(m, tailArea);
  if (!(area > 0)) return null;
  const g = f.finGeo;
  if (g && g.root > 0) { const k = Math.sqrt(area * 1e4 / ((g.root + g.tip) / 2 * g.height)); return { area, root: g.root * k, tip: g.tip * k, height: g.height * k, sweep: g.sweep * k }; }
  const cr = 1.15 * FU.finChord(area), ct = 0.6 * cr;
  return { area, root: cr, tip: ct, height: 2 * area * 1e4 / (cr + ct), sweep: (cr - ct) * 0.7 };
}
function finSvg(a, b) {
  const L = [a, b].filter(Boolean); if (!L.length) return '';
  const quad = f => [[0, 0], [f.root, 0], [f.sweep + f.tip, f.height], [f.sweep, f.height]];
  const all = L.flatMap(quad), w = Math.max(...all.map(p => p[0])), h = Math.max(...all.map(p => p[1]));
  const W = 200, s = (W - 12) / Math.max(w, h * 0.8, 1), H = h * s + 12;
  const pts = f => quad(f).map(([x, y]) => `${(6 + x * s).toFixed(1)},${(H - 6 - y * s).toFixed(1)}`).join(' ');
  return svgWrap(W, H, (a ? `<polygon points="${pts(a)}" fill="none" stroke="var(--muted)" stroke-dasharray="4 3" stroke-width="1.2"/>` : '') + (b ? `<polygon points="${pts(b)}" fill="var(--accent-soft)" fill-opacity=".7" stroke="var(--accent)" stroke-width="1.5"/>` : ''));
}
const rowT = (label, a, b, d = 0, unit = '') => {
  const ch = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 0.5 * 10 ** -d;
  return `<tr><td>${label}</td><td>${de(a, d)}${unit}</td><td${ch ? ' class="ch"' : ''}>${de(b, d)}${unit}</td></tr>`;
};

function renderTake() {
  const box = $id('p3take');
  if (!take) { box.hidden = true; box.innerHTML = ''; return; }
  const t = take, q = t.q, m = curModel(), ex = t.ex;
  box.hidden = false;
  // Gruppen: gleicher Name und gleiches Bauteil
  const groups = new Map();
  t.pieces.forEach((p, i) => { const key = (p.name || 'Körper') + '\u0001' + t.kinds[i]; const g = groups.get(key) || { name: p.name || 'Körper', kind: t.kinds[i], idx: [] }; g.idx.push(i); groups.set(key, g); });
  const segKind = (g, n) => `<span class="seg" role="group" aria-label="Bauteil für ${esc(g.name)}">${KIND_ORDER.map(k => `<button type="button" data-g="${n}" data-kind="${k}" aria-pressed="${g.kind === k}"><i style="background:${KIND_COL[k]}"></i>${B3.LABEL[k]}</button>`).join('')}</span>`;
  const gl = [...groups.values()];
  let h = `<h3>Bauteile aus ${esc(q.name)} übernehmen <button type="button" class="x" data-t="close" aria-label="schliessen">×</button></h3>
    <p class="hint">Jedes Teil der Datei gehört zu einem Bauteil (Farbe im 3D). Stimmt eine Zuordnung nicht, hier umstellen oder das Teil im 3D antippen. Die App schneidet die Teile wie Rippen und vergleicht mit dem Modell; übernommen wird nur, was angehakt ist.</p>
    <div class="grp">${gl.map((g, n) => `<b title="${esc(g.name)}">${esc(g.name)}<small>${g.idx.length > 1 ? g.idx.length + ' Teile' : ''}</small></b>${segKind(g, n)}`).join('')}</div>`;
  if (t.err) h += `<p class="hint" style="color:var(--bad)">Schneiden ging nicht: ${esc(t.err)}</p>`;
  // Vorschau mit allen gefundenen Teilen (Profile nur gemessen)
  const pv = ex ? B3.apply(m, ex, t.has, { wingMode: 'dicke', tailMode: 'dicke' }).model : m;
  const card = (k, inner) => {
    const has = t.has && t.has[k];
    return `<div class="card${has && t.use[k] ? '' : ' off'}"><label><input type="checkbox" data-use="${k}"${has && t.use[k] ? ' checked' : ''}${has ? '' : ' disabled'}><i style="background:${KIND_COL[k]}"></i>${PART_NAME[k]} übernehmen</label>${has ? inner : `<span class="none">Keine Teile als ${B3.LABEL[k]} zugeordnet.</span>`}</div>`;
  };
  const surf = k => {
    const S = ex && (k === 'wing' ? ex.wing : ex.tail); if (!S) return '';
    const a = B3.surfStats(m[k].stations), b = B3.surfStats(pv[k].stations);
    let tb = `<table><tr><th></th><th>jetzt</th><th>neu</th></tr>` + rowT('Spannweite mm', a?.span, b?.span) + rowT('Fläche dm²', a?.area, b?.area, 1) + rowT('Streckung', a?.aspect, b?.aspect, 1) +
      rowT('Wurzeltiefe mm', a?.root, b?.root) + rowT('mittlere Tiefe mm', a?.mac, b?.mac) + rowT('V-Form max °', a?.dihMax, b?.dihMax, 1) + rowT('V-Form min °', a?.dihMin, b?.dihMin, 1) + rowT('Schränkung Spitze °', a?.twistTip, b?.twistTip, 1) + rowT('Stationen', a?.n, b?.n);
    if (k === 'tail') tb += rowT('Lage x mm', m.tail.x, pv.tail.x) + rowT('Lage z mm', m.tail.z || 0, pv.tail.z);
    tb += '</table>';
    const seg = `<span class="seg" role="group" aria-label="Profile">${PROF_MODES.map(([v, l]) => `<button type="button" data-mode="${k}" data-v="${v}" aria-pressed="${t.mode[k] === v}">${l}</button>`).join('')}</span>`;
    const st = pv[k].stations;
    const det = `<details><summary>Stationen</summary><table><tr><th>y</th><th>Tiefe</th><th>Pfeil.</th><th>V °</th><th>Schr. °</th><th>Dicke %</th><th>Wölb. %</th></tr>${st.map(s => `<tr><td>${de(s.y, 1)}</td><td>${de(s.chord, 1)}</td><td>${de(s.offset, 1)}</td><td>${de(s.dihedral, 1)}</td><td>${de(s.twist, 1)}</td><td>${de(100 * s.thickness, 2)}</td><td>${de(100 * s.camber, 2)}</td></tr>`).join('')}</table></details>`;
    const notes = [];
    if (S.cut > 0) notes.push(`Ausschnitt an der Wurzel bis y ${de(S.cut)} mm überbrückt (volle Tiefe bis zur Mitte).`);
    if (S.rows[0].yp > 1) notes.push(`Fläche beginnt bei y ${de(S.rows[0].yp)} mm, innen bis zur Mitte durchgezogen.`);
    if (S.tipCut) notes.push('Spitze unter 10 % Tiefe weggelassen, die App rundet dort elliptisch weiter.');
    return planSvg(m[k].stations, st) + tb + `<div>${seg}</div>` + (notes.length ? `<p class="hint">${notes.join(' ')}</p>` : '') + det;
  };
  const fuse = () => {
    if (!ex || !ex.fus) return '';
    const tbl = B3.fuseTable(ex.fus, ex.ref), o = fuseOutline(m), n = fuseOutline(pv);
    const st = L => L.length ? { len: L[L.length - 1].x - L[0].x, nose: -L[0].x, w: Math.max(...L.map(p => p.w)), h: Math.max(...L.map(p => p.h)) } : {};
    const a = st(o), b = st(n);
    return fuseSvg(m, pv) + `<table><tr><th></th><th>jetzt</th><th>neu</th></tr>${rowT('Länge mm', a.len, b.len)}${rowT('Nase vor Flügel mm', a.nose, b.nose)}${rowT('grösste Breite mm', a.w, b.w)}${rowT('grösste Höhe mm', a.h, b.h)}</table>` +
      `<p class="hint">Als Kontur mit ${tbl.length} Schnitten, Oberfläche ${(m.fuselage || {}).finish === 'oldtimer' || FU.of(m).type === 'oldtimer' ? 'Oldtimer' : 'modern'} (im Reiter Rumpf änderbar).</p>`;
  };
  const finC = () => {
    if (!ex || !ex.fin) return '';
    const ta = VL.planform(m.tail.stations).area, a = finShape(m, ta), b = finShape(pv, VL.planform(pv.tail.stations).area);
    return finSvg(a, b) + `<table><tr><th></th><th>jetzt</th><th>neu</th></tr>${rowT('Fläche dm²', a?.area, b?.area, 2)}${rowT('Höhe mm', a?.height, b?.height)}${rowT('Wurzeltiefe mm', a?.root, b?.root)}${rowT('Endtiefe mm', a?.tip, b?.tip)}</table><p class="hint">Fläche über dem Rumpfrücken, Seitenansicht.</p>`;
  };
  h += `<div class="cards">${card('fuse', fuse())}${card('wing', surf('wing'))}${card('tail', surf('tail'))}${card('fin', finC())}</div>`;
  const ew = ex && B3.ewd(ex);
  const any = t.use && Object.values(t.use).some(Boolean);
  h += `<div class="foot"><button type="button" class="btn sm" data-t="go"${any ? '' : ' disabled'}>Übernehmen</button><span class="hint">Mass in mm ab der Flügelnase an der Wurzel${ex && ex.wing ? ' (aus dieser Datei)' : ''}. Vorher wird ein Zwischenstand im Verlauf gesichert, ↶ macht es rückgängig.${Number.isFinite(ew) ? ` Einstellwinkeldifferenz in der Zeichnung ${de(ew, 1)}° (Flügelwurzel gegen HLW).` : ''}</span></div>`;
  box.innerHTML = h;
  box._groups = gl;
}
$id('p3take').addEventListener('click', e => {
  if (!take) return;
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.t === 'close') { closeTake(); return; }
  if (b.dataset.t === 'go') { applyTake(); return; }
  if (b.dataset.kind) { const g = $id('p3take')._groups[+b.dataset.g]; if (g) setKind(g.idx, b.dataset.kind); return; }
  if (b.dataset.mode) { take.mode[b.dataset.mode] = b.dataset.v; renderTake(); }
});
$id('p3take').addEventListener('change', e => {
  const k = e.target.dataset.use; if (!take || !k) return;
  take.use[k] = e.target.checked; renderTake();
});

function applyTake() {
  const t = take, q = t.q, m = curModel();
  if (!t.ex || !Object.values(t.use).some(Boolean)) return;
  if (window.histMark) window.histMark('vor Übernahme aus ' + q.name);
  const base = q.name.replace(/\.[^.]+$/, ''), made = [];
  const profileFor = (sh, part, y) => {
    const coords = B3.profileCoords(sh);
    const hit = made.find(p => p.part === part && B3.sameShape(p.coords, coords));
    if (hit) return hit.id;
    const prof = window.MMPA.projekt.addProfile(project, { name: `${base} ${part === 'wing' ? 'Flügel' : 'HLW'} y ${Math.round(y)}`, coords, source: '3D-Import' });
    made.push({ id: prof.id, coords, part });
    return prof.id;
  };
  const r = B3.apply(m, t.ex, t.use, { wingMode: t.mode.wing, tailMode: t.mode.tail, profileFor });
  m.wing = r.model.wing; m.tail = r.model.tail; m.fuselage = r.model.fuselage;
  const done = Object.keys(t.use).filter(k => t.use[k]).map(k => PART_NAME[k]);
  // Import an die Flügelnase des Modells schieben, damit er wieder über dem gerechneten Modell liegt
  if (t.ex.wing && (Math.abs(t.ex.ref.x) > 0.05 || Math.abs(t.ex.ref.z) > 0.05)) q.place = { ...q.place, dx: (q.place.dx || 0) - t.ex.ref.x, dz: (q.place.dz || 0) - t.ex.ref.z };
  saveImp(q);
  persist(); syncModelForm(); stationTable('wing'); stationTable('tail'); scheduleModel();
  if (made.length && typeof renderAll === 'function') renderAll();
  placeImp(q);
  toast(`Übernommen aus ${q.name}: ${done.join(', ')}` + (made.length ? ` · ${made.length} Profil${made.length > 1 ? 'e' : ''} angelegt` : ''));
}

window.MMPA3D = { draw, setView };
// Der Grundriss stand schon auf 3D, bevor dieses Modul geladen war
if (window.MMPA3D_pending || !$id('plan3d').hidden) { window.MMPA3D_pending = false; draw(curModel(), lastModel); }
