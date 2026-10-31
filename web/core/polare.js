// Profilpolaren rechnen (Typ 1: Re fest, Typ 2: Re·√Ca fest) und Kennwerte daraus ableiten.
// Rechner ist vorerst NeuralFoil; XFOIL kommt später über die Desktop-App mit derselben Schnittstelle.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const NF = isNode ? require('./neuralfoil.js') : root.MMPA.neuralfoil;

  const range = (a, b, step) => {
    const out = [];
    for (let v = a; v <= b + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
  };

  // Basiswiderstand einer stumpfen Endleiste nach Hoerner (Fluid-Dynamic Drag, Kap. 6): auf die Fläche der Endleiste
  // bezogen Cw_b = 0,135 / ∛Cw_f, mit Cw_f = Profilwiderstand auf dieselbe Fläche bezogen. Auf die Tiefe bezogen:
  // ΔCw = 0,135·(h/l)^(4/3) / ∛Cw. h/l = Endleistendicke durch Tiefe. NeuralFoil (gelernt an XFOIL) enthält diesen
  // Totwasser-Anteil kaum, deshalb kommt er hier dazu.
  function baseDrag(cd, gap) {
    if (!(gap > 0) || !(cd > 0)) return 0;
    return 0.135 * Math.pow(gap, 4 / 3) / Math.cbrt(Math.max(cd, 0.002));
  }

  // opts: { type: 1|2, re, alphaFrom, alphaTo, alphaStep, nCrit, xtrTop, xtrBot, teGap (Endleistendicke / Tiefe, für den Basiswiderstand) }
  // Typ 2: re ist Re·√Ca (wie in XFOIL), die örtliche Re = re / √Ca
  function compute(coords, opts = {}) {
    const o = { type: 1, re: 200000, alphaFrom: -5, alphaTo: 12, alphaStep: 0.5, nCrit: 9, xtrTop: 1, xtrBot: 1, ...opts };
    const at = NF.prepare(coords);
    const pts = [];
    for (const alpha of range(o.alphaFrom, o.alphaTo, o.alphaStep)) {
      // Typ 2 startet mit der Re des vorigen Punkts, das spart Iterationen
      let Re = o.type === 2 && pts.length ? pts[pts.length - 1].re : o.re;
      let r = at(alpha, Re, o.nCrit, o.xtrTop, o.xtrBot);
      if (o.type === 2) {
        // Re hängt vom Betrag von Ca ab (negatives Ca fliegt genauso schnell wie positives): einige Festpunkt-Schritte;
        // unter |Ca| 0.05 bleibt Re bei re/√0.05
        for (let k = 0; k < 8; k++) {
          const ReNew = o.re / Math.sqrt(Math.max(Math.abs(r.cl), 0.05));
          if (Math.abs(ReNew - Re) < 1) break;
          Re = ReNew;
          r = at(alpha, Re, o.nCrit, o.xtrTop, o.xtrBot);
        }
      }
      const cdB = baseDrag(r.cd, o.teGap);
      pts.push({ alpha, cl: r.cl, cd: r.cd + cdB, cdBase: cdB, cm: r.cm, xtrTop: r.xtrTop, xtrBot: r.xtrBot, conf: r.conf, re: Re });
    }
    return { opts: o, points: pts, summary: summary(pts) };
  }

  // Kennwerte: Ca max, Cw min, beste Gleitzahl, Nullauftriebswinkel, Cm0, Auftriebsanstieg
  function summary(pts) {
    if (!pts.length) return {};
    let iMax = 0, iMin = 0, iLD = 0;
    pts.forEach((p, i) => {
      if (p.cl > pts[iMax].cl) iMax = i;
      if (p.cd < pts[iMin].cd) iMin = i;
      if (p.cl / p.cd > pts[iLD].cl / pts[iLD].cd) iLD = i;
    });
    let alpha0 = NaN, cm0 = NaN, slope = NaN;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.cl <= 0 && b.cl > 0) {
        const f = -a.cl / (b.cl - a.cl);
        alpha0 = a.alpha + f * (b.alpha - a.alpha);
        cm0 = a.cm + f * (b.cm - a.cm);
        break;
      }
    }
    // Anstieg im linearen Bereich: Ausgleichsgerade über Ca 0.1 … 0.7
    const lin = pts.filter(p => p.cl >= 0.1 && p.cl <= 0.7 && p.alpha < pts[iMax].alpha);
    if (lin.length >= 3) {
      const n = lin.length, sx = lin.reduce((s, p) => s + p.alpha, 0), sy = lin.reduce((s, p) => s + p.cl, 0);
      const sxx = lin.reduce((s, p) => s + p.alpha * p.alpha, 0), sxy = lin.reduce((s, p) => s + p.alpha * p.cl, 0);
      slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    }
    const low = pts.filter(p => p.conf < 0.5).length;
    return {
      clMax: pts[iMax].cl, alphaClMax: pts[iMax].alpha,
      cdMin: pts[iMin].cd, clAtCdMin: pts[iMin].cl,
      ldMax: pts[iLD].cl / pts[iLD].cd, clAtLdMax: pts[iLD].cl, alphaAtLdMax: pts[iLD].alpha,
      alpha0, cm0, slopePerDeg: slope, lowConfidence: low,
    };
  }

  // Cw bei gegebenem Ca auf dem Ast vom kleinsten bis zum grössten Ca (NaN ausserhalb).
  // Schneidet eine leicht wellige Polare das Ca mehrmals, zählt der kleinste Widerstand.
  function cdAtCl(pts, cl) {
    let iMax = 0, iMin = 0;
    pts.forEach((p, i) => { if (p.cl > pts[iMax].cl) iMax = i; if (p.cl < pts[iMin].cl) iMin = i; });
    const [a0, a1] = iMin < iMax ? [iMin, iMax] : [iMax, iMin];
    let best = NaN;
    for (let i = a0 + 1; i <= a1; i++) {
      const a = pts[i - 1], b = pts[i];
      if ((a.cl - cl) * (b.cl - cl) <= 0 && b.cl !== a.cl) {
        const cd = a.cd + (cl - a.cl) / (b.cl - a.cl) * (b.cd - a.cd);
        if (!(cd >= best)) best = cd;
      }
    }
    return best;
  }

  // Hüllkurve einer Klappenschar: für jedes Ca die Klappenstellung mit dem kleinsten Cw
  // polars: [{ flap, points }] → [{ cl, cd, flap }]
  function envelope(polars, clFrom = -0.2, clTo = 1.4, step = 0.02) {
    const out = [];
    for (let cl = clFrom; cl <= clTo + 1e-9; cl += step) {
      let best = null;
      for (const p of polars) {
        const cd = cdAtCl(p.points, cl);
        if (Number.isFinite(cd) && (!best || cd < best.cd)) best = { cl: Math.round(cl * 1000) / 1000, cd, flap: p.flap };
      }
      if (best) out.push(best);
    }
    return out;
  }

  // Re·√Ca aus Flächenbelastung [g/dm²] und Profiltiefe [mm]: V = √(2·m·g/(ρ·S·Ca)), Re = V·l/ν
  function reSqrtCl(wingLoadingGdm2, chordMm, rho = 1.225, nu = 1.5e-5) {
    const ws = wingLoadingGdm2 / 1000 * 100 * 9.81; // N/m²
    return Math.sqrt(2 * ws / rho) * chordMm / 1000 / nu;
  }

  // Kennzahlen für den direkten Vergleich zweier Profile in einem Einsatzbereich Ca von … bis:
  // cdMean = mittlerer Profilwiderstand im Bereich (kleiner ist besser), dazu beste Gleitzahl und Steigzahl Ca^1.5/Cw
  function metrics(pts, clFrom = 0.2, clTo = 0.9, n = 15) {
    let sum = 0, ok = 0;
    for (let i = 0; i < n; i++) {
      const cd = cdAtCl(pts, clFrom + (clTo - clFrom) * i / (n - 1));
      if (Number.isFinite(cd)) { sum += cd; ok++; }
    }
    let ld = -Infinity, clLd = NaN, climb = -Infinity, clClimb = NaN;
    for (const p of pts) {
      if (p.cl <= 0) continue;
      if (p.cl / p.cd > ld) { ld = p.cl / p.cd; clLd = p.cl; }
      const c = Math.pow(p.cl, 1.5) / p.cd;
      if (c > climb) { climb = c; clClimb = p.cl; }
    }
    const s = summary(pts);
    return {
      cdMean: ok === n ? sum / n : NaN, covered: ok / n,
      ldMax: ld, clAtLdMax: clLd, climbMax: climb, clAtClimbMax: clClimb,
      clMax: s.clMax, cm0: s.cm0, alpha0: s.alpha0, lowConfidence: s.lowConfidence,
    };
  }

  const api = { compute, baseDrag, summary, cdAtCl, envelope, range, metrics, reSqrtCl };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).polare = api;
})(typeof self !== 'undefined' ? self : this);
