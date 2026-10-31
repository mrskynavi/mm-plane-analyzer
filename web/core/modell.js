// Modellrechnung: Flügel und Höhenleitwerk mit dem Wirbelgitter (vlm.js) rechnen und daraus
// Neutralpunkt, Schwerpunkt, Stabilitätsmass, Trimm und EWD bestimmen, wie in XFLR5.
// Dazu die Handrechnung aus Christophs Excel-Blatt als Gegenprobe und die Profilpolaren der Stationen
// für das örtliche Ca max. Längen in mm, Masse in g, Winkel in Grad.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;
  const PR = isNode ? require('./projekt.js') : root.MMPA.projekt;
  const POL = isNode ? require('./polare.js') : root.MMPA.polare;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const F = isNode ? require('./rumpf.js') : root.MMPA.rumpf;

  const RHO = 1.225, NU = 1.5e-5, G = 9.81;
  const XS = P.cosspace(60);

  // Endleiste: gebaut wird sie nie messerscharf. Dicke in mm für das ganze Modell (model.drag.te, Standard 0,7 mm),
  // je Station überschreibbar (station.te). Weil die Dicke in mm gilt, ist sie bei kleiner Tiefe relativ grösser.
  const TE_MM = 0.7;
  const teMm = (model, st) => {
    const v = st.te ?? (model.drag && model.drag.te) ?? TE_MM;
    return Number.isFinite(+v) ? Math.max(0, +v) : TE_MM;
  };
  // Kopie des Modells, in der jede Station ihre Endleistendicke als Bruchteil der Tiefe trägt (teGap)
  function resolveTe(model) {
    const res = list => list.map(s => ({ ...s, teGap: s.chord > 0 ? teMm(model, s) / s.chord : 0 }));
    return { ...model, wing: { ...model.wing, stations: res(model.wing.stations) }, tail: { ...model.tail, stations: res(model.tail.stations) } };
  }
  // Dasselbe Modell mit einer Endleistendicke für alle Stationen (0 = scharf, zum Vergleich)
  function withTe(model, mm) {
    const m = JSON.parse(JSON.stringify(model));
    m.drag = { ...(m.drag || {}), te: mm };
    for (const s of m.wing.stations.concat(m.tail.stations)) delete s.te;
    return m;
  }

  // Profil einer Station mit eigener Dicke und Wölbung (absolut, Bruchteil der Tiefe)
  function stationProfile(st, profiles) {
    const p = st.profileId && profiles.find(q => q.id === st.profileId);
    if (!p) return null;
    const raw = P.stats(P.modify(p.coords, {}));
    const mod = { ...p.mod };
    if (st.thickness != null && raw.thickness > 0) mod.thickness = st.thickness / raw.thickness;
    if (st.camber != null && raw.camber > 1e-4) mod.camber = st.camber / raw.camber;
    // Rücklagen absolut (Bruchteil der Tiefe), null = wie das Profil
    if (st.xThickness != null) mod.xThickness = st.xThickness;
    if (st.xCamber != null) mod.xCamber = st.xCamber;
    // Endleistendicke (Bruchteil der Tiefe), null = wie das Profil
    if (st.teGap != null) mod.teGap = st.teGap;
    return { profile: p, mod, coords: p.coords };
  }
  const cache = new Map();
  const cached = (key, fn) => { if (!cache.has(key)) { if (cache.size > 400) cache.delete(cache.keys().next().value); cache.set(key, fn()); } return cache.get(key); };

  function stationGeometry(st, profiles) {
    const sp = stationProfile(st, profiles);
    if (!sp) return null;
    return cached('g' + PR.hash(JSON.stringify([sp.coords, sp.mod])), () => {
      const geo = PR.geometry({ coords: sp.coords, mod: sp.mod });
      const { c } = P.thicknessCamber(geo, XS);
      return { geo, camber: { xs: XS, zs: c }, stats: P.stats(geo), name: sp.profile.name, teGap: sp.mod.teGap ?? 0 };
    });
  }

  // Polare einer Station (Typ 2 aus Flächenbelastung und örtlicher Tiefe) für Ca max, α0 und Cm0.
  // flap: Ausschlag der Klappe des angrenzenden Segments in Grad, flapDepth in % der Tiefe.
  function stationPolar(st, profiles, wingLoading, nCrit = 9, flap = 0, flapDepth = 25) {
    const g = stationGeometry(st, profiles);
    if (!g) return null;
    const re = Math.round(POL.reSqrtCl(wingLoading, st.chord) / 100) * 100;
    flap = Math.round((flap || 0) * 100) / 100;
    return cached('p' + PR.hash(JSON.stringify([g.camber.zs.slice(0, 8), g.stats, g.teGap, re, nCrit, flap, flap ? flapDepth : 0])), () => {
      const geo = flap ? P.flap(g.geo, flap, 1 - flapDepth / 100) : g.geo;
      const r = POL.compute(geo, { type: 2, re, alphaFrom: -6, alphaTo: 16, alphaStep: 1, nCrit, teGap: g.teGap });
      return { re, flap, ...r.summary, pts: r.points };
    });
  }

  // Klappe eines Segments (gilt von Station i bis i+1)
  const segFlap = s => (s.flapDepth > 0 && s.flap ? s.flap : 0);
  // Polaren an beiden Enden jedes Segments, mit der Klappe dieses Segments: [[innen, aussen], …]
  const segmentPolars = (stations, profiles, ws, nCrit) => stations.slice(0, -1).map((s, i) =>
    [s, stations[i + 1]].map(q => stationPolar(q, profiles, ws, nCrit, segFlap(s), s.flapDepth || 25)));

  // Modell mit einer Wölbklappenstellung: jede Flügelklappe bekommt δ mal ihren Wölbanteil (flapMix, Standard 1)
  function withFlap(model, delta) {
    const m = JSON.parse(JSON.stringify(model));
    m.wing.stations.forEach((s, i) => {
      if (i < m.wing.stations.length - 1 && s.flapDepth > 0) s.flap = Math.round(delta * (s.flapMix ?? 1) * 100) / 100;
    });
    return m;
  }

  // Polare einer Leitwerksstation bei fester Re (die Leitwerks-Ca folgt nicht der Flügel-Ca)
  function tailPolar(st, profiles, re, nCrit = 9) {
    const g = stationGeometry(st, profiles);
    if (!g) return null;
    re = Math.max(20000, Math.round(re / 5000) * 5000);
    return cached('t' + PR.hash(JSON.stringify([g.camber.zs.slice(0, 8), g.stats, g.teGap, re, nCrit])), () => {
      const r = POL.compute(g.geo, { type: 1, re, alphaFrom: -8, alphaTo: 8, alphaStep: 1, nCrit, teGap: g.teGap });
      return { re, ...r.summary, pts: r.points };
    });
  }

  // Cw bei Ca auf der Polare; unter dem kleinsten Ca der Wert dort, über Ca max NaN (Abriss)
  const cdOf = (pol, cl) => {
    if (!pol) return NaN;
    const cd = POL.cdAtCl(pol.pts, cl);
    if (Number.isFinite(cd)) return cd;
    const lo = pol.pts.reduce((m, p) => (p.cl < m.cl ? p : m));
    return cl < lo.cl ? lo.cd : NaN;
  };

  // Profilwiderstand einer Fläche aus den Streifen: Cw zwischen den Stationen linear verteilt.
  // seg[i] = [Polare innen, Polare aussen] des Segments i (mit dessen Klappe)
  function profileDrag(strips, stations, seg, sRef) {
    const P0 = V.stationPoints(stations);
    let D = 0;
    for (const s of strips) {
      let i = 1;
      while (i < P0.length - 1 && s.y > P0[i].le[1]) i++;
      const y0 = P0[i - 1].le[1], y1 = P0[i].le[1], t = Math.min(1, Math.max(0, (s.y - y0) / (y1 - y0 || 1)));
      const cd = cdOf(seg[i - 1][0], s.cl) * (1 - t) + cdOf(seg[i - 1][1], s.cl) * t;
      D += cd * s.chord * s.width;
    }
    return 2 * D / sRef;
  }

  // Handrechnung wie im Excel-Blatt (Blatt „Masse, SP“): aF = Λ/(√(Λ²+4)+2), Neutralpunkt hinter dem Flügel-NP
  // xN/lμ = aF·aH·SH/S·rH/lμ / (1 + aF·aH·SH/S), Abwind 4·aF/Λ·(α−α0)
  function handMethod(wing, tail, { tailEff, xCG, CL, alpha0 = 0, cm0 = 0 }) {
    const aF = wing.aspect / (Math.sqrt(wing.aspect ** 2 + 4) + 2);
    const aH = tail.aspect / (Math.sqrt(tail.aspect ** 2 + 4) + 2);
    const lmu = wing.mac, xNF = wing.xMac + lmu / 4, xNH = tail.xMac + tail.mac / 4;
    const rH = xNH - xNF, sh = tail.area * tailEff / wing.area;
    const k = aF * aH * sh;
    const xNP = xNF + lmu * k * rH / lmu / (1 + k);
    // Leitwerks-Ca aus dem Momentengleichgewicht um den Schwerpunkt, Flügel trägt den Rest
    const d = xCG - xNF;
    const caH = (CL * d / lmu + cm0) / (sh * rH / lmu);
    const caF = CL - caH * sh;
    const aw = caF / (2 * Math.PI * aF) * 180 / Math.PI + alpha0; // Flügel zur Profilsehne
    const eps = 4 * aF / wing.aspect * (aw - alpha0);
    const ah = caH / (2 * Math.PI * aH) * 180 / Math.PI;
    return { aF, aH, xNP, rH, caH, caF, alphaWing: aw, eps, ewd: aw - eps - ah };
  }

  const tailEffOf = stations => {
    // wirksame Leitwerksfläche für die Längsstabilität: Fläche·cos²(V-Form), flächengewichtet
    let s = 0, se = 0;
    for (let i = 1; i < stations.length; i++) {
      const a = (stations[i - 1].chord + stations[i].chord) / 2 * (stations[i].y - stations[i - 1].y);
      const g = (stations[i - 1].dihedral || 0) * Math.PI / 180;
      s += a; se += a * Math.cos(g) ** 2;
    }
    return s ? se / s : 1;
  };

  // Rumpf: Moment nach Multhopp mit dem Auf- und Abwind des Wirbelgitters entlang der Rumpfachse.
  // Die Einflusszahlen der Panels auf die Rumpfpunkte hängen nur von der Geometrie ab (nicht von Wölbung
  // und Klappen); zurück kommt cmFus(α, G).
  function fuselageMoment(model, fus, wing, sys) {
    const W = model.wing, T = model.tail;
    const P0w = V.stationPoints(W.stations), rootLe = P0w[0].le[0], rootTe = rootLe + W.stations[0].chord;
    const tailLe = T.x + (T.stations[0]?.offset || 0);
    const pts = [];
    for (let i = 1; i < fus.pts.length; i++) {
      const a = fus.pts[i - 1], b = fus.pts[i], x = (a.x + b.x) / 2;
      if ((x > rootLe && x < rootTe) || x > tailLe) continue;
      const w = a.r + b.r;
      pts.push({ k: Math.PI / 2 * w * w * (b.x - a.x) / (wing.area * wing.mac), inf: sys.panels.map(p => V.horseshoe([x, 0, 0], p.A, p.B, sys.far)[2]) });
    }
    return (alpha, G) => pts.reduce((m, q) => {
      let vz = 0;
      for (let j = 0; j < G.length; j++) vz += q.inf[j] * G[j];
      return m + q.k * (alpha * V.RAD + vz);
    }, 0);
  }

  // Wo beginnt der Abriss? Streifen mit der höchsten Ausnutzung Ca/Ca max und Bewertung nach seiner Lage:
  // innen (bis 50 % der Halbspannweite) gutmütig, aussen ab 75 % kritisch. Liegt aussen fast dieselbe
  // Ausnutzung an wie am höchsten Punkt innen (weniger als 3 Punkte Abstand), gilt es als neutral.
  // used: [{ y, ratio, eta }]
  function stallLocation(used) {
    if (!used.length) return null;
    const top = used.reduce((m, s) => (s.ratio > m.ratio ? s : m));
    const outer = used.filter(s => s.eta >= 0.75).reduce((m, s) => Math.max(m, s.ratio), 0);
    const rating = top.eta >= 0.75 ? 'kritisch' : top.eta >= 0.5 || top.ratio - outer < 0.03 ? 'neutral' : 'gutmütig';
    return { ...top, outer, rating };
  }

  // Hauptrechnung. Gibt alles zurück, was die Oberfläche zeigt.
  function analyze(model, profiles, { ny = 30, nx = 8, nyTail = 10, nxTail = 5, nCrit = 9 } = {}) {
    model = resolveTe(model);
    const W = model.wing, T = model.tail;
    const wing = V.planform(W.stations), tail = V.planform(T.stations, T.x);
    const wingGeo = W.stations.map(s => stationGeometry(s, profiles));
    const tailGeo = T.stations.map(s => stationGeometry(s, profiles));
    const geoKey = PR.hash(JSON.stringify([W, T.x, T.z, T.stations, wingGeo.map(g => g && g.camber.zs), tailGeo.map(g => g && g.camber.zs), ny, nx]));
    const sys = cached('s' + geoKey, () => {
      const pw = V.panelize(W.stations, { ny, nx, incidence: W.incidence || 0, camber: wingGeo.map(g => g && g.camber), tag: 0 });
      const pt = V.panelize(T.stations, { ny: nyTail, nx: nxTail, x0: T.x, z0: T.z || 0, camber: tailGeo.map(g => g && g.camber), tag: 1 });
      return V.build(pw.concat(pt));
    });
    const ref = { sRef: wing.area, cRef: wing.mac, xRef: 0 };
    const fus = F.shape(model);
    const cmFus = cached('f' + geoKey + PR.hash(JSON.stringify(fus.pts)), () => fuselageMoment(model, fus, wing, sys));
    const run = (alpha, it) => {
      const r = V.solve(sys, alpha, { ...ref, extra: it ? p => (p.surf === 1 ? it : 0) : null });
      r.cmF = cmFus(alpha, r.G); r.Cm += r.cmF;
      return r;
    };

    // linear in α und Leitwerkseinstellung: drei Lösungen genügen
    const r0 = run(0, 0), ra = run(1, 0), ri = run(0, 1);
    const cA = ra.CL - r0.CL, mA = ra.Cm - r0.Cm, cI = ri.CL - r0.CL, mI = ri.Cm - r0.Cm;
    const xNP = -(mA / cA) * wing.mac, xNP0 = -((mA - (ra.cmF - r0.cmF)) / cA) * wing.mac; // mit und ohne Rumpf
    const sigmaOf = x => (xNP - x) / wing.mac;
    const xCG = model.cg.mode === 'sigma' ? xNP - model.cg.sigma * wing.mac : model.cg.x;
    const sigma = sigmaOf(xCG);

    // Trimm, Moment um den Schwerpunkt = 0. Entweder ist das Ca vorgegeben und die EWD folgt daraus, oder die
    // gebaute EWD ist vorgegeben (Leitwerkseinstellung fest) und das Ca stellt sich ein: dann nur α suchen.
    // dCm/dα um den Schwerpunkt = −CLα·σ; bei σ ≤ 0 gibt es kein stabiles Gleichgewicht.
    let CL = model.clDesign, alpha = 0, it = 0, byEwd = null;
    if (model.trimBy === 'ewd' && Number.isFinite(model.ewd)) {
      it = (W.incidence || 0) - model.ewd;
      const dF = mA + cA * xCG / wing.mac;
      for (let k = 0; k < 4; k++) { const r = run(alpha, it); alpha -= (r.Cm + r.CL * xCG / wing.mac) / dF; }
      const cl = run(alpha, it).CL;
      byEwd = { ewd: model.ewd, cl, stable: sigma > 0.005, ok: sigma > 0.005 && cl >= 0.05 && cl <= 1.6 };
      if (byEwd.ok) CL = cl;
      else { CL = Math.min(1.6, Math.max(0.05, Number.isFinite(cl) ? cl : model.clDesign)); alpha = 0; it = 0; }
    }
    if (!byEwd || !byEwd.ok) {
      const target = -CL * xCG / wing.mac; // Cm um die Nasenleiste der Wurzel
      for (let k = 0; k < 3; k++) {
        const r = k === 0 ? r0 : run(alpha, it);
        const dC = CL - r.CL, dM = target - r.Cm;
        const det = cA * mI - cI * mA;
        alpha += (dC * mI - cI * dM) / det;
        it += (cA * dM - dC * mA) / det;
      }
    }
    const trim = run(alpha, it);
    if (byEwd && byEwd.ok) CL = trim.CL;
    const ws = model.mass / (wing.area / 1e4); // g/dm²
    const speed = Math.sqrt(2 * model.mass / 1000 * G / (RHO * wing.area / 1e6 * CL));
    const clTail = (trim.lift[1] || 0) / (0.5 * tail.area);
    const clWing = (trim.lift[0] || 0) / (0.5 * wing.area);

    // Profilpolaren der Flügelstationen: örtliches Ca max entlang der Spannweite
    // (an beiden Enden jedes Segments mit dessen Klappe)
    const seg = segmentPolars(W.stations, profiles, ws, nCrit);
    const P0 = V.stationPoints(W.stations);
    const clMaxAt = y => {
      for (let i = 1; i < P0.length; i++) {
        const y0 = P0[i - 1].le[1], y1 = P0[i].le[1];
        if (y <= y1 + 1e-9) {
          const [a, b] = seg[i - 1], t = (y - y0) / (y1 - y0 || 1);
          if (!a || !b) return NaN;
          return a.clMax + (b.clMax - a.clMax) * t;
        }
      }
      return NaN;
    };
    const strips = trim.strips.filter(s => s.surf === 0).map(s => ({ y: s.y, cl: s.cl, clMax: clMaxAt(s.y), chord: s.chord }));
    const tailStrips = trim.strips.filter(s => s.surf === 1).map(s => ({ y: s.y, cl: s.cl, chord: s.chord }));
    // flächengewichtete Profilwerte für die Handrechnung
    let sw = 0, a0 = 0, c0 = 0;
    for (let i = 1; i < W.stations.length; i++) {
      const a = (W.stations[i - 1].chord + W.stations[i].chord) / 2 * (W.stations[i].y - W.stations[i - 1].y);
      for (const q of seg[i - 1]) if (q && Number.isFinite(q.alpha0)) { sw += a / 2; a0 += q.alpha0 * a / 2; c0 += q.cm0 * a / 2; }
    }
    const hand = handMethod(wing, tail, { tailEff: tailEffOf(T.stations), xCG, CL, alpha0: sw ? a0 / sw : 0, cm0: sw ? c0 / sw : 0 });

    // Arbeitstabelle: für jedes Ca die EWD bei verschiedenen Stabilitätsmassen, der Schwerpunkt für ein
    // unbelastetes Leitwerk (wie im Excel-Blatt mit Ca HLW = 0) und die Gleitzahl ohne Rumpf
    const lT = ri.lift[1] - r0.lift[1], lA = ra.lift[1] - r0.lift[1];
    const sigmas = [...new Set([0.15, 0.2, 0.25].concat(model.cg.mode === 'sigma' ? [+(+model.cg.sigma).toFixed(4)] : []))].sort((a, b) => a - b);
    // Trimm für Ca und Schwerpunkt x: lineare Schätzung, dann zwei Newton-Schritte (die Einstellwinkel drehen die Normalen)
    const trimAt = (cl, x) => {
      const det = cA * mI - cI * mA, tM = -cl * x / wing.mac;
      let a = 0, i = 0, r = r0;
      for (let k = 0; k < 3; k++) {
        if (k) r = run(a, i);
        const dC = cl - r.CL, dM = tM - r.Cm;
        a += (dC * mI - cI * dM) / det; i += (cA * dM - dC * mA) / det;
      }
      return [a, i];
    };
    const table = [];
    const finA = F.finArea(model, tail.area);
    const finCd0 = re => { const q = T.stations[0] && tailPolar(T.stations[0], profiles, re, nCrit); const c = q && cdOf(q, 0); return Number.isFinite(c) ? c : null; };
    for (let k = 2; k <= 28; k++) {
      const cl = Math.round(k * 0.05 * 100) / 100;
      const [al, iT] = trimAt(cl, xCG);
      const r = run(al, iT);
      const v = Math.sqrt(2 * model.mass / 1000 * G / (RHO * wing.area / 1e6 * cl));
      const sw = r.strips.filter(q => q.surf === 0), st = r.strips.filter(q => q.surf === 1);
      const over = sw.some(q => Number.isFinite(clMaxAt(q.y)) && q.cl > clMaxAt(q.y));
      const reT = v * tail.mac / 1000 / NU;
      const tpols = T.stations.map(q => tailPolar(q, profiles, reT, nCrit));
      const cdi = V.trefftz(r.strips, wing.area);
      const cdw = profileDrag(sw, W.stations, seg, wing.area), cdt = profileDrag(st, T.stations, tpols.slice(0, -1).map((q, i) => [q, tpols[i + 1]]), wing.area);
      const cdf = F.drag(fus, v, wing.area), cdv = F.finDrag(finA, v, wing.area, finCd0);
      const x = F.withExtras(model, wing.area, { cdi, cdw, cdt, cdf, cdv }, al), cd = x.cd, E = cl / cd;
      const stall = over || !Number.isFinite(cdw); // Ca einer Station über ihrem Ca max
      // Leitwerk ohne Last: α und Einstellung so, dass Ca erreicht und Leitwerksauftrieb 0
      let a0n = 0, i0n = 0, rn = r0;
      for (let k = 0; k < 3; k++) {
        if (k) rn = run(a0n, i0n);
        const dC = cl - rn.CL, dL = -(rn.lift[1] || 0), det = cA * lT - cI * lA;
        a0n += (dC * lT - cI * dL) / det; i0n += (cA * dL - dC * lA) / det;
      }
      rn = run(a0n, i0n);
      const x0 = -rn.Cm * wing.mac / rn.CL;
      table.push({
        cl, v, alpha: al, ewdCur: (W.incidence || 0) - iT, E, sink: v / E, cd, cdi: x.cdi, cdw: x.cdw, cdt: x.cdt, cdf: x.cdf, cdv: x.cdv, cdx: x.cdx, cdBase: x.base, stall, clTail: (r.lift[1] || 0) / (0.5 * tail.area),
        // Ausnutzung Ca/Ca max je Flügelstreifen [η, Ca/Ca max], für den Innenflügel im Kreisflug
        use: sw.map(q => [q.y / (wing.projSpan / 2), q.cl / clMaxAt(q.y)]).filter(u => Number.isFinite(u[1]) && u[1] > -10),
        ewd: sigmas.map(sg => { const [, it2] = trimAt(cl, xNP - sg * wing.mac); return (W.incidence || 0) - it2; }),
        neutral: { x: x0, sigma: (xNP - x0) / wing.mac, ewd: (W.incidence || 0) - i0n },
      });
      if (stall) break;
    }
    const ok = table.filter(t => !t.stall && Number.isFinite(t.E));
    const best = ok.reduce((m, t) => (!m || t.E > m.E ? t : m), null), minSink = ok.reduce((m, t) => (!m || t.sink < m.sink ? t : m), null);

    const tailVolume = tail.area * tailEffOf(T.stations) * ((tail.xMac + tail.mac / 4) - xCG) / (wing.area * wing.mac);
    const stall = strips.filter(s => Number.isFinite(s.clMax)).reduce((m, s) => Math.max(m, s.cl / s.clMax), 0);
    // Wo beginnt der Abriss? Streifen mit der höchsten Ausnutzung Ca/Ca max und Bewertung nach seiner Lage:
    // innen (bis 50 % der Halbspannweite) gutmütig, aussen ab 75 % kritisch. Liegt aussen fast dieselbe
    // Ausnutzung an wie am höchsten Punkt innen (weniger als 3 Punkte Abstand), gilt es als neutral.
    const stallAt = stallLocation(strips.filter(s => Number.isFinite(s.clMax) && s.clMax > 0).map(s => ({ y: s.y, ratio: s.cl / s.clMax, eta: s.y / (wing.projSpan / 2) })));
    const zone = trimZone({ CL, stall, table, best, minSink, byEwd });
    return {
      wing, tail, xNP, xCG, sigma, CLalpha: cA * 180 / Math.PI,
      trim: { CL, alpha, tailIncidence: it, ewd: (W.incidence || 0) - it, clWing, clTail, speed, re: speed * wing.mac / 1000 / NU, by: byEwd ? 'ewd' : 'ca', byEwd, zone },
      wingLoading: ws, tailVolume, table, sigmas, best, minSink, xNP0,
      fuselage: { ...fus, fin: finA, dNP: xNP - xNP0 }, strips, tailStrips, segments: seg, stall, stallAt, hand,
      profiles: { wing: wingGeo.map(g => g && g.name), tail: tailGeo.map(g => g && g.name) },
      panels: sys.panels.length,
    };
  }

  // Wo liegt der Trimmpunkt in der Polare? keine (kein Gleichgewicht), abriss (über Ca max), hoch (über 90 %
  // Ca max), langsam (über dem geringsten Sinken), thermik, gleiten (um die beste Gleitzahl), schnell.
  function trimZone({ CL, stall, table, best, minSink, byEwd }) {
    if (byEwd && !byEwd.stable) return { key: 'keine', warn: true };
    if (byEwd && !byEwd.ok) return { key: 'keine', warn: true, cl: byEwd.cl };
    const okMax = table.filter(t => !t.stall).reduce((m, t) => Math.max(m, t.cl), 0);
    if (stall >= 1 || (table.some(t => t.stall) && CL > okMax + 0.025)) return { key: 'abriss', warn: true };
    if (stall > 0.9) return { key: 'hoch', warn: true };
    if (!best || !minSink) return { key: 'unbekannt' };
    const tol = 0.05;
    if (CL > minSink.cl + tol) return { key: 'langsam' };
    if (CL < best.cl - tol) return { key: 'schnell' };
    return { key: Math.abs(CL - minSink.cl) < Math.abs(CL - best.cl) ? 'thermik' : 'gleiten' };
  }

  // Höhenruder: Bauart „gedaempft“ (feste Flosse mit Ruder) oder „pendel“ (ganzes Leitwerk dreht), dazu die
  // Bezugs-EWD, bei der das Ruder neutral steht (null = EWD beim Trimm-Ca). Die Rudertiefe ist die Klappentiefe
  // der Leitwerksstationen. Wirksamkeit τ = Winkeländerung je Grad Ruder aus dem Wirbelgitter, Leitwerk allein.
  const elevatorOf = model => ({ type: 'gedaempft', ewd: null, ...((model.tail && model.tail.elevator) || {}) });
  function elevatorTau(stations) {
    const segs = stations.slice(0, -1);
    if (!segs.some(s => s.flapDepth > 0)) return 0;
    return cached('e' + PR.hash(JSON.stringify(stations.map(s => [s.y, s.chord, s.offset, s.dihedral, s.twist, s.flapDepth]))), () => {
      const clean = stations.map(s => ({ ...s, flap: 0 }));
      const flapped = stations.map((s, i) => ({ ...s, flap: i < stations.length - 1 && s.flapDepth > 0 ? 1 : 0 }));
      const opt = { ny: 12, nx: 16 }, ref = { sRef: V.planform(stations).area, cRef: 1 };
      const sys = V.build(V.panelize(clean, opt));
      const a = V.solve(sys, 1, ref).CL, f = V.solve({ ...sys, panels: V.panelize(flapped, opt) }, 0, ref).CL;
      return a ? f / a : 0;
    });
  }
  // Ausschlag in Grad für eine EWD, positiv = Endleiste nach unten (Tiefe). null, wenn das Ruder fehlt.
  function elevatorDeflection(model, ewd, ewdRef) {
    const e = elevatorOf(model), ref = e.ewd ?? ewdRef;
    if (!Number.isFinite(ewd) || !Number.isFinite(ref)) return null;
    if (e.type === 'pendel') return ref - ewd;
    const tau = elevatorTau(model.tail.stations);
    return tau > 0.05 ? (ref - ewd) / tau : null;
  }

  const api = { analyze, resolveTe, withTe, teMm, TE_MM, trimZone, handMethod, tailPolar, stationGeometry, stationPolar, stationProfile, withFlap, fuselageMoment, profileDrag, cdOf, tailEffOf, stallLocation, elevatorOf, elevatorTau, elevatorDeflection, RHO, NU, G };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).modell = api;
})(typeof self !== 'undefined' ? self : this);
