// NeuralFoil in JavaScript: Profilpolaren aus einem neuronalen Netz, trainiert auf XFOIL-Rechnungen.
// Übertragung von neuralfoil/main.py (Version 0.3.3, Peter Sharpe, MIT-Lizenz, siehe LICENSE-neuralfoil.txt).
// Gleiche Rechenschritte wie das Original; test/neuralfoil.test.js prüft gegen Werte aus Python.
(function (root) {
  'use strict';

  const prof = typeof module !== 'undefined' && module.exports ? require('./profil.js') : root.MMPA.profil;
  const W = typeof module !== 'undefined' && module.exports ? require('./nf-gewichte.js') : root.MMPA.nfGewichte;

  const decode = (b64, f64 = false) => {
    let bytes;
    if (typeof Buffer !== 'undefined') bytes = Buffer.from(b64, 'base64');
    else { const s = atob(b64); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return f64 ? new Float64Array(buf) : Float64Array.from(new Float32Array(buf));
  };

  let net = null;
  function load() {
    if (net) return net;
    net = {
      layers: W.layers.map(l => ({ rows: l.rows, cols: l.cols, w: decode(l.w), b: decode(l.b) })),
      mean: decode(W.mean, true),
      invCov: decode(W.invCov, true),
      n: W.nInputs,
    };
    return net;
  }

  const comb = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };

  // Kleinste Quadrate mit Householder-QR (A: m×n, Zeilen als Arrays)
  function lstsq(A, b) {
    const m = A.length, n = A[0].length;
    const R = A.map(r => r.slice()), y = b.slice();
    for (let k = 0; k < n; k++) {
      let norm = 0;
      for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      const alpha = R[k][k] > 0 ? -norm : norm;
      const v = new Array(m).fill(0);
      v[k] = R[k][k] - alpha;
      for (let i = k + 1; i < m; i++) v[i] = R[i][k];
      let vv = 0;
      for (let i = k; i < m; i++) vv += v[i] * v[i];
      if (vv === 0) continue;
      for (let j = k; j < n; j++) {
        let s = 0;
        for (let i = k; i < m; i++) s += v[i] * R[i][j];
        s = 2 * s / vv;
        for (let i = k; i < m; i++) R[i][j] -= s * v[i];
      }
      let s = 0;
      for (let i = k; i < m; i++) s += v[i] * y[i];
      s = 2 * s / vv;
      for (let i = k; i < m; i++) y[i] -= s * v[i];
    }
    const x = new Array(n).fill(0);
    for (let k = n - 1; k >= 0; k--) {
      let s = y[k];
      for (let j = k + 1; j < n; j++) s -= R[k][j] * x[j];
      x[k] = R[k][k] ? s / R[k][k] : 0;
    }
    return x;
  }

  // Kulfan-Parameter (CST mit Nasenmodifikation), wie AeroSandbox get_kulfan_parameters(method="least_squares")
  function kulfanFit(coords, nWeights = 8, normalizeCoords = true) {
    const c = normalizeCoords ? prof.normalize(coords).coords : coords;
    const x = c.map(p => p[0]), y = c.map(p => p[1]);
    const le = prof.leIndex(c);
    const N = nWeights - 1;
    const K = Array.from({ length: nWeights }, (_, i) => comb(N, i));
    const rows = x.map((xv, j) => {
      const C = Math.pow(xv, 0.5) * (1 - xv);
      const S = K.map((k, i) => k * Math.pow(xv, i) * Math.pow(1 - xv, N - i) * C);
      const upper = j <= le;
      const lowerCols = upper ? S.map(() => 0) : S;
      const upperCols = upper ? S : S.map(() => 0);
      const lem = xv * Math.pow(Math.max(1 - xv, 0), nWeights + 0.5);
      return [...lowerCols, ...upperCols, lem, upper ? xv / 2 : -xv / 2];
    });
    let sol = lstsq(rows, y);
    let te = sol[sol.length - 1], lew = sol[sol.length - 2];
    if (te < 0) {
      sol = lstsq(rows.map(r => r.slice(0, -1)), y);
      te = 0; lew = sol[sol.length - 1];
    }
    return { lower: sol.slice(0, nWeights), upper: sol.slice(nWeights, 2 * nWeights), leWeight: lew, teThickness: te };
  }

  const swish = v => v / (1 + Math.exp(-v));
  const LN_EPS = Math.log(10 / Number.MAX_VALUE);
  const sigmoid = v => { const z = Math.min(Math.max(v, LN_EPS), -LN_EPS); return 1 / (1 + Math.exp(-z)); };

  function evalNet(x) {
    const { layers } = load();
    let h = x;
    for (let L = 0; L < layers.length; L++) {
      const { rows, cols, w, b } = layers[L];
      const o = new Float64Array(rows);
      for (let r = 0; r < rows; r++) {
        let s = b[r];
        const off = r * cols;
        for (let c = 0; c < cols; c++) s += w[off + c] * h[c];
        o[r] = L < layers.length - 1 ? swish(s) : s;
      }
      h = o;
    }
    return h;
  }

  function mahalanobis2(x) {
    const { mean, invCov, n } = load();
    const d = Array.from(x, (v, i) => v - mean[i]);
    let s = 0;
    for (let i = 0; i < n; i++) { let r = 0; for (let j = 0; j < n; j++) r += d[j] * invCov[j * n + i]; s += r * d[i]; }
    return s;
  }

  const sind = a => Math.sin(a * Math.PI / 180), cosd = a => Math.cos(a * Math.PI / 180);

  // Ein Betriebspunkt aus Kulfan-Parametern. alpha in Grad.
  function fromKulfan(k, alpha, Re, nCrit = 9, xtrUpper = 1, xtrLower = 1) {
    const x = Float64Array.from([
      ...k.upper, ...k.lower, k.leWeight, k.teThickness * 50,
      sind(2 * alpha), cosd(alpha), 1 - cosd(alpha) ** 2,
      (Math.log(Re) - 12.5) / 3.5, (nCrit - 9) / 4.5, xtrUpper, xtrLower,
    ]);
    const n = load().n;
    const y = evalNet(x);
    y[0] -= mahalanobis2(x) / (2 * n);
    const xf = Float64Array.from(x);
    for (let i = 0; i < 8; i++) { xf[i] = -x[8 + i]; xf[8 + i] = -x[i]; }
    xf[16] = -x[16]; xf[18] = -x[18]; xf[23] = x[24]; xf[24] = x[23];
    const yf = evalNet(xf);
    yf[0] -= mahalanobis2(xf) / (2 * n);
    // nur die Beiwerte zurückspiegeln, die Grenzschichtgrössen braucht die App nicht
    const f0 = (y[0] + yf[0]) / 2, f1 = (y[1] - yf[1]) / 2, f2 = (y[2] + yf[2]) / 2, f3 = (y[3] - yf[3]) / 2;
    const f4 = (y[4] + yf[5]) / 2, f5 = (y[5] + yf[4]) / 2;
    return {
      conf: sigmoid(f0), cl: f1 / 2, cd: Math.exp((f2 - 2) * 2), cm: f3 / 20,
      xtrTop: Math.min(Math.max(f4, 0), 1), xtrBot: Math.min(Math.max(f5, 0), 1),
    };
  }

  // Wie get_aero_from_airfoil: Koordinaten normieren, Winkel/Re/Moment auf die Originallage zurückrechnen.
  // Gibt eine Funktion zurück, damit die Kulfan-Anpassung pro Profil nur einmal läuft.
  function prepare(coords) {
    const nrm = prof.normalize(coords);
    const k = kulfanFit(nrm.coords, 8, false);
    const s = nrm.scale, da = nrm.rotDeg;
    const xq = -nrm.dx + 0.25 * (1 / s * cosd(da)) - 0.25;
    const yq = -nrm.dy + 0.25 * (1 / s * sind(-da));
    const at = (alpha, Re, nCrit = 9, xtrUpper = 1, xtrLower = 1) => {
      const r = fromKulfan(k, alpha + da, Re / s, nCrit, xtrUpper, xtrLower);
      r.cm += -r.cl * xq + r.cd * yq;
      return r;
    };
    at.kulfan = k;
    return at;
  }

  const api = { kulfanFit, fromKulfan, prepare, lstsq };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).neuralfoil = api;
})(typeof self !== 'undefined' ? self : this);
