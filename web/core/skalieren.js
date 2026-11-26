// Ganzes Modell mit einem Faktor k skalieren: Flügel, Höhenleitwerk, Rumpf, Seitenleitwerk, Schwerpunktlage und der
// Aufbau (Holm, Steg, Verbinder, Lagengrenzen, Ruder-Trennstellen). Winkel, Profile (relativ zur Tiefe), Prozente,
// Stabilitätsmass und Ca bleiben. Flächen gehen mit k², Längen mit k.
// Bewusst nicht skaliert, weil es Halbzeug oder Bautechnik ist, das es nur in festen Stärken gibt:
// Schalenlagen (Furnier, Gewebe), Endleistendicke, Holmschlauch, Ruderhorn und Servoarm, Fläche je Anlenkung.
// Holm: Breite × k, Gurtdicke × k (bei Rovings: Anzahl × k², so bleibt die Gurtdicke geometrisch ähnlich).
// Masse: 'k3' gleiche Bauweise (Volumen), 'k2' gleiche Flächenbelastung, 'keep' unverändert, oder eine Zahl in g.
(function (root) {
  'use strict';

  const r2 = v => Math.round(v * 100) / 100;
  const sc = (o, keys, k) => { if (!o) return; for (const key of keys) if (typeof o[key] === 'number' && Number.isFinite(o[key])) o[key] = r2(o[key] * k); };

  function massOf(mass, k, mode = 'k3') {
    if (typeof mode === 'number' && mode > 0) return mode;
    if (mode === 'keep') return mass;
    return Math.round(mass * (mode === 'k2' ? k * k : k * k * k));
  }

  function scaleSurface(s, k) {
    if (!s) return;
    sc(s, ['x', 'z'], k);
    (s.stations || []).forEach(q => sc(q, ['y', 'chord', 'offset'], k));
    sc(s.build, ['ribs'], k);
    const S = s.struct;
    if (S) {
      const sp = S.spar;
      if (sp) {
        sc(sp, ['b', 't0', 't1'], k);
        for (const n of ['n0', 'n1']) if (typeof sp[n] === 'number') sp[n] = Math.max(1, Math.round(sp[n] * k * k));
        if (typeof sp.n0 === 'number' && typeof sp.n1 === 'number') sp.n1 = Math.min(sp.n0, sp.n1);
      }
      sc(S.web, ['t', 't1'], k);
      ((S.shell && S.shell.layers) || []).forEach(l => sc(l, ['y1'], k));
      (S.joiners || []).forEach(j => sc(j, ['y', 'd', 'di', 'b', 'h', 't', 'len'], k));
      if (S.joiner) sc(S.joiner, ['y', 'd', 'di', 'b', 'h', 't', 'len'], k);
      if (S.link && Array.isArray(S.link.cuts)) S.link.cuts = S.link.cuts.map(c => (typeof c === 'number' ? r2(c * k) : c));
    }
  }

  // Liefert eine skalierte Kopie; das Original bleibt unverändert.
  function scaleModel(model, k, opts = {}) {
    if (!(k > 0) || !Number.isFinite(k)) throw new Error('Faktor muss grösser als 0 sein');
    const m = JSON.parse(JSON.stringify(model));
    scaleSurface(m.wing, k);
    scaleSurface(m.tail, k);
    const f = m.fuselage;
    if (f) {
      sc(f, ['nose', 'diameter'], k);
      if (typeof f.fin === 'number') f.fin = r2(f.fin * k * k);   // dm²
      if (Array.isArray(f.table)) f.table.forEach(q => sc(q, ['x', 'w', 'h'], k));
      if (f.finGeo) { sc(f.finGeo, ['root', 'tip', 'height', 'x'], k); if (typeof f.finGeo.area === 'number') f.finGeo.area = r2(f.finGeo.area * k * k); }
    }
    if (m.cg) sc(m.cg, ['x'], k);
    sc(m.drag, ['spinner', 'prop'], k);
    sc(m.opt, ['minHeight'], k);
    sc(m.fusion, ['wing', 'tail'], k);
    if (typeof m.mass === 'number') m.mass = massOf(m.mass, k, opts.mass);
    return m;
  }

  const api = { scaleModel, massOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).skalieren = api;
})(typeof self !== 'undefined' ? self : this);
