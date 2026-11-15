// 3D-Modell für die Ansicht im Grundriss: Flügel und Höhenleitwerk aus den Profilschnitten des Fusion-Exports
// (Tiefe, Pfeilung, V-Form, Schränkung, Profil, Randbogen), Rumpf aus der Kontur von rumpf.js als elliptische
// Querschnitte, Seitenleitwerk als symmetrisches Trapez mit der Fläche aus der Rechnung.
// Liefert reine Dreiecksnetze (Punkte in mm, App-Achsen: x nach hinten, y Spannweite, z oben), damit Tests und
// spätere Schritte (Druckbild, verformter Flügel) ohne three.js auskommen.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const FX = isNode ? require('./fusion.js') : root.MMPA.fusion;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const F = isNode ? require('./rumpf.js') : root.MMPA.rumpf;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;

  const RAD = Math.PI / 180;

  // Netz sammeln: Punkte und Dreiecke
  function mesh(name, kind) {
    const pos = [], idx = [], att = [];
    return {
      name, kind, pos, idx, att,
      // a = [x/c, Seite]: Seite +1 oben, −1 unten, 0 ohne (Deckel, Rumpf); für Druckbild und Ablösekarte
      v(p, a) { pos.push(p[0], p[1], p[2]); att.push(a ? a[0] : 0, a ? a[1] : 0); return pos.length / 3 - 1; },
      tri(a, b, c) { idx.push(a, b, c); },
      quad(a, b, c, d) { idx.push(a, b, c, a, c, d); },
    };
  }
  // rev: Umlauf aller Dreiecke drehen, damit die Normalen nach aussen zeigen (Volumen positiv)
  const done = (m, rev) => {
    const I = Uint32Array.from(m.idx);
    if (rev) for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    return { name: m.name, kind: m.kind, positions: Float32Array.from(m.pos), indices: I, surface: Float32Array.from(m.att) };
  };

  // Fläche (Flügel oder HLW) aus Schnitten, die alle gleich viele Punkte haben (Endleiste oben → Nase → Endleiste unten)
  // Beide Hälften: die linke gespiegelt (y → −y, Umlauf gedreht).
  function lofted(name, kind, secs, tip, shift, rot, nSide) {
    const m = mesh(name, kind);
    // Punkte je Schnitt: oben von der Endleiste zur Nase (Kosinusteilung), dann unten zurück (ohne Nase)
    const xs = P.cosspace(nSide);
    const param = i => (i < nSide ? [xs[nSide - 1 - i], 1] : [xs[i - nSide + 1], -1]);
    const tf = p => {
      // Einstellwinkel um die Nasenleiste der Wurzel (Nase hoch positiv), dann an die Lage im Modell schieben
      const x = p[0], z = p[2], c = Math.cos(rot), s = Math.sin(rot);
      return [x * c + z * s + shift[0], p[1] + shift[1], z * c - x * s + shift[2]];
    };
    [1, -1].forEach(side => {
      const flip = side < 0;
      const put = (p, i) => { const q = tf(p); return m.v([q[0], q[1] * side, q[2]], i == null ? null : param(i)); };
      const T = flip ? (a, b, c) => m.tri(a, c, b) : (a, b, c) => m.tri(a, b, c);
      const Q = (a, b, c, d) => { T(a, b, c); T(a, c, d); };
      const rings = secs.map(s => s.pts.map((p, i) => put(p, i)));
      const n = rings[0].length;
      for (let j = 1; j < rings.length; j++) {
        const a = rings[j - 1], b = rings[j];
        for (let i = 1; i < n; i++) Q(a[i - 1], a[i], b[i], b[i - 1]);
        Q(a[n - 1], a[0], b[0], b[n - 1]); // offene Endleiste schliessen
      }
      // Wurzel: Deckel als Fächer (liegt meist im Rumpf)
      // eigene Punkte, damit die Schattierung an der Kante nicht verschmiert
      const r0 = secs[0].pts.map(p => put(p));
      for (let i = 1; i < n - 1; i++) T(r0[0], r0[i + 1], r0[i]);
      // Spitze: zum Randpunkt, sonst Deckel
      const rl = rings[rings.length - 1];
      if (tip) {
        const t = put(tip.pt);
        for (let i = 0; i < n; i++) T(rl[i], rl[(i + 1) % n], t);
      } else for (let i = 1; i < n - 1; i++) T(rl[0], rl[i], rl[i + 1]);
    });
    return done(m, true);
  }

  function surface(model, profiles, part, opts) {
    const S = part === 'wing' ? model.wing : model.tail;
    const st = S.stations;
    // Zwischenschnitte alle ~2 % der Halbspannweite (linear, Form bleibt gleich): sonst hat ein langes Segment
    // nur Punkte an seinen Enden und der verbogene Flügel (Ebene Biegung) knickt an den Stationen
    const semi = Math.max(1, st[st.length - 1].y - st[0].y);
    const r = FX.sections(model, profiles, part, { all: true, n: opts.n || 24, passes: 1, step: opts.step || semi / 48 });
    const x0 = part === 'tail' ? model.tail.x : 0, z0 = part === 'tail' ? (model.tail.z || 0) : 0;
    const o = V.stationPoints(st, x0, z0)[0].le;
    const rot = part === 'wing' ? (S.incidence || 0) * RAD : 0;
    const n = opts.n || 24;
    if (r.sections[0].pts.length !== 2 * n - 1) throw new Error('Schnitte mit unerwarteter Punktzahl');
    return { mesh: lofted(part === 'wing' ? 'Flügel' : 'Höhenleitwerk', part, r.sections, r.tip, o, rot, n), sections: r };
  }

  // Rumpf: Ringe über die Kontur, Querschnitt elliptisch (Breite w, Höhe h). Achse gerade, so gelegt, dass die
  // Flügelwurzel auf dem Rumpfrücken sitzt (Schulterdecker, wie die meisten Segler) – die App kennt die Höhenlage nicht.
  function fuselage(model, opts = {}) {
    const sh = F.shape(model);
    const k = Math.sqrt(sh.width || 1);
    const ring = sh.pts.map(p => ({ x: p.x, w: p.w ?? p.r * k, h: p.h ?? p.r / k }));
    // auf höchstens ~80 Ringe ausdünnen, Nase und Ende bleiben
    const step = Math.max(1, Math.ceil(ring.length / 80));
    const R = ring.filter((p, i) => i % step === 0 || i === ring.length - 1);
    const c = model.wing.stations[0].chord;
    const hAt = x => {
      for (let i = 1; i < R.length; i++) if (R[i].x >= x) { const a = R[i - 1], b = R[i], t = (x - a.x) / ((b.x - a.x) || 1); return { w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }; }
      return R[R.length - 1];
    };
    const zAxis = -0.75 * hAt(0.3 * c).h;
    const nA = opts.around || 28;
    const m = mesh('Rumpf', 'fuse');
    const rings = R.map(p => {
      const out = [];
      for (let j = 0; j < nA; j++) {
        const a = 2 * Math.PI * j / nA;
        out.push(m.v([p.x, p.w * Math.sin(a), zAxis + p.h * Math.cos(a)]));
      }
      return out;
    });
    for (let i = 1; i < rings.length; i++) {
      const a = rings[i - 1], b = rings[i];
      for (let j = 0; j < nA; j++) { const j1 = (j + 1) % nA; m.quad(a[j], a[j1], b[j1], b[j]); }
    }
    // Enden schliessen (Spitze hat Radius 0, schadet nicht)
    const cap = (rg, x, rev) => {
      const c0 = m.v([x, 0, zAxis]);
      for (let j = 0; j < nA; j++) { const j1 = (j + 1) % nA; rev ? m.tri(c0, rg[j1], rg[j]) : m.tri(c0, rg[j], rg[j1]); }
    };
    cap(rings[0], R[0].x, true); cap(rings[rings.length - 1], R[R.length - 1].x, false);
    return { mesh: done(m, true), shape: sh, zAxis, hAt };
  }

  // Seitenleitwerk: Fläche A (dm²) aus der Rechnung, Wurzeltiefe wie in der Draufsicht (1,15 · finChord), Spitze 60 %,
  // Endkante am Rumpfende, Profil NACA 0009 (12 % ist für Modellseitenleitwerke zu dick)
  function fin(model, fuse, area, opts = {}) {
    if (!(area > 0)) return null;
    let cr = 1.15 * F.finChord(area), ct = 0.6 * cr, hgt = 2 * area * 1e4 / (cr + ct), sweep = (cr - ct) * 0.7;
    const x3 = fuse.shape.x3;
    let xr = x3 - cr;
    // Umriss aus dem 3D-Import (Bauteile übernehmen): Form wie gemessen, auf die Fläche der Rechnung skaliert
    const g = (model.fuselage || {}).finGeo;
    if (g && g.root > 0 && g.height > 0) {
      const k = Math.sqrt(area * 1e4 / ((g.root + (g.tip || 0)) / 2 * g.height));
      cr = g.root * k; ct = (g.tip || 0) * k; hgt = g.height * k; sweep = (g.sweep || 0) * k;
      xr = Number.isFinite(g.x) && g.x < x3 && g.x + cr > x3 - cr ? g.x : x3 - cr;
    }
    const top = fuse.hAt(Math.min(xr + cr / 2, x3));
    const z0 = fuse.zAxis + top.h * 0.6;
    const n = opts.n || 16, xs = P.cosspace(n);
    const half = x => 0.09 / 0.2 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const prof = [...xs.slice().reverse().map(x => [x, half(x)]), ...xs.slice(1).map(x => [x, -half(x)])];
    const secs = [[xr, z0, cr], [xr + sweep, z0 + hgt, ct]].map(([x, z, c]) => prof.map(([u, t]) => [x + u * c, t * c, z]));
    const m = mesh('Seitenleitwerk', 'fin');
    const rg = secs.map(s => s.map(p => m.v(p)));
    const N = prof.length;
    for (let i = 1; i < N; i++) m.quad(rg[0][i - 1], rg[0][i], rg[1][i], rg[1][i - 1]);
    m.quad(rg[0][N - 1], rg[0][0], rg[1][0], rg[1][N - 1]);
    for (let i = 1; i < N - 1; i++) { m.tri(rg[0][0], rg[0][i + 1], rg[0][i]); m.tri(rg[1][0], rg[1][i], rg[1][i + 1]); }
    return { mesh: done(m), root: cr, tip: ct, height: hgt, x: xr, z: z0 };
  }

  // Ganzes Modell. opts.finArea (dm²) aus der Rechnung, sonst wie rumpf.finArea
  function build(model, profiles, opts = {}) {
    const parts = [], missing = [];
    const add = (fn, label) => {
      try { const r = fn(); if (r) parts.push(r.mesh); return r; } catch (e) { missing.push(label + ': ' + e.message); return null; }
    };
    const w = add(() => surface(model, profiles, 'wing', opts), 'Flügel');
    const t = add(() => surface(model, profiles, 'tail', opts), 'Höhenleitwerk');
    const fu = add(() => fuselage(model, opts), 'Rumpf');
    let fa = opts.finArea;
    if (fa == null) { try { fa = F.finArea(model, V.planform(model.tail.stations).area); } catch (e) { fa = 0; } }
    const fi = fu ? add(() => fin(model, fu, fa, opts), 'Seitenleitwerk') : null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    parts.forEach(p => { for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = p.positions[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } });
    return { parts, bounds: { min: lo, max: hi }, fin: fi && { root: fi.root, tip: fi.tip, height: fi.height }, zAxis: fu && fu.zAxis, missing, wing: w && w.sections, tail: t && t.sections };
  }

  // Volumen eines geschlossenen Netzes (Divergenzsatz), für Tests: positiv, wenn die Dreiecke aussen gegen den Uhrzeigersinn laufen
  function volume(p) {
    const X = p.positions, I = p.indices;
    let v = 0;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      v += X[a] * (X[b + 1] * X[c + 2] - X[b + 2] * X[c + 1]) - X[a + 1] * (X[b] * X[c + 2] - X[b + 2] * X[c]) + X[a + 2] * (X[b] * X[c + 1] - X[b + 1] * X[c]);
    }
    return v / 6;
  }

  const api = { build, surface, fuselage, fin, volume };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).modell3d = api;
})(typeof self !== 'undefined' ? self : this);
