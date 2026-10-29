// Rumpf als feste Form mit wenigen Parametern: Stabrumpf, Keulenrumpf mit kleinem oder grossem Stirnwiderstand.
// Die Keulen sind wie ein manntragender Segler geformt: Cockpit mit dem grössten Querschnitt vor dem Flügel,
// Einschnürung unter dem Flügel, dann ein konischer Leitwerksträger bis zum Höhenleitwerk.
// Liefert die Kontur (Radius über x), den Widerstand nach Hoerner und das Rumpfmoment nach Multhopp
// mit dem Auf- und Abwind aus dem Wirbelgitter. x in mm ab der Nasenleiste der Flügelwurzel, nach hinten positiv.
(function (root) {
  'use strict';

  const NU = 1.5e-5;
  // Standardwerte je Form, bezogen auf die Wurzeltiefe c: grösster Durchmesser d, Leitwerksträger am Ende (boom)
  // und hinter dem Flügel (cone) als Anteil von d, Nasenkappe als Anteil der Nasenlänge, laminarer Anlauf,
  // Zuschlag für Haube und Kanten
  const TYPES = {
    stab: { name: 'Stabrumpf', d: 0.2, boom: 0.4, laminar: true, extra: 1.0 },
    'keule-klein': { name: 'Keulenrumpf, kleiner Stirnwiderstand', d: 0.55, cone: 0.4, boom: 0.2, cap: 0.5, laminar: true, extra: 1.0 },
    'keule-gross': { name: 'Keulenrumpf, grosser Stirnwiderstand', d: 0.7, cone: 0.5, boom: 0.28, cap: 0.35, laminar: false, extra: 1.1 },
  };

  const defaults = model => ({ type: 'keule-klein', nose: Math.round(1.8 * model.wing.stations[0].chord / 10) * 10, diameter: null, fin: null });
  const of = model => ({ ...defaults(model), ...(model.fuselage || {}) });

  // Kontur: Punkte { x, r } von der Nase bis zum Ende am Höhenleitwerk
  function shape(model) {
    const f = of(model), t = TYPES[f.type] || TYPES['keule-klein'];
    const c = model.wing.stations[0].chord;
    const D = f.diameter || Math.round(t.d * c), R = D / 2, Rb = R * t.boom;
    const x0 = -f.nose, tc = model.tail.stations[0] ? model.tail.stations[0].chord : 0.6 * c;
    const x3 = Math.max(model.tail.x + (model.tail.stations[0]?.offset || 0) + tc, c * 1.5);
    const n = 120, pts = [];
    const ease = u => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2; // weicher Übergang 0 → 1
    for (let i = 0; i <= n; i++) {
      const x = x0 + (x3 - x0) * (1 - Math.cos(Math.PI * i / n)) / 2; // dichter an Nase und Ende
      let r;
      if (f.type === 'stab') {
        // Gondel: elliptische Nase, zylindrisch bis hinter den Flügel, dann kurz auf den dünnen Leitwerksträger
        const cap = Math.min(f.nose, 2.5 * D), xe = 0.5 * c, xt = xe + 0.8 * c;
        if (x < x0 + cap) r = R * Math.sqrt(Math.max(0, 1 - ((x0 + cap - x) / cap) ** 2));
        else if (x < xe) r = R;
        else if (x < xt) r = R + (Rb - R) * ease((x - xe) / (xt - xe));
        else r = Rb * (1 - 0.2 * (x - xt) / Math.max(1, x3 - xt));
      } else {
        // Segler: Nasenkappe bis zum Cockpit, grösster Querschnitt bis zur Schulter, Einschnürung bis kurz hinter
        // die Endleiste, dann gerader Kegel bis zum Leitwerk
        const cap = Math.max(D / 2, t.cap * f.nose), xs = x0 + Math.max(cap, 0.6 * f.nose);
        const xc = Math.max(xs + 0.5 * c, 1.3 * c), Rc = R * t.cone;
        if (x < x0 + cap) r = R * Math.sqrt(Math.max(0, 1 - ((x0 + cap - x) / cap) ** 2));
        else if (x < xs) r = R;
        else if (x < xc) r = R + (Rc - R) * ease((x - xs) / (xc - xs));
        else r = Rc + (Rb - Rc) * (x - xc) / Math.max(1, x3 - xc);
      }
      pts.push({ x, r });
    }
    // Benetzte Fläche und Teilung in Gondel (r > 1,5·Leitwerksträger) und Leitwerksträger
    let swet = 0, sPod = 0, podEnd = x0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], ds = Math.hypot(b.x - a.x, b.r - a.r), dA = Math.PI * (a.r + b.r) * ds;
      swet += dA;
      if (Math.max(a.r, b.r) > 1.5 * Rb) { sPod += dA; podEnd = b.x; }
    }
    return { ...f, typeName: t.name, D, Rb, x0, x3, length: x3 - x0, pts, swet, sPod, sBoom: swet - sPod, podLength: podEnd - x0, laminar: t.laminar, extra: t.extra };
  }

  // Reibungsbeiwert einer Platte: turbulent nach Schlichting, mit laminarem Anlauf bis Re 500 000; darunter laminar
  const cf = (re, laminar) => {
    if (!laminar) return 0.455 / Math.log10(re) ** 2.58;
    return re < 5e5 ? 1.328 / Math.sqrt(re) : 0.455 / Math.log10(re) ** 2.58 - 1700 / re;
  };

  // Rumpfwiderstand bezogen auf die Flügelfläche sRef (mm²) bei v (m/s)
  function drag(sh, v, sRef) {
    const re = v * sh.length / 1000 / NU;
    const c = cf(re, sh.laminar), ff = f => 1 + 1.5 / f ** 1.5 + 7 / f ** 3; // Hoerner, Formfaktor eines Rotationskörpers
    // Stabrumpf: Gondel mit ihrer Schlankheit, Rohr wie eine Platte; Segler: ein Körper über die ganze Länge
    if (sh.type !== 'stab') return c * ff(sh.length / sh.D) * sh.swet * sh.extra / sRef;
    return c * (ff(sh.podLength / sh.D) * sh.sPod * sh.extra + 1.02 * sh.sBoom) / sRef;
  }

  // Seitenleitwerk ohne Auftrieb: Fläche in dm², mittlere Tiefe bei Streckung 1,4 (Höhe/Tiefe).
  // cd0(re) liefert den Profilwiderstand bei Ca 0 (Leitwerksprofil), sonst Platte mit Dickenzuschlag 9 %.
  const finChord = area => Math.sqrt(area * 1e4 / 1.4);
  function finDrag(area, v, sRef, cd0 = null) {
    if (!area) return 0;
    const re = v * finChord(area) / 1000 / NU;
    const cd = (cd0 && cd0(re)) || 2 * Math.max(cf(re, true), 0.455 / Math.log10(re) ** 2.58 * 0.6) * (1 + 2 * 0.09 + 60 * 0.09 ** 4);
    return cd * area * 1e4 / sRef;
  }
  // Seitenleitwerk automatisch: bei V-Leitwerk keins, sonst etwa 60 % der HLW-Fläche
  const finArea = (model, tailArea) => {
    const f = of(model);
    if (f.fin != null) return f.fin;
    const vtail = model.tail.stations.some(s => (s.dihedral || 0) > 25);
    return vtail ? 0 : Math.round(0.6 * tailArea / 1e4 * 10) / 10;
  };

  // Rumpfmoment nach Multhopp: dCm = π/2 · w² · β · dx / (S·lμ), β = örtlicher Anströmwinkel aus α und dem Auf-/Abwind
  // des Wirbelgitters. Über dem Flügel (Wurzel Nase bis Endleiste) und ab dem Leitwerk zählt der Rumpf nicht.
  // flow(x) liefert den Anströmwinkel in rad an der Rumpfachse.
  function moment(sh, flow, { sRef, cRef, wingRoot, tailLe }) {
    let m = 0;
    for (let i = 1; i < sh.pts.length; i++) {
      const a = sh.pts[i - 1], b = sh.pts[i], x = (a.x + b.x) / 2;
      if ((x > wingRoot[0] && x < wingRoot[1]) || x > tailLe) continue;
      const w = a.r + b.r;
      m += Math.PI / 2 * w * w * flow(x) * (b.x - a.x);
    }
    return m / (sRef * cRef);
  }

  const api = { TYPES, defaults, of, shape, drag, finDrag, finChord, finArea, moment, cf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).rumpf = api;
})(typeof self !== 'undefined' ? self : this);
