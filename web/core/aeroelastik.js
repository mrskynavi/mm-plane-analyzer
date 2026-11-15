// F3 Aeroelastik des Flügels: Zusammenspiel von Luftkraft und Verformung, gerechnet mit Streifentheorie auf dem
// Balken aus F2 (EI, GJ, Masse je Meter, elastische Achse = Holmlage).
//  · Verwindung im Flug: das Moment um den Holm verdreht den Flügel, die Verdrehung ändert den Auftrieb, der wieder
//    das Moment ändert. θ = q·C·(t + A·θ) → θ = (1 − q·C·A)⁻¹ · q·C·t
//  · Divergenz: Staudruck, bei dem diese Rückkopplung keine Lösung mehr hat (Holm hinter t/4)
//  · Ruderwirksamkeit: das Querruder dreht den Flügel gegen seinen Ausschlag; Umkehr, wo das Rollmoment null wird
//  · Flattern: Eigenfrequenzen aus Rayleigh, Richtwert nach der Näherung von Theodorsen und Garrick
// Es sind Richtwerte: stationäre Streifentheorie, ohne Rumpf, Leitwerksträger, Rudermassen und Spiel in der Anlenkung.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const V = isNode ? require('./vlm.js') : root.MMPA.vlm;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;
  const DB = isNode ? require('./druckbild.js') : root.MMPA.druckbild;

  const RHO = M.RHO, G0 = M.G, DEG = 180 / Math.PI;
  const lerpSt = (rows, y, k) => {
    let i = 1; while (i < rows.length - 1 && y > rows[i].y) i++;
    const a = rows[i - 1], b = rows[i], t = Math.min(1, Math.max(0, (y - a.y) / ((b.y - a.y) || 1)));
    return a[k] + (b[k] - a[k]) * t;
  };
  const vOfQ = q => Math.sqrt(2 * q * 1e6 / RHO);       // q in N/mm² → m/s
  const qOfV = v => 0.5 * RHO * v * v / 1e6;            // m/s → N/mm²

  // Klappenwirkung nach der Theorie dünner Profile: Auftrieb und Moment um t/4 je Radiant Ausschlag
  function flapDerivs(depth) {
    const th = Math.acos(1 - 2 * (1 - depth));
    return { cl: 2 * (Math.PI - th + Math.sin(th)), cm: -0.5 * Math.sin(th) * (1 - Math.cos(th)) };
  }

  // Eigenfrequenzen der eingespannten Halbfläche (Rayleigh mit der statischen Biege- und Drehlinie)
  function frequencies(rows, scale, xs, xcg, kE = 1, kG = 1) {
    const L = rows[rows.length - 1].y / 1000, N = 80, dy = L / N;
    const y = Array.from({ length: N + 1 }, (_, i) => i * dy);
    const at = k => y.map(v => lerpSt(rows, v * 1000, k));
    const m = at('massPerM').map(v => v * scale / 1000), EI = at('EI').map(v => v * kE / 1e6), GJ = at('GJ').map(v => v * kG / 1e6), c = at('chord').map(v => v / 1000);
    const back = f => { const o = new Array(N + 1).fill(0); for (let i = N - 1; i >= 0; i--) o[i] = o[i + 1] + (f[i] + f[i + 1]) / 2 * dy; return o; };
    const fwd = f => { const o = new Array(N + 1).fill(0); for (let i = 1; i <= N; i++) o[i] = o[i - 1] + (f[i] + f[i - 1]) / 2 * dy; return o; };
    const sum = f => f.reduce((a, v, i) => a + v * (i === 0 || i === N ? 0.5 : 1), 0) * dy;
    // Biegung unter Eigengewicht
    const Mb = back(back(m.map(v => v * G0))), w = fwd(fwd(Mb.map((v, i) => v / Math.max(EI[i], 1e-9))));
    const fh = Math.sqrt(G0 * sum(m.map((v, i) => v * w[i])) / Math.max(sum(m.map((v, i) => v * w[i] * w[i])), 1e-30)) / (2 * Math.PI);
    // Torsion: Drehträgheit je Meter um die elastische Achse (Trägheitsradius der Masse 0,25 Tiefen um ihren Schwerpunkt)
    const I = m.map((v, i) => v * c[i] * c[i] * (0.0625 + (xcg - xs) ** 2));
    let ft = NaN;
    if (GJ.every(v => v > 0)) {
      const th = fwd(back(I).map((v, i) => v / GJ[i]));
      ft = Math.sqrt(sum(I.map((v, i) => v * th[i])) / Math.max(sum(I.map((v, i) => v * th[i] * th[i])), 1e-30)) / (2 * Math.PI);
    }
    return { fh, ft, L };
  }

  function analyze(model, profiles, r, res, { nCrit = 9 } = {}) {
    const Pt = res.wing, rows = Pt.stations, str = Pt.struct, kE = rows.kEI || 1, kG = rows.kGJ || 1;
    const xs = str.spar.pos / 100, xcg = (str.aero.cg ?? 40) / 100, vMax = res.meta.loads.vMax, Ld = r.load;
    const out = { vMax, xs, xcg, notes: [] };
    // Streifen des Flügels
    const idx = []; for (let i = 0; i < Ld.surf.length; i++) if (Ld.surf[i] === 0) idx.push(i);
    idx.sort((a, b) => Ld.y[a] - Ld.y[b]);
    const n = idx.length, y = idx.map(i => Ld.y[i]), w = idx.map(i => Ld.width[i]), c = idx.map(i => Ld.chord[i]), z = idx.map(i => Ld.z[i]);
    const a = idx.map(i => Math.max(Ld.ca[i], 0.02) * DEG);          // Auftriebsanstieg je Radiant
    const e = c.map(v => (xs - 0.25) * v);                           // Holm hinter t/4 (mm)

    const fr = frequencies(rows, Pt.scale, xs, xcg, kE, kG);
    out.fh = fr.fh; out.ft = fr.ft;

    // Drehnachgiebigkeit: Verdrehung bei y durch ein Moment 1 N·mm an der Stelle η = ∫0..min(y,η) dy / GJ
    const yTip = rows[rows.length - 1].y, NF = 240;
    let ok = true; const F = [0];
    for (let k = 1; k <= NF; k++) {
      const g0 = lerpSt(rows, yTip * (k - 1) / NF, 'GJ') * kG, g1 = lerpSt(rows, yTip * k / NF, 'GJ') * kG;
      if (!(g0 > 0) || !(g1 > 0)) { ok = false; break; }
      F.push(F[k - 1] + (1 / g0 + 1 / g1) / 2 * yTip / NF);
    }
    if (!ok) { out.ok = false; out.notes.push('Der Flügel hat keinen geschlossenen Torsionskasten (GJ = 0). Divergenz, Ruderwirksamkeit und Flattern lassen sich so nicht rechnen.'); return out; }
    out.ok = true;
    const Fy = y.map(v => { const f = Math.min(1, v / yTip) * NF, i = Math.min(NF - 1, Math.floor(f)); return F[i] + (F[i + 1] - F[i]) * (f - i); });
    const C = (i, j) => Math.min(Fy[i], Fy[j]);
    const kA = c.map((v, i) => v * e[i] * a[i] * w[i]);              // Moment je Radiant Verdrehung und Staudruck (mm³)

    // Divergenz: grösster Eigenwert von C·A (Potenzmethode)
    if (xs > 0.25) {
      let th = new Array(n).fill(1), lam = 0;
      for (let it = 0; it < 200; it++) {
        const nx = th.map((_, i) => { let s = 0; for (let j = 0; j < n; j++) s += C(i, j) * kA[j] * th[j]; return s; });
        const mx = Math.max(...nx.map(Math.abs)); if (!(mx > 0)) break;
        th = nx.map(v => v / mx); if (Math.abs(mx - lam) < 1e-10 * mx) { lam = mx; break; } lam = mx;
      }
      if (lam > 0) out.div = { q: 1 / lam, v: vOfQ(1 / lam) };
    } else out.notes.push('Der Holm liegt bei oder vor t/4: Auftrieb dreht den Flügel nicht auf, Divergenz gibt es nicht.');
    const qD = out.div ? out.div.q : Infinity;

    // Verdrehung (rad) je Streifen bei Staudruck q für Momente t (N·mm je Staudruck 1)
    const twist = (q, t) => {
      if (q >= 0.999 * qD) return null;
      const A = y.map((_, i) => y.map((__, j) => (i === j ? 1 : 0) - q * C(i, j) * kA[j]));
      const b = y.map((_, i) => { let s = 0; for (let j = 0; j < n; j++) s += C(i, j) * t[j]; return q * s; });
      return Array.from(V.lu(A)(b));
    };
    const rigid = (q, t) => y.map((_, i) => { let s = 0; for (let j = 0; j < n; j++) s += C(i, j) * t[j]; return q * s; });

    // Geradeausflug bei n = 1 über die Fahrt: Verwindung, Umlagerung des Auftriebs, Folgen für Biegemoment und Gleitzahl
    const S = r.wing.area / 1e6, mg = res.meta.mass * G0, vS = res.meta.vS;
    const tab = (r.table || []).filter(t => t.v > 0 && Number.isFinite(t.E)).sort((p, q) => p.v - q.v);
    const eAt = v => { if (!tab.length) return NaN; if (v <= tab[0].v) return tab[0].E; for (let i = 1; i < tab.length; i++) if (v <= tab[i].v) return tab[i - 1].E + (tab[i].E - tab[i - 1].E) * (v - tab[i - 1].v) / (tab[i].v - tab[i - 1].v); return NaN; };
    const SK = isNode ? require('./struktur.js') : root.MMPA.struktur;
    const speeds = []; { const v0 = 1.15 * vS, k = 6; for (let i = 0; i < k; i++) speeds.push(v0 * Math.pow(vMax / v0, i / (k - 1))); }
    const cdi = cl => V.trefftz(cl.map((v, i) => ({ a: [y[i] - w[i] / 2, z[i]], b: [y[i] + w[i] / 2, z[i]], gamma: v * c[i] / 2 })), r.wing.area);
    out.sweep = [];
    for (const v of speeds) {
      const q = qOfV(v), CL = mg / (0.5 * RHO * v * v * S), st = SK.stateFor(model, r, CL, v);
      const sp = DB.surface(model, profiles, r, 0, st, nCrit).slice().sort((p, q2) => p.y - q2.y);
      if (sp.length !== n) continue;
      const t = sp.map((s, i) => c[i] * w[i] * (c[i] * s.cm + s.cl * e[i]));
      const th = twist(q, t), th0 = rigid(q, t);
      if (!th) { out.sweep.push({ v, cl: CL, diverged: true }); continue; }
      // gleicher Gesamtauftrieb: Anstellwinkel nachführen
      const dA = -th.reduce((s, x, i) => s + a[i] * x * c[i] * w[i], 0) / a.reduce((s, x, i) => s + x * c[i] * w[i], 0);
      const cl0 = sp.map(s => s.cl), cl1 = cl0.map((x, i) => x + a[i] * (th[i] + dA));
      const mom = cl => cl.reduce((s, x, i) => s + x * c[i] * w[i] * y[i], 0);
      const dCdi = cdi(cl1) - cdi(cl0), E = eAt(v);
      out.sweep.push({ v, cl: CL, phi: th[n - 1] * DEG, phiRigid: th0[n - 1] * DEG, dAlpha: dA * DEG, dM: mom(cl1) / mom(cl0) - 1, dCdi, E, E2: Number.isFinite(E) ? CL / (CL / E + dCdi) : NaN, theta: th.map(x => x * DEG) });
    }
    out.ys = y;

    // Querruder: äusserste Klappe. Wirksamkeit = Rollmoment elastisch / starr
    const groups = SK.flapGroups(model.wing.stations), g = groups[groups.length - 1];
    if (g) {
      const d = flapDerivs(g.depth / 100), KV = 0.8;                 // 0,8: Zähigkeit mindert die Klappenwirkung
      const f = y.map((v, i) => Math.max(0, Math.min(g.y1, v + w[i] / 2) - Math.max(g.y0, v - w[i] / 2)) / w[i]);
      const cld = a.map((v, i) => f[i] * d.cl * KV * v / (2 * Math.PI));
      const t = c.map((v, i) => v * w[i] * (v * d.cm * KV * f[i] + cld[i] * e[i]));
      const R0 = cld.reduce((s, x, i) => s + x * c[i] * w[i] * y[i], 0);
      const eta = q => { const th = twist(q, t); return th ? 1 + th.reduce((s, x, i) => s + a[i] * x * c[i] * w[i] * y[i], 0) / R0 : NaN; };
      const vTop = Math.min(3 * vMax, 0.995 * (out.div ? out.div.v : Infinity));
      const curve = []; for (let i = 0; i <= 30; i++) { const v = vTop * i / 30; curve.push({ v, eta: eta(qOfV(v)) }); }
      const ail = { y0: g.y0, y1: g.y1, depth: g.depth, curve, etaMax: eta(qOfV(vMax)) };
      if (eta(qOfV(vTop)) < 0) {
        let lo = 0, hi = vTop;
        for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (eta(qOfV(mid)) > 0) lo = mid; else hi = mid; }
        ail.rev = (lo + hi) / 2;
      }
      out.aileron = ail;
    } else out.notes.push('Keine Klappe am Flügel eingetragen: Ruderwirksamkeit entfällt.');

    // Flatter-Richtwert am Schnitt bei 75 % der Halbspannweite (Theodorsen/Garrick-Näherung für kleines f Biegung / f Torsion)
    const yr = 0.75 * yTip, cr = lerpSt(rows, yr, 'chord') / 1000, b = cr / 2, mr = lerpSt(rows, yr, 'massPerM') * Pt.scale / 1000;
    const mu = mr / (Math.PI * RHO * b * b), r2 = 4 * (0.0625 + (xcg - xs) ** 2), d = 2 * (xcg - 0.25);
    out.flutter = { y: yr, mu, ratio: fr.fh / fr.ft };
    if (d > 0 && Number.isFinite(fr.ft)) out.flutter.v = b * 2 * Math.PI * fr.ft * Math.sqrt(mu * r2 / (2 * d));
    else out.notes.push('Schwerpunkt des Flügelschnitts bei oder vor t/4: klassisches Biege-Torsions-Flattern tritt nicht auf.');
    if (out.flutter.ratio > 0.7) out.notes.push('Biege- und Torsionsfrequenz liegen nahe beieinander: der Flatter-Richtwert ist dann zu optimistisch.');
    return out;
  }

  const api = { analyze, frequencies, flapDerivs };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).aeroelastik = api;
})(typeof self !== 'undefined' ? self : this);
