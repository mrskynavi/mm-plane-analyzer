// Prüfstand Festigkeit, Schritt F1: Materialbibliothek, Aufbau je Flügel/HLW und Lasten.
// Aufbau: Holm (Lage, Gurte oben/unten), Steg, Schale (Lagen), Füllung, Verbinder, Anlenkung. Daraus Masse je Meter.
// Lasten je Lastfall aus der linearen Streifenbasis der Modellrechnung (r.load) und dem Druckbild (Cm, Scharniermoment):
// Querkraft Q(y), Biegemoment M(y), Torsion T(y) um die Holmachse, Verbinder σ = M/W, Kraft an den Anlenkungen.
// Steifigkeit, Spannungen in Gurt/Steg/Schale und die Verformung folgen in F2.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const M = isNode ? require('./modell.js') : root.MMPA.modell;
  const P = isNode ? require('./profil.js') : root.MMPA.profil;
  const DB = isNode ? require('./druckbild.js') : root.MMPA.druckbild;

  const G0 = 9.81, RHO = 1.225;

  // Richtwerte (N/mm², kg/m³). E/G entlang der Faser bzw. bei 0/90, E45/G45 bei ±45°. Alle im Projekt überschreibbar.
  const MATERIALS = {
    'cfk-roving': { name: 'CFK-Rovings, handlaminiert', group: 'Faser', E: 110000, G: 4000, sigT: 1200, sigC: 700, tau: 50, rho: 1500 },
    'cfk-gewebe': { name: 'CFK-Gewebe', group: 'Faser', E: 50000, E45: 14000, G: 4000, G45: 22000, sigT: 500, sigC: 400, tau: 50, rho: 1450 },
    'gfk-gewebe': { name: 'GFK-Gewebe', group: 'Faser', E: 18000, E45: 9000, G: 3500, G45: 7500, sigT: 250, sigC: 200, tau: 40, rho: 1800 },
    'cfk-stab': { name: 'CFK-Stab/-Rohr pultrudiert', group: 'Halbfabrikat', E: 130000, G: 5000, sigT: 1800, sigC: 1100, tau: 60, rho: 1600 },
    'cfk-rohr-gew': { name: 'CFK-Rohr gewickelt', group: 'Halbfabrikat', E: 70000, G: 12000, sigT: 700, sigC: 500, tau: 60, rho: 1550 },
    'gfk-stab': { name: 'GFK-Stab pultrudiert', group: 'Halbfabrikat', E: 40000, G: 4000, sigT: 900, sigC: 500, tau: 50, rho: 2000 },
    'federstahl': { name: 'Federstahl', group: 'Metall', E: 210000, G: 80000, sigT: 1500, sigC: 1500, tau: 850, rho: 7850 },
    'alu-7075': { name: 'Alu 7075', group: 'Metall', E: 70000, G: 26000, sigT: 480, sigC: 480, tau: 280, rho: 2800 },
    'kiefer': { name: 'Kiefer', group: 'Holz', E: 10000, G: 600, sigT: 60, sigC: 40, tau: 8, rho: 500 },
    'abachi': { name: 'Abachi', group: 'Holz', E: 5000, G: 400, sigT: 40, sigC: 30, tau: 6, rho: 380 },
    'balsa': { name: 'Balsa mittel', group: 'Holz', E: 3000, G: 150, sigT: 15, sigC: 10, tau: 2, rho: 150 },
    'birke': { name: 'Birkensperrholz', group: 'Holz', E: 8000, G: 700, sigT: 50, sigC: 40, tau: 8, rho: 700 },
    'styro': { name: 'Styropor/Styrodur', group: 'Kern', E: 8, G: 3, sigT: 0.2, sigC: 0.15, tau: 0.15, rho: 30 },
  };
  const MAT_FIELDS = ['E', 'G', 'sigT', 'sigC', 'tau', 'rho'];
  // Bibliothek plus Änderungen und eigene Materialien des Projekts (project.materials = { id: { name?, E?, … } })
  function materials(project) {
    const out = {};
    for (const [id, m] of Object.entries(MATERIALS)) out[id] = { id, ...m };
    for (const [id, m] of Object.entries((project && project.materials) || {})) out[id] = { id, name: id, group: 'Eigene', ...(out[id] || {}), ...m, changed: !!MATERIALS[id], own: !MATERIALS[id] };
    return out;
  }

  // Querschnitte von Halbfabrikaten und Gurten (mm): Fläche A, Flächenmoment I und Widerstandsmoment W um die Querachse
  const FORMS = { rund: 'Rundstab', rohr: 'Rohr', vierkant: 'Vierkant/Flach', vierkantrohr: 'Vierkantrohr' };
  function section(q) {
    const f = q.form || 'rund', d = +q.d || 0, di = Math.min(+q.di || 0, d), b = +q.b || 0, h = +q.h || 0;
    const t = Math.min(+q.t || 0, b / 2, h / 2);
    let A, I, e;
    if (f === 'rund') { A = Math.PI * d * d / 4; I = Math.PI * d ** 4 / 64; e = d / 2; }
    else if (f === 'rohr') { A = Math.PI * (d * d - di * di) / 4; I = Math.PI * (d ** 4 - di ** 4) / 64; e = d / 2; }
    else if (f === 'vierkantrohr') { const bi = b - 2 * t, hi = h - 2 * t; A = b * h - bi * hi; I = (b * h ** 3 - bi * hi ** 3) / 12; e = h / 2; }
    else { A = b * h; I = b * h ** 3 / 12; e = h / 2; }
    return { A, I, W: e > 0 ? I / e : 0, height: f === 'rund' || f === 'rohr' ? d : h, width: f === 'rund' || f === 'rohr' ? d : b };
  }
  // Laminatquerschnitt aus Rovings: tex = g/km, Faserdichte 1,78 g/cm³, Faseranteil phi
  const rovingArea = (n, tex = 1600, phi = 0.5) => n * tex / 1e6 / 1.78e-3 / phi;

  // Vorlagen für den Aufbau
  const TEMPLATES = {
    schale: {
      label: 'Schalenflügel',
      spar: { pos: 30, mat: 'cfk-roving', b: 12, t0: 1.2, t1: 0.3 }, web: { mat: 'balsa', t: 3 },
      shell: { box: 'voll', layers: [{ mat: 'gfk-gewebe', t: 0.05, angle: 45 }, { mat: 'balsa', t: 1.0, angle: 0 }, { mat: 'gfk-gewebe', t: 0.03, angle: 45 }] },
      fill: 'hohl',
    },
    styro: {
      label: 'Styro/Abachi',
      spar: { pos: 30, mat: 'cfk-roving', b: 10, t0: 0.8, t1: 0.2 }, web: { mat: 'balsa', t: 2 },
      shell: { box: 'voll', layers: [{ mat: 'gfk-gewebe', t: 0.04, angle: 45 }, { mat: 'abachi', t: 0.6, angle: 0 }] },
      fill: 'styro',
    },
    rippen: {
      label: 'Rippen mit D-Box',
      spar: { pos: 30, mat: 'kiefer', b: 8, t0: 3, t1: 3 }, web: { mat: 'balsa', t: 1.5 },
      shell: { box: 'dbox', layers: [{ mat: 'balsa', t: 1.5, angle: 0 }] },
      fill: 'rippen',
    },
  };
  const JOINER = { wing: { mat: 'federstahl', form: 'rund', d: 8, di: 6, b: 10, h: 8, t: 1, len: 160, n: 1 }, tail: { mat: 'cfk-stab', form: 'rund', d: 4, di: 2, b: 4, h: 4, t: 1, len: 60, n: 1 } };
  const LINK = { horn: 12, arm: 10 };
  const LOADS = { n: 30, vMax: 60, gust: 10, nLand: 6, tow: 0, flap: 10, elev: 15 };

  // Aufbau einer Fläche mit Vorgaben. part = 'wing' | 'tail'
  function structOf(model, part) {
    const S = model[part] || {}, s = S.struct || {};
    const tpl = TEMPLATES[s.template] ? s.template : (S.build && S.build.type === 'rippen' ? 'rippen' : part === 'tail' ? 'styro' : 'schale');
    const T = TEMPLATES[tpl];
    return {
      template: tpl,
      spar: { ...T.spar, ...(s.spar || {}) },
      web: { ...T.web, ...(s.web || {}) },
      shell: { box: (s.shell && s.shell.box) || T.shell.box, layers: (s.shell && Array.isArray(s.shell.layers) ? s.shell.layers : T.shell.layers).map(l => ({ ...l })) },
      fill: s.fill || T.fill,
      ribs: s.ribs ?? (S.build && S.build.ribs) ?? 60, ribT: s.ribT ?? 2,
      joiner: { ...JOINER[part], ...(s.joiner || {}) },
      link: { ...LINK, ...(s.link || {}) },
      mass: Number.isFinite(s.mass) && s.mass > 0 ? s.mass : null, // gewogene Masse beider Hälften in g
    };
  }
  const loadsOf = model => ({ ...LOADS, ...(model.loads || {}) });

  // Umfang, Fläche und Holmhöhe des Profils einer Station (bezogen auf Tiefe 1)
  function contour(geo, pos) {
    let per = 0, perBox = 0, area = 0;
    for (let i = 1; i < geo.length; i++) {
      const a = geo[i - 1], b = geo[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      per += d; if ((a[0] + b[0]) / 2 <= pos) perBox += d;
      area += a[0] * b[1] - b[0] * a[1];
    }
    return { per, perBox, area: Math.abs(area) / 2, t: P.thicknessCamber(geo, [pos]).t[0] };
  }

  // Querschnitt und Masse je Meter an jeder Station einer Fläche
  function stations(model, profiles, part, mats) {
    const S = structOf(model, part), st = model[part].stations;
    const yEnd = st[st.length - 1].y || 1;
    const rho = id => (mats[id] ? mats[id].rho : 0);
    const tShell = S.shell.layers.reduce((a, l) => a + (+l.t || 0), 0);
    const mShell = S.shell.layers.reduce((a, l) => a + (+l.t || 0) * rho(l.mat), 0); // g/m² je mm·kg/m³ = g/m²
    return st.map(q => {
      const g = M.stationGeometry(q, profiles);
      const c = g ? contour(g.geo, S.spar.pos / 100) : { per: 2.05, perBox: 0.65, area: 0.07, t: 0.1 };
      const f = Math.min(1, Math.max(0, q.y / yEnd));
      const tCap = S.spar.t0 + (S.spar.t1 - S.spar.t0) * f;
      const hOut = c.t * q.chord - 2 * tShell;                     // Holmhöhe aussen (unter der Schale)
      const aCap = S.spar.b * Math.max(0, Math.min(tCap, hOut / 2)); // je Gurt
      const hWeb = Math.max(0, hOut - 2 * tCap);
      const per = (S.shell.box === 'dbox' ? c.perBox : c.per) * q.chord;
      const aProf = c.area * q.chord * q.chord;
      // Masse je Meter Spannweite in g/m: mm² · kg/m³ = mg/m
      let mm = (2 * aCap * rho(S.spar.mat) + hWeb * (+S.web.t || 0) * rho(S.web.mat)) / 1000 + per / 1000 * mShell;
      if (S.fill === 'styro') mm += aProf * rho('styro') / 1000;
      if (S.fill === 'rippen') mm += aProf * 0.6 * S.ribT / Math.max(10, S.ribs) * rho('balsa') / 1000;
      return { y: q.y, chord: q.chord, tCap, hOut, hWeb, aCap, perimeter: per, tShell, massPerM: mm };
    });
  }
  const lerpSt = (rows, y, k) => {
    let i = 1; while (i < rows.length - 1 && y > rows[i].y) i++;
    const a = rows[i - 1], b = rows[i], t = Math.min(1, Math.max(0, (y - a.y) / ((b.y - a.y) || 1)));
    return a[k] + (b[k] - a[k]) * t;
  };
  // Masse beider Hälften in g (Trapezregel über die Stationen), ohne Verbinder
  function massOf(rows) {
    let m = 0;
    for (let i = 1; i < rows.length; i++) m += (rows[i - 1].massPerM + rows[i].massPerM) / 2 * (rows[i].y - rows[i - 1].y) / 1000;
    return 2 * m;
  }

  // Leitwerkseinstellung als Gerade über α aus Trimm und Arbeitstabelle (im linearen Modell exakt)
  function trimLine(model, r) {
    const inc = model.wing.incidence || 0;
    const pts = [[r.trim.alpha, r.trim.tailIncidence], ...(r.table || []).map(t => [t.alpha, inc - t.ewdCur])].filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0), den = n * sxx - sx * sx;
    const b = n >= 2 && Math.abs(den) > 1e-9 ? (n * sxy - sx * sy) / den : 0;
    return { a: (sy - b * sx) / n, b };
  }
  // Flugzustand für Gesamt-Ca bei Fahrt v
  function stateFor(model, r, cl, v) {
    const L = r.load, tl = trimLine(model, r);
    const alpha = (cl - L.CL0 - tl.a * L.CLi) / (L.CLa + tl.b * L.CLi);
    return { key: 'x', alpha, it: tl.a + tl.b * alpha, v, cl };
  }

  // Q, M, T einer Halbfläche aus Streifenlasten. strips: [{ y, width, lift N, weight N, torque Nm }]
  function beam(strips, ys) {
    const Q = [], Mb = [], T = [];
    for (const y of ys) {
      let q = 0, m = 0, t = 0;
      for (const s of strips) {
        const y0 = s.y - s.width / 2, y1 = s.y + s.width / 2;
        if (y1 <= y) continue;
        const part = y0 >= y ? 1 : (y1 - y) / s.width, yc = y0 >= y ? s.y : (y + y1) / 2;
        const p = (s.lift - s.weight) * part;
        q += p; m += p * (yc - y) / 1000; t += s.torque * part;
      }
      Q.push(q); Mb.push(m); T.push(t);
    }
    return { Q, M: Mb, T };
  }

  // Zusammenhängende Klappen einer Fläche (Segmente mit Klappentiefe, getrennt wo flapMix oder Tiefe wechselt)
  function flapGroups(st) {
    const out = [];
    for (let i = 0; i < st.length - 1; i++) {
      const s = st[i];
      if (!(s.flapDepth > 0)) continue;
      const last = out[out.length - 1];
      if (last && last.to === i && (st[i - 1].flapMix ?? 1) === (s.flapMix ?? 1)) { last.to = i + 1; last.y1 = st[i + 1].y; last.segs.push(i); }
      else out.push({ from: i, to: i + 1, y0: s.y, y1: st[i + 1].y, depth: s.flapDepth, segs: [i] });
    }
    return out;
  }

  function analyze(model, profiles, r, { nCrit = 9, project = null } = {}) {
    if (!r || !r.load) throw new Error('Modellrechnung fehlt');
    model = M.resolveTe(model);
    const mats = materials(project || { materials: model.materials });
    const Ld = loadsOf(model), mass = model.mass / 1000, mg = mass * G0, S = r.wing.area / 1e6;
    const clMax = r.stall > 0 ? r.trim.CL / r.stall : 1.2;
    const qOf = v => 0.5 * RHO * v * v;
    const vS = Math.sqrt(2 * mg / (RHO * S * clMax));
    const vA = vS * Math.sqrt(Ld.n);                       // Fahrt, ab der n erreichbar ist
    const nReach = (Ld.vMax / vS) ** 2;                    // bei V max erreichbar
    const aRad = r.load.CLa * 180 / Math.PI;
    const nGust = 1 + RHO * Ld.vMax * Ld.gust * aRad / (2 * mg / S);

    // Lastfälle: Lastvielfaches, Fahrt, Auftrieb ja/nein
    const cases = [];
    const nA = Math.min(Ld.n, nReach);
    cases.push({ key: 'abfangen', label: 'Abfangen bei Ca max', n: nA, v: Math.min(vA, Ld.vMax), note: Ld.n > nReach ? `n ${fmt(Ld.n)} ist bis ${fmt(Ld.vMax * 3.6, 0)} km/h nicht erreichbar, gerechnet mit n ${fmt(nA)}` : `ab ${fmt(vA * 3.6, 0)} km/h erreichbar` });
    if (vA < Ld.vMax * 0.98) cases.push({ key: 'abfangen-v', label: 'Abfangen bei V max', n: Ld.n, v: Ld.vMax, note: 'kleines Ca, mehr Torsion' });
    cases.push({ key: 'boee', label: 'Böe bei V max', n: Math.min(nGust, nReach), v: Ld.vMax, note: `Böe ${fmt(Ld.gust)} m/s senkrecht` });
    cases.push({ key: 'speed', label: 'Schnellflug', n: 1, v: Ld.vMax, note: 'Torsion aus dem Profilmoment' });
    if (Ld.tow > 0) { const nT = Math.min(1 + Ld.tow / mg, nReach); cases.push({ key: 'hochstart', label: 'Hochstart/Winde', n: nT, v: Math.max(vS * Math.sqrt(nT), vS), note: `Seilzug ${fmt(Ld.tow, 0)} N` }); }
    cases.push({ key: 'landung', label: 'Landung', n: Ld.nLand, v: 0, ground: true, note: 'nur Trägheit der Fläche, nach unten' });

    const parts = {};
    for (const [surf, part] of [[0, 'wing'], [1, 'tail']]) {
      const str = structOf(model, part), rows = stations(model, profiles, part, mats);
      const calc = massOf(rows), scale = str.mass && calc > 0 ? str.mass / calc : 1;
      const yEnd = rows[rows.length - 1].y, N = 40, ys = Array.from({ length: N + 1 }, (_, i) => yEnd * i / N);
      parts[part] = { struct: str, stations: rows, massCalc: calc, mass: str.mass || calc, ys, cases: [], surf, scale };
    }

    for (const c of cases) {
      const q = qOf(c.v), cl = c.ground ? 0 : c.n * mg / (q * S);
      const state = c.ground ? null : stateFor(model, r, cl, c.v);
      for (const part of ['wing', 'tail']) {
        const Pt = parts[part], xs = Pt.struct.spar.pos / 100;
        let strips;
        if (c.ground) {
          const L = r.load; strips = [];
          for (let i = 0; i < L.surf.length; i++) if (L.surf[i] === Pt.surf) strips.push({ y: L.y[i], width: L.width[i], chord: L.chord[i], lift: 0, torque: 0 });
        } else {
          strips = DB.surface(model, profiles, r, Pt.surf, state, nCrit).map(s => {
            const A = s.chord * s.width / 1e6, lift = q * s.cl * A;
            return { y: s.y, width: s.width, chord: s.chord, lift, torque: q * A * s.chord / 1000 * s.cm + lift * (xs - 0.25) * s.chord / 1000 };
          });
        }
        strips.forEach(s => { s.weight = (c.ground ? -1 : 1) * c.n * G0 * lerpSt(Pt.stations, s.y, 'massPerM') * Pt.scale * s.width / 1e6; });
        // Landung: die Fläche will nach unten weiter, die Last zeigt nach unten
        if (c.ground) strips.forEach(s => { s.weight = Math.abs(s.weight); });
        const b = beam(strips, Pt.ys);
        Pt.cases.push({ ...c, cl, alpha: state ? state.alpha : null, lift: 2 * strips.reduce((a, s) => a + s.lift, 0), ...b, rootQ: b.Q[0], rootM: b.M[0], rootT: b.T[0] });
      }
    }

    // Verbinder: Nennspannung im ungünstigsten Lastfall
    for (const part of ['wing', 'tail']) {
      const Pt = parts[part], j = Pt.struct.joiner, sec = section(j), mat = mats[j.mat] || mats.federstahl, n = Math.max(1, j.n || 1);
      const worst = Pt.cases.reduce((m, c) => (Math.abs(c.rootM) > Math.abs(m.rootM) ? c : m), Pt.cases[0]);
      const Mr = Math.abs(worst.rootM) * 1000, Qr = Math.abs(worst.rootQ);
      const sigma = sec.W > 0 ? Mr / (n * sec.W) : Infinity, tau = sec.A > 0 ? Qr / (n * sec.A) : Infinity;
      const allow = Math.min(mat.sigT, mat.sigC);
      Pt.joiner = {
        ...sec, mat: mat.name, sigma, tau, allow, reserve: allow / sigma, reserveTau: mat.tau / tau, case: worst.label, M: Mr / 1000, Q: Qr,
        bearing: j.len > 0 ? (6 * Mr / (sec.width * j.len * j.len) + Qr / (sec.width * j.len)) / n : null, // Lochleibung an der Kastenkante, N/mm²
        mass: n * sec.A * (j.len * 2) / 1e6 * mat.rho, // g, Länge beidseitig im Kasten
      };
    }

    // Anlenkungen: Scharniermoment je Klappe bei V max mit vollem Ausschlag, beide Richtungen
    const servo = [];
    const qV = qOf(Ld.vMax), stV = stateFor(model, r, mg / (qV * S), Ld.vMax);
    for (const [surf, part, defl] of [[0, 'wing', Ld.flap], [1, 'tail', Ld.elev]]) {
      const st = model[part].stations, groups = flapGroups(st), link = parts[part].struct.link;
      if (!groups.length) continue;
      const pend = part === 'tail' && model.tail.elevator && model.tail.elevator.type === 'pendel';
      const run = d => DB.surface(model, profiles, r, surf, stV, nCrit, () => d);
      const up = run(-defl), down = run(defl);
      groups.forEach((g, k) => {
        const mom = strips => strips.filter(s => g.segs.includes(s.seg) && Number.isFinite(s.ch)).reduce((a, s) => a + qV * s.ch * s.chord * s.chord * s.width / 1e9, 0);
        const mU = mom(up), mD = mom(down), mh = Math.abs(mU) > Math.abs(mD) ? mU : mD;
        const force = Math.abs(mh) * 1000 / link.horn, torque = force * link.arm / 10; // N, Ncm
        servo.push({ part, name: (part === 'wing' ? 'Flügel Klappe ' : 'Höhenruder ') + (groups.length > 1 ? k + 1 : '').toString().trim(), y0: g.y0, y1: g.y1, depth: g.depth, defl, v: Ld.vMax, moment: mh, momentUp: mU, momentDown: mD, force, torque, kgcm: torque / G0, horn: link.horn, arm: link.arm, pendel: !!pend });
      });
    }

    return { wing: parts.wing, tail: parts.tail, servo, meta: { clMax, vS, vA, nReach, nGust, loads: Ld, mass } };
  }
  function fmt(v, d = 1) { return Number(v).toFixed(d).replace('.', ','); }

  const api = { MATERIALS, MAT_FIELDS, FORMS, TEMPLATES, JOINER, LINK, LOADS, materials, section, rovingArea, structOf, loadsOf, stations, massOf, trimLine, stateFor, beam, flapGroups, analyze };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).struktur = api;
})(typeof self !== 'undefined' ? self : this);
