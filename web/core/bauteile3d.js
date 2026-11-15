// Bauteile aus einem importierten 3D-Modell für die Rechnung übernehmen: Rumpf als Konturtabelle, Flügel und
// Höhenleitwerk als Stationen (Tiefe, Pfeilung, V-Form, Schränkung, Dicke/Wölbung oder ganzes Profil aus dem Schnitt),
// Seitenleitwerk als Fläche und Umriss.
// Eingang sind die Netze in App-Achsen (mm; x nach hinten, y Spannweite, z oben), wie import3d.place sie liefert.
// Ablauf: pieces() zerlegt in Teile (zusammenhängende Schalen), classify() ordnet sie Bauteilen zu, extract() schneidet.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;

  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const KINDS = ['fuse', 'wing', 'tail', 'fin', 'none'];
  const LABEL = { fuse: 'Rumpf', wing: 'Flügel', tail: 'HLW', fin: 'SLW', none: '–' };

  const bboxOf = P => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    return { min: lo, max: hi };
  };

  // ---- Teile: jede Schale eines Körpers einzeln (Punkte an derselben Stelle gelten als verbunden).
  // Mehr als maxParts Schalen (z. B. jede Fläche einzeln vernetzt): der Körper bleibt ein Teil.
  function pieces(meshes, maxParts = 60) {
    const out = [];
    meshes.forEach((m, src) => {
      const P = m.positions, I = m.indices, nv = P.length / 3;
      const key = new Map(), weld = new Int32Array(nv);
      for (let i = 0; i < nv; i++) {
        const k = Math.round(P[i * 3] * 50) + ',' + Math.round(P[i * 3 + 1] * 50) + ',' + Math.round(P[i * 3 + 2] * 50);
        let w = key.get(k); if (w === undefined) { w = i; key.set(k, i); } weld[i] = w;
      }
      const par = new Int32Array(nv); for (let i = 0; i < nv; i++) par[i] = i;
      const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      const join = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
      for (let i = 0; i < I.length; i += 3) { join(weld[I[i]], weld[I[i + 1]]); join(weld[I[i]], weld[I[i + 2]]); }
      const groups = new Map();
      for (let t = 0; t < I.length; t += 3) { const r = find(weld[I[t]]); let g = groups.get(r); if (!g) { g = []; groups.set(r, g); } g.push(t); }
      const list = groups.size > maxParts ? [null] : [...groups.values()];
      list.forEach(tris => {
        if (!tris) { out.push({ name: m.name, layer: m.layer, src, positions: P, indices: I, box: bboxOf(P) }); return; }
        const map = new Map(), pos = [], idx = new Uint32Array(tris.length * 3);
        tris.forEach((t, k) => { for (let j = 0; j < 3; j++) { const v = I[t + j]; let q = map.get(v); if (q === undefined) { q = pos.length / 3; map.set(v, q); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); } idx[k * 3 + j] = q; } });
        const positions = Float32Array.from(pos);
        out.push({ name: m.name, layer: m.layer, src, positions, indices: idx, box: bboxOf(positions) });
      });
    });
    return out;
  }

  // ---- Zuordnung: Name (Körper, Ebene) zuerst, dann Form und Lage. hint: Teil der Datei ('wing', 'tail', 'fuse', 'all', 'free')
  const NAMES = [
    ['none', /wheel|\brad\b|pilot|servo|akku|empf(ä|ae)nger|propeller|luftschraube|kufe/i],
    ['fin', /\bslw\b|seitenleit|seitenruder|seitenflosse|rudder|\bfin\b|vertical/i],
    ['tail', /\bhlw\b|h(ö|oe)henleit|h(ö|oe)henruder|h(ö|oe)henflosse|elevator|stabili[sz]er|\bstab\b|tail ?plane|horizontal/i],
    ['wing', /fl(ü|ue)gel|wing|tragfl|querruder|aileron|w(ö|oe)lbklappe|\bflap/i],
    ['fuse', /rumpf|fuse|body|haube|canopy|cockpit|spinner|boom|leitwerkstr(ä|ae)ger|kabine/i],
  ];
  function nameKind(p) {
    const s = (p.name || '') + ' ' + (p.layer || '');
    for (const [k, re] of NAMES) if (re.test(s)) return k;
    return null;
  }
  function classify(ps, hint) {
    if (!ps.length) return [];
    const all = { min: [0, 1, 2].map(k => Math.min(...ps.map(p => p.box.min[k]))), max: [0, 1, 2].map(k => Math.max(...ps.map(p => p.box.max[k]))) };
    const L = all.max[0] - all.min[0], B = Math.max(all.max[1], -all.min[1]), diag = Math.hypot(L, 2 * B, all.max[2] - all.min[2]);
    const dims = p => [0, 1, 2].map(k => p.box.max[k] - p.box.min[k]);
    const cen = p => [0, 1, 2].map(k => (p.box.max[k] + p.box.min[k]) / 2);
    const finLike = p => { const [dx, dy, dz] = dims(p), c = cen(p); return dz > 1.5 * dy && dz > 0.25 * dx && dx < 0.45 * L && Math.abs(c[1]) < 0.05 * B + dy; };
    const lifting = p => { const [dx, dy, dz] = dims(p); return dy > 1.2 * dx && dy > 1.5 * dz; };
    const fuseLike = p => { const [dx, dy] = dims(p), c = cen(p); return dx >= dy && Math.abs(c[1]) < 0.15 * B + dy / 2; };
    const out = ps.map(p => {
      let k = nameKind(p);
      // ein Rumpf-Körper mit Seitenflosse: die Flosse als Teil für sich erkennen
      if ((k === 'fuse' || k == null) && finLike(p) && hint !== 'wing' && hint !== 'tail') return 'fin';
      if (k) return k;
      if (hint === 'wing' || hint === 'tail') return hint;
      if (hint === 'fuse') return 'fuse';
      if (lifting(p)) return cen(p)[0] > all.min[0] + 0.6 * L && hint !== 'wing' ? 'tail' : 'wing';
      if (fuseLike(p)) return 'fuse';
      return null;
    });
    // kleine oder unklare Teile: wie das nächste grosse Teil (Deckel, Ränder, Ruderhörner)
    const big = ps.map((p, i) => out[i] && Math.hypot(...dims(p)) > 0.08 * diag ? i : -1).filter(i => i >= 0);
    const gap = (a, b) => Math.hypot(...[0, 1, 2].map(k => Math.max(0, a.box.min[k] - b.box.max[k], b.box.min[k] - a.box.max[k])));
    return out.map((k, i) => {
      if (k) return k;
      let best = -1, d = Infinity;
      big.forEach(j => { const g = gap(ps[i], ps[j]); if (g < d) { d = g; best = j; } });
      return best >= 0 && d < 0.05 * diag ? out[best] : 'none';
    });
  }

  // ---- Schnitt mit der Ebene Achse = v: Punkte auf den Schnittlinien, dicht genug für das Profil (Abstand ≤ step)
  function slice(ps, ax, v, step = Infinity) {
    const n = [0, 0, 0]; n[ax] = 1;
    return slicePlane(ps, n, v, step);
  }
  // Schnitt mit der Ebene n·p = d (n Einheitsvektor)
  function slicePlane(ps, n, d, step = Infinity) {
    const pts = [];
    ps.forEach(p => {
      // Teil ganz auf einer Seite? (Ecken des Quaders)
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < 8; c++) {
        const q = n[0] * (c & 1 ? p.box.max[0] : p.box.min[0]) + n[1] * (c & 2 ? p.box.max[1] : p.box.min[1]) + n[2] * (c & 4 ? p.box.max[2] : p.box.min[2]);
        if (q < lo) lo = q; if (q > hi) hi = q;
      }
      if (d < lo || d > hi) return;
      const P = p.positions, I = p.indices;
      const dist = i => P[i] * n[0] + P[i + 1] * n[1] + P[i + 2] * n[2] - d;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const da = dist(a), db = dist(b), dc = dist(c);
        if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
        const hit = [];
        const edge = (i, j, di, dj) => {
          if ((di > 0) === (dj > 0) || di === dj) return;
          const s = di / (di - dj);
          hit.push([P[i] + (P[j] - P[i]) * s, P[i + 1] + (P[j + 1] - P[i + 1]) * s, P[i + 2] + (P[j + 2] - P[i + 2]) * s]);
        };
        edge(a, b, da, db); edge(b, c, db, dc); edge(c, a, dc, da);
        if (hit.length < 2) continue;
        const [q, r] = hit, len = Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]), m = Math.min(40, Math.max(1, Math.ceil(len / step)));
        for (let k = 0; k <= m; k++) pts.push([q[0] + (r[0] - q[0]) * k / m, q[1] + (r[1] - q[1]) * k / m, q[2] + (r[2] - q[2]) * k / m]);
      }
    });
    return pts;
  }
  const boxOfList = ps => ({ min: [0, 1, 2].map(k => Math.min(...ps.map(p => p.box.min[k]))), max: [0, 1, 2].map(k => Math.max(...ps.map(p => p.box.max[k]))) });

  // ---- Profil im Schnitt: Punkte in Tiefe u (0 Nase … 1 Endleiste) und Höhe v (oben positiv), je Bin oben/unten
  const NB = 60, UB = Array.from({ length: NB + 1 }, (_, i) => (1 - Math.cos(Math.PI * i / NB)) / 2);
  // pts, le, te in der Schnittebene: [Tiefe x, Höhe h]
  function sectionShape(pts, le, te) {
    const dx = te[0] - le[0], dz = te[1] - le[1], c = Math.hypot(dx, dz), ux = dx / c, uz = dz / c;
    const up = new Array(NB + 1).fill(-Infinity), lo = new Array(NB + 1).fill(Infinity);
    pts.forEach(p => {
      const u = ((p[0] - le[0]) * ux + (p[1] - le[1]) * uz) / c, v = (-(p[0] - le[0]) * uz + (p[1] - le[1]) * ux) / c;
      if (u < -0.01 || u > 1.01) return;
      // nächster Bin
      let k = Math.round(Math.acos(Math.min(1, Math.max(-1, 1 - 2 * Math.min(1, Math.max(0, u))))) / Math.PI * NB);
      k = Math.min(NB, Math.max(0, k));
      if (v > up[k]) up[k] = v; if (v < lo[k]) lo[k] = v;
    });
    up[0] = lo[0] = 0;
    const fill = a => {
      for (let i = 0; i <= NB; i++) if (!Number.isFinite(a[i])) {
        let l = i - 1; while (l >= 0 && !Number.isFinite(a[l])) l--;
        let r = i + 1; while (r <= NB && !Number.isFinite(a[r])) r++;
        a[i] = l < 0 ? a[r] : r > NB ? a[l] : a[l] + (a[r] - a[l]) * (UB[i] - UB[l]) / (UB[r] - UB[l]);
      }
      return a;
    };
    fill(up); fill(lo);
    // innen liegende Punkte (Holm, Rippen, Scharnierspalt) stören nicht: oben das Maximum, unten das Minimum
    for (let i = 1; i < NB; i++) if (up[i] < lo[i]) { const m = (up[i] + lo[i]) / 2; up[i] = lo[i] = m; }
    // leicht glätten (Facetten des Netzes), Nase und Endleiste bleiben
    const sm = a => a.map((v, i) => i < 2 || i > NB - 1 ? v : (a[i - 1] + 2 * v + a[i + 1]) / 4);
    const U = sm(up), L = sm(lo);
    let t = 0, ct = 0, xt = 0, xc = 0;
    for (let i = 0; i <= NB; i++) {
      const th = U[i] - L[i], cm = (U[i] + L[i]) / 2;
      if (th > t) { t = th; xt = UB[i]; }
      if (Math.abs(cm) > Math.abs(ct)) { ct = cm; xc = UB[i]; }
    }
    const coords = [];
    for (let i = NB; i >= 0; i--) coords.push([UB[i], U[i]]);
    for (let i = 1; i <= NB; i++) coords.push([UB[i], L[i]]);
    return { thickness: t, camber: ct, xThickness: xt, xCamber: xc, coords };
  }

  // Douglas-Peucker über mehrere Grössen gleichzeitig: Stationen bleiben dort, wo Nasen-/Endleiste, Höhe oder Winkel knicken
  function thin(rows, vals, eps) {
    const keep = new Set([0, rows.length - 1]);
    (function dp(a, b) {
      let worst = -1, d = 0;
      for (let i = a + 1; i < b; i++) {
        const t = (rows[i].yp - rows[a].yp) / ((rows[b].yp - rows[a].yp) || 1);
        const e = Math.max(...vals.map(f => Math.abs(f(rows[i]) - (f(rows[a]) + t * (f(rows[b]) - f(rows[a]))))));
        if (e > d) { d = e; worst = i; }
      }
      if (d > eps) { keep.add(worst); dp(a, worst); dp(worst, b); }
    })(0, rows.length - 1);
    return [...keep].sort((a, b) => a - b);
  }

  // ---- Flügel oder HLW: Schnitte quer zur Spannweite, eine Hälfte (die grössere)
  function surface(ps, opts = {}) {
    if (!ps.length) return null;
    const box = boxOfList(ps), side = box.max[1] >= -box.min[1] ? 1 : -1;
    const y0 = Math.max(0, side > 0 ? box.min[1] : -box.max[1]), y1 = side > 0 ? box.max[1] : -box.min[1];
    if (y1 - y0 < 5) return null;
    // Schnitt quer zur Spannweite durch die Ebene mit Normale t (Spannweitenrichtung), Rahmen x und h (Höhe in der Ebene)
    const cut2 = (t, d, step) => {
      const h = [0, -side * t[2], side * t[1]]; // t um 90° gedreht in der y-z-Ebene: zeigt nach oben
      const pts = slicePlane(ps, t, d, step);
      return { pts, H: h, p2: pts.map(p => [p[0], p[1] * h[1] + p[2] * h[2]]) };
    };
    const section = (t, d) => {
      const { pts, H, p2 } = cut2(t, d);
      if (pts.length < 6) return null;
      let ti = 0;
      p2.forEach((p, i) => { if (p[0] > p2[ti][0]) ti = i; });
      let li = ti, dd = 0;
      p2.forEach((p, i) => { const q = Math.hypot(p[0] - p2[ti][0], p[1] - p2[ti][1]); if (q > dd) { dd = q; li = i; } });
      if (dd < 1) return null;
      // Endleiste: Mitte der hintersten Punkte (die Endleiste hat eine Dicke, der hinterste Punkt liegt oben oder unten)
      const xe = p2[ti][0], near = [];
      p2.forEach((p, i) => { if (p[0] > xe - Math.max(0.3, 0.004 * dd)) near.push(i); });
      const tz = near.reduce((s, i) => s + pts[i][2], 0) / near.length, th = near.reduce((s, i) => s + p2[i][1], 0) / near.length;
      const L3 = pts[li];
      const chord = Math.hypot(xe - p2[li][0], th - p2[li][1]);
      return { yp: side * L3[1], le: [L3[0], L3[2]], te: [xe, tz], chord, ang: Math.atan2(p2[li][1] - th, xe - p2[li][0]) * DEG, t, d, H };
    };
    const n = opts.n || 100;
    let rows = [];
    for (let k = 0; k <= n; k++) {
      const f = (1 - Math.cos(Math.PI * k / n)) / 2, yp = y0 + 0.4 + (y1 - y0 - 0.8) * f;
      const r = section([0, side, 0], yp);
      if (r) rows.push({ ...r, yp });
    }
    // steile Stücke (Winglet, V-Leitwerk): nochmals schneiden, quer zur örtlichen Spannweitenrichtung. Senkrecht
    // geschnitten wäre der Schnitt dort verzerrt (zu dick, Winkel falsch).
    if (rows.length > 4) {
      const gAt = i => {
        const L = rows.slice(Math.max(0, i - 2), i + 3), my = L.reduce((s, r) => s + r.yp, 0) / L.length, mz = L.reduce((s, r) => s + r.te[1], 0) / L.length;
        let a = 0, b = 0; L.forEach(r => { a += (r.yp - my) * (r.te[1] - mz); b += (r.yp - my) ** 2; });
        return Math.atan2(a, b || 1);
      };
      rows = rows.map((r, i) => {
        const g = gAt(i);
        const t = [0, side * Math.cos(g), Math.sin(g)];
        // durch die Endleiste des senkrechten Schnitts
        const q = Math.abs(g) > 3 * RAD ? section(t, t[1] * side * r.yp + t[2] * r.te[1]) : null;
        return q && q.chord > 0.5 * r.chord && q.yp >= y0 && q.yp <= y1 ? { ...q, g } : { ...r, g };
      }).sort((a, b) => a.yp - b.yp);
      // Ausreisser im Winkel (Schnitt durch eine Kante des Netzes): weg, wenn er um mehr als 2° neben seinen Nachbarn liegt
      rows = rows.filter((r, i) => {
        const nb = rows.slice(Math.max(0, i - 2), i + 3).filter(q => q !== r).map(q => q.ang).sort((a, b) => a - b);
        return nb.length < 2 || Math.abs(r.ang - nb[nb.length >> 1]) < 2;
      });
    }
    if (rows.length < 2) return null;
    // Spitze: wo die Tiefe unter 10 % fällt, endet die Fläche (die App rundet von dort elliptisch weiter)
    const cMax = Math.max(...rows.map(r => r.chord));
    let end = rows.length - 1;
    while (end > 1 && rows[end].chord < 0.1 * cMax) end--;
    let R = rows.slice(0, end + 1);
    // Ausschnitt an der Wurzel (Ruder oder Flosse ausgespart): schmale Schnitte im innersten Achtel überbrücken,
    // die Fläche läuft mit dem ersten vollen Schnitt bis zur Wurzel
    const semi0 = R[R.length - 1].yp - R[0].yp, iRef = R.findIndex(r => r.yp - R[0].yp >= 0.12 * semi0);
    let cut = 0;
    if (iRef > 0) {
      const cRef = Math.max(...R.slice(iRef, R.findIndex(r => r.yp - R[0].yp >= 0.25 * semi0) + 1 || R.length).map(r => r.chord));
      let j = 0; while (j < iRef && R[j].chord < 0.8 * cRef) j++;
      if (j > 0 && j < iRef) { cut = R[j].yp; R = [{ ...R[j], yp: R[0].yp }, ...R.slice(j)]; }
    }
    const semi = R[R.length - 1].yp - R[0].yp, cm = R.reduce((a, r) => a + r.chord, 0) / R.length;
    const eps = Math.max(0.6, (opts.tol || 0.0025) * semi);
    const keep = thin(R, [r => r.le[0], r => r.le[0] + r.chord, r => r.le[1], r => r.ang * RAD * cm], eps);
    const K = keep.map(i => ({ ...R[i], i }));
    // Profil an jeder Station, im selben Schnitt quer zur Fläche
    const out = K.map(r => {
      const { p2 } = cut2(r.t, r.d, r.chord / 200);
      // Endleiste im Rahmen: Punkt mit grösstem x, Nase am weitesten davon
      let tb = p2[0]; p2.forEach(p => { if (p[0] > tb[0]) tb = p; });
      let lb = tb, dd = 0; p2.forEach(p => { const q = Math.hypot(p[0] - tb[0], p[1] - tb[1]); if (q > dd) { dd = q; lb = p; } });
      return { ...r, shape: sectionShape(p2, lb, tb) };
    });
    return { side, rows: out, all: R, cMax, cut, tipCut: rows[rows.length - 1].yp > R[R.length - 1].yp + 1 };
  }

  // ---- Rumpf: Schnitte quer zur Flugrichtung; Breite und Höhe je Station.
  // Ragt etwas Schmales über die Kontur (Flosse, Mast im selben Körper), zählt die Höhe nur, wo der Schnitt
  // noch mindestens 40 % der grössten Breite hat (Ellipse: Höhe dort / 0,92).
  function fuselage(ps, opts = {}) {
    if (!ps.length) return null;
    const box = boxOfList(ps), x0 = box.min[0], x1 = box.max[0], L = x1 - x0;
    if (L < 10) return null;
    const n = opts.n || 40, raw = [], step = Math.max(0.5, Math.max(box.max[1] - box.min[1], box.max[2] - box.min[2]) / 150);
    for (let k = 1; k <= n; k++) {
      const x = x0 + L * (1 - Math.cos(Math.PI * k / n)) / 2;
      const pts = slice(ps, 0, Math.min(x, x1 - 0.3), step);
      if (pts.length < 3) { raw.push({ x, cl: [] }); continue; }
      // Gruppen in der Höhe: getrennte Stücke im Schnitt (Kappe der Flosse, Kufe, Rad) für sich
      pts.sort((p, q) => p[2] - q[2]);
      const span = pts[pts.length - 1][2] - pts[0][2], gap = Math.max(2, 0.08 * span), cl = [];
      let cur = [pts[0]];
      for (let i = 1; i < pts.length; i++) { if (pts[i][2] - pts[i - 1][2] > gap) { cl.push(cur); cur = []; } cur.push(pts[i]); }
      cl.push(cur);
      // breite Gruppen gehören zusammen (Öffnung für den Flügel in der Rumpfwand); getrennt bleiben nur schmale Stücke
      const ms = cl.filter(c => c.length >= 3).map(c => ({ pts: c, m: measure(c) }));
      const wm = Math.max(0, ...ms.map(q => q.m.w)), out = [];
      ms.forEach(q => {
        const last = out[out.length - 1];
        if (last && q.m.w >= 0.5 * wm && last.m.w >= 0.5 * wm && q.m.zb - last.m.zt < Math.max(last.m.h, q.m.h)) { last.pts = last.pts.concat(q.pts); last.m = measure(last.pts); } else out.push(q);
      });
      raw.push({ x, cl: out.map(q => q.m) });
    }
    // Kontur: vom breitesten Schnitt aus nach vorn und hinten je die Gruppe, die zur vorigen passt; wo keine passt, endet der Rumpf
    let i0 = -1, wBest = 0;
    raw.forEach((r, i) => r.cl.forEach(c => { if (c.w > wBest) { wBest = c.w; i0 = i; } }));
    if (i0 < 0) return null;
    const pick = new Array(raw.length).fill(null);
    pick[i0] = raw[i0].cl.reduce((a, c) => c.w > a.w ? c : a);
    [-1, 1].forEach(d => {
      let prev = pick[i0];
      for (let i = i0 + d; i >= 0 && i < raw.length; i += d) {
        const mid = (prev.zt + prev.zb) / 2, tol = Math.max(10, 0.6 * prev.h);
        const c = raw[i].cl.filter(q => q.zb - tol <= mid && q.zt + tol >= mid).sort((p, q) => Math.abs((p.zt + p.zb) / 2 - mid) - Math.abs((q.zt + q.zb) / 2 - mid))[0];
        if (!c) break;
        pick[i] = c; prev = c;
      }
    });
    const rows = [];
    let first = pick.findIndex(c => c);
    const xNose = first > 0 ? raw[first - 1].x : x0;
    rows.push({ x: xNose, w: 0, h: 0, zt: null, zb: null });
    pick.forEach((c, i) => { if (c) rows.push({ x: raw[i].x, w: c.w, h: c.zt - c.zb, zt: c.zt, zb: c.zb }); });
    return rows.length >= 3 ? { rows, box } : null;
  }
  // Breite und Höhe einer Gruppe. Ragt etwas Schmales über die Kontur (Flosse, Mast im selben Körper), zählt die
  // Höhe nur, wo der Schnitt noch mindestens 40 % der grössten Breite hat (Ellipse: Höhe dort / 0,92).
  // Halbe Rümpfe (nur eine Seite gezeichnet) zählen doppelt: Breite = 2 · grösster Abstand von der Mitte.
  function measure(pts) {
    let w = 0, zt = -Infinity, zb = Infinity;
    pts.forEach(p => { w = Math.max(w, Math.abs(p[1])); zt = Math.max(zt, p[2]); zb = Math.min(zb, p[2]); });
    const NBd = 24, bw = new Array(NBd).fill(0), hz = (zt - zb) / NBd || 1;
    pts.forEach(p => { const i = Math.min(NBd - 1, Math.floor((p[2] - zb) / hz)); bw[i] = Math.max(bw[i], Math.abs(p[1])); });
    const wMax = Math.max(...bw);
    let it = NBd - 1; while (it > 0 && bw[it] < 0.4 * wMax) it--;
    let ib = 0; while (ib < NBd - 1 && bw[ib] < 0.4 * wMax) ib++;
    const ztT = zb + (it + 1) * hz, zbT = zb + ib * hz, mid = (ztT + zbT) / 2, halfT = (ztT - zbT) / 2 / 0.917;
    if (zt - zb > 1.4 * 2 * halfT) { zt = Math.min(zt, mid + halfT); zb = Math.max(zb, mid - halfT); }
    return { w: 2 * w, zt, zb, h: zt - zb };
  }

  // ---- Seitenleitwerk: Fläche der Seitenansicht über dem Rumpfrücken (Raster in der x-z-Ebene)
  function fin(ps, fus) {
    if (!ps.length) return null;
    const box = boxOfList(ps), x0 = box.min[0], z0 = box.min[2], W = box.max[0] - x0, H = box.max[2] - z0;
    if (W < 5 || H < 5) return null;
    const N = 240, cx = W / N, cz = H / N, grid = new Uint8Array(N * N);
    ps.forEach(p => {
      const P = p.positions, I = p.indices;
      for (let t = 0; t < I.length; t += 3) {
        const a = [P[I[t] * 3], P[I[t] * 3 + 2]], b = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 2]], c = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 2]];
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - x0) / cx)), i1 = Math.min(N - 1, Math.floor((Math.max(a[0], b[0], c[0]) - x0) / cx));
        const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - z0) / cz)), j1 = Math.min(N - 1, Math.floor((Math.max(a[1], b[1], c[1]) - z0) / cz));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          if (Math.abs(area) < 1e-9) { grid[j * N + i] = 1; continue; }
          const px = x0 + (i + 0.5) * cx, pz = z0 + (j + 0.5) * cz;
          const w1 = ((b[0] - px) * (c[1] - pz) - (c[0] - px) * (b[1] - pz)) / area, w2 = ((c[0] - px) * (a[1] - pz) - (a[0] - px) * (c[1] - pz)) / area;
          if (w1 >= -0.02 && w2 >= -0.02 && w1 + w2 <= 1.02) grid[j * N + i] = 1;
        }
      }
    });
    // Rumpfrücken: Oberkante aus den Rumpfschnitten (ohne Rumpf: unterste Zeile der Flosse)
    const R = fus && fus.rows.filter(r => r.zt != null);
    const topAt = x => {
      if (!R || !R.length) return -Infinity;
      if (x <= R[0].x) return R[0].zt; if (x >= R[R.length - 1].x) return R[R.length - 1].zt;
      for (let i = 1; i < R.length; i++) if (R[i].x >= x) { const t = (x - R[i - 1].x) / ((R[i].x - R[i - 1].x) || 1); return R[i - 1].zt + (R[i].zt - R[i - 1].zt) * t; }
      return -Infinity;
    };
    let cells = 0;
    const rowsZ = [];
    for (let j = 0; j < N; j++) {
      let lo = -1, hi = -1;
      for (let i = 0; i < N; i++) {
        const x = x0 + (i + 0.5) * cx, z = z0 + (j + 0.5) * cz;
        if (grid[j * N + i] && z > topAt(x)) { cells++; if (lo < 0) lo = i; hi = i; }
      }
      if (lo >= 0) rowsZ.push({ z: z0 + (j + 0.5) * cz, le: x0 + lo * cx, te: x0 + (hi + 1) * cx });
    }
    if (rowsZ.length < 2) return null;
    const area = cells * cx * cz;
    // Trapez gleicher Fläche: Wurzel und Spitze aus dem untersten und obersten Zehntel
    const k = Math.max(1, Math.round(rowsZ.length / 10));
    const avg = (list, f) => list.reduce((s, r) => s + f(r), 0) / list.length;
    const bot = rowsZ.slice(0, k), top = rowsZ.slice(-k);
    const height = rowsZ[rowsZ.length - 1].z - rowsZ[0].z + cz;
    let root = avg(bot, r => r.te - r.le), tip = avg(top, r => r.te - r.le);
    const s = 2 * area / ((root + tip) * height); root *= s; tip *= s;
    return { area, root, tip, height, xLe: avg(bot, r => r.le), sweep: avg(top, r => r.le) - avg(bot, r => r.le), zRoot: rowsZ[0].z - cz / 2 };
  }

  // ---- alles zusammen. kinds: Bauteil je Teil. Bezug: Nasenleiste der Flügelwurzel (falls ein Flügel da ist).
  function extract(ps, kinds, opts = {}) {
    const of = k => ps.filter((_, i) => kinds[i] === k);
    const wing = surface(of('wing'), opts);
    const tail = surface(of('tail'), opts);
    const fus = fuselage(of('fuse'), opts);
    const fi = fin(of('fin'), fus);
    const ref = wing ? { x: wing.rows[0].le[0], z: wing.rows[0].le[1] } : { x: 0, z: 0 };
    return { ref, wing, tail, fus, fin: fi, counts: KINDS.reduce((o, k) => (o[k] = of(k).length, o), {}) };
  }

  // ---- in Modellwerte umrechnen
  const r1 = v => Math.round(v * 10) / 10;
  // Stationen aus den Schnitten. old: bisherige Stationen (Profil, Klappen usw. von der ähnlichsten relativen Spannweite)
  // mode: 'keep' Profil wie bisher, 'dicke' Dicke und Wölbung gemessen, 'neu' Profil aus dem Schnitt (profileFor(shape, y) → id)
  function toStations(S, old, ref, { mode = 'dicke', profileFor = null, rootIn = true } = {}) {
    const K = S.rows, A = S.all, x0 = K[0].le[0], z0 = K[0].le[1];
    // Bezug der Schränkung: der tiefste Schnitt (an der Wurzel meist die Wurzel selbst)
    const ang0 = K.reduce((a, r) => r.chord > a.chord ? r : a).ang;
    const twists = K.map(r => r.ang - ang0), flat = twists.every(t => Math.abs(t) < 0.3);
    // V-Form je Segment als Ausgleichsgerade über alle Schnitte dazwischen. Ohne Schränkung an der Endleiste
    // (scharf, liegt genau), sonst an der Nase (um sie dreht die Schränkung); die Nase allein springt mit den
    // Facetten des Netzes und mit der Profildicke um Zehntelmillimeter
    const z25 = flat ? r => r.te[1] : r => r.le[1];
    const slope = (a, b) => {
      const L = A && a.i != null ? A.slice(a.i, b.i + 1) : [a, b];
      const n = L.length, my = L.reduce((s, r) => s + r.yp, 0) / n, mz = L.reduce((s, r) => s + z25(r), 0) / n;
      let sxy = 0, sxx = 0; L.forEach(r => { sxy += (r.yp - my) * (z25(r) - mz); sxx += (r.yp - my) ** 2; });
      const g = Math.atan(sxx > 0 ? sxy / sxx : 0) * DEG;
      return Math.abs(g) < 0.3 ? 0 : g;
    };
    // Weg entlang der Fläche (die App misst y entlang der V-Form)
    const pos = [{ s: K[0].yp, g: 0 }];
    for (let i = 1; i < K.length; i++) {
      const g = slope(K[i - 1], K[i]);
      pos.push({ s: pos[i - 1].s + (K[i].yp - K[i - 1].yp) / Math.cos(g * RAD), g });
    }
    const shift = rootIn && K[0].yp > 1 ? 0 : -K[0].yp; // Stück im Rumpf: Wurzel bis zur Mitte durchziehen
    const b0 = old[old.length - 1].y || 1, b1 = pos[pos.length - 1].s + shift || 1;
    const near = y => old.reduce((a, s) => Math.abs(s.y / b0 - y / b1) < Math.abs(a.y / b0 - y / b1) ? s : a);
    const st = K.map((r, i) => {
      const y = pos[i].s + shift, src = near(y), sh = r.shape;
      const o = {
        ...JSON.parse(JSON.stringify(src)), y: Math.round(y), chord: r1(r.chord), offset: r1(r.le[0] - x0),
        dihedral: i < K.length - 1 ? r1(pos[i + 1].g) : 0, twist: flat ? 0 : r1(twists[i]),
      };
      if (mode === 'dicke' && sh) { o.thickness = +sh.thickness.toFixed(4); o.camber = +sh.camber.toFixed(4); }
      if (mode === 'neu' && sh && profileFor) { const id = profileFor(sh, y); if (id) Object.assign(o, { profileId: id, thickness: null, camber: null, xThickness: null, xCamber: null }); }
      return o;
    });
    if (rootIn && K[0].yp > 1) st.unshift({ ...st[0], y: 0, dihedral: 0 });
    return { stations: st, x: x0 - ref.x, z: z0 - ref.z, incidence: ang0 };
  }
  // Rumpftabelle in mm ab der Flügelnase
  const fuseTable = (F, ref) => F.rows.map(r => ({ x: Math.round(r.x - ref.x), w: Math.round(r.w), h: Math.round(r.h) }));
  const finOut = (f, ref) => f && { area: Math.round(f.area / 1e4 * 100) / 100, root: Math.round(f.root), tip: Math.round(f.tip), height: Math.round(f.height), x: Math.round(f.xLe - ref.x), sweep: Math.round(f.sweep) };

  // Kennzahlen für den Vergleich
  function surfStats(stations) {
    try {
      const p = V.planform(stations);
      const dih = stations.slice(0, -1).map(s => s.dihedral || 0), tw = stations.map(s => s.twist || 0);
      return { span: p.projSpan, area: p.area / 1e4, aspect: p.projSpan ** 2 / p.area, root: stations[0].chord, mac: p.mac, n: stations.length,
        dihMin: Math.min(...dih), dihMax: Math.max(...dih), twistTip: tw[tw.length - 1] - tw[0], sweep25: Math.atan2(stations.at(-1).offset + stations.at(-1).chord / 4 - stations[0].offset - stations[0].chord / 4, stations.at(-1).y - stations[0].y) * DEG };
    } catch (e) { return null; }
  }
  function fuseStats(table) {
    if (!table || table.length < 2) return null;
    return { length: table.at(-1).x - table[0].x, nose: -table[0].x, w: Math.max(...table.map(r => r.w)), h: Math.max(...table.map(r => r.h)) };
  }

  // Vorschlag anwenden: liefert das geänderte Modell (Kopie). use: { fuse, wing, tail, fin }, mode je Fläche
  function apply(model, ex, use, opts = {}) {
    const m = JSON.parse(JSON.stringify(model)), notes = [];
    if (use.wing && ex.wing) {
      const r = toStations(ex.wing, m.wing.stations, ex.ref, { mode: opts.wingMode || 'dicke', profileFor: opts.profileFor && ((sh, y) => opts.profileFor(sh, 'wing', y)) });
      m.wing.stations = r.stations;
      m.wing.tipShape = ex.wing.rows.at(-1).chord < 0.2 * ex.wing.cMax ? 'rund' : 'gerade';
    }
    if (use.tail && ex.tail) {
      const r = toStations(ex.tail, m.tail.stations, ex.ref, { mode: opts.tailMode || 'dicke', profileFor: opts.profileFor && ((sh, y) => opts.profileFor(sh, 'tail', y)), rootIn: true });
      m.tail.stations = r.stations; m.tail.x = Math.round(r.x); m.tail.z = Math.round(r.z);
      m.tail.tipShape = ex.tail.rows.at(-1).chord < 0.2 * ex.tail.cMax ? 'rund' : 'gerade';
    }
    if (use.fuse && ex.fus) {
      const old = m.fuselage || {};
      const finish = old.finish || (old.type === 'oldtimer' ? 'oldtimer' : 'modern');
      m.fuselage = { ...old, type: 'kontur', finish, table: fuseTable(ex.fus, ex.ref) };
    }
    if (use.fin && ex.fin) {
      const f = finOut(ex.fin, ex.ref);
      m.fuselage = { ...(m.fuselage || {}), fin: f.area, finGeo: f };
    }
    return { model: m, notes };
  }

  // Winkel der Flügelwurzel gegen das HLW (Einstellwinkeldifferenz, wie gezeichnet)
  const ewd = ex => ex.wing && ex.tail ? ex.wing.rows[0].ang - ex.tail.rows[0].ang : null;

  // Profil aus dem Schnitt als Koordinaten (Endleiste oben → Nase → Endleiste unten)
  const profileCoords = sh => sh.coords.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  // gleiches Profil? (grösste Abweichung in Bruchteilen der Tiefe; die Endleiste zählt nicht, sie ist absolut gleich dick
  // und darum relativ an jeder Station anders)
  const sameShape = (a, b, tol = 0.0025) => a.length === b.length && a.every((p, i) => p[0] > 0.95 || Math.abs(p[1] - b[i][1]) < tol);

  const api = { KINDS, LABEL, pieces, classify, slice, sectionShape, surface, fuselage, fin, extract, toStations, fuseTable, finOut, surfStats, fuseStats, apply, ewd, profileCoords, sameShape, nameKind };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).bauteile3d = api;
})(typeof self !== 'undefined' ? self : this);