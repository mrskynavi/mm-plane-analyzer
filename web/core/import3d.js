// 3D-Dateien einlesen (3MF, OBJ, STL; STEP über OpenCascade, siehe vendor/occt) und in die App-Achsen legen,
// damit das gebaute Teil in der 3D-Ansicht neben dem gerechneten Modell liegt.
// Ergebnis: { meshes: [{ name, positions: Float32Array, indices: Uint32Array }], unit, source }, Längen in der
// Einheit der Datei mal unit = mm.
// Fusion exportiert mit Y oben: Spannweite +X, Profildicke Y, Tiefe +Z (Nase bei Z = 0, Wurzel bei X = 0).
(function (root) {
  'use strict';

  const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };
  const extOf = name => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const KINDS = { '3mf': '3mf', obj: 'obj', stl: 'stl', step: 'step', stp: 'step' };
  const kindOf = name => KINDS[extOf(name)] || null;

  // ---- ZIP (für 3MF): zentrales Verzeichnis lesen, Deflate über DecompressionStream (Browser, Node ≥ 18)
  async function unzip(buf, want) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('keine ZIP-Datei');
    let n = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true);
    const big = v => Number(dv.getBigUint64(v, true));
    // ZIP64 (Fusion schreibt so): Verzeichnis über den Locator vor dem Ende
    if ((p === 0xffffffff || n === 0xffff) && e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
      const z = big(e - 12);
      if (dv.getUint32(z, true) === 0x06064b50) { n = big(z + 32); p = big(z + 48); }
    }
    const out = {}, dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      let lo = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      // ZIP64-Zusatzfeld: nur die Werte, die oben 0xFFFFFFFF sind, in dieser Reihenfolge
      for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + xl;) {
        const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = big(q); q += 8; }
          if (csize === 0xffffffff) { csize = big(q); q += 8; }
          if (lo === 0xffffffff) { lo = big(q); q += 8; }
        }
        x += 4 + len;
      }
      p += 46 + nl + xl + cl;
      if (!want(name)) continue;
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = u8.subarray(start, start + csize);
      if (method === 0) out[name] = data;
      else if (method === 8) out[name] = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error('ZIP-Methode ' + method + ' wird nicht unterstützt');
    }
    return out;
  }

  // ---- 3MF: Objekte mit Netz oder Komponenten, Bauteile mit Transformation (3×4, Zeilen wie in der Norm)
  const attr = (s, k) => { const m = s.match(new RegExp('\\s' + k + '="([^"]*)"')); return m ? m[1] : null; };
  const mat = t => {
    if (!t) return null;
    const v = t.trim().split(/\s+/).map(Number);
    return v.length === 12 && v.every(Number.isFinite) ? v : null;
  };
  // Punkt p mit Matrix m (3MF: x' = x·m0 + y·m3 + z·m6 + m9 …)
  const apply = (m, x, y, z) => [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]];
  const mul = (a, b) => { // erst a, dann b
    if (!a) return b; if (!b) return a;
    const r = new Array(12);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
    }
    return r;
  };

  function parse3mfXml(xml) {
    const unit = UNITS[attr(xml.slice(0, 2000), 'unit') || 'millimeter'] || 1;
    const title = (xml.match(/<metadata[^>]*name="Title"[^>]*>([^<]*)<\/metadata>/) || [])[1] || '';
    const objects = {};
    const reObj = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let m;
    while ((m = reObj.exec(xml))) {
      const id = attr(m[1], 'id'), body = m[2], o = { name: attr(m[1], 'name') || '', mesh: null, comps: [] };
      const vs = body.indexOf('<vertices');
      if (vs >= 0) {
        const pos = [], idx = [];
        const vEnd = body.indexOf('</vertices>', vs), vPart = body.slice(vs, vEnd);
        const reV = /<vertex\b[^>]*?\sx="([^"]+)"[^>]*?\sy="([^"]+)"[^>]*?\sz="([^"]+)"/g;
        let v; while ((v = reV.exec(vPart))) pos.push(+v[1], +v[2], +v[3]);
        const tPart = body.slice(body.indexOf('<triangles', vEnd));
        const reT = /<triangle\b[^>]*?\sv1="(\d+)"[^>]*?\sv2="(\d+)"[^>]*?\sv3="(\d+)"/g;
        let t; while ((t = reT.exec(tPart))) idx.push(+t[1], +t[2], +t[3]);
        o.mesh = { pos, idx };
      }
      const reC = /<component\b([^>]*)\/?>/g;
      let c; while ((c = reC.exec(body))) o.comps.push({ id: attr(c[1], 'objectid'), m: mat(attr(c[1], 'transform')) });
      objects[id] = o;
    }
    const meshes = [];
    const emit = (id, m, name, depth) => {
      const o = objects[id];
      if (!o || depth > 8) return;
      if (o.mesh) {
        const P = o.mesh.pos, out = new Float32Array(P.length);
        for (let i = 0; i < P.length; i += 3) {
          const q = m ? apply(m, P[i], P[i + 1], P[i + 2]) : [P[i], P[i + 1], P[i + 2]];
          out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
        }
        meshes.push({ name: o.name || name || 'Körper ' + (meshes.length + 1), positions: out, indices: Uint32Array.from(o.mesh.idx) });
      }
      o.comps.forEach(c => emit(c.id, mul(c.m, m), o.name || name, depth + 1));
    };
    const build = xml.slice(xml.lastIndexOf('<build'));
    const reI = /<item\b([^>]*)\/?>/g;
    let it; while ((it = reI.exec(build))) emit(attr(it[1], 'objectid'), mat(attr(it[1], 'transform')), '', 0);
    return { meshes, unit, title };
  }

  async function parse3mf(buf) {
    const files = await unzip(buf, n => /\.model$/i.test(n));
    const main = Object.keys(files).find(n => /^\/?3D\/3dmodel\.model$/i.test(n)) || Object.keys(files)[0];
    if (!main) throw new Error('3MF ohne 3D-Modell');
    const r = parse3mfXml(new TextDecoder().decode(files[main]));
    if (!r.meshes.length) throw new Error('3MF enthält keine Netze');
    return { ...r, source: '3mf' };
  }

  // ---- OBJ: v und f (Vielecke als Fächer, negative Indizes, v/vt/vn), Gruppen o/g als eigene Körper
  function parseObj(text) {
    const pos = [], meshes = [];
    let cur = null;
    const start = name => { cur = { name, idx: [] }; meshes.push(cur); };
    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l[0] === '#') continue;
      const sp = l.split(/\s+/), k = sp[0];
      if (k === 'v') pos.push(+sp[1], +sp[2], +sp[3]);
      else if (k === 'o' || k === 'g') start(sp.slice(1).join(' ') || 'Körper ' + (meshes.length + 1));
      else if (k === 'f') {
        if (!cur) start('Körper 1');
        const nv = pos.length / 3;
        const f = sp.slice(1).map(s => { const i = parseInt(s, 10); return i < 0 ? nv + i : i - 1; });
        for (let i = 1; i < f.length - 1; i++) cur.idx.push(f[0], f[i], f[i + 1]);
      }
    }
    const P = Float32Array.from(pos);
    const out = meshes.filter(m => m.idx.length).map(m => compact(m.name, P, m.idx));
    if (!out.length) throw new Error('OBJ ohne Flächen');
    return { meshes: out, unit: 1, source: 'obj' };
  }
  // nur die Punkte, die ein Körper braucht
  function compact(name, P, idx) {
    const map = new Map(), pos = [], I = new Uint32Array(idx.length);
    idx.forEach((v, k) => {
      let j = map.get(v);
      if (j === undefined) { j = pos.length / 3; map.set(v, j); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
      I[k] = j;
    });
    return { name, positions: Float32Array.from(pos), indices: I };
  }

  // ---- STL binär oder ASCII; gleiche Punkte werden zusammengelegt, damit die Schattierung glatt wird
  function parseStl(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tris = [];
    const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 512)));
    const binLen = u8.length >= 84 ? 84 + 50 * dv.getUint32(80, true) : -1;
    if (binLen === u8.length || !/^\s*solid[\s\S]*facet/.test(head)) {
      const n = dv.getUint32(80, true);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) tris.push(dv.getFloat32(o + k * 4, true));
      }
    } else {
      const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, s = new TextDecoder().decode(u8);
      let m; while ((m = re.exec(s))) tris.push(+m[1], +m[2], +m[3]);
    }
    if (!tris.length) throw new Error('STL ohne Dreiecke');
    return { meshes: [weld('STL', tris)], unit: 1, source: 'stl' };
  }
  function weld(name, tris) {
    const map = new Map(), pos = [], I = new Uint32Array(tris.length / 3);
    for (let i = 0; i < tris.length; i += 3) {
      const key = tris[i].toFixed(4) + ',' + tris[i + 1].toFixed(4) + ',' + tris[i + 2].toFixed(4);
      let j = map.get(key);
      if (j === undefined) { j = pos.length / 3; map.set(key, j); pos.push(tris[i], tris[i + 1], tris[i + 2]); }
      I[i / 3] = j;
    }
    return { name, positions: Float32Array.from(pos), indices: I };
  }

  // ---- STEP: Ergebnis von occt-import-js (ReadStepFile mit linearUnit millimeter)
  function fromOcct(r) {
    if (!r || !r.success) throw new Error('STEP-Datei liess sich nicht lesen');
    const meshes = (r.meshes || []).map((m, i) => ({
      name: m.name || 'Körper ' + (i + 1),
      positions: Float32Array.from(m.attributes.position.array),
      indices: Uint32Array.from(m.index.array),
    })).filter(m => m.indices.length);
    if (!meshes.length) throw new Error('STEP ohne Flächen');
    return { meshes, unit: 1, source: 'step' };
  }
  const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0015, angularDeflection: 0.35 };

  // Datei lesen. opts.step(u8) liefert das occt-Ergebnis (Browser: Worker, Node: Modul)
  async function parse(name, buf, opts = {}) {
    const kind = kindOf(name);
    if (kind === '3mf') return parse3mf(buf);
    if (kind === 'obj') return parseObj(new TextDecoder().decode(buf));
    if (kind === 'stl') return parseStl(buf);
    if (kind === 'step') {
      if (!opts.step) throw new Error('STEP-Leser nicht geladen');
      return fromOcct(await opts.step(new Uint8Array(buf)));
    }
    throw new Error('Dateityp nicht erkannt (3MF, OBJ, STL, STEP)');
  }

  // ---- Lage im Modell: welche Dateiachse oben ist und wohin die Nase zeigt, Einheit, Verschiebung, Spiegeln
  const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Standard für Fusion: Y oben, Nase −Z
  const DEFAULT_PLACE = { up: '+Y', nose: '-Z', scale: 1, dx: 0, dy: 0, dz: 0, mirror: false };
  function basis(place) {
    const ez = AX[place.up] || AX['+Y'], n = AX[place.nose] || AX['-Z'];
    if (Math.abs(ez[0] * n[0] + ez[1] * n[1] + ez[2] * n[2]) > 0.5) throw new Error('Nase und Oben dürfen nicht dieselbe Achse sein');
    const ex = n.map(v => -v), ey = cross(ez, ex); // App: x nach hinten (gegen die Nase), z oben, y = z × x
    return { ex, ey, ez };
  }
  // Punkte in App-Achsen (mm). Mit mirror kommt die Spiegelung an y = 0 dazu (Halbflügel → ganzer Flügel)
  function place(meshes, unit, pl) {
    const p = { ...DEFAULT_PLACE, ...pl }, { ex, ey, ez } = basis(p), s = unit * (p.scale || 1);
    const out = [];
    meshes.forEach(m => {
      const P = m.positions, Q = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        Q[i] = (x * ex[0] + y * ex[1] + z * ex[2]) * s + p.dx;
        Q[i + 1] = (x * ey[0] + y * ey[1] + z * ey[2]) * s + p.dy;
        Q[i + 2] = (x * ez[0] + y * ez[1] + z * ez[2]) * s + p.dz;
      }
      out.push({ name: m.name, positions: Q, indices: m.indices });
      if (p.mirror) {
        const R = Q.slice(), I = m.indices.slice();
        for (let i = 1; i < R.length; i += 3) R[i] = -R[i];
        for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
        out.push({ name: m.name + ' (gespiegelt)', positions: R, indices: I });
      }
    });
    return out;
  }
  // Ausdehnung in App-Achsen
  function bounds(meshes) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    meshes.forEach(m => { const P = m.positions; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } });
    return { min: lo, max: hi };
  }
  // Vorschlag für die Lage: Halbteil (alles auf einer Seite) spiegeln; Name mit HLW/Höhenleitwerk an die Leitwerkslage
  function suggest(r, fileName, model) {
    const p = { ...DEFAULT_PLACE };
    const b = bounds(place(r.meshes, r.unit, p));
    const span = b.max[1] - b.min[1];
    if (b.min[1] > -0.02 * span || b.max[1] < 0.02 * span) p.mirror = true;
    if (b.max[1] < 0.02 * span) p.dy = 0; // linke Hälfte: Spiegelung deckt die rechte
    const n = (fileName + ' ' + (r.title || '')).toLowerCase();
    if (model && /hlw|höhenleitwerk|hoehenleitwerk|leitwerk|tail/.test(n)) { p.dx = model.tail.x || 0; p.dz = model.tail.z || 0; p.part = 'tail'; }
    else p.part = /rumpf|fuse/.test(n) ? 'fuse' : /fl(ü|ue)gel|wing/.test(n) ? 'wing' : 'free';
    return p;
  }
  const triangles = meshes => meshes.reduce((a, m) => a + m.indices.length / 3, 0);

  const api = { UNITS, kindOf, unzip, parse3mfXml, parse3mf, parseObj, parseStl, fromOcct, OCCT_PARAMS, parse, AX, DEFAULT_PLACE, basis, place, bounds, suggest, triangles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).import3d = api;
})(typeof self !== 'undefined' ? self : this);
