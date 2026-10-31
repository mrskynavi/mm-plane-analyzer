// Strak-Optimierer: Dicke, Wölbung und deren Rücklagen an den Flügelstationen und den Wölbklappenwinkel
// je Arbeitspunkt gemeinsam suchen, ausgehend von einem vorgegebenen Wurzelprofil.
// Ziel ist der kleinste gewichtete Gesamtwiderstand an den Arbeitspunkten (Speed, Gleiten, Thermik …),
// jeder Arbeitspunkt getrimmt mit dem Schwerpunkt des Modells. Das Wirbelgitter liefert das örtliche Ca,
// NeuralFoil den Profilwiderstand bei der örtlichen Re. Randbedingungen: Mindestdicke, Abrissreserve,
// Cm0-Grenze und ein glatter Strak. Gesucht wird ableitungsfrei mit CMA-ES.
//
// Damit eine Bewertung nur etwa 30 ms braucht, rechnet der Optimierer schneller als die normale Modellrechnung:
// - Das Gleichungssystem des Wirbelgitters hängt nur vom Grundriss ab; Wölbung und Klappen ändern nur die
//   rechte Seite. Die LU-Zerlegung wird einmal gerechnet.
// - Die Profile entstehen wie in profil.modify auf festen x-Stellen. Die Klappe wird als Knick der Skelettlinie
//   eingerechnet (Scherung statt Drehung), dadurch bleiben die x-Stellen fest und die Kulfan-Anpassung von
//   NeuralFoil wird ein einfaches Matrix-Vektor-Produkt.
// - Pro Station und Arbeitspunkt nur wenige NeuralFoil-Punkte um das örtliche Ca, dazwischen eine Parabel.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;
  const PR = isNode ? require('./projekt.js') : root.MMPA.projekt;
  const NF = isNode ? require('./neuralfoil.js') : root.MMPA.neuralfoil;
  const POL = isNode ? require('./polare.js') : root.MMPA.polare;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const F = isNode ? require('./rumpf.js') : root.MMPA.rumpf;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;

  const { RHO, NU, G } = M;
  const X = P.cosspace(100); // wie profil.modify
  const NW = 8;

  // ---------- Profile auf festen x-Stellen ----------

  // Kulfan-Anpassung wie neuralfoil.kulfanFit, aber mit vorab gerechneter Pseudoinverse für die festen x-Stellen.
  // Koordinaten: Oberseite Hinterkante → Nase (100 Punkte), Unterseite ohne Nase (99 Punkte).
  let pinv = null;
  function kulfanMatrix() {
    if (pinv) return pinv;
    const xs = X.slice().reverse().concat(X.slice(1)), le = X.length - 1, N = NW - 1;
    const comb = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
    const K = Array.from({ length: NW }, (_, i) => comb(N, i));
    const rows = xs.map((xv, j) => {
      const C = Math.pow(xv, 0.5) * (1 - xv), S = K.map((k, i) => k * Math.pow(xv, i) * Math.pow(1 - xv, N - i) * C);
      const upper = j <= le, zero = S.map(() => 0);
      return [...(upper ? zero : S), ...(upper ? S : zero), xv * Math.pow(Math.max(1 - xv, 0), NW + 0.5), upper ? xv / 2 : -xv / 2];
    });
    const solveAll = A => {
      const m = A.length, cols = A[0].length, out = Array.from({ length: cols }, () => new Float64Array(m));
      for (let j = 0; j < m; j++) {
        const e = new Array(m).fill(0); e[j] = 1;
        const x = NF.lstsq(A, e);
        for (let i = 0; i < cols; i++) out[i][j] = x[i];
      }
      return out;
    };
    pinv = { full: solveAll(rows), noTe: solveAll(rows.map(r => r.slice(0, -1))) };
    return pinv;
  }
  function kulfan(y) {
    const K = kulfanMatrix();
    const mv = A => A.map(row => { let s = 0; for (let j = 0; j < y.length; j++) s += row[j] * y[j]; return s; });
    let sol = mv(K.full), te = sol[2 * NW + 1], lew = sol[2 * NW];
    if (te < 0) { sol = mv(K.noTe); te = 0; lew = sol[2 * NW]; }
    return { lower: sol.slice(0, NW), upper: sol.slice(NW, 2 * NW), leWeight: lew, teThickness: te };
  }

  const shiftMap = (xOld, xNew) => {
    if (!(xOld > 0 && xOld < 1 && xNew > 0 && xNew < 1) || Math.abs(xOld - xNew) < 1e-6) return x => x;
    const p = Math.log(xOld) / Math.log(xNew);
    return x => Math.pow(x, p);
  };

  // Ausgangsprofil vorbereiten: normierte Koordinaten und Kennwerte wie in profil.modify
  const baseCache = new Map();
  function prepareBase(prof) {
    const key = PR.hash(JSON.stringify(prof.coords));
    if (!baseCache.has(key)) {
      const base = P.normalize(prof.coords).coords;
      baseCache.set(key, { coords: base, stats: P.stats(base), raw: P.stats(P.modify(prof.coords, {})) });
    }
    return baseCache.get(key);
  }

  // Dicke und Skelettlinie auf X für ein Profil mit absoluten Kennwerten q = { thickness, camber, xThickness, xCamber, teGap }
  function shape(B, q) {
    const s = B.stats;
    const tf = q.thickness / B.raw.thickness, cf = B.raw.camber > 1e-4 ? q.camber / B.raw.camber : 1;
    const mt = shiftMap(s.xThickness, q.xThickness ?? s.xThickness), mc = shiftMap(s.xCamber, q.xCamber ?? s.xCamber);
    const t = P.thicknessCamber(B.coords, X.map(mt)).t, c = P.thicknessCamber(B.coords, X.map(mc)).c;
    return { t: P.teGapThickness(t.map(v => v * tf), X, q.teGap), c: c.map(v => v * cf), teGap: q.teGap ?? 0 };
  }

  // Klappe als Knick der Skelettlinie hinter xh, dann so gedreht, dass die Hinterkante auf der Sehne liegt
  // (wie die Normierung in NeuralFoil). Ergibt die Kulfan-Parameter und die Winkel-, Re- und Momentkorrektur.
  function aeroShape(sh, flapDeg = 0, xh = 0.75) {
    const tn = Math.tan(flapDeg * Math.PI / 180);
    const cz = X.map((x, i) => sh.c[i] - (x > xh ? (x - xh) * tn : 0));
    const zte = cz[cz.length - 1];
    const c2 = X.map((x, i) => cz[i] - x * zte);
    const up = X.map((x, i) => c2[i] + sh.t[i] / 2), lo = X.map((x, i) => c2[i] - sh.t[i] / 2);
    const y = up.slice().reverse().concat(lo.slice(1));
    return { k: kulfan(y), da: -Math.atan(zte) * 180 / Math.PI, reK: Math.sqrt(1 + zte * zte), yq: 0.25 * zte, teGap: sh.teGap || 0 };
  }
  const nfAt = (a, alpha, re, nCrit) => {
    const r = NF.fromKulfan(a.k, alpha + a.da, re * a.reK, nCrit);
    r.cm += r.cd * a.yq;
    r.cd += POL.baseDrag(r.cd, a.teGap);
    return r;
  };

  // Örtliche Polare um ein Ca: Anstellwinkel zum Ziel-Ca suchen (Sekante), Punkte bei ±dA dazu, Parabel Cw(Ca).
  // hint = Anstellwinkel vom letzten Mal. Mit clMax: weiter aufwärts bis zum Abriss.
  function localPolar(a, re, clT, spread, nCrit, hint, wantClMax) {
    const pts = [], ev = al => { const r = nfAt(a, al, re, nCrit); const p = { alpha: al, cl: r.cl, cd: r.cd, cm: r.cm }; pts.push(p); return p; };
    let p0 = ev(Number.isFinite(hint) ? hint : clT * 9 - 2), p1 = ev(p0.alpha + 1.5);
    for (let k = 0; k < 4; k++) {
      const s = (p1.cl - p0.cl) / (p1.alpha - p0.alpha);
      // flach oder fallend: Start lag im Abriss oder auf einem Plateau der Polare (mit Klappe häufig), tiefer neu ansetzen
      const al = s > 0.02 ? Math.min(18, Math.max(-12, p1.alpha + (clT - p1.cl) / s)) : Math.max(-12, Math.min(p0.alpha, p1.alpha) - 3);
      p0 = p1; p1 = ev(al);
      if (Math.abs(p1.cl - clT) < 0.01) break;
    }
    const alpha = p1.alpha, ok = Math.abs(p1.cl - clT) < 0.04;
    const dA = Math.min(3, Math.max(1, spread / 2 / 0.1));
    ev(alpha - dA); const top = ev(alpha + dA);
    let clMax = NaN;
    if (wantClMax) {
      // NeuralFoil ist nahe am Abriss leicht wellig: erst aufhören, wenn Ca zweimal hintereinander sinkt
      // oder deutlich unter dem bisher Höchsten liegt
      let best = top.cl, prev = top, al = top.alpha, down = 0;
      for (let k = 0; k < 12 && al < 22; k++) {
        al += 1.5; const p = ev(al);
        down = p.cl < prev.cl ? down + 1 : 0;
        best = Math.max(best, p.cl); prev = p;
        if (down >= 2 || p.cl < best - 0.05) break;
      }
      clMax = Math.max(...pts.map(p => p.cl));
    }
    // Parabel Cw(Ca) durch die Punkte nahe am Ziel (kleinste Quadrate)
    const near = pts.filter(p => Math.abs(p.alpha - alpha) <= dA + 1e-9);
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (const p of near) { const u = p.cl - clT, u2 = u * u; s0++; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2; b0 += p.cd; b1 += p.cd * u; b2 += p.cd * u2; }
    const det3 = (a1, a2, a3, b1_, b2_, b3, c1, c2, c3) => a1 * (b2_ * c3 - b3 * c2) - a2 * (b1_ * c3 - b3 * c1) + a3 * (b1_ * c2 - b2_ * c1);
    const D = det3(s0, s1, s2, s1, s2, s3, s2, s3, s4);
    let q;
    if (Math.abs(D) > 1e-14) q = [det3(b0, s1, s2, b1, s2, s3, b2, s3, s4) / D, det3(s0, b0, s2, s1, b1, s3, s2, b2, s4) / D, det3(s0, s1, b0, s1, s2, b1, s2, s3, b2) / D];
    else q = [b0 / s0, 0, 0];
    const us = near.map(p => p.cl - clT), uLo = Math.min(...us) - 0.1, uHi = Math.max(...us) + 0.1;
    const cdAt = cl => { const u = Math.min(uHi, Math.max(uLo, cl - clT)); return Math.max(1e-4, q[0] + q[1] * u + q[2] * u * u); };
    return { alpha, ok, clMax, cdAt, cd: cdAt(clT), evals: pts.length };
  }

  // Cm0 eines Profils ohne Klappe: zwei Punkte, linear auf Ca = 0
  function cm0Of(a, re, nCrit) {
    const p = nfAt(a, -3, re, nCrit), q = nfAt(a, 0, re, nCrit);
    const f = Math.abs(q.cl - p.cl) > 1e-6 ? -p.cl / (q.cl - p.cl) : 0;
    return p.cm + f * (q.cm - p.cm);
  }

  // ---------- Modell schnell bewerten ----------

  // Grundriss, Gleichungssystem, Neutralpunkt, Schwerpunkt und alles, was sich während der Suche nicht ändert.
  // points: [{ name, cl, weight }]
  function context(model, profiles, { points, nCrit = 9, ny = 30, nx = 8, nyTail = 10, nxTail = 5 } = {}) {
    model = M.resolveTe(model);
    const W = model.wing, T = model.tail;
    const wing = V.planform(W.stations), tail = V.planform(T.stations, T.x);
    const tailGeo = T.stations.map(s => M.stationGeometry(s, profiles));
    const ptl = V.panelize(T.stations, { ny: nyTail, nx: nxTail, x0: T.x, z0: T.z || 0, camber: tailGeo.map(g => g && g.camber), tag: 1 });
    const pw0 = V.panelize(W.stations, { ny, nx, incidence: W.incidence || 0, camber: [], tag: 0 });
    const sys = V.build(pw0.concat(ptl));
    const fus = F.shape(model), cmFus = M.fuselageMoment(model, fus, wing, sys);
    const ref = { sRef: wing.area, cRef: wing.mac, xRef: 0 };
    const run = (panels, alpha, it) => {
      const r = V.solve({ panels, far: sys.far, solve: sys.solve }, alpha, { ...ref, extra: it ? p => (p.surf === 1 ? it : 0) : null });
      r.Cm += cmFus(alpha, r.G);
      return r;
    };
    const all0 = sys.panels;
    const r0 = run(all0, 0, 0), ra = run(all0, 1, 0), ri = run(all0, 0, 1);
    const cA = ra.CL - r0.CL, mA = ra.Cm - r0.Cm, cI = ri.CL - r0.CL, mI = ri.Cm - r0.Cm;
    const xNP = -(mA / cA) * wing.mac;
    const xCG = model.cg.mode === 'sigma' ? xNP - model.cg.sigma * wing.mac : model.cg.x;
    const finA = F.finArea(model, tail.area);
    const P0 = V.stationPoints(W.stations);
    const pts = points.map(p => {
      const v = Math.sqrt(2 * model.mass / 1000 * G / (RHO * wing.area / 1e6 * p.cl));
      const reT = v * tail.mac / 1000 / NU;
      const tp = T.stations.map(q => M.tailPolar(q, profiles, reT, nCrit));
      const finCd0 = re => { const q = T.stations[0] && M.tailPolar(T.stations[0], profiles, re, nCrit); const c = q && M.cdOf(q, 0); return Number.isFinite(c) ? c : null; };
      return { ...p, v, tailSeg: tp.slice(0, -1).map((q, i) => [q, tp[i + 1]]), cdf: F.drag(fus, v, wing.area), cdv: F.finDrag(finA, v, wing.area, finCd0) };
    });
    const crit = points.reduce((b, p, i) => (p.cl > points[b].cl ? i : b), 0);
    return { model, profiles, W, T, wing, tail, ptl, sys, run, cA, mA, cI, mI, xNP, xCG, pts, crit, P0, nCrit, ny, nx, hints: new Map(), trims: new Map() };
  }

  // Ein Entwurf: pro Flügelstation { prof, q } (Ausgangsprofil und absolute Kennwerte), flaps: Winkel je Arbeitspunkt
  function evaluatePoint(ctx, design, k, flap, shapes) {
    const { W, P0, wing } = ctx, st = W.stations, pt = ctx.pts[k];
    const flapOf = i => (i < st.length - 1 && st[i].flapDepth > 0 ? flap * (st[i].flapMix ?? 1) : 0);
    // Wirbelgitter mit Wölbung der Entwürfe und den Klappen dieses Arbeitspunkts
    const stF = st.map((s, i) => ({ ...s, flap: flapOf(i), twist: design[i].q.twist ?? s.twist ?? 0 }));
    const pw = V.panelize(stF, { ny: ctx.ny, nx: ctx.nx, incidence: W.incidence || 0, camber: shapes.map(s => ({ xs: X, zs: s.c })), tag: 0 });
    const panels = pw.concat(ctx.ptl);
    const CL = pt.cl, target = -CL * ctx.xCG / wing.mac, det = ctx.cA * ctx.mI - ctx.cI * ctx.mA;
    let [al, it] = ctx.trims.get(k) || [0, 0], r;
    for (let n = 0; n < 4; n++) {
      r = ctx.run(panels, al, it);
      const dC = CL - r.CL, dM = target - r.Cm;
      if (Math.abs(dC) < 2e-4 && Math.abs(dM) < 2e-5 && n) break;
      al += (dC * ctx.mI - ctx.cI * dM) / det; it += (ctx.cA * dM - dC * ctx.mA) / det;
      if (n === 3) r = ctx.run(panels, al, it);
    }
    ctx.trims.set(k, [al, it]);
    const strips = r.strips.filter(s => s.surf === 0), tStrips = r.strips.filter(s => s.surf === 1);
    // Streifen den Segmenten zuordnen
    const segOf = s => { let i = 1; while (i < P0.length - 1 && s.y > P0[i].le[1]) i++; const y0 = P0[i - 1].le[1], y1 = P0[i].le[1]; return [i - 1, Math.min(1, Math.max(0, (s.y - y0) / (y1 - y0 || 1)))]; };
    const segs = st.slice(0, -1).map(() => []);
    for (const s of strips) { const [i, t] = segOf(s); segs[i].push({ s, t }); }
    // Profilwerte an beiden Enden jedes Segments, gleiche Station und Klappe nur einmal
    const want = k === ctx.crit, ends = new Map(), segEnds = [];
    let evals = 0, ok = true;
    segs.forEach((list, i) => {
      const f = flapOf(i), pair = [];
      for (const e of [0, 1]) {
        const si = i + e, w = list.map(q => (e ? q.t : 1 - q.t)), ws = w.reduce((a, b) => a + b, 0);
        const clT = ws > 0 ? list.reduce((a, q, j) => a + q.s.cl * w[j], 0) / ws : (list[0]?.s.cl ?? CL);
        const cls = list.map(q => q.s.cl), spread = cls.length ? Math.max(...cls) - Math.min(...cls) : 0.1;
        const key = si + '|' + f.toFixed(3) + '|' + clT.toFixed(2);
        let lp = ends.get(key);
        if (!lp) {
          const sk = si + '|' + f.toFixed(3);
          if (!shapes.aero.has(sk)) shapes.aero.set(sk, aeroShape(shapes[si], f, 1 - (st[i].flapDepth || 25) / 100));
          const re = pt.v * st[si].chord / 1000 / NU, hk = k + '|' + si + '|' + e;
          lp = localPolar(shapes.aero.get(sk), re, clT, spread, ctx.nCrit, ctx.hints.get(hk), want);
          ctx.hints.set(hk, lp.alpha); evals += lp.evals; ok = ok && lp.ok;
          ends.set(key, lp);
        }
        pair.push(lp);
      }
      segEnds.push(pair);
    });
    let D = 0, stall = 0;
    const lowRe = F.lowReDrag(ctx.model);
    const used = [], half = wing.projSpan / 2;
    segs.forEach((list, i) => {
      const [a, b] = segEnds[i];
      for (const { s, t } of list) {
        const cd = a.cdAt(s.cl) * (1 - t) + b.cdAt(s.cl) * t;
        D += (lowRe ? lowRe(cd, s.cl, pt.v * s.chord / 1000 / 1.5e-5) : cd) * s.chord * s.width;
        if (want) { const cm = a.clMax * (1 - t) + b.clMax * t; if (cm > 0) { stall = Math.max(stall, s.cl / cm); used.push({ y: s.y, ratio: s.cl / cm, eta: s.y / half }); } }
      }
    });
    // Abrissverhalten: höchste Ausnutzung innen (bis 50 %), in der Mitte (50–75 %) und aussen (ab 75 %)
    const zone = (lo, hi) => used.filter(q => q.eta >= lo && q.eta < hi).reduce((m, q) => Math.max(m, q.ratio), 0);
    const stallZones = want ? { inner: zone(0, 0.5), mid: zone(0.5, 0.75), outer: zone(0.75, 2), at: M.stallLocation(used) } : null;
    const cdw = 2 * D / wing.area;
    const cdt = M.profileDrag(tStrips, ctx.T.stations, pt.tailSeg, wing.area);
    const cdi = V.trefftz(r.strips, wing.area);
    const x = F.withExtras(ctx.model, wing.area, { cdi, cdw, cdt, cdf: pt.cdf, cdv: pt.cdv }, al), cd = x.cd, E = CL / cd;
    return {
      name: pt.name, cl: CL, flap, v: pt.v, alpha: al, ewd: (W.incidence || 0) - it, cd, cdi: x.cdi, cdw: x.cdw, cdt: x.cdt, cdf: x.cdf, cdv: x.cdv, cdx: x.cdx, E, sink: pt.v / E,
      stall: want ? stall : null, stallZones, ok: ok && Number.isFinite(cd), evals,
      strips: strips.map(s => ({ y: s.y, cl: s.cl })), clTail: (r.lift[1] || 0) / (0.5 * ctx.tail.area),
    };
  }

  function prepareShapes(ctx, design) {
    const shapes = design.map(d => shape(prepareBase(d.prof), d.q));
    shapes.aero = new Map();
    return shapes;
  }

  // Ganzer Entwurf: alle Arbeitspunkte, Cm0 und Dicke je Station
  function evaluate(ctx, design, flaps) {
    const shapes = prepareShapes(ctx, design);
    const points = ctx.pts.map((_, k) => evaluatePoint(ctx, design, k, flaps[k], shapes));
    const vRef = ctx.pts[ctx.crit].v;
    const stations = design.map((d, i) => {
      const a0 = shapes.aero.get(i + '|0.000') || aeroShape(shapes[i], 0);
      return { ...d.q, cm0: cm0Of(a0, vRef * ctx.W.stations[i].chord / 1000 / NU, ctx.nCrit), height: d.q.thickness * ctx.W.stations[i].chord };
    });
    return { points, stations };
  }

  // Station des Modells als Entwurf: Ausgangsprofil und absolute Kennwerte wie in der Modellrechnung
  function designOf(st, profiles, prof = null) {
    const sp = M.stationProfile(st, profiles);
    if (!sp) return null;
    const p = prof || sp.profile, B = prepareBase(p);
    if (prof && prof !== sp.profile) {
      // anderes Ausgangsprofil: Dicke und Wölbung der Station übernehmen, Rücklagen vom neuen Profil
      const g = M.stationGeometry(st, profiles).stats;
      return { prof: p, q: { thickness: g.thickness, camber: B.raw.camber > 1e-4 ? g.camber : B.raw.camber, xThickness: B.stats.xThickness, xCamber: B.stats.xCamber, twist: st.twist || 0, teGap: st.teGap ?? null } };
    }
    const mod = sp.mod;
    return { prof: p, q: { thickness: (mod.thickness ?? 1) * B.raw.thickness, camber: (mod.camber ?? 1) * B.raw.camber, xThickness: mod.xThickness ?? B.stats.xThickness, xCamber: mod.xCamber ?? B.stats.xCamber, twist: st.twist || 0, teGap: st.teGap ?? null } };
  }

  // Bester Klappenwinkel für einen Arbeitspunkt (Goldener Schnitt), mit Strafe für zu wenig Abrissreserve
  function bestFlap(ctx, design, k, lo, hi, stallLimit = 0.9, shapes = null) {
    shapes = shapes || prepareShapes(ctx, design);
    const f = d => { const r = evaluatePoint(ctx, design, k, d, shapes); return { r, j: (r.ok ? r.cd : 1) + (r.stall ? 0.02 * Math.max(0, r.stall - stallLimit) ** 2 * 100 : 0) }; };
    const g = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
    while (b - a > 0.2) {
      if (fc.j < fd.j) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
    }
    const best = fc.j < fd.j ? c : d;
    return Math.round(best * 4) / 4;
  }

  // ---------- CMA-ES ----------
  function rng(seed) {
    let s = seed >>> 0;
    const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    u.normal = () => {
      if (spare != null) { const v = spare; spare = null; return v; }
      let a = 0, b = 0; while (a === 0) a = u(); b = u();
      const r = Math.sqrt(-2 * Math.log(a)); spare = r * Math.sin(2 * Math.PI * b); return r * Math.cos(2 * Math.PI * b);
    };
    return u;
  }
  // Eigenwerte und -vektoren einer symmetrischen Matrix (Jacobi)
  function eigen(A) {
    const n = A.length, a = A.map(r => r.slice()), v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    return { values: a.map((r, i) => r[i]), vectors: v };
  }
  function cmaes(x0, sigma0, seed = 1) {
    const n = x0.length, rand = rng(seed);
    const lambda = 4 + Math.floor(3 * Math.log(n)), mu = Math.floor(lambda / 2);
    let w = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
    const ws = w.reduce((a, b) => a + b, 0); w = w.map(x => x / ws);
    const mueff = 1 / w.reduce((a, b) => a + b * b, 0);
    const cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n), cs = (mueff + 2) / (n + mueff + 5);
    const c1 = 2 / ((n + 1.3) ** 2 + mueff), cmu = Math.min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff));
    const damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs, chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    let m = x0.slice(), sigma = sigma0, gen = 0;
    let C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    let B = C.map(r => r.slice()), D = new Array(n).fill(1), pc = new Array(n).fill(0), ps = new Array(n).fill(0);
    const ask = () => Array.from({ length: lambda }, () => {
      const z = Array.from({ length: n }, () => rand.normal()), y = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) y[i] += B[i][j] * D[j] * z[j];
      return m.map((v, i) => v + sigma * y[i]);
    });
    const tell = (xs, fs) => {
      gen++;
      const idx = fs.map((f, i) => i).sort((a, b) => fs[a] - fs[b]).slice(0, mu);
      const old = m;
      m = new Array(n).fill(0);
      idx.forEach((k, i) => { for (let j = 0; j < n; j++) m[j] += w[i] * xs[k][j]; });
      const yw = m.map((v, j) => (v - old[j]) / sigma);
      // C^-1/2 · yw
      const t = new Array(n).fill(0), cy = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t[i] += B[j][i] * yw[j];
      for (let i = 0; i < n; i++) t[i] /= D[i];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cy[i] += B[i][j] * t[j];
      const k1 = Math.sqrt(cs * (2 - cs) * mueff);
      for (let i = 0; i < n; i++) ps[i] = (1 - cs) * ps[i] + k1 * cy[i];
      const psn = Math.hypot(...ps);
      const hsig = psn / Math.sqrt(1 - (1 - cs) ** (2 * gen)) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
      const k2 = Math.sqrt(cc * (2 - cc) * mueff);
      for (let i = 0; i < n; i++) pc[i] = (1 - cc) * pc[i] + hsig * k2 * yw[i];
      const ys = idx.map(k => xs[k].map((v, j) => (v - old[j]) / sigma));
      for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
        let r = 0; ys.forEach((y, q) => { r += w[q] * y[i] * y[j]; });
        const v = (1 - c1 - cmu) * C[i][j] + c1 * (pc[i] * pc[j] + (1 - hsig) * cc * (2 - cc) * C[i][j]) + cmu * r;
        C[i][j] = v; C[j][i] = v;
      }
      sigma *= Math.exp(cs / damps * (psn / chiN - 1));
      const e = eigen(C);
      B = e.vectors; D = e.values.map(v => Math.sqrt(Math.max(v, 1e-20)));
    };
    return { ask, tell, get mean() { return m; }, get sigma() { return sigma; }, get gen() { return gen; }, lambda, n };
  }

  // ---------- Optimierer ----------

  const WORSE_MARGIN = 0.002;
  const DEFAULTS = {
    points: [{ name: 'Speed', cl: 0.15, weight: 1 }, { name: 'Gleiten', cl: 0.45, weight: 2 }, { name: 'Thermik', cl: 0.8, weight: 1 }],
    vars: { thickness: true, camber: true, xThickness: true, xCamber: true, twist: true, flap: true },
    flapMin: -5, flapMax: 10, minThick: 0.07, minHeight: 0, stallMargin: 0.1, stallMode: 'gutmuetig', twistMin: -5, twistMax: 2, cm0Min: null, smooth: 0.002, maxEvals: 1500, seed: 1, start: 'modell', noWorse: true,
  };

  // settings: { rootId, points: [{ name, cl, weight, flap (Zahl = fest, null = optimieren) }], vars, flapMin, flapMax,
  //   minThick (Bruchteil), minHeight (mm, 0 = aus), stallMargin, stallMode ('aus' | 'neutral' | 'gutmuetig'),
  //   twistMin/twistMax (Schränkung in Grad), cm0Min (null = Cm0 der Wurzel), smooth, maxEvals, nCrit,
//   start ('modell' = Stationen wie im Modell | 'wurzel' = Wölbung und Rücklagen der Wurzel nach aussen übernehmen),
//   noWorse (true = kein Flugzustand darf schlechter werden) }
  // Gibt einen schrittweisen Optimierer zurück: step() rechnet eine Generation, result() das Ergebnis.
  function optimizer(model, profiles, settings = {}) {
    model = M.resolveTe(model);
    const S = { ...DEFAULTS, ...settings, vars: { ...DEFAULTS.vars, ...(settings.vars || {}) } };
    const W = model.wing, st = W.stations, n = st.length;
    const rootProf = profiles.find(p => p.id === (S.rootId || st[0].profileId));
    if (!rootProf) throw new Error('Kein Wurzelprofil gewählt');
    if (st.some(s => !M.stationProfile(s, profiles))) throw new Error('Jede Flügelstation braucht ein Profil');
    const hasFlap = st.slice(0, -1).some(s => s.flapDepth > 0 && (s.flapMix ?? 1) !== 0);
    const ctx = context(model, profiles, { points: S.points, nCrit: S.nCrit ?? 9 });
    const B = prepareBase(rootProf);
    const stallLimit = 1 - S.stallMargin;

    // Vorher: Profile wie im Modell, Klappen je Arbeitspunkt bestmöglich (sonst wäre der Vergleich unfair)
    const before = st.map(s => designOf(s, profiles));
    const fixedFlap = k => (!hasFlap ? 0 : S.points[k].flap != null && Number.isFinite(+S.points[k].flap) ? +S.points[k].flap : null);
    const flapFree = k => S.vars.flap && fixedFlap(k) == null;
    const shB = prepareShapes(ctx, before);
    const flapsBefore = S.points.map((p, k) => (fixedFlap(k) != null ? fixedFlap(k) : (S.vars.flap ? bestFlap(ctx, before, k, S.flapMin, S.flapMax, stallLimit, shB) : 0)));
    const evBefore = evaluate(ctx, before, flapsBefore);
    const cdRef = evBefore.points.map(p => (p.ok ? p.cd : NaN));

    // Wurzel bleibt, wie sie im Modell steht (oder das gewählte Profil unverändert)
    const rootDesign = st[0].profileId === rootProf.id ? designOf(st[0], profiles) : designOf({ ...st[0], profileId: rootProf.id, thickness: null, camber: null, xThickness: null, xCamber: null }, profiles);
    const r = rootDesign.q, symmetric = B.raw.camber < 2e-3;
    const cm0Root = evaluate(ctx, [rootDesign].concat(st.slice(1).map(s => designOf(s, profiles, rootProf))), flapsBefore).stations[0].cm0;
    const cm0Min = S.cm0Min != null && Number.isFinite(+S.cm0Min) ? +S.cm0Min : Math.floor((cm0Root - 0.005) * 200) / 200;

    // Stellgrössen mit Grenzen, alle auf 0 … 1 abgebildet
    const vars = [];
    const add = (kind, i, lo, hi, x0) => { if (hi - lo < 1e-6) return; vars.push({ kind, i, lo, hi, x0: Math.min(hi, Math.max(lo, x0)) }); };
    // Startwerte: wie im Modell oder von der Wurzel aus (Wölbung, Rücklagen und Endleiste der Wurzel, Dicke und Schränkung der Station)
    const start = st.map((s, i) => {
      if (!i) return r;
      const q = designOf(s, profiles, rootProf).q;
      return S.start === 'wurzel' ? { ...q, camber: r.camber, xThickness: r.xThickness, xCamber: r.xCamber } : q;
    });
    for (let i = 1; i < n; i++) {
      const c = st[i].chord, s0 = start[i];
      const tLo = Math.max(S.minThick, S.minHeight > 0 ? S.minHeight / c : 0, 0.5 * r.thickness), tHi = Math.max(tLo, Math.min(0.2, 1.3 * r.thickness));
      if (S.vars.thickness) add('thickness', i, tLo, tHi, s0.thickness); else start[i].thickness = Math.min(tHi, Math.max(tLo, s0.thickness));
      if (S.vars.camber && !symmetric) add('camber', i, Math.max(0, 0.3 * r.camber), 1.6 * r.camber + 0.003, s0.camber);
      if (S.vars.xThickness) add('xThickness', i, Math.max(0.15, r.xThickness - 0.1), Math.min(0.5, r.xThickness + 0.1), s0.xThickness);
      if (S.vars.xCamber && !symmetric) add('xCamber', i, Math.max(0.15, r.xCamber - 0.15), Math.min(0.65, r.xCamber + 0.15), s0.xCamber);
      if (S.vars.twist) add('twist', i, Math.min(S.twistMin, s0.twist), Math.max(S.twistMax, s0.twist), s0.twist);
    }
    S.points.forEach((p, k) => { if (flapFree(k) && hasFlap) add('flap', k, S.flapMin, S.flapMax, flapsBefore[k]); });
    const decode = u => {
      const q = start.map(s => ({ ...s })), flaps = S.points.map((p, k) => (fixedFlap(k) != null ? fixedFlap(k) : flapsBefore[k]));
      vars.forEach((v, j) => { const x = v.lo + Math.min(1, Math.max(0, u[j])) * (v.hi - v.lo); if (v.kind === 'flap') flaps[v.i] = x; else q[v.i][v.kind] = x; });
      return { design: q.map((qq, i) => ({ prof: rootProf, q: qq })).map((d, i) => (i ? d : rootDesign)), flaps };
    };

    // glatter Strak: Knick der Verläufe über der Spannweite bestrafen
    const eta = st.map(s => s.y / st[n - 1].y);
    const SCALE = { thickness: 0.01, camber: 0.005, xThickness: 0.05, xCamber: 0.05, twist: 0.5 };
    const roughness = design => {
      let s = 0;
      for (const kind of Object.keys(SCALE)) for (let i = 1; i < n - 1; i++) {
        const h1 = eta[i] - eta[i - 1], h2 = eta[i + 1] - eta[i];
        // Knick der Steigung mal halber Stationsabstand: die Knickhöhe. So zählen eng liegende Stationen
        // (z. B. am Randbogen) nicht mehr als weit auseinander liegende.
        const d = (design[i + 1].q[kind] - design[i].q[kind]) / h2 - (design[i].q[kind] - design[i - 1].q[kind]) / h1;
        s += (d * (h1 + h2) / 2 / SCALE[kind]) ** 2;
      }
      return s;
    };
    const wsum = S.points.reduce((a, p) => a + (+p.weight || 0), 0) || 1;
    const score = ev => {
      let j = 0;
      ev.points.forEach((p, k) => { j += (+S.points[k].weight || 0) / wsum * (p.ok && Number.isFinite(cdRef[k]) ? p.cd / cdRef[k] : 3); });
      return j;
    };
    const penalties = (ev, design) => {
      const crit = ev.points[ctx.crit];
      const pStall = crit.stall != null ? 200 * Math.max(0, crit.stall - stallLimit) ** 2 : 0;
      // Abrissverhalten beim langsamsten Zustand: gutmütig = Abriss beginnt innen, Mitte darunter und aussen
      // mindestens 4 Punkte Reserve gegenüber innen; neutral = aussen nicht am höchsten
      const z = crit.stallZones;
      const exc = !z || S.stallMode === 'aus' ? 0 : S.stallMode === 'neutral' ? Math.max(0, z.outer - Math.max(z.inner, z.mid) + 0.01)
        : Math.max(0, z.mid - z.inner + 0.01, z.outer - z.inner + 0.04);
      const pShape = 400 * exc * exc;
      const pCm = ev.stations.slice(1).reduce((a, s) => a + 2000 * Math.max(0, cm0Min - s.cm0) ** 2, 0);
      const pSmooth = S.smooth * roughness(design);
      return { stall: pStall, shape: pShape, cm0: pCm, smooth: pSmooth, sum: pStall + pShape + pCm + pSmooth };
    };
    const fitness = u => {
      const { design, flaps } = decode(u);
      const ev = evaluate(ctx, design, flaps), pen = penalties(ev, design);
      const out = u.reduce((a, x) => a + (x < 0 ? x * x : x > 1 ? (x - 1) ** 2 : 0), 0);
      return { f: score(ev) + pen.sum + out, ev, design, flaps, pen };
    };

    const u0 = vars.map(v => (v.x0 - v.lo) / (v.hi - v.lo));
    const es = vars.length ? cmaes(u0, 0.12, S.seed) : null;
    const first = fitness(u0);
    // best: bester Wert insgesamt; bestOk: bester, bei dem kein Arbeitspunkt schlechter ist als vorher. Das läuft neben der Suche her
    // und lenkt sie nicht; die kleine Reserve deckt die Abweichung der schnellen Bewertung gegenüber der vollen Rechnung.
    const isOk = q => q.ev.points.every((p, k) => !Number.isFinite(cdRef[k]) || (p.ok && p.cd <= cdRef[k] * (1 - WORSE_MARGIN)));
    let best = first, bestOk = isOk(first) ? first : null, evals = 0, stale = 0, done = !vars.length;
    const history = [first.f];
    const t0 = Date.now();
    function step() {
      if (done) return progress();
      const xs = es.ask(), res = xs.map(fitness);
      evals += xs.length;
      es.tell(xs, res.map(q => q.f));
      const gb = res.reduce((a, b) => (b.f < a.f ? b : a));
      if (gb.f < best.f - 1e-6) { best = gb; stale = 0; } else stale++;
      for (const q of res) if ((!bestOk || q.f < bestOk.f) && isOk(q)) bestOk = q;
      history.push(best.f);
      if (evals >= S.maxEvals || es.sigma < 2e-3 || stale > 40) done = true;
      return progress();
    }
    const progress = () => ({ evals, maxEvals: S.maxEvals, gen: es ? es.gen : 0, best: best.f, start: first.f, gain: 1 - best.f / first.f, done, seconds: (Date.now() - t0) / 1000 });
    function result() {
      // Vorher mit denselben Strafen bewerten, damit die Zahlen vergleichbar sind
      const penB = penalties(evBefore, before);
      // nie schlechter als der Ausgangszustand: findet die Suche nichts Besseres, bleibt das Modell, wie es ist
      // lieber eine Lösung ohne schlechteren Arbeitspunkt, solange das Abrissverhalten gleich gut bleibt
      const stallPen = q => q.pen.stall + q.pen.shape;
      const pick = S.noWorse && bestOk && stallPen(bestOk) <= stallPen(best) + 0.01 ? bestOk : best;
      // bessere Lösung verworfen, weil ein Flugzustand schlechter würde: für den Hinweis im Ergebnis
      const tradeOf = q => q.ev.points.map((p, k) => ({ name: p.name, change: p.ok && Number.isFinite(cdRef[k]) ? p.cd / cdRef[k] - 1 : null }));
      const traded = pick !== best && best.f < pick.f - 1e-4 && best.f < score(evBefore) + penB.sum - 1e-4
        ? { gain: 1 - score(best.ev) / score(evBefore), points: tradeOf(best) } : null;
      // nie schlechter als der Ausgangszustand: findet die Suche nichts Besseres, bleibt das Modell, wie es ist
      // unter 0,01 % gilt als Rauschen der schnellen Bewertung (Startwinkel der Ca-Suche hängen von der Reihenfolge ab)
      const kept = pick.f >= score(evBefore) + penB.sum - 1e-4;
      const after = kept ? { ev: evBefore, design: before, flaps: flapsBefore, pen: penB } : pick;
      const pack = (ev, design, flaps, pen) => ({
        points: ev.points.map(p => ({ name: p.name, cl: p.cl, flap: p.flap, v: p.v, alpha: p.alpha, ewd: p.ewd, E: p.E, sink: p.sink, cd: p.cd, cdw: p.cdw, cdi: p.cdi, cdt: p.cdt, stall: p.stall, stallAt: p.stallZones ? p.stallZones.at : null, ok: p.ok, clTail: p.clTail })),
        stations: design.map((d, i) => ({ y: st[i].y, chord: st[i].chord, profile: d.prof.name, profileId: d.prof.id, ...d.q, cm0: ev.stations[i].cm0, height: ev.stations[i].height })),
        flaps, score: score(ev), penalties: pen,
      });
      return {
        before: pack(evBefore, before, flapsBefore, penB),
        after: pack(after.ev, after.design, after.flaps, after.pen),
        gain: 1 - score(after.ev) / score(evBefore), kept, traded, start: S.start, noWorse: S.noWorse, evals, seconds: (Date.now() - t0) / 1000, history,
        limits: { cm0Min, stallLimit, stallMode: S.stallMode, minThick: S.minThick, minHeight: S.minHeight }, rootId: rootProf.id, rootName: rootProf.name,
        xCG: ctx.xCG, xNP: ctx.xNP, vars: vars.map(v => v.kind),
      };
    }
    return { step, result, progress, get done() { return done; }, dims: vars.length, ctx };
  }

  // Ergebnis ins Modell übernehmen (Kopie): Stationen bekommen das Wurzelprofil mit den neuen Kennwerten,
  // die Klappenwinkel kommen als Flugzustände ins Modell.
  function apply(model, res) {
    const m = JSON.parse(JSON.stringify(model));
    if (res.kept) return m;
    res.after.stations.forEach((s, i) => {
      const t = m.wing.stations[i];
      if (i === 0 && t.profileId === res.rootId) return;
      Object.assign(t, { profileId: res.rootId, thickness: round(s.thickness, 5), camber: round(s.camber, 5), xThickness: round(s.xThickness, 4), xCamber: round(s.xCamber, 4) });
      if (i && s.twist != null) t.twist = round(s.twist, 2);
      if (i === 0) Object.assign(t, { thickness: null, camber: null, xThickness: null, xCamber: null });
    });
    const old = (m.flaps && m.flaps.modes) || [];
    m.flaps = { ...(m.flaps || {}), modes: res.after.points.map((p, k) => ({ ...(old[k] || {}), name: p.name, cl: p.cl, flap: round(p.flap, 2) })) };
    return m;
  }
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

  // Flugzustände des Modells mit den aktuellen Profilen schnell bewerten; best = Klappe je Zustand suchen
  function flightModes(model, profiles, modes, { nCrit = 9, best = false, flapMin = -5, flapMax = 10 } = {}) {
    model = M.resolveTe(model);
    const ctx = context(model, profiles, { points: modes.map(q => ({ name: q.name, cl: q.cl, weight: 1 })), nCrit });
    const design = model.wing.stations.map(s => designOf(s, profiles));
    if (design.some(d => !d)) throw new Error('Jede Flügelstation braucht ein Profil');
    const shapes = prepareShapes(ctx, design);
    return modes.map((q, k) => {
      ctx.crit = k; // Abrissreserve an jedem Zustand prüfen
      const flap = best && !q.fixed ? bestFlap(ctx, design, k, flapMin, flapMax, 0.9, shapes) : (+q.flap || 0);
      return { ...evaluatePoint(ctx, design, k, flap, shapes), xCG: ctx.xCG };
    });
  }

  // Klappenschar mit der normalen Modellrechnung: Gesamtpolare je Klappenstellung und die Hüllkurve
  // (für jedes Ca die Stellung mit der besten Gleitzahl). Rechnet eine Stellung pro Aufruf von next().
  function flapSeries(model, profiles, deltas, opts = {}) {
    const res = [];
    let i = 0;
    const next = () => {
      if (i >= deltas.length) return true;
      const d = deltas[i++], r = M.analyze(M.withFlap(model, d), profiles, opts);
      res.push({ flap: d, r });
      return i >= deltas.length;
    };
    const envelope = ({ monotone = false } = {}) => {
      const map = new Map();
      for (const { flap, r } of res) for (const t of r.table) {
        if (t.stall || !Number.isFinite(t.E)) continue;
        const k = t.cl.toFixed(2), o = map.get(k);
        if (!o || t.E > o.E) map.set(k, { ...t, flap });
      }
      const best = [...map.values()].sort((a, b) => a.cl - b.cl);
      if (!monotone) return best;
      // Klappenplan für einen Mischer: Klappe steigt mit Ca nie ab. Unter dieser Bedingung die Summe von E/E_best
      // maximal (dynamische Programmierung), so verschwinden die Sprünge, wo sich die Klappen kaum unterscheiden.
      const flaps = res.map(q => q.flap).sort((a, b) => a - b);
      const rows = best.map(b => flaps.map(f => {
        const q = res.find(x => x.flap === f), t = q.r.table.find(x => x.cl.toFixed(2) === b.cl.toFixed(2));
        return t && !t.stall && Number.isFinite(t.E) ? { ...t, flap: f, s: t.E / b.E } : null;
      }));
      const score = [], from = [];
      rows.forEach((row, k) => {
        score[k] = []; from[k] = [];
        let run = k ? -Infinity : 0, arg = -1;
        row.forEach((c, j) => {
          if (k && score[k - 1][j] > run) { run = score[k - 1][j]; arg = j; }
          score[k][j] = c && run > -Infinity ? run + c.s : -Infinity; from[k][j] = arg;
        });
      });
      const last = rows.length - 1;
      if (last < 0) return best;
      let j = score[last].indexOf(Math.max(...score[last]));
      if (!(score[last][j] > -Infinity)) return best;
      const out = [];
      for (let k = last; k >= 0; k--) { out.unshift(rows[k][j]); j = from[k][j]; }
      return out;
    };
    return { next, results: res, envelope, get done() { return i >= deltas.length; } };
  }

  // Kreisflug in der Thermik: je Radius die Klappe, das Ca und die Querneigung mit dem geringsten Sinken.
  // Im Kreis mit Radius R und Querneigung φ gilt n = 1/cos φ, Fahrt V = V1·√n (V1 = Geradeausfahrt beim gleichen Ca)
  // und R = V1²/(g·sin φ), also sin φ = V1²/(g·R). Sinken = Sinken geradeaus · n^1,5.
  // Der Innenflügel ist langsamer, an der Stelle y um den Faktor 1 − y·cos φ/R; damit er gleich viel trägt wie
  // geradeaus (sonst rollt das Modell ein, man hält mit dem Querruder dagegen), steigt sein Ca um 1/(1 − y·cos φ/R)².
  // Diese Ausnutzung muss margin unter Ca max bleiben. Das Leitwerk dreht mit Ω·sin φ und sieht l_H·sin φ/R mehr
  // Anstellwinkel, die EWD steigt um so viel (mehr Höhe als geradeaus).
  // res: Ergebnisse der Klappenschar [{ flap, r }]. Zurück je Radius das Beste und das Beste je Klappe.
  function circling(res, radii, { margin = 0.1, steps = 5 } = {}) {
    const G = M.G, lerp = (a, b, t) => a + (b - a) * t;
    // Ca-Raster der Arbeitstabelle fein unterteilen (5 Zwischenwerte je 0,05)
    const fine = r => {
      const ok = r.table.filter(t => !t.stall && Number.isFinite(t.sink) && t.use && t.use.length), out = [];
      ok.forEach((a, i) => {
        const b = ok[i + 1];
        if (!b || b.use.length !== a.use.length || Math.abs(b.cl - a.cl) > 0.051) { out.push(a); return; }
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          out.push({ cl: lerp(a.cl, b.cl, t), v: lerp(a.v, b.v, t), sink: lerp(a.sink, b.sink, t), ewdCur: lerp(a.ewdCur, b.ewdCur, t), use: a.use.map((u, j) => [u[0], lerp(u[1], b.use[j][1], t)]) });
        }
      });
      return out;
    };
    const flaps = res.map(({ flap, r }) => ({ flap, rows: fine(r), half: r.wing.projSpan / 2000, lt: (r.tail.xMac + r.tail.mac / 4 - r.xCG) / 1000 }));
    return radii.map(R => {
      const byFlap = flaps.map(({ flap, rows, half, lt }) => {
        let best = null, limit = null;
        for (const t of rows) {
          const s = t.v * t.v / (G * R);
          if (!(s < 1)) continue;
          const phi = Math.asin(s), c = Math.cos(phi), n = 1 / c;
          let inner = 0;
          for (const [eta, q] of t.use) { const f = 1 - eta * half * c / R; inner = Math.max(inner, f > 0.05 ? q / (f * f) : Infinity); }
          if (inner > 1 - margin) { limit = limit || 'abriss'; continue; }
          const sink = t.sink * n ** 1.5;
          if (!best || sink < best.sink) best = { R, flap, cl: t.cl, bank: phi * 180 / Math.PI, n, v: t.v * Math.sqrt(n), sink, inner, ewd: t.ewdCur + lt * s / R * 180 / Math.PI };
        }
        return best || { R, flap, none: limit || 'zu schnell' };
      });
      const ok = byFlap.filter(q => !q.none);
      return { R, best: ok.reduce((m, q) => (!m || q.sink < m.sink ? q : m), null), byFlap };
    });
  }

  // Koordinaten eines Entwurfs (für die Konturen), wie profil.modify
  function coordsOf(d) {
    const B = prepareBase(d.prof);
    return P.modify(d.prof.coords, { thickness: d.q.thickness / B.raw.thickness, camber: B.raw.camber > 1e-4 ? d.q.camber / B.raw.camber : 1, xThickness: d.q.xThickness, xCamber: d.q.xCamber, teGap: d.q.teGap ?? null });
  }

  const api = { coordsOf, optimizer, apply, evaluate, context, designOf, bestFlap, flightModes, flapSeries, circling, shape, aeroShape, prepareBase, kulfan, localPolar, cmaes, eigen, rng, DEFAULTS, X };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).strak = api;
})(typeof self !== 'undefined' ? self : this);
