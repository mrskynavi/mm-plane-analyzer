// Profilgeometrie: .dat einlesen, normieren, neu verteilen, Dicke/Wölbung ändern, Klappe drehen.
// Koordinaten immer als [[x, y], ...] im Selig-Format: Hinterkante oben → Nase → Hinterkante unten.
// Läuft im Browser (MMPA.profil) und in Node (require), ohne Abhängigkeiten.
(function (root) {
  'use strict';

  const num = s => {
    const v = Number(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : NaN;
  };

  // .dat-Text (Selig oder Lednicer) → { name, coords }
  function parseDat(text, fallbackName = 'Profil') {
    const lines = String(text || '').split(/\r?\n/);
    let name = '';
    const rows = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { if (rows.length) rows.push(null); continue; }
      let parts = line.split(/[\s;]+/).filter(Boolean);
      if (parts.length === 1 && parts[0].split(',').length === 2) parts = parts[0].split(',');
      const vals = parts.map(num);
      if (parts.length >= 2 && vals.slice(0, 2).every(Number.isFinite)) rows.push([vals[0], vals[1]]);
      else if (!rows.length && !name) name = line;
    }
    // Leerzeilen am Ende und doppelte Leerzeilen weg
    const blocks = [[]];
    for (const r of rows) {
      if (r === null) { if (blocks[blocks.length - 1].length) blocks.push([]); }
      else blocks[blocks.length - 1].push(r);
    }
    const pts = blocks.filter(b => b.length);
    if (!pts.length) throw new Error('Keine Koordinaten gefunden');
    let coords;
    const first = pts[0][0];
    // Lednicer: erste Zeile nennt die Punktzahl oben und unten (beide > 1), dann Oberseite und Unterseite je von der Nase aus
    if (first[0] > 1.5 && first[1] > 1.5) {
      const nu = Math.round(first[0]);
      const nl = Math.round(first[1]);
      const flat = pts.flat().slice(1);
      const upper = flat.slice(0, nu);
      const lower = flat.slice(nu, nu + nl);
      if (upper.length < 3 || lower.length < 3) throw new Error('Lednicer-Datei unvollständig');
      coords = upper.slice().reverse();
      const sameLE = Math.hypot(lower[0][0] - upper[0][0], lower[0][1] - upper[0][1]) < 1e-9;
      coords.push(...(sameLE ? lower.slice(1) : lower));
    } else {
      coords = pts.flat();
    }
    if (coords.length < 10) throw new Error('Zu wenige Koordinaten (' + coords.length + ')');
    return { name: name || fallbackName, coords };
  }

  function toDat(name, coords) {
    return [name, ...coords.map(([x, y]) => ' ' + x.toFixed(6) + '  ' + y.toFixed(6))].join('\n') + '\n';
  }

  const leIndex = coords => {
    let i0 = 0;
    for (let i = 1; i < coords.length; i++) if (coords[i][0] < coords[i0][0]) i0 = i;
    return i0;
  };

  // Wie AeroSandbox Airfoil.normalize(): Nase (weitester Punkt von der Hinterkante) auf 0/0, Tiefe 1, Hinterkante auf der x-Achse
  function normalize(coords) {
    const n = coords.length;
    let xte = (coords[0][0] + coords[n - 1][0]) / 2;
    let yte = (coords[0][1] + coords[n - 1][1]) / 2;
    let le = 0, dmax = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(coords[i][0] - xte, coords[i][1] - yte);
      if (d > dmax) { dmax = d; le = i; }
    }
    const dx = -coords[le][0], dy = -coords[le][1];
    const scale = 1 / dmax;
    let c = coords.map(([x, y]) => [(x + dx) * scale, (y + dy) * scale]);
    xte = (c[0][0] + c[n - 1][0]) / 2;
    yte = (c[0][1] + c[n - 1][1]) / 2;
    const rot = -Math.atan2(yte, xte);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    c = c.map(([x, y]) => [cr * x - sr * y, sr * x + cr * y]);
    return { coords: c, dx, dy, scale, rotDeg: rot * 180 / Math.PI };
  }

  // Ober- und Unterseite, beide von der Nase zur Hinterkante (x steigend)
  function surfaces(coords) {
    const i = leIndex(coords);
    const upper = coords.slice(0, i + 1).reverse();
    const lower = coords.slice(i);
    return { upper, lower };
  }

  // Lineare Interpolation y(x) auf einer Seite (wie np.interp, ausserhalb auf den Randwert)
  function interpSide(side, x) {
    const s = side.slice().sort((a, b) => a[0] - b[0]);
    const out = new Array(x.length);
    let j = 0;
    for (let k = 0; k < x.length; k++) {
      const xv = x[k];
      if (xv <= s[0][0]) { out[k] = s[0][1]; continue; }
      if (xv >= s[s.length - 1][0]) { out[k] = s[s.length - 1][1]; continue; }
      if (k === 0 || xv < x[k - 1]) j = 0;
      while (j < s.length - 2 && s[j + 1][0] < xv) j++;
      const [x0, y0] = s[j], [x1, y1] = s[j + 1];
      out[k] = x1 === x0 ? y0 : y0 + (y1 - y0) * (xv - x0) / (x1 - x0);
    }
    return out;
  }

  const cosspace = (n, a = 0, b = 1) => Array.from({ length: n }, (_, i) => a + (b - a) * (1 - Math.cos(Math.PI * i / (n - 1))) / 2);

  // Natürlicher kubischer Spline über einen Parameter t, für x und y getrennt
  function spline(t, v) {
    const n = t.length;
    const h = new Array(n - 1), a = new Array(n).fill(0), b = new Array(n).fill(1), c = new Array(n).fill(0), d = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) h[i] = t[i + 1] - t[i];
    for (let i = 1; i < n - 1; i++) {
      a[i] = h[i - 1]; b[i] = 2 * (h[i - 1] + h[i]); c[i] = h[i];
      d[i] = 6 * ((v[i + 1] - v[i]) / h[i] - (v[i] - v[i - 1]) / h[i - 1]);
    }
    const m = new Array(n).fill(0);
    for (let i = 1; i < n; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
    m[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
    m[0] = 0; m[n - 1] = 0;
    return tq => {
      let i = 0;
      while (i < n - 2 && t[i + 1] < tq) i++;
      const hi = h[i], A = (t[i + 1] - tq) / hi, B = (tq - t[i]) / hi;
      return A * v[i] + B * v[i + 1] + ((A ** 3 - A) * m[i] + (B ** 3 - B) * m[i + 1]) * hi * hi / 6;
    };
  }

  // Neu verteilen: pro Seite n Punkte, an Nase und Hinterkante verdichtet (Kosinus), Spline über die Bogenlänge
  function repanel(coords, nPerSide = 100) {
    const i = leIndex(coords);
    const side = pts => {
      const s = [0];
      for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const keep = [0];
      for (let k = 1; k < pts.length; k++) if (s[k] > s[keep[keep.length - 1]] + 1e-12) keep.push(k);
      const t = keep.map(k => s[k]);
      const fx = spline(t, keep.map(k => pts[k][0]));
      const fy = spline(t, keep.map(k => pts[k][1]));
      return cosspace(nPerSide, 0, t[t.length - 1]).map(tq => [fx(tq), fy(tq)]);
    };
    const up = side(coords.slice(0, i + 1)); // Hinterkante oben → Nase
    const lo = side(coords.slice(i)); // Nase → Hinterkante unten
    return up.concat(lo.slice(1));
  }

  function thicknessCamber(coords, x) {
    const { upper, lower } = surfaces(coords);
    const yu = interpSide(upper, x), yl = interpSide(lower, x);
    return { t: x.map((_, k) => yu[k] - yl[k]), c: x.map((_, k) => (yu[k] + yl[k]) / 2), yu, yl };
  }

  // Kennwerte eines (normierten) Profils
  function stats(coords) {
    const x = Array.from({ length: 401 }, (_, i) => i / 400);
    const { t, c } = thicknessCamber(coords, x);
    let it = 0, ic = 0;
    for (let i = 1; i < x.length; i++) {
      if (t[i] > t[it]) it = i;
      if (Math.abs(c[i]) > Math.abs(c[ic])) ic = i;
    }
    const n = coords.length;
    const te = Math.hypot(coords[0][0] - coords[n - 1][0], coords[0][1] - coords[n - 1][1]);
    // Nasenradius aus dem Umkreis der drei Punkte um die Nase
    const i = leIndex(coords);
    let rLE = NaN;
    if (i > 0 && i < n - 1) {
      const [p, q, r] = [coords[i - 1], coords[i], coords[i + 1]];
      const a = Math.hypot(q[0] - p[0], q[1] - p[1]), b = Math.hypot(r[0] - q[0], r[1] - q[1]), cc = Math.hypot(r[0] - p[0], r[1] - p[1]);
      const area = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
      rLE = area > 0 ? a * b * cc / (4 * area) : Infinity;
    }
    return { thickness: t[it], xThickness: x[it], camber: c[ic], xCamber: x[ic], teThickness: te, leRadius: rLE, points: n };
  }

  // Abbildung x → x^p, die einen Punkt bei xNew auf xOld legt (0 und 1 bleiben)
  function shiftMap(xOld, xNew) {
    if (!(xOld > 0 && xOld < 1 && xNew > 0 && xNew < 1) || Math.abs(xOld - xNew) < 1e-6) return x => x;
    const p = Math.log(xOld) / Math.log(xNew);
    return x => Math.pow(x, p);
  }

  // Offene Endleiste (wie XFOIL GDES TGAP): die Dicke über die hinteren blend der Tiefe sanft so ändern, dass sie an
  // der Hinterkante genau gap ist (Bruchteil der Tiefe). Der Zuschlag wächst mit s² (s = 0 am Beginn, 1 an der
  // Hinterkante): vorne knickfrei, an der Hinterkante öffnet sich der Keil. Vor 1 − blend bleibt das Profil gleich,
  // grösste Dicke und Wölbung ändern sich also nicht. t: Dicken an den Stellen x (x steigend, letzter Wert bei 1).
  const TE_BLEND = 0.2;
  const teBlend = (x, blend = TE_BLEND) => { const s = (x - (1 - blend)) / blend; return s <= 0 ? 0 : s >= 1 ? 1 : s * s; };
  function teGapThickness(t, x, gap, blend = TE_BLEND) {
    if (gap == null || !Number.isFinite(gap)) return t;
    const d = Math.max(0, gap) - t[t.length - 1];
    return t.map((v, k) => v + d * teBlend(x[k], blend));
  }

  // Dicke und Wölbung skalieren und ihre Lage verschieben (wie XFOIL GDES TFAC/HIGH).
  // mod: { thickness: Faktor, camber: Faktor, xThickness: neue Lage oder null, xCamber: neue Lage oder null,
  //        teGap: Endleistendicke als Bruchteil der Tiefe oder null (= wie das Profil) }
  function modify(coords, mod = {}, nPerSide = 100) {
    const base = normalize(coords).coords;
    const s = stats(base);
    const x = cosspace(nPerSide);
    const tf = mod.thickness ?? 1, cf = mod.camber ?? 1;
    const mt = shiftMap(s.xThickness, mod.xThickness ?? s.xThickness);
    const mc = shiftMap(s.xCamber, mod.xCamber ?? s.xCamber);
    const xt = x.map(mt), xc = x.map(mc);
    // interpSide braucht steigende x, beide Abbildungen sind monoton
    const t = teGapThickness(thicknessCamber(base, xt).t.map(v => tf * v), x, mod.teGap);
    const c = thicknessCamber(base, xc).c;
    const up = x.map((xv, k) => [xv, cf * c[k] + t[k] / 2]);
    const lo = x.map((xv, k) => [xv, cf * c[k] - t[k] / 2]);
    return up.slice().reverse().concat(lo.slice(1));
  }

  // Klappe um einen Drehpunkt drehen (wie AeroSandbox add_control_surface). Ausschlag positiv = nach unten.
  // hinge: 'auto' (unten bei positivem, oben bei negativem Ausschlag), 'unten', 'oben', 'mitte'
  function flap(coords, deflectionDeg, hingeX = 0.75, hinge = 'auto', nPerSide = 100) {
    const base = repanel(normalize(coords).coords, nPerSide);
    if (!deflectionDeg) return base;
    const { t, c } = thicknessCamber(base, [hingeX]);
    const side = hinge === 'auto' ? (deflectionDeg > 0 ? 'unten' : 'oben') : hinge;
    const hy = side === 'unten' ? c[0] - t[0] / 2 : side === 'oben' ? c[0] + t[0] / 2 : c[0];
    const a = -deflectionDeg * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const half = deflectionDeg / 2 * Math.PI / 180;
    const behind = ([x, y]) => (x - hingeX) * Math.cos(half) - (y - hy) * Math.sin(half) > 0;
    const rot = ([x, y]) => [hingeX + ca * (x - hingeX) - sa * (y - hy), hy + sa * (x - hingeX) + ca * (y - hy)];
    const i = leIndex(base);
    const up = base.slice(0, i + 1), lo = base.slice(i + 1);
    const out = [];
    for (const p of up) { const r = rot(p); out.push(behind(r) ? r : p); }
    for (const p of lo) { const r = rot(p); out.push(behind(r) ? r : p); }
    return repanel(out, nPerSide);
  }

  // NACA-4-Ziffern-Profil, z. B. '0009' oder '2412', mit geschlossener Hinterkante
  function naca4(code, nPerSide = 100) {
    const m = +code[0] / 100, p = +code[1] / 10, tt = +code.slice(2) / 100;
    const x = cosspace(nPerSide);
    const yt = x.map(v => 5 * tt * (0.2969 * Math.sqrt(v) - 0.126 * v - 0.3516 * v * v + 0.2843 * v ** 3 - 0.1036 * v ** 4));
    const yc = x.map(v => (m && p) ? (v < p ? m / (p * p) * (2 * p * v - v * v) : m / ((1 - p) ** 2) * ((1 - 2 * p) + 2 * p * v - v * v)) : 0);
    const dy = x.map(v => (m && p) ? (v < p ? 2 * m / (p * p) * (p - v) : 2 * m / ((1 - p) ** 2) * (p - v)) : 0);
    const up = x.map((v, k) => { const th = Math.atan(dy[k]); return [v - yt[k] * Math.sin(th), yc[k] + yt[k] * Math.cos(th)]; });
    const lo = x.map((v, k) => { const th = Math.atan(dy[k]); return [v + yt[k] * Math.sin(th), yc[k] - yt[k] * Math.cos(th)]; });
    return up.slice().reverse().concat(lo.slice(1));
  }

  const api = { parseDat, toDat, normalize, teGapThickness, teBlend, TE_BLEND, surfaces, interpSide, repanel, thicknessCamber, stats, modify, flap, naca4, cosspace, leIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).profil = api;
})(typeof self !== 'undefined' ? self : this);
