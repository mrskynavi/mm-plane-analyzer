// Wirbelgitterverfahren (VLM) für Flügel und Leitwerk, wie VLM in XFLR5 und AVL:
// Hufeisenwirbel auf der Fläche, gebundener Wirbel bei 1/4, Kontrollpunkt bei 3/4 jedes Panels,
// Nachlauf gerade nach hinten. Wölbung, Einstellwinkel, Schränkung und Klappen gehen über die Normale
// in die Randbedingung ein (Skelettlinie wie bei dünnen Profilen). Symmetrischer Geradeausflug:
// nur die rechte Hälfte wird gerechnet, die linke als Spiegelbild.
// Längen in mm, Winkel in Grad. x nach hinten, y nach rechts, z nach oben.
(function (root) {
  'use strict';

  const RAD = Math.PI / 180;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => mul(a, 1 / norm(a));

  // Stationen einer Fläche: { y, chord, offset, dihedral, twist, flapDepth, flap }.
  // y ist die Spannweite entlang der Fläche (wie XFLR5), V-Form, Klappe gelten bis zur nächsten Station.
  // Ergibt die Lage der Stationen im Raum.
  function stationPoints(stations, x0 = 0, z0 = 0) {
    const pts = [];
    let yp = 0, z = z0;
    stations.forEach((s, i) => {
      if (i > 0) {
        const ds = s.y - stations[i - 1].y, g = (stations[i - 1].dihedral || 0) * RAD;
        yp += ds * Math.cos(g); z += ds * Math.sin(g);
      }
      pts.push({ le: [x0 + (s.offset || 0), yp, z], chord: s.chord, twist: s.twist || 0 });
    });
    return pts;
  }

  // Fläche, Spannweite, mittlere aerodynamische Tiefe und deren Lage (beide Hälften)
  function planform(stations, x0 = 0) {
    const P = stationPoints(stations, x0);
    let S = 0, Sc = 0, Sx = 0, Sy = 0;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], h = stations[i].y - stations[i - 1].y;
      const c0 = a.chord, c1 = b.chord;
      const s = (c0 + c1) / 2 * h;
      S += s;
      Sc += h / 3 * (c0 * c0 + c0 * c1 + c1 * c1);
      // Lage der Nasenleiste, gewichtet mit der Tiefe
      Sx += h / 6 * (a.le[0] * (2 * c0 + c1) + b.le[0] * (c0 + 2 * c1));
      Sy += h / 6 * (stations[i - 1].y * (2 * c0 + c1) + stations[i].y * (c0 + 2 * c1));
    }
    const span = 2 * (stations[stations.length - 1].y - stations[0].y);
    const area = 2 * S;
    return { area, span, aspect: span * span / area, mac: Sc / S, xMac: Sx / S, yMac: Sy / S, projSpan: 2 * P[P.length - 1].le[1] };
  }

  // Panels der rechten Hälfte. camber[i]: Skelettlinie der Station i als { xs, zs } (z/c über x/c) oder null.
  function panelize(surf, { ny = 24, nx = 6, x0 = 0, z0 = 0, incidence = 0, camber = [], tag = 0, tipDense = true } = {}) {
    const st = surf, P = stationPoints(st, x0, z0);
    const semi = st[st.length - 1].y - st[0].y;
    const xc = Array.from({ length: nx + 1 }, (_, k) => (1 - Math.cos(Math.PI * k / nx)) / 2);
    const panels = [];
    const camb = (ci, x) => {
      const c = camber[ci]; if (!c) return 0;
      const xs = c.xs, zs = c.zs;
      if (x <= xs[0]) return zs[0];
      for (let k = 1; k < xs.length; k++) if (x <= xs[k]) return zs[k - 1] + (x - xs[k - 1]) / (xs[k] - xs[k - 1]) * (zs[k] - zs[k - 1]);
      return zs[zs.length - 1];
    };
    for (let i = 1; i < st.length; i++) {
      const a = P[i - 1], b = P[i], s0 = st[i - 1];
      const n = Math.max(2, Math.round(ny * (st[i].y - s0.y) / semi));
      const last = i === st.length - 1;
      // im äussersten Segment zur Spitze hin dichter
      const eta = Array.from({ length: n + 1 }, (_, k) => last && tipDense ? Math.sin(Math.PI / 2 * k / n) : k / n);
      const flapX = s0.flap ? 1 - (s0.flapDepth || 25) / 100 : 2;
      for (let j = 0; j < n; j++) {
        const e0 = eta[j], e1 = eta[j + 1], em = (e0 + e1) / 2;
        const lerp = (u, v, t) => u + (v - u) * t;
        const le0 = add(a.le, mul(sub(b.le, a.le), e0)), le1 = add(a.le, mul(sub(b.le, a.le), e1)), lem = add(a.le, mul(sub(b.le, a.le), em));
        const c0 = lerp(a.chord, b.chord, e0), c1 = lerp(a.chord, b.chord, e1), cm = lerp(a.chord, b.chord, em);
        const tw = lerp(a.twist, b.twist, em);
        const sv = unit(sub(le1, le0));
        const n0 = unit(cross([1, 0, 0], sv));
        for (let k = 0; k < nx; k++) {
          const xa = xc[k], xb = xc[k + 1], q = xa + (xb - xa) / 4, t = xa + 3 * (xb - xa) / 4;
          const A = [le0[0] + q * c0, le0[1], le0[2]], B = [le1[0] + q * c1, le1[1], le1[2]];
          const cp = [lem[0] + t * cm, lem[1], lem[2]];
          // Neigung der Skelettlinie im Kontrollpunkt, zwischen den Stationen gemittelt
          const h = Math.min(0.01, (xb - xa) / 4), t0 = Math.max(0, t - h), t1 = Math.min(1, t + h);
          const dz = (camb(i - 1, t1) - camb(i - 1, t0)) * (1 - em) + (camb(i, t1) - camb(i, t0)) * em;
          let theta = (incidence + tw) * RAD - Math.atan(dz / (t1 - t0));
          if ((xa + xb) / 2 > flapX) theta += s0.flap * RAD;
          const nv = add(mul(n0, Math.cos(theta)), mul(cross(sv, n0), Math.sin(theta)));
          panels.push({ A, B, cp, n0, n: nv, chord: cm, width: norm(sub(le1, le0)), strip: tag * 1e4 + i * 1e3 + j, y: lem[1], z: lem[2], surf: tag });
        }
      }
    }
    return panels;
  }

  // Induzierte Geschwindigkeit eines geraden Wirbelfadens P1→P2 (Zirkulation 1) im Punkt P, mit kleinem Kern
  const CORE = 1e-3; // mm, relativ zur Fadenlänge
  function segment(P, P1, P2) {
    const r1 = sub(P, P1), r2 = sub(P, P2), r0 = sub(P2, P1);
    const c = cross(r1, r2), cc = dot(c, c), l1 = norm(r1), l2 = norm(r2);
    const r00 = dot(r0, r0);
    if (l1 < 1e-9 || l2 < 1e-9 || cc < 1e-12 * r00) return [0, 0, 0];
    const k = dot(r0, sub(mul(r1, 1 / l1), mul(r2, 1 / l2))) / (4 * Math.PI * (cc + CORE * CORE * r00));
    return mul(c, k);
  }
  function horseshoe(P, A, B, far) {
    const FA = [A[0] + far, A[1], A[2]], FB = [B[0] + far, B[1], B[2]];
    let v = add(add(segment(P, FA, A), segment(P, A, B)), segment(P, B, FB));
    // Spiegelbild der linken Hälfte, umgekehrter Umlauf
    const Am = [A[0], -A[1], A[2]], Bm = [B[0], -B[1], B[2]], FAm = [FA[0], -FA[1], FA[2]], FBm = [FB[0], -FB[1], FB[2]];
    v = add(v, add(add(segment(P, FBm, Bm), segment(P, Bm, Am)), segment(P, Am, FAm)));
    return v;
  }

  // LU-Zerlegung mit Spaltenpivot, einmal pro Geometrie
  function lu(M) {
    const n = M.length, A = M.map(r => Float64Array.from(r)), piv = Array.from({ length: n }, (_, i) => i);
    for (let k = 0; k < n; k++) {
      let p = k, mx = Math.abs(A[k][k]);
      for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > mx) { mx = Math.abs(A[i][k]); p = i; }
      if (p !== k) { [A[p], A[k]] = [A[k], A[p]]; [piv[p], piv[k]] = [piv[k], piv[p]]; }
      const d = A[k][k];
      for (let i = k + 1; i < n; i++) {
        const f = A[i][k] / d; A[i][k] = f;
        if (f) for (let j = k + 1; j < n; j++) A[i][j] -= f * A[k][j];
      }
    }
    return b => {
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = b[piv[i]]; for (let j = 0; j < i; j++) s -= A[i][j] * x[j]; x[i] = s; }
      for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
      return x;
    };
  }

  // Gleichungssystem aufbauen. surfaces: [{ panels, area? }], Bezug: sRef (mm²), cRef (mm), xRef (mm)
  function build(panels) {
    let span = 0;
    for (const p of panels) span = Math.max(span, Math.abs(p.B[1]), Math.abs(p.A[1]));
    const far = 2000 * Math.max(span, 1);
    const M = panels.map(pi => panels.map(pj => dot(horseshoe(pi.cp, pj.A, pj.B, far), pi.n0)));
    return { panels, solve: lu(M) };
  }

  // Ein Betriebspunkt: alpha in Grad, extra(panel) = zusätzlicher Winkel in Grad (z. B. Leitwerkseinstellung)
  function solve(sys, alpha, { sRef, cRef, xRef = 0, extra = null } = {}) {
    const a = alpha * RAD, V = [Math.cos(a), 0, Math.sin(a)];
    const rhs = sys.panels.map(p => {
      let n = p.n;
      const e = extra ? extra(p) : 0;
      if (e) { const sv = unit(sub(p.B, p.A)), t = e * RAD; n = add(mul(n, Math.cos(t)), mul(cross(sv, n), Math.sin(t))); }
      return -dot(V, n);
    });
    const G = sys.solve(rhs);
    const Lh = [-Math.sin(a), 0, Math.cos(a)];
    let L = 0, M = 0;
    const bySurf = {}, strips = new Map();
    sys.panels.forEach((p, i) => {
      const l = sub(p.B, p.A), F = mul(cross(V, l), G[i]);
      const mid = mul(add(p.A, p.B), 0.5);
      const lift = 2 * dot(F, Lh);
      L += lift;
      M += 2 * (mid[2] * F[0] - (mid[0] - xRef) * F[2]);
      bySurf[p.surf] = (bySurf[p.surf] || 0) + lift;
      const s = strips.get(p.strip) || { y: p.y, z: p.z, chord: p.chord, width: p.width, surf: p.surf, gamma: 0 };
      s.gamma += G[i]; strips.set(p.strip, s);
    });
    const q = 0.5 * sRef;
    const out = { alpha, CL: L / q, Cm: M / (q * cRef), lift: bySurf, strips: [...strips.values()].map(s => ({ ...s, cl: 2 * s.gamma / s.chord })) };
    return out;
  }

  const api = { stationPoints, planform, panelize, build, solve, segment, horseshoe, lu, RAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).vlm = api;
})(typeof self !== 'undefined' ? self : this);
