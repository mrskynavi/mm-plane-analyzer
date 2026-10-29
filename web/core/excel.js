// Modell aus Christophs Excel-Blatt „Masse, SP“ übernehmen (z. B. SB10 M1_5.xls, lak19_15m.xls).
// Aufbau des Blatts: Spalten B (Root) bis G (5. Knick) und H (Randbogen),
// Zeilen 16–22 Flügel (Trapezlänge, Profiltiefe, Pfeilung = Lage der Nasenleiste, cmo, Schränkung, V-Form, Dicke),
// Zeilen 24–26 Höhenleitwerk, C12 Abstand Flügelwurzel-Endleiste bis HLW in dm, Gewichte F12, F13, H19, H27,
// B43 fester Schwerpunkt in mm. cell(adr) liefert den Wert einer Zelle (Formeln mit ihrem Ergebnis).
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const PR = isNode ? require('./projekt.js') : root.MMPA.projekt;

  const COLS = ['B', 'C', 'D', 'E', 'F', 'G'];
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);

  // Stationen einer Fläche aus den Zeilen Länge, Tiefe, Pfeilung (optional Schränkung, V-Form, Dicke)
  function surface(cell, r) {
    const len = c => num(cell(c + r.len)), st = [];
    let y = 0;
    const root = num(cell('B' + r.chord));
    if (!root) return [];
    st.push({ col: 'B', y: 0, chord: root, offset: num(cell('B' + r.off)) || 0 });
    for (const c of COLS.slice(1)) {
      const l = len(c), ch = num(cell(c + r.chord));
      if (!l || l <= 0 || !ch) continue; // Spalten ohne Trapezlänge sind leer oder Reste
      y += l;
      st.push({ col: c, y, chord: ch, offset: num(cell(c + r.off)) ?? st[st.length - 1].offset });
    }
    // Randbogen als letzte Station mit kleiner Tiefe; die Nasenleiste läuft nach hinten
    const lt = len('H');
    if (lt && lt > 0 && st.length) {
      const last = st[st.length - 1];
      const ch = num(cell('H' + r.chord)) || Math.max(5, 0.2 * last.chord);
      st.push({ col: 'H', y: y + lt, chord: ch, offset: num(cell('H' + r.off)) ?? last.offset + 0.6 * (last.chord - ch), tip: true });
    }
    return st;
  }

  function modelFromSheet(cell, { wingProfileId = null, tailProfileId = null, base = null } = {}) {
    const notes = [];
    const ws = surface(cell, { len: 16, chord: 17, off: 18 });
    if (ws.length < 2) throw new Error('Im Blatt „Masse, SP“ fehlen die Flügeldaten (Zeilen 16 bis 18)');
    const ts = surface(cell, { len: 24, chord: 25, off: 26 });
    const m = PR.createModel(String(cell('A3') || 'Excel-Modell').trim(), wingProfileId, tailProfileId);
    if (base) { m.tail.z = base.tail.z; m.clDesign = base.clDesign; m.cg = { ...base.cg }; }

    // V-Form und Schränkung: Spalte X gehört zum Trapez, das an Station X endet; Dicke gehört zur Station
    m.wing.stations = ws.map((s, i) => {
      const next = ws[i + 1];
      const dih = next ? num(cell(next.col + '21')) : null;
      const tw = num(cell(s.col + '20'));
      let th = num(cell(s.col + '22'));
      if (th == null && s.col === 'B') th = num(cell('C22'));
      if (th == null && i > 0) th = num(cell(ws[i - 1].col + '22')); // leere Dicke: wie die Station davor
      return PR.station(Math.round(s.y * 10) / 10, Math.round(s.chord * 10) / 10, Math.round(s.offset * 10) / 10, {
        dihedral: dih || 0, twist: tw || 0, profileId: wingProfileId, thickness: th ? th / 100 : null, flapDepth: 25, flap: 0,
      });
    });
    if (ts.length >= 2) {
      m.tail.stations = ts.map(s => PR.station(Math.round(s.y * 10) / 10, Math.round(s.chord * 10) / 10, Math.round(s.offset * 10) / 10, { profileId: tailProfileId }));
      // C12: Abstand von der Endleiste der Flügelwurzel bis zur Nasenleiste des HLW in dm
      const d = num(cell('C12'));
      if (d != null) m.tail.x = Math.round(d * 100 + ws[0].chord + ws[0].offset);
      else notes.push('Leitwerksabstand C12 fehlt, Standardwert übernommen');
    } else notes.push('keine HLW-Daten gefunden, Standardleitwerk übernommen');

    const mass = ['F12', 'F13', 'H19', 'H27'].map(a => num(cell(a)) || 0).reduce((a, b) => a + b, 0);
    if (mass > 0) m.mass = mass;
    const cg = num(cell('B43'));
    if (cg != null && cg > 0) m.cg = { mode: 'x', sigma: m.cg.sigma, x: cg };
    if (num(cell('B30'))) notes.push('Seitenleitwerk wird für Schwerpunkt und EWD nicht gebraucht und nicht übernommen');
    m.notes = notes.join('; ');
    return { model: m, notes };
  }

  const api = { modelFromSheet, surface };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).excel = api;
})(typeof self !== 'undefined' ? self : this);
