// W3: freier Nachlauf, Rauchfäden und Abwind-Ebene.
// Die Zirkulation je Streifen kommt aus der linearen Streifenbasis der Modellrechnung (r.load). Auf der Fläche liegen
// je Streifen vier gebundene Wirbel (Verteilung wie an der ebenen Platte), an den Streifenkanten laufen die freien
// Wirbel von der Endleiste nach hinten. Der Nachlauf ist frei: jeder Faden folgt der örtlichen Strömung
// (Anströmung + alle Wirbel beider Hälften), in einigen Durchgängen von vorn nach hinten nachgeführt. So rollt
// sich die Wirbelschicht am Randbogen ein und sinkt hinter dem Flügel ab.
// Daraus: Geschwindigkeit in jedem Punkt, Rauchfäden (Stromlinien) und der Abwindwinkel in einer Ebene quer zur Strömung.
// Reibungsfrei und stationär; Rumpf und Ablösung fehlen. Längen in mm, Geschwindigkeit bezogen auf V = 1.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;

  const RAD = Math.PI / 180;
  // Anteil der Zirkulation in vier gleich tiefen Feldern (ebene Platte), gebundener Wirbel je bei 1/4 des Feldes
  const WK = [0.609, 0.209, 0.124, 0.058], XK = [0.0625, 0.3125, 0.5625, 0.8125];
  const NC = 21; // Stützstellen der Skelettlinie

  // Fläche als Folge von Stationen im Raum, mit Tiefe, Winkel, Dicke und Skelettlinie
  function sheet(stations, profiles, x0, z0, incidence) {
    const P = V.stationPoints(stations, x0, z0);
    const st = stations.map((s, i) => {
      let g = null; try { g = M.stationGeometry(s, profiles); } catch (e) { g = null; }
      const cam = new Float64Array(NC);
      if (g && g.camber) for (let k = 0; k < NC; k++) cam[k] = interp(g.camber.xs, g.camber.zs, k / (NC - 1));
      const t = g && g.stats ? (g.stats.thickness ?? g.stats.t ?? 0.1) : 0.1;
      return { s: s.y - stations[0].y, y: P[i].le[1], x: P[i].le[0], z: P[i].le[2], chord: s.chord, th: (incidence + (s.twist || 0)) * RAD, t: t > 1 ? t / 100 : t, cam };
    });
    return { st, yTip: st[st.length - 1].y, sTip: st[st.length - 1].s };
  }
  function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1);
    return ys[ys.length - 1];
  }
  // Schnitt an der Stelle u (key 's' = Bogenlänge, 'y' = Spannweitenlage)
  function cut(sh, key, u) {
    const st = sh.st;
    let k = 1; while (k < st.length - 1 && u > st[k][key]) k++;
    const a = st[k - 1], b = st[k], t = Math.min(1, Math.max(0, (u - a[key]) / ((b[key] - a[key]) || 1)));
    const L = (p, q) => p + (q - p) * t;
    return { a, b, t, y: L(a.y, b.y), x: L(a.x, b.x), z: L(a.z, b.z), chord: L(a.chord, b.chord), th: L(a.th, b.th), tk: L(a.t, b.t) };
  }
  const camAt = (c, xc) => { const f = Math.min(NC - 1.001, Math.max(0, xc * (NC - 1))), i = Math.floor(f), w = f - i; return (c.a.cam[i] + (c.a.cam[i + 1] - c.a.cam[i]) * w) * (1 - c.t) + (c.b.cam[i] + (c.b.cam[i + 1] - c.b.cam[i]) * w) * c.t; };
  // Punkt der Skelettfläche bei x/c
  const onSheet = (c, xc) => [c.x + xc * c.chord * Math.cos(c.th), c.y, c.z - xc * c.chord * Math.sin(c.th) + camAt(c, xc) * c.chord];
  // halbe Profildicke (NACA-Dickenverteilung, auf die Profildicke skaliert)
  const halfT = (tk, xc) => (xc <= 0 || xc >= 1 ? 0 : 5 * tk * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc * xc * xc - 0.1036 * xc * xc * xc * xc));

  // Wirbelfäden als flaches Feld: je Faden x1 y1 z1 x2 y2 z2 Γ rc². Die linke Hälfte steht ausgeschrieben dahinter
  // (gespiegelt, Endpunkte vertauscht).
  const SZ = 8;
  function pushSeg(arr, p, q, g, rc2) {
    arr.push(p[0], p[1], p[2], q[0], q[1], q[2], g, rc2);
    arr.push(q[0], -q[1], q[2], p[0], -p[1], p[2], g, rc2);
  }
  // Induzierte Geschwindigkeit der Fäden [from, to) im Punkt (x, y, z), aufaddiert in out
  function induce(S, from, to, x, y, z, out) {
    let u = 0, v = 0, w = 0;
    for (let i = from * SZ, e = to * SZ; i < e; i += SZ) {
      const ax = x - S[i], ay = y - S[i + 1], az = z - S[i + 2], bx = x - S[i + 3], by = y - S[i + 4], bz = z - S[i + 5];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx, cc = cx * cx + cy * cy + cz * cz;
      const l1 = Math.sqrt(ax * ax + ay * ay + az * az), l2 = Math.sqrt(bx * bx + by * by + bz * bz);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const rx = S[i + 3] - S[i], ry = S[i + 4] - S[i + 1], rz = S[i + 5] - S[i + 2], r00 = rx * rx + ry * ry + rz * rz;
      const k = S[i + 6] * (rx * (ax / l1 - bx / l2) + ry * (ay / l1 - by / l2) + rz * (az / l1 - bz / l2)) / (4 * Math.PI * (cc + S[i + 7] * r00 + 1e-12));
      u += cx * k; v += cy * k; w += cz * k;
    }
    out[0] += u; out[1] += v; out[2] += w;
  }

  // Nachlauf aufbauen. state: { alpha, it } in Grad. opts.iter: Durchgänge (0 = gerader Nachlauf)
  function build(model, profiles, r, state, opts = {}) {
    const L = r && r.load;
    if (!L) throw new Error('Modellrechnung fehlt');
    const iter = opts.iter ?? 4;
    const al = state.alpha * RAD, vinf = [Math.cos(al), 0, Math.sin(al)];
    const sheets = [
      sheet(model.wing.stations, profiles, 0, 0, model.wing.incidence || 0),
      sheet(model.tail.stations, profiles, model.tail.x, model.tail.z || 0, state.it || 0),
    ];
    const semi = sheets[0].yTip, cref = r.wing.mac;
    const rcB = (0.04 * cref) ** 2, rcW = (opts.core ?? 0.025) * semi; // Kernradien: gebunden, frei
    // Streifen je Fläche, nach y geordnet, mit Kanten entlang der Fläche
    const fixed = [[], []], fils = [];
    let xEnd = 0;
    for (let sf = 0; sf < 2; sf++) {
      const sh = sheets[sf], idx = [];
      for (let i = 0; i < L.surf.length; i++) if (L.surf[i] === sf) idx.push(i);
      idx.sort((a, b) => L.y[a] - L.y[b]);
      let s = 0; const edges = [cut(sh, 's', 0)], gam = [];
      idx.forEach(i => {
        s += L.width[i]; edges.push(cut(sh, 's', Math.min(s, sh.sTip)));
        gam.push((L.c0[i] + state.alpha * L.ca[i] + (state.it || 0) * L.ci[i]) * L.chord[i] / 2);
      });
      idx.forEach((_, j) => {
        const A = edges[j], B = edges[j + 1], g = gam[j];
        let cum = 0;
        for (let k = 0; k < 4; k++) {
          const a = onSheet(A, XK[k]), b = onSheet(B, XK[k]);
          pushSeg(fixed[sf], a, b, WK[k] * g, rcB);
          cum += WK[k];
          const xn = k < 3 ? XK[k + 1] : 1, a1 = onSheet(A, xn), b1 = onSheet(B, xn);
          pushSeg(fixed[sf], b, b1, cum * g, rcB); // äussere Kante nach hinten
          pushSeg(fixed[sf], a1, a, cum * g, rcB); // innere Kante nach vorn
        }
      });
      // freie Wirbel: an jeder Kante die Differenz der Nachbarn (nach hinten gezählt)
      for (let j = 0; j <= idx.length; j++) {
        const E = edges[j];
        if (E.y < 1e-6) continue; // in der Symmetrieebene hebt sich der Faden mit seinem Spiegelbild auf
        const g = (j > 0 ? gam[j - 1] : 0) - (j < idx.length ? gam[j] : 0);
        const te = onSheet(E, 1);
        fils.push({ surf: sf, g, te, eta: E.y / semi });
        xEnd = Math.max(xEnd, te[0]);
      }
    }
    // Stützstellen in x hinter der Endleiste: erst fein, dann gröber
    const len = Math.max(opts.length ?? 0, 2.6 * semi) + (xEnd - fils.reduce((m, f) => Math.min(m, f.te[0]), 1e9));
    const dx = []; let d = 0.02 * semi, sum = 0;
    while (sum < len && dx.length < 60) { dx.push(d); sum += d; d *= 1.1; }
    const K = dx.length;
    fils.forEach(f => {
      f.p = new Float64Array((K + 1) * 3);
      f.p[0] = f.te[0]; f.p[1] = f.te[1]; f.p[2] = f.te[2];
      for (let k = 0; k < K; k++) { f.p[k * 3 + 3] = f.p[k * 3] + dx[k]; f.p[k * 3 + 4] = f.p[k * 3 + 1]; f.p[k * 3 + 5] = f.p[k * 3 + 2] + dx[k] * vinf[2] / vinf[0]; }
    });
    // Feld: [Flügel fest | Flügel frei | HLW fest | HLW frei]
    const nFix = [fixed[0].length / SZ, fixed[1].length / SZ];
    const nFil = [fils.filter(f => f.surf === 0).length, fils.filter(f => f.surf === 1).length];
    const perFil = 2 * (K + 1); // K Stücke + Fortsetzung ins Weite, je mit Spiegelbild
    const off = [0, nFix[0], nFix[0] + nFil[0] * perFil, nFix[0] + nFil[0] * perFil + nFix[1]];
    const n = off[3] + nFil[1] * perFil;
    const S = new Float64Array(n * SZ);
    S.set(fixed[0], 0); S.set(fixed[1], off[2] * SZ);
    const far = 200 * semi, rc2 = rcW * rcW;
    const order = [...fils.filter(f => f.surf === 0), ...fils.filter(f => f.surf === 1)];
    order.forEach((f, q) => { f.at = (f.surf === 0 ? off[1] + q * perFil : off[3] + (q - nFil[0]) * perFil); });
    const put = (i, p, q, g) => {
      const o = i * SZ;
      S[o] = p[0]; S[o + 1] = p[1]; S[o + 2] = p[2]; S[o + 3] = q[0]; S[o + 4] = q[1]; S[o + 5] = q[2]; S[o + 6] = g; S[o + 7] = rc2;
      S[o + 8] = q[0]; S[o + 9] = -q[1]; S[o + 10] = q[2]; S[o + 11] = p[0]; S[o + 12] = -p[1]; S[o + 13] = p[2]; S[o + 14] = g; S[o + 15] = rc2;
    };
    const write = (f, k) => { // Stück k → k+1 (k = K: Fortsetzung)
      const p = f.p, a = [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]];
      const b = k < K ? [p[k * 3 + 3], p[k * 3 + 4], p[k * 3 + 5]] : [a[0] + far * vinf[0], a[1], a[2] + far * vinf[2]];
      put(f.at + 2 * k, a, b, f.g);
    };
    order.forEach(f => { for (let k = 0; k <= K; k++) write(f, k); });
    const W = { S, n, off, vinf, alpha: state.alpha, sheets, semi, cref, fils: order, K, dx, xEnd };
    // Nachführen: Ebene für Ebene nach hinten, jeder Punkt folgt der Strömung am vorherigen
    const v = [0, 0, 0];
    for (let it = 0; it < iter; it++) {
      for (let k = 0; k < K; k++) {
        const nxt = order.map(f => {
          const p = f.p; v[0] = vinf[0]; v[1] = 0; v[2] = vinf[2];
          induce(S, 0, n, p[k * 3], p[k * 3 + 1], p[k * 3 + 2], v);
          const vx = Math.max(0.3, v[0]);
          return [p[k * 3 + 1] + dx[k] * v[1] / vx, p[k * 3 + 2] + dx[k] * v[2] / vx];
        });
        order.forEach((f, q) => {
          // Verschiebung der Ebene k+1 an alle Punkte dahinter weitergeben, damit der Faden glatt bleibt
          const dy = nxt[q][0] - f.p[k * 3 + 4], dz = nxt[q][1] - f.p[k * 3 + 5];
          for (let j = k + 1; j <= K; j++) { f.p[j * 3 + 1] += dy; f.p[j * 3 + 2] += dz; }
          if (f.p[k * 3 + 4] < 0) f.p[k * 3 + 4] = 0; // nicht über die Symmetrieebene
          write(f, k); if (k + 1 <= K) write(f, k + 1);
        });
      }
      order.forEach(f => { for (let k = 0; k <= K; k++) write(f, k); });
    }
    return W;
  }

  // Geschwindigkeit im Punkt p (V = 1). wingOnly: nur Flügel und sein Nachlauf (Abwind am Leitwerk)
  function velocity(W, p, wingOnly = false) {
    const v = [W.vinf[0], 0, W.vinf[2]];
    induce(W.S, 0, wingOnly ? W.off[2] : W.n, p[0], p[1], p[2], v);
    return v;
  }
  // Abwindwinkel in Grad: Anstellwinkel minus örtlicher Strömungswinkel
  const epsOf = (W, v) => W.alpha - Math.atan2(v[2], v[0]) / RAD;

  // Lage zur Fläche: null ausserhalb des Grundrisses, sonst { zs: Höhe der Skelettfläche, ht: halbe Dicke }
  function over(sh, x, y) {
    const ya = Math.abs(y);
    if (ya > sh.yTip) return null;
    const c = cut(sh, 'y', ya), xc = (x - c.x) / (c.chord * Math.cos(c.th));
    if (xc < 0 || xc > 1) return null;
    const fade = Math.min(1, (sh.yTip - ya) / (0.03 * sh.yTip + 1e-9));
    return { zs: c.z - xc * c.chord * Math.sin(c.th) + camAt(c, xc) * c.chord, ht: halfT(c.tk, xc) * c.chord * fade };
  }

  // Rauchfäden: Stromlinien ab den Startpunkten. Die Rechnung kennt nur die Skelettfläche; damit die Fäden nicht
  // durch das dicke Profil laufen, bleiben sie auf ihrer Seite der Fläche und werden um die Profildicke verdrängt
  // (klingt mit dem Abstand ab).
  function smoke(W, seeds, opts = {}) {
    const h = opts.step ?? 0.07 * W.cref, xTo = opts.xTo ?? W.xEnd + 0.8 * W.cref, maxN = opts.max ?? 400;
    return seeds.map(seed => {
      let p = seed.slice();
      const side = [0, 0], out = [];
      const show = q => {
        let z = q[2];
        W.sheets.forEach((sh, i) => {
          const o = over(sh, q[0], q[1]); if (!o) return;
          const d = q[2] - o.zs, sd = side[i] || (d >= 0 ? 1 : -1);
          z = o.zs + sd * (Math.abs(d) + o.ht * Math.exp(-Math.abs(d) / (3 * o.ht + 1e-6)));
        });
        out.push(q[0], q[1], z);
      };
      show(p);
      for (let n = 0; n < maxN && p[0] < xTo; n++) {
        const v1 = velocity(W, p), s1 = h / Math.hypot(v1[0], v1[1], v1[2]);
        const m = [p[0] + v1[0] * s1 / 2, p[1] + v1[1] * s1 / 2, p[2] + v1[2] * s1 / 2];
        const v2 = velocity(W, m), s2 = h / Math.hypot(v2[0], v2[1], v2[2]);
        const q = [p[0] + v2[0] * s2, p[1] + v2[1] * s2, p[2] + v2[2] * s2];
        W.sheets.forEach((sh, i) => {
          const o = over(sh, q[0], q[1]);
          if (!o) { side[i] = 0; return; }
          const d = q[2] - o.zs;
          if (!side[i]) { const o0 = over(sh, p[0], p[1]); side[i] = (o0 ? p[2] - o0.zs : d) >= 0 ? 1 : -1; if (!o0) side[i] = d >= 0 ? 1 : -1; }
          if (d * side[i] < 0.2) q[2] = o.zs + side[i] * 0.2; // nicht durch die Fläche
        });
        p = q; show(p);
      }
      return Float32Array.from(out);
    });
  }

  // Startpunkte: quer = Reihe über die Halbspannweite in der Höhe h über der Fläche, hoch = Stapel bei y = eta · Halbspannweite
  function rake(W, { mode = 'quer', h = 0, eta = 0.5, n = 13 } = {}) {
    const sh = W.sheets[0], seeds = [], back = 0.9 * W.cref;
    const start = (y, dz) => { const c = cut(sh, 'y', Math.min(y, sh.yTip)); return [c.x - back, y, c.z + dz - back * W.vinf[2] / W.vinf[0]]; };
    if (mode === 'hoch') { const span = 0.9 * W.cref; for (let i = 0; i < n; i++) seeds.push(start(eta * W.semi, (i / (n - 1) - 0.5) * span + 0.01 * W.cref)); }
    else for (let i = 0; i < n; i++) seeds.push(start(W.semi * (0.03 + 1.07 * i / (n - 1)), h));
    return seeds;
  }

  // Abwind-Ebene quer zur Flugrichtung bei x: Abwindwinkel (nur Flügel und sein Nachlauf) und Querströmung
  function plane(W, x, opts = {}) {
    const ny = opts.ny ?? 45, nz = opts.nz ?? 25, yMax = 1.25 * W.semi, hz = opts.hz ?? 0.32 * W.semi;
    const te = onSheet(cut(W.sheets[0], 's', 0), 1);
    const zc = te[2] + Math.max(0, x - te[0]) * W.vinf[2] / W.vinf[0] * 0.5;
    const ys = Array.from({ length: ny }, (_, i) => yMax * i / (ny - 1)), zs = Array.from({ length: nz }, (_, j) => zc - hz + 2 * hz * j / (nz - 1));
    const eps = new Float32Array(ny * nz), vy = new Float32Array(ny * nz), vz = new Float32Array(ny * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < ny; i++) {
      const v = velocity(W, [x, ys[i], zs[j]], true), k = j * ny + i;
      eps[k] = epsOf(W, v); vy[k] = v[1]; vz[k] = v[2] - W.vinf[2];
    }
    return { x, ys, zs, eps, vy, vz };
  }

  // Abwind am Höhenleitwerk: Mittel über die 1/4-Linie, mit der Tiefe gewichtet (nur Flügel und sein Nachlauf)
  function tailDownwash(W) {
    const sh = W.sheets[1]; let a = 0, b = 0;
    for (let i = 0; i < 12; i++) {
      const c = cut(sh, 's', sh.sTip * (i + 0.5) / 12), p = onSheet(c, 0.25);
      a += epsOf(W, velocity(W, p, true)) * c.chord; b += c.chord;
    }
    return b ? a / b : NaN;
  }
  // Wo liegt der Randwirbel in der Ebene x? Schwerpunkt der Wirbelstärke der äusseren Fäden des Flügels
  function tipCore(W, x) {
    let sy = 0, sz = 0, sg = 0;
    W.fils.forEach(f => {
      if (f.surf !== 0 || f.eta < 0.6) return;
      let k = 0; while (k < W.K - 1 && f.p[(k + 1) * 3] < x) k++;
      const t = Math.min(1, Math.max(0, (x - f.p[k * 3]) / ((f.p[k * 3 + 3] - f.p[k * 3]) || 1)));
      const y = f.p[k * 3 + 1] + (f.p[k * 3 + 4] - f.p[k * 3 + 1]) * t, z = f.p[k * 3 + 2] + (f.p[k * 3 + 5] - f.p[k * 3 + 2]) * t, g = Math.max(0, f.g);
      sy += y * g; sz += z * g; sg += g;
    });
    return sg > 0 ? { y: sy / sg, z: sz / sg } : null;
  }

  // Alles für die Anzeige. want: { wake, smoke, plane }; rake und planeX wie oben
  function compute(model, profiles, r, state, opts = {}, W = null) {
    model = M.resolveTe ? M.resolveTe(model) : model;
    W = W || build(model, profiles, r, state, opts);
    const want = opts.want || { wake: true, smoke: true, plane: true };
    const tailX = onSheet(cut(W.sheets[1], 's', 0), 0.25)[0];
    const out = { state, semi: W.semi, tailX, xEnd: W.xEnd };
    if (!W.info) {
      const W0 = build(model, profiles, r, state, { ...opts, iter: 0 });
      W.info = { epsTail: tailDownwash(W), epsStraight: tailDownwash(W0), core: tipCore(W, tailX) };
    }
    out.info = W.info;
    if (want.wake) out.wake = W.fils.map(f => ({ surf: f.surf, g: f.g, eta: f.eta, pts: Float32Array.from(f.p) }));
    if (want.smoke) out.smoke = smoke(W, rake(W, opts.rake));
    if (want.plane) out.plane = plane(W, opts.planeX ?? tailX);
    return { W, out };
  }

  const api = { build, velocity, smoke, rake, plane, tailDownwash, tipCore, compute, induce, epsOf, over };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).nachlauf = api;
})(typeof self !== 'undefined' ? self : this);
