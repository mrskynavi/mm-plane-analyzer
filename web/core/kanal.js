// Digitaler Windkanal für ein Profil.
// 1. Reibungsfreie Strömung: Panelverfahren nach Hess und Smith (Quellen je Panel, ein gemeinsamer Wirbelbelag,
//    Kutta-Bedingung an der Hinterkante). Gibt Cp an der Oberfläche und die Geschwindigkeit an jedem Punkt
//    im Feld (für Farbbild und Stromlinien).
// 2. Grenzschicht: aus NeuralFoil (θ, H, ue/V an 32 Punkten je Seite). Daraus Cp mit Grenzschicht = 1 − (ue/V)²,
//    Verdrängungsdicke δ* = H·θ und der Zustand je Punkt: laminar, turbulent, laminar abgelöst (Blase), abgelöst.
// Alle Längen auf die Tiefe bezogen, im normierten Profil (Nase 0/0, Hinterkante 1/0), wie NeuralFoil rechnet.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const PF = isNode ? require('./profil.js') : root.MMPA.profil;
  const NF = isNode ? require('./neuralfoil.js') : root.MMPA.neuralfoil;

  const TWO_PI = 2 * Math.PI;
  // Grenzwerte des Formfaktors H: laminar löst die Grenzschicht etwa ab H ≈ 4 ab (Falkner-Skan-Ablösung),
  // turbulent ab H ≈ 2,5 bis 3. Darüber gilt der Punkt als abgelöst.
  const H_LAM = 4.0, H_TURB = 3.0;

  // Geschwindigkeit, die ein Panel von (x1,y1) nach (x2,y2) mit Quellbelag 1 bzw. Wirbelbelag 1 (Gegenuhrzeigersinn)
  // am Punkt (px,py) erzeugt. Rückgabe [uQ, vQ, uW, vW] im globalen System.
  function induced(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    const tx = dx / L, ty = dy / L;
    // lokale Lage: x' entlang des Panels, y' auf der Normalen (−ty, tx)
    const rx = px - x1, ry = py - y1;
    const xl = rx * tx + ry * ty, yl = -rx * ty + ry * tx;
    const r1 = Math.hypot(xl, yl), r2 = Math.hypot(xl - L, yl);
    const lg = Math.log(Math.max(r1, 1e-12) / Math.max(r2, 1e-12)) / TWO_PI;
    const th = (Math.atan2(yl, xl - L) - Math.atan2(yl, xl)) / TWO_PI;
    // Quelle: u' = ln(r1/r2)/2π, v' = (θ2−θ1)/2π; Wirbel: u' = −(θ2−θ1)/2π, v' = ln(r1/r2)/2π
    const uQ = lg, vQ = th, uW = -th, vW = lg;
    return [uQ * tx - vQ * ty, uQ * ty + vQ * tx, uW * tx - vW * ty, uW * ty + vW * tx];
  }

  function gauss(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // Punkt im Profil? (Strahlverfahren, Kontur als geschlossenes Polygon)
  function inside(nodes, x, y) {
    let c = false;
    for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) {
      const [xi, yi] = nodes[i], [xj, yj] = nodes[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  // Reibungsfreie Lösung. coords: normiertes Profil (Selig-Reihenfolge), alpha in Grad.
  // Panels laufen im Uhrzeigersinn: Hinterkante unten → Nase → Hinterkante oben, die Normale zeigt nach aussen.
  function solve(coords, alpha, { nPerSide = 80 } = {}) {
    const nodes = PF.repanel(coords, nPerSide).slice().reverse();
    const N = nodes.length - 1;
    const pan = [];
    for (let i = 0; i < N; i++) {
      const [x1, y1] = nodes[i], [x2, y2] = nodes[i + 1], L = Math.hypot(x2 - x1, y2 - y1);
      pan.push({ x1, y1, x2, y2, L, tx: (x2 - x1) / L, ty: (y2 - y1) / L, nx: -(y2 - y1) / L, ny: (x2 - x1) / L, xm: (x1 + x2) / 2, ym: (y1 + y2) / 2 });
    }
    const a = alpha * Math.PI / 180, Ux = Math.cos(a), Uy = Math.sin(a);
    // Einflüsse an den Kontrollpunkten (Mitte, auf der Aussenseite)
    const inf = pan.map(p => pan.map(q => induced(p.xm + p.nx * 1e-9, p.ym + p.ny * 1e-9, q.x1, q.y1, q.x2, q.y2)));
    const A = [], b = [];
    for (let i = 0; i < N; i++) {
      const p = pan[i], row = new Array(N + 1).fill(0);
      for (let j = 0; j < N; j++) { const f = inf[i][j]; row[j] = f[0] * p.nx + f[1] * p.ny; row[N] += f[2] * p.nx + f[3] * p.ny; }
      A.push(row); b.push(-(Ux * p.nx + Uy * p.ny));
    }
    // Kutta: Tangentialgeschwindigkeit am ersten und letzten Panel gleich gross, Strömung verlässt die Hinterkante glatt
    const k0 = pan[0], kN = pan[N - 1], kRow = new Array(N + 1).fill(0);
    for (let j = 0; j < N; j++) {
      const f0 = inf[0][j], fN = inf[N - 1][j];
      kRow[j] = f0[0] * k0.tx + f0[1] * k0.ty + fN[0] * kN.tx + fN[1] * kN.ty;
      kRow[N] += f0[2] * k0.tx + f0[3] * k0.ty + fN[2] * kN.tx + fN[3] * kN.ty;
    }
    A.push(kRow); b.push(-(Ux * (k0.tx + kN.tx) + Uy * (k0.ty + kN.ty)));
    const sol = gauss(A, b), sigma = sol.slice(0, N), gamma = sol[N];

    // Geschwindigkeit im Feld: dieselben Formeln wie induced(), ohne Zwischenfelder und mit einem atan2 je Panel
    const P = Float64Array.from(pan.flatMap((q, j) => [q.x1, q.y1, q.tx, q.ty, q.L, sigma[j]]));
    const vel = (x, y) => {
      let u = Ux, v = Uy;
      for (let k = 0; k < P.length; k += 6) {
        const tx = P[k + 2], ty = P[k + 3], L = P[k + 4], sg = P[k + 5];
        const rx = x - P[k], ry = y - P[k + 1];
        const xl = rx * tx + ry * ty, yl = -rx * ty + ry * tx, xm = xl - L;
        const lg = 0.5 * Math.log((xl * xl + yl * yl + 1e-24) / (xm * xm + yl * yl + 1e-24)) / TWO_PI;
        const th = Math.atan2(yl * L, xl * xm + yl * yl) / TWO_PI;
        u += sg * (lg * tx - th * ty) - gamma * (th * tx + lg * ty);
        v += sg * (lg * ty + th * tx) + gamma * (lg * tx - th * ty);
      }
      return [u, v];
    };
    // Oberfläche: Tangentialgeschwindigkeit und Cp je Panel, Seite nach Lage zur Nase
    let iLe = 0;
    for (let i = 1; i < N; i++) if (pan[i].xm < pan[iLe].xm) iLe = i;
    let fx = 0, fy = 0;
    const surf = pan.map((p, i) => {
      let vt = Ux * p.tx + Uy * p.ty;
      for (let j = 0; j < N; j++) { const f = inf[i][j]; vt += sigma[j] * (f[0] * p.tx + f[1] * p.ty) + gamma * (f[2] * p.tx + f[3] * p.ty); }
      const cp = 1 - vt * vt;
      fx -= cp * p.nx * p.L; fy -= cp * p.ny * p.L;
      return { x: p.xm, y: p.ym, cp, vt, side: i < iLe ? 'lower' : 'upper' };
    });
    const cl = -fx * Uy + fy * Ux;
    const contour = nodes.slice();
    return { alpha, nodes: contour, panels: pan, sigma, gamma, surf, cl, vel, inside: (x, y) => inside(contour, x, y) };
  }

  // Geschwindigkeit und Cp auf einem Gitter, Punkte im Profil sind NaN
  function field(sys, { x0 = -0.4, x1 = 1.6, y0 = -0.5, y1 = 0.5, nx = 100, ny = 50 } = {}) {
    const speed = new Float64Array(nx * ny), cp = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = y1 - (y1 - y0) * (j + 0.5) / ny;
      for (let i = 0; i < nx; i++) {
        const x = x0 + (x1 - x0) * (i + 0.5) / nx, k = j * nx + i;
        if (sys.inside(x, y)) { speed[k] = NaN; cp[k] = NaN; continue; }
        const [u, v] = sys.vel(x, y), s = Math.hypot(u, v);
        speed[k] = s; cp[k] = 1 - s * s;
      }
    }
    return { x0, x1, y0, y1, nx, ny, speed, cp };
  }

  // Stromlinien ab Startpunkten vor dem Profil (Runge-Kutta 4, Schritt auf die Länge bezogen)
  function streamlines(sys, { x0 = -0.4, x1 = 1.6, ys = null, step = 0.02, maxSteps = 300 } = {}) {
    const starts = ys || Array.from({ length: 15 }, (_, i) => -0.3 + 0.6 * i / 14);
    const dir = (x, y) => { const [u, v] = sys.vel(x, y), s = Math.hypot(u, v) || 1; return [u / s, v / s]; };
    return starts.map(ys0 => {
      // Start so, dass die ungestörte Linie bei x = 0 auf der Höhe ys0 läge: auch bei grossem α laufen alle durchs Bild
      const a = sys.alpha * Math.PI / 180;
      let x = x0, y = ys0 + x0 * Math.tan(a);
      const line = [[x, y]];
      for (let k = 0; k < maxSteps && x < x1; k++) {
        const k1 = dir(x, y), k2 = dir(x + k1[0] * step / 2, y + k1[1] * step / 2);
        const k3 = dir(x + k2[0] * step / 2, y + k2[1] * step / 2), k4 = dir(x + k3[0] * step, y + k3[1] * step);
        x += step * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6; y += step * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
        if (!Number.isFinite(x + y) || sys.inside(x, y)) break;
        line.push([x, y]);
      }
      return line;
    });
  }

  // Grenzschicht einer Seite auswerten. bl = { theta, H, ue } an den Punkten xs, xtr = Umschlag (Bruchteil der Tiefe).
  function side(xs, bl, xtr) {
    const pts = xs.map((x, i) => {
      const H = bl.H[i], theta = bl.theta[i], ue = Math.abs(bl.ue[i]);
      const turb = x >= xtr;
      const sep = turb ? H > H_TURB : H > H_LAM;
      return { x, H, theta, ue, cp: 1 - ue * ue, dstar: H * theta, state: turb ? (sep ? 'abgeloest' : 'turbulent') : (sep ? 'blase' : 'laminar') };
    });
    // Laminare Ablöseblase: laminar abgelöst vor dem Umschlag, endet wo die turbulente Grenzschicht wieder anliegt
    // (laminar abgelöst erst ganz hinten an der Endleiste zählt nicht als Blase)
    let bubble = null;
    const iLs = pts.findIndex(p => p.state === 'blase');
    if (iLs >= 0 && pts[iLs].x > 0.95) for (let i = iLs; i < pts.length; i++) if (pts[i].state === 'blase') pts[i].state = 'laminar';
    if (iLs >= 0 && pts[iLs].x <= 0.95) {
      let iEnd = pts.findIndex((p, i) => i > iLs && p.x >= xtr && p.H <= H_TURB);
      const reattached = iEnd >= 0;
      if (!reattached) iEnd = pts.length - 1;
      bubble = { from: pts[iLs].x, to: pts[iEnd].x, open: !reattached };
      for (let i = iLs; i < iEnd; i++) pts[i].state = 'blase';
    }
    // Turbulente Ablösung: der erste Punkt hinter dem Umschlag (und hinter der Blase), ab dem es bis zur Endleiste abgelöst bleibt
    let sep = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      if (p.x < xtr || (bubble && p.x <= bubble.to) || p.H <= H_TURB) break;
      sep = p.x;
    }
    if (sep != null) for (const p of pts) if (p.x >= sep) p.state = 'abgeloest';
    return { pts, xtr, bubble, sep };
  }

  // Grenzschicht aus dem NeuralFoil-Ergebnis (r = at(…, true))
  function boundaryLayer(r) {
    if (!r || !r.bl) return null;
    const xs = r.bl.x;
    return { upper: side(xs, r.bl.upper, r.xtrTop), lower: side(xs, r.bl.lower, r.xtrBot), cl: r.cl, cd: r.cd, conf: r.conf };
  }

  // Ablauf über α: je Polarpunkt (mit seiner Re) Umschlag, Blase und Ablösung oben und unten
  function sweep(at, points, nCrit = 9, xtrTop = 1, xtrBot = 1) {
    return points.map(q => {
      const b = boundaryLayer(at(q.alpha, q.re, nCrit, xtrTop, xtrBot, true));
      const pick = s => ({ xtr: s.xtr, bubble: s.bubble, sep: s.sep });
      return { alpha: q.alpha, re: q.re, cl: q.cl, upper: pick(b.upper), lower: pick(b.lower) };
    });
  }

  // Alles für ein Bild: Geometrie normieren (wie NeuralFoil), reibungsfrei lösen, Grenzschicht dazu.
  // alpha bezieht sich auf die Profilsehne der Datei, im normierten Profil gilt alpha + rotDeg.
  function analyze(coords, alpha, re, { nCrit = 9, xtrTop = 1, xtrBot = 1, at = null, nPerSide = 80 } = {}) {
    const nrm = PF.normalize(coords);
    const aN = alpha + nrm.rotDeg;
    const sys = solve(nrm.coords, aN, { nPerSide });
    const f = at || NF.prepare(coords);
    const bl = boundaryLayer(f(alpha, re, nCrit, xtrTop, xtrBot, true));
    return { coords: nrm.coords, alphaN: aN, sys, bl };
  }

  const api = { induced, solve, field, streamlines, boundaryLayer, sweep, analyze, H_LAM, H_TURB };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).kanal = api;
})(typeof self !== 'undefined' ? self : this);
