// Rumpf als feste Form mit wenigen Parametern: Stabrumpf, moderner Segler oder Oldtimer.
// Moderner Segler: spitze Nase, grösster Querschnitt an den Schultern des Piloten weit vor dem Flügel, lange weiche
// Einschnürung bis hinter die Endleiste, dann ein schlanker Leitwerksträger bis zum Seitenleitwerk.
// Oldtimer (etwa Moswey 3, Grunau Baby, Spalinger): kurze stumpfe Nase, Pilot unter der Nasenleiste, grösster
// Querschnitt unter dem Flügel, dann ein gerade auslaufender Holzrumpf bis zum Ruder, das hinter das Höhenleitwerk reicht.
// Liefert die Kontur (Radius über x), den Widerstand nach Hoerner und das Rumpfmoment nach Multhopp
// mit dem Auf- und Abwind aus dem Wirbelgitter. x in mm ab der Nasenleiste der Flügelwurzel, nach hinten positiv.
(function (root) {
  'use strict';

  const NU = 1.5e-5;
  // Standardwerte je Form, bezogen auf die Wurzeltiefe c: grösster Durchmesser d, Länge vor dem Flügel nose,
  // Leitwerksträger am Ende (boom) und hinter dem Flügel (cone) als Anteil von d, laminarer Anlauf, Zuschlag
  // für Haube, Kanten und Übergänge (extra), Breite zu Durchmesser in der Draufsicht (width; der Querschnitt ist
  // hochoval, gerechnet wird mit einem Kreis gleicher Fläche).
  // Oldtimer: turbulente Grenzschicht (Holz, Stoff, Spalte), 20 % für Haube mit Stufe, Kufe, Flügelanschluss ohne Ausrundung.
  const TYPES = {
    stab: { name: 'Stabrumpf', d: 0.2, nose: 1.8, boom: 0.4, laminar: true, extra: 1.0, width: 1 },
    modern: { name: 'Moderner Segler', d: 0.55, nose: 1.8, cone: 0.4, boom: 0.2, laminar: true, extra: 1.0, width: 0.87 },
    oldtimer: { name: 'Oldtimer', d: 0.62, nose: 1.4, boom: 0.28, laminar: false, extra: 1.2, width: 0.78 },
  };
  // frühere Formen: Keule klein war der moderne Segler, Keule gross der ältere Segler
  const LEGACY = { 'keule-klein': 'modern', 'keule-gross': 'oldtimer' };
  const typeOf = t => TYPES[t] ? t : LEGACY[t] || 'modern';

  const defaults = model => {
    const t = TYPES[typeOf(model.fuselage?.type)];
    return { type: 'modern', nose: Math.round(t.nose * model.wing.stations[0].chord / 10) * 10, diameter: null, fin: null };
  };
  const of = model => {
    const f = { ...defaults(model), ...(model.fuselage || {}) };
    return { ...f, type: typeOf(f.type) };
  };

  // Kontur: Punkte { x, r } von der Nase bis zum Ende am Seitenleitwerk
  function shape(model) {
    const f = of(model), t = TYPES[f.type];
    const c = model.wing.stations[0].chord;
    const D = f.diameter || Math.round(t.d * c), R = D / 2, Rb = R * t.boom;
    const x0 = -f.nose, tc = model.tail.stations[0] ? model.tail.stations[0].chord : 0.6 * c;
    // Oldtimer: das Seitenruder reicht hinter das Höhenleitwerk
    const x3 = Math.max(model.tail.x + (model.tail.stations[0]?.offset || 0) + tc * (f.type === 'oldtimer' ? 1.3 : 1), c * 1.5);
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
      } else if (f.type === 'oldtimer') {
        // stumpfe Nase bis kurz vor die Nasenleiste, gleich breit bis zum Holm, dann gerade auslaufend
        const xm = x0 + Math.max(0.9 * f.nose, 0.6 * D), xp = Math.max(xm, 0.3 * c), cap = xm - x0;
        const g = v => (v < 0.2 ? v * v / 0.4 : v - 0.1) / 0.9; // Gerade mit weichem Anfang
        if (x < xm) r = R * Math.sqrt(Math.max(0, 1 - ((xm - x) / cap) ** 2)) ** 0.8;
        else if (x < xp) r = R;
        else r = R + (Rb - R) * g(Math.min(1, (x - xp) / Math.max(1, x3 - xp)));
      } else {
        // moderner Segler: spitz zulaufende Nase bis zu den Schultern, dann ohne zylindrisches Stück weich
        // eingeschnürt bis hinter die Endleiste und als schlanker Kegel bis zum Leitwerk
        const cap = Math.max(0.55 * f.nose, 0.6 * D), xs = x0 + cap;
        const xc = Math.max(xs + 0.6 * c, 1.25 * c), Rc = R * t.cone;
        if (x < xs) r = R * Math.max(0, 1 - ((xs - x) / cap) ** 2) ** 0.6;
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
    return { ...f, typeName: t.name, D, Rb, x0, x3, length: x3 - x0, pts, swet, sPod, sBoom: swet - sPod, podLength: podEnd - x0, laminar: t.laminar, extra: t.extra, width: t.width };
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

  // Zusatzwiderstände, die weder Profil noch Rumpf erfassen. Widerstandsflächen Cw·A in cm²:
  // Klappluftschraube angeklappt 0,25 · Spinnerfläche (Blattwurzeln, Mitnehmer, Stufe am Spinner),
  // starre Luftschraube stehend 0,06 · Kreisfläche (Zweiblatt), aussenliegende Anlenkung je Stück 0,4 (Horn,
  // Gabelkopf, Gestänge). Offene Ruderspalte: Cw +0,0008 auf die Fläche mit Rudern (Klappentiefe > 0).
  // Faktor auf den Profilwiderstand (Welligkeit, Lack, Turbulatoren) und Zuschlag in Prozent auf allen
  // schädlichen Widerstand (Haube, Übergänge, Kupplung, Rad, Antenne).
  const DRIVES = { keiner: 'kein Antrieb vorn', klapp: 'Klappluftschraube', starr: 'starre Luftschraube' };
  const EXTRAS = { profile: 1, other: 0, span: 1, fusAoa: 0, lowRe: 0, drive: 'keiner', spinner: 40, prop: 350, horns: 0, horn: 0.4, gaps: 'abgedeckt' };
  const extrasOf = model => ({ ...EXTRAS, ...(model.drag || {}) });
  const ruddered = stations => {
    let a = 0;
    for (let i = 1; i < stations.length; i++) if (stations[i - 1].flapDepth > 0) a += (stations[i - 1].chord + stations[i].chord) / 2 * Math.abs(stations[i].y - stations[i - 1].y);
    return 2 * a;
  };
  // Feste Zuschläge als Cw auf die Flügelfläche sRef (mm²), unabhängig vom Ca
  function extraFixed(model, sRef) {
    const x = extrasOf(model), disc = d => Math.PI / 4 * d * d;
    const drive = x.drive === 'klapp' ? 0.25 * disc(x.spinner) : x.drive === 'starr' ? 0.06 * disc(x.prop) : 0;
    const horns = (x.horns || 0) * x.horn * 100;
    const gaps = x.gaps === 'offen' ? 0.0008 * (ruddered(model.wing.stations) + ruddered(model.tail.stations)) : 0;
    return { drive: drive / sRef, horns: horns / sRef, gaps: gaps / sRef };
  }
  // Teilwiderstände eines Arbeitspunkts mit Zuschlägen: Profile mal Faktor, dazu cdx (Antrieb, Anlenkungen,
  // Spalte und Prozent-Zuschlag); base ist der Widerstand ohne alle Zuschläge
  // Zuschlag kleine Re (Ablöseblasen) auf den Profilwiderstand eines Flügelstreifens: lowRe in % bei Re 100'000
  // und Ca 1,0, wächst umgekehrt mit der Re (höchstens das Vierfache) und quadratisch mit dem Ca über 0,4.
  // Gibt eine Funktion (cd, cl, re) → cd zurück, oder null ohne Zuschlag.
  function lowReDrag(model) {
    const k = (extrasOf(model).lowRe || 0) / 100;
    if (!(k > 0)) return null;
    return (cd, cl, re) => cd * (1 + k * Math.min(4, 1e5 / Math.max(re, 1)) * Math.max(0, (cl - 0.4) / 0.6) ** 2);
  }

  // alpha: Anstellwinkel des Rumpfs (Modellachse) in Grad, für den Rumpfzuschlag im Langsamflug.
  // span: Spannweiten-Wirkungsgrad gegenüber der Rechnung (1 = wie gerechnet), der induzierte Widerstand wird durch span geteilt.
  // fusAoa: Zuschlag auf den Rumpfwiderstand in % bei 5° Anstellwinkel, wächst mit dem Quadrat des Winkels.
  function withExtras(model, sRef, { cdi, cdw, cdt, cdf, cdv }, alpha = 0) {
    const x = extrasOf(model), f = extraFixed(model, sRef), pf = x.profile > 0 ? x.profile : 1;
    const e = x.span > 0 ? x.span : 1, i = cdi / e, fu = cdf * (1 + (x.fusAoa || 0) / 100 * (alpha / 5) ** 2);
    const w = cdw * pf, t = cdt * pf, v = cdv * pf, fixed = f.drive + f.horns + f.gaps;
    const cdx = fixed + (x.other || 0) / 100 * (w + t + fu + v + fixed);
    return { cdi: i, cdf: fu, cdw: w, cdt: t, cdv: v, cdx, cd: i + w + t + fu + v + cdx, base: cdi + cdw + cdt + cdf + cdv };
  }

  const api = { TYPES, LEGACY, typeOf, defaults, of, shape, drag, finDrag, finChord, finArea, moment, cf, DRIVES, EXTRAS, extrasOf, extraFixed, withExtras, lowReDrag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).rumpf = api;
})(typeof self !== 'undefined' ? self : this);
