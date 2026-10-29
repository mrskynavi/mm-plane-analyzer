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

  const RHO = 1.225, NU = 1.5e-5, G = 9.81;
  const XS = P.cosspace(60);

  // Profil einer Station mit eigener Dicke und Wölbung (absolut, Bruchteil der Tiefe)
  function stationProfile(st, profiles) {
    const p = st.profileId && profiles.find(q => q.id === st.profileId);
    if (!p) return null;
    const raw = P.stats(P.modify(p.coords, {}));
    const mod = { ...p.mod };
    if (st.thickness != null && raw.thickness > 0) mod.thickness = st.thickness / raw.thickness;
    if (st.camber != null && raw.camber > 1e-4) mod.camber = st.camber / raw.camber;
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
      return { geo, camber: { xs: XS, zs: c }, stats: P.stats(geo), name: sp.profile.name };
    });
  }

  // Polare einer Station (Typ 2 aus Flächenbelastung und örtlicher Tiefe) für Ca max, α0 und Cm0
  function stationPolar(st, profiles, wingLoading, nCrit = 9) {
    const g = stationGeometry(st, profiles);
    if (!g) return null;
    const re = Math.round(POL.reSqrtCl(wingLoading, st.chord) / 100) * 100;
    return cached('p' + PR.hash(JSON.stringify([g.camber.zs.slice(0, 8), g.stats, re, nCrit])), () => {
      const r = POL.compute(g.geo, { type: 2, re, alphaFrom: -6, alphaTo: 16, alphaStep: 1, nCrit });
      return { re, ...r.summary };
    });
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

  // Hauptrechnung. Gibt alles zurück, was die Oberfläche zeigt.
  function analyze(model, profiles, { ny = 30, nx = 8, nyTail = 10, nxTail = 5, nCrit = 9 } = {}) {
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
    const run = (alpha, it) => V.solve(sys, alpha, { ...ref, extra: it ? p => (p.surf === 1 ? it : 0) : null });

    // linear in α und Leitwerkseinstellung: drei Lösungen genügen
    const r0 = run(0, 0), ra = run(1, 0), ri = run(0, 1);
    const cA = ra.CL - r0.CL, mA = ra.Cm - r0.Cm, cI = ri.CL - r0.CL, mI = ri.Cm - r0.Cm;
    const xNP = -(mA / cA) * wing.mac;
    const sigmaOf = x => (xNP - x) / wing.mac;
    const xCG = model.cg.mode === 'sigma' ? xNP - model.cg.sigma * wing.mac : model.cg.x;
    const sigma = sigmaOf(xCG);

    // Trimm: CL = Auslegungs-Ca, Moment um den Schwerpunkt = 0
    const CL = model.clDesign;
    const target = -CL * xCG / wing.mac; // Cm um die Nasenleiste der Wurzel
    let alpha = 0, it = 0;
    for (let k = 0; k < 3; k++) {
      const r = k === 0 ? r0 : run(alpha, it);
      const dC = CL - r.CL, dM = target - r.Cm;
      const det = cA * mI - cI * mA;
      alpha += (dC * mI - cI * dM) / det;
      it += (cA * dM - dC * mA) / det;
    }
    const trim = run(alpha, it);
    const ws = model.mass / (wing.area / 1e4); // g/dm²
    const speed = Math.sqrt(2 * model.mass / 1000 * G / (RHO * wing.area / 1e6 * CL));
    const clTail = (trim.lift[1] || 0) / (0.5 * tail.area);
    const clWing = (trim.lift[0] || 0) / (0.5 * wing.area);

    // Profilpolaren der Flügelstationen: örtliches Ca max entlang der Spannweite
    const pols = W.stations.map(s => stationPolar(s, profiles, ws, nCrit));
    const P0 = V.stationPoints(W.stations);
    const clMaxAt = y => {
      for (let i = 1; i < P0.length; i++) {
        const y0 = P0[i - 1].le[1], y1 = P0[i].le[1];
        if (y <= y1 + 1e-9) {
          const a = pols[i - 1], b = pols[i], t = (y - y0) / (y1 - y0 || 1);
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
      for (const q of [pols[i - 1], pols[i]]) if (q && Number.isFinite(q.alpha0)) { sw += a / 2; a0 += q.alpha0 * a / 2; c0 += q.cm0 * a / 2; }
    }
    const hand = handMethod(wing, tail, { tailEff: tailEffOf(T.stations), xCG, CL, alpha0: sw ? a0 / sw : 0, cm0: sw ? c0 / sw : 0 });

    const tailVolume = tail.area * tailEffOf(T.stations) * ((tail.xMac + tail.mac / 4) - xCG) / (wing.area * wing.mac);
    const stall = strips.filter(s => Number.isFinite(s.clMax)).reduce((m, s) => Math.max(m, s.cl / s.clMax), 0);
    return {
      wing, tail, xNP, xCG, sigma, CLalpha: cA * 180 / Math.PI,
      trim: { CL, alpha, tailIncidence: it, ewd: (W.incidence || 0) - it, clWing, clTail, speed, re: speed * wing.mac / 1000 / NU },
      wingLoading: ws, tailVolume, strips, tailStrips, stations: pols, stall, hand,
      profiles: { wing: wingGeo.map(g => g && g.name), tail: tailGeo.map(g => g && g.name) },
      panels: sys.panels.length,
    };
  }

  const api = { analyze, handMethod, stationGeometry, stationPolar, stationProfile };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).modell = api;
})(typeof self !== 'undefined' ? self : this);
