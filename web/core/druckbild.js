// Druckbild und Ablösekarte am ganzen Modell (quasi-3D, wie XFLR5): Das Wirbelgitter liefert je Streifen das
// örtliche Ca. Für die beiden Stationen links und rechts des Streifens wird der wirksame Anstellwinkel aus ihrer
// linearen Polare gesucht (α0 + Ca/Anstieg) und NeuralFoil mit Grenzschicht gerechnet, bei der Re des Streifens.
// Die Grenzschicht (θ, H, ue) wird zwischen den Stationen gemittelt und wie im Profil-Kanal ausgewertet:
// Cp = 1 − (ue/V)², laminar / turbulent / Blase / abgelöst. Über Ca max löst die Strömung im Netz ab.
// Flugzustände: Trimm, die Zeilen der Arbeitstabelle und für den Abriss-Film ein paar Grad über die letzte hinaus.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;
  const NF = isNode ? require('./neuralfoil.js') : root.MMPA.neuralfoil;
  const K = isNode ? require('./kanal.js') : root.MMPA.kanal;
  const PR = isNode ? require('./projekt.js') : root.MMPA.projekt;

  const NU = 1.5e-5, RHO = 1.225, G = 9.81;
  const STATE = { laminar: 0, turbulent: 1, blase: 2, abgeloest: 3 };
  const N_BL = 32;

  // Vorbereitete NeuralFoil-Funktionen und lineare Polaren je Geometrie (und Re-Stufe)
  const prepCache = new Map(), linCache = new Map();
  const remember = (map, key, fn, max = 200) => {
    if (map.has(key)) return map.get(key);
    const v = fn();
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, v); return v;
  };

  // Station → Geometrie (mit Klappe des Segments), NeuralFoil und Umschlagvorgabe aus der Bauweise
  function stationSection(st, profiles, flap, flapDepth) {
    const g = M.stationGeometry(st, profiles);
    if (!g) return null;
    flap = Math.round((flap || 0) * 100) / 100;
    const geo = flap ? P.flap(g.geo, flap, 1 - (flapDepth || 25) / 100) : g.geo;
    const key = PR.hash(JSON.stringify([g.camber.zs, g.stats, flap, flap ? flapDepth : 0]));
    const at = remember(prepCache, key, () => NF.prepare(geo), 60);
    return { key, at, xtrTop: st.xtrTop ?? 1, xtrBot: st.xtrBot ?? 1 };
  }

  // Lineare Polare (α0 und Anstieg je Grad) dieser Station bei Re, Re in 10-%-Stufen
  function linear(sec, re, nCrit) {
    const rb = Math.round(Math.log(Math.max(re, 2e4)) / Math.log(1.1));
    return remember(linCache, sec.key + ':' + rb + ':' + nCrit + ':' + sec.xtrTop + ':' + sec.xtrBot, () => {
      const R = Math.pow(1.1, rb), pts = [];
      for (let a = -6; a <= 8; a += 2) { const r = sec.at(a, R, nCrit, sec.xtrTop, sec.xtrBot); pts.push([a, r.cl]); }
      const lin = pts.filter(p => p[1] > -0.5 && p[1] < 0.9);
      const use = lin.length >= 3 ? lin : pts;
      const n = use.length, sx = use.reduce((s, p) => s + p[0], 0), sy = use.reduce((s, p) => s + p[1], 0);
      const sxx = use.reduce((s, p) => s + p[0] * p[0], 0), sxy = use.reduce((s, p) => s + p[0] * p[1], 0);
      let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      if (!(slope > 0.03)) slope = 0.105; // 2π je Radiant
      const c = (sy - slope * sx) / n; // Ca bei α = 0
      return { a0: -c / slope, slope };
    }, 2000);
  }

  // Flugzustände: Trimm, Arbeitstabelle, darüber hinaus α in 1°-Schritten mit der letzten Leitwerkseinstellung
  function states(model, r, extra = 6) {
    const inc = model.wing.incidence || 0, L = r.load, S = r.wing.area / 1e6, mg = model.mass / 1000 * G;
    const vOf = cl => Math.sqrt(2 * mg / (RHO * S * Math.max(cl, 0.05)));
    const out = [{ key: 'trim', label: 'Trimm', alpha: r.trim.alpha, it: r.trim.tailIncidence, v: r.trim.speed, cl: r.trim.CL }];
    (r.table || []).forEach((t, k) => out.push({ key: 't' + k, label: 'Ca ' + t.cl.toFixed(2), alpha: t.alpha, it: inc - t.ewdCur, v: t.v, cl: t.cl, film: true }));
    const last = out[out.length - 1];
    if (L && last) for (let k = 1; k <= extra; k++) {
      const alpha = last.alpha + k, cl = L.CL0 + alpha * L.CLa + last.it * L.CLi;
      out.push({ key: 'x' + k, label: 'α +' + k + '°', alpha, it: last.it, v: vOf(cl), cl, film: true, beyond: true });
    }
    return out;
  }

  // Grenzschicht zweier Stationen mischen (Anteil t der zweiten)
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  function blend(ra, rb, t) {
    const side = k => ({ theta: mix(ra.bl[k].theta, rb.bl[k].theta, t), H: mix(ra.bl[k].H, rb.bl[k].H, t), ue: mix(ra.bl[k].ue, rb.bl[k].ue, t) });
    return {
      bl: { x: ra.bl.x, upper: side('upper'), lower: side('lower') },
      xtrTop: ra.xtrTop + (rb.xtrTop - ra.xtrTop) * t, xtrBot: ra.xtrBot + (rb.xtrBot - ra.xtrBot) * t,
      cl: ra.cl + (rb.cl - ra.cl) * t, cd: ra.cd + (rb.cd - ra.cd) * t, conf: Math.min(ra.conf, rb.conf),
    };
  }
  // Blase ab der Nase, die bis zur Endleiste nicht wieder anliegt, ist ein Abriss von vorn (geplatzte Blase)
  const burst = s => {
    if (!s.bubble || !s.bubble.open || s.bubble.from > 0.3) return s;
    s.pts.forEach(p => { if (p.x >= s.bubble.from) p.state = 'abgeloest'; });
    return { ...s, sep: s.bubble.from, bubble: null };
  };
  const pack = s => (s = burst(s), {
    cp: Float32Array.from(s.pts.map(p => p.cp)), st: Uint8Array.from(s.pts.map(p => STATE[p.state])),
    xtr: s.xtr, sep: s.sep, bubble: s.bubble,
  });

  // Eine Fläche (0 Flügel, 1 HLW) in einem Flugzustand
  function surface(model, profiles, r, surf, state, nCrit) {
    const S = surf === 0 ? model.wing : model.tail;
    const st = S.stations;
    const Pp = surf === 0 ? V.stationPoints(st) : V.stationPoints(st, model.tail.x, model.tail.z || 0);
    const yS = Pp.map(p => p.le[1]);
    // Stationen je Segment (Klappe des Segments gilt an beiden Enden)
    const segSec = st.slice(0, -1).map((s, i) => {
      const flap = surf === 0 && s.flapDepth > 0 && s.flap ? s.flap : 0;
      return [stationSection(s, profiles, flap, s.flapDepth), stationSection(st[i + 1], profiles, flap, s.flapDepth)];
    });
    const L = r.load, out = [];
    for (let i = 0; i < L.surf.length; i++) {
      if (L.surf[i] !== surf) continue;
      const y = L.y[i], chord = L.chord[i];
      const cl = L.c0[i] + state.alpha * L.ca[i] + state.it * L.ci[i];
      const re = Math.max(2e4, state.v * chord / 1000 / NU);
      let k = 1; while (k < yS.length - 1 && y > yS[k]) k++;
      const t = Math.min(1, Math.max(0, (y - yS[k - 1]) / ((yS[k] - yS[k - 1]) || 1)));
      const [sa, sb] = segSec[k - 1];
      if (!sa || !sb) continue;
      const run = sec => { const l = linear(sec, re, nCrit), a = l.a0 + cl / l.slope; return { a, r: sec.at(a, re, nCrit, sec.xtrTop, sec.xtrBot, true) }; };
      const A = run(sa), B = run(sb);
      const bl = K.boundaryLayer(blend(A.r, B.r, t));
      out.push({ y, chord, cl, clProf: bl.cl, alphaEff: A.a + (B.a - A.a) * t, re, conf: bl.conf, upper: pack(bl.upper), lower: pack(bl.lower) });
    }
    return out;
  }

  // Abriss: Streifen mit abgelöster Oberseite vor 80 % der Tiefe oder Profil-Ca deutlich unter dem Wirbelgitter-Ca
  // (Randstreifen mit sehr kleiner Re zählen nicht, dort rechnet das Netz unsicher)
  const stalled = q => q.re > 3e4 && ((q.upper.sep != null && q.upper.sep < 0.8) || (q.cl > 0.3 && q.clProf < 0.9 * q.cl));
  const score = q => (q.upper.sep != null ? 1 - q.upper.sep : 0) + Math.max(0, 1 - q.clProf / Math.max(q.cl, 1e-6));
  function summary(wing, span) {
    const st = wing.filter(stalled);
    if (!st.length) return { stalled: 0, first: null };
    const first = st.reduce((m, q) => (score(q) > score(m) ? q : m));
    return { stalled: st.length / wing.length, first: { y: first.y, eta: first.y / span, sep: first.upper.sep } };
  }

  function compute(model, profiles, r, state, { nCrit = 9 } = {}) {
    if (!r || !r.load) throw new Error('Modellrechnung fehlt');
    model = M.resolveTe(model);
    const wing = surface(model, profiles, r, 0, state, nCrit), tail = surface(model, profiles, r, 1, state, nCrit);
    return { state, wing, tail, stall: summary(wing, r.wing.projSpan / 2), x: NF.BL_X };
  }

  // Mehrere Zustände (Abriss-Film); onFrame(i, frame) für Fortschritt
  function film(model, profiles, r, list, opts = {}, onFrame = null) {
    return list.map((s, i) => { const f = compute(model, profiles, r, s, opts); if (onFrame) onFrame(i, f); return f; });
  }

  // Wert an x/c aus den 32 Grenzschichtpunkten (linear, an den Enden gehalten)
  function at(xs, arr, x) {
    if (x <= xs[0]) return arr[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return arr[i - 1] + (arr[i] - arr[i - 1]) * t; }
    return arr[arr.length - 1];
  }
  function stateAt(xs, arr, x) {
    let k = 0; for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[k] - x)) k = i;
    return arr[k];
  }

  const api = { STATE, N_BL, states, compute, film, surface, linear, stationSection, stalled, at, stateAt };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).druckbild = api;
})(typeof self !== 'undefined' ? self : this);
