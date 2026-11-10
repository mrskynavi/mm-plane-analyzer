// StepFour-Flügeldatei (.sfw, „SFW1.60“) einlesen: Flügelteil mit Trapezen, wie Christoph die SB-10 geliefert hat.
// Aufbau (Zeilen, Komma getrennt, Dezimalpunkt):
//   SFW1.60 · Name · leer · Anzahl Trapeze · Lage im Block (nicht gebraucht) · Gesamtlänge, Wurzeltiefe · 0
//   Wurzelprofil: Pfad\NAME.KOO, Tiefe mm, Dicke %, Wölbung %, Schränkung °
//   je Trapez: Endprofil (wie oben), dann Schneidedaten, dann „Länge, Versatz Nasenleiste, …“ und zwei Zeilen
//   Maschinendaten. Versatz positiv = Nasenleiste nach hinten, wie die Pfeilung im Excel-Blatt und in der App.
// Mehrere Dateien (z. B. 5A innen, 5B aussen) werden in der gewählten Reihenfolge aneinandergehängt.
(function (root) {
  'use strict';

  const num = s => { const v = parseFloat(String(s).trim().replace(',', '.')); return Number.isFinite(v) ? v : null; };
  const cells = l => l.split(',').map(s => s.trim());
  const isProfile = l => /\.(koo|dat)\s*,/i.test(l) || (cells(l).length >= 4 && num(cells(l)[0]) == null);

  function profileLine(l) {
    const c = cells(l), path = c[0], file = path.split(/[\\/]/).pop();
    return { file, name: file.replace(/\.[^.]*$/, ''), chord: num(c[1]), thickness: num(c[2]), camber: num(c[3]), twist: num(c[4]) || 0 };
  }

  // Ein Flügelteil: { name, profiles: [Wurzel, Ende Trapez 1, …], segments: [{ len, offset }] }
  function parse(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim());
    if (!/^SFW/i.test(lines[0] || '')) throw new Error('Keine StepFour-Flügeldatei (erste Zeile ist nicht „SFW…“)');
    const name = lines[1] || '';
    const n = Math.round(num(lines[3]));
    if (!(n >= 1 && n <= 50)) throw new Error('Anzahl Trapeze fehlt (Zeile 4)');
    const head = cells(lines[5] || '').map(num);
    let i = 6;
    const nextProfile = () => { while (i < lines.length && !isProfile(lines[i])) i++; return i < lines.length ? profileLine(lines[i++]) : null; };
    const root = nextProfile();
    if (!root || !root.chord) throw new Error('Wurzelprofil fehlt');
    const profiles = [root], segments = [];
    for (let k = 0; k < n; k++) {
      const tip = nextProfile();
      if (!tip || !tip.chord) throw new Error(`Endprofil von Trapez ${k + 1} fehlt`);
      // Trapezzeile: die erste Zeile nach dem Profil mit genau drei Zahlen, die erste ist die Länge
      let seg = null;
      while (i < lines.length && !isProfile(lines[i])) {
        const c = cells(lines[i++]);
        if (c.length === 3 && c.every(v => num(v) != null) && num(c[0]) > 0) { seg = { len: num(c[0]), offset: num(c[1]), extra: num(c[2]) }; break; }
      }
      if (!seg) throw new Error(`Länge und Versatz von Trapez ${k + 1} fehlen`);
      profiles.push(tip); segments.push(seg);
    }
    const span = segments.reduce((a, s) => a + s.len, 0);
    const notes = [];
    if (head[0] > 0 && Math.abs(head[0] - span) > 1) notes.push(`Gesamtlänge im Kopf ${head[0]} mm, Trapeze ergeben ${span} mm`);
    return { name, profiles, segments, span, notes };
  }

  // Flügelteile aneinanderhängen → Stationen ab der Wurzelrippe (y 0, Nasenleiste 0)
  function combine(parts) {
    const rows = [], notes = [];
    let y = 0, off = 0;
    parts.forEach((p, pi) => {
      p.profiles.forEach((pr, k) => {
        if (k > 0) { y += p.segments[k - 1].len; off += p.segments[k - 1].offset; }
        const row = { y: Math.round(y * 10) / 10, chord: pr.chord, offset: Math.round(off * 10) / 10, profile: pr.name, thickness: pr.thickness, camber: pr.camber, twist: pr.twist, part: pi };
        if (k === 0 && rows.length) {
          // Wurzel eines weiteren Teils = Ende des vorigen: eine Station, Werte des neuen Teils
          const last = rows[rows.length - 1];
          const d = [];
          if (Math.abs(last.chord - pr.chord) > 0.5) d.push(`Tiefe ${last.chord}/${pr.chord} mm`);
          if (last.thickness != null && pr.thickness != null && Math.abs(last.thickness - pr.thickness) > 0.05) d.push(`Dicke ${last.thickness}/${pr.thickness} %`);
          if (last.profile.toLowerCase() !== pr.name.toLowerCase()) d.push(`Profil ${last.profile}/${pr.name}`);
          if (d.length) notes.push(`Stoss bei ${row.y} mm passt nicht ganz (${d.join(', ')}), genommen ist der Wert des äusseren Teils`);
          rows[rows.length - 1] = row;
        } else rows.push(row);
      });
    });
    return { rows, notes };
  }

  // Profilname aus der Datei (z. B. MH-32, SD8020) mit Projekt-Profilen und Bibliothek vergleichen
  const key = s => String(s || '').replace(/\(.*?\)/g, ' ').replace(/\s+\d+(\.\d+)?\s*%.*$/, '').replace(/airfoil/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function matchProfile(name, profiles, libKeys = []) {
    const k = key(name);
    if (!k) return null;
    const own = profiles.filter(p => key(p.name) === k);
    // Original vor abgeleiteten Profilen
    const p = own.find(q => !q.baseId && q.source !== 'abgeleitet' && q.source !== 'labor') || own[0];
    if (p) return { profile: p };
    const lk = libKeys.find(l => key(l) === k);
    return lk ? { lib: lk } : null;
  }

  // Neue Stationen einer Fläche. rows aus combine, old = bisherige Stationen, rootY = Lage der Wurzelrippe ab Mitte,
  // profileId(name) liefert die Id des passenden Profils oder null. V-Form, Klappen und Rücklagen bleiben von der
  // alten Station an derselben Stelle (SFW kennt sie nicht), sonst V-Form 0 und Klappe wie die ähnlichste alte Station.
  function toStations(rows, old, { rootY = 0, profileId = () => null } = {}) {
    const PR = root.MMPA ? root.MMPA.projekt : require('./projekt.js');
    const b0 = old[old.length - 1].y || 1, b1 = rootY + rows[rows.length - 1].y || 1;
    const nearest = y => old.reduce((a, s) => Math.abs(s.y / b0 - y / b1) < Math.abs(a.y / b0 - y / b1) ? s : a);
    const make = (r, y) => {
      const near = nearest(y), same = old.find(s => Math.abs(s.y - y) <= 2);
      const src = same || near;
      return PR.station(Math.round(y * 10) / 10, r.chord, r.offset, {
        dihedral: same ? same.dihedral || 0 : 0, twist: r.twist || 0,
        profileId: profileId(r.profile) ?? near.profileId,
        thickness: r.thickness ? +(r.thickness / 100).toFixed(5) : null,
        camber: r.camber ? +(r.camber / 100).toFixed(5) : null,
        xThickness: src.xThickness ?? null, xCamber: src.xCamber ?? null,
        flapDepth: src.flapDepth ?? 25, flap: src.flap || 0, flapMix: src.flapMix ?? null,
        ...(src.te != null ? { te: src.te } : {}),
      });
    };
    const st = rows.map(r => make(r, rootY + r.y));
    // Stück im Rumpf: Wurzelrippe bis zur Mitte durchgezogen
    if (rootY > 0) st.unshift({ ...make(rows[0], 0), dihedral: 0 });
    return st;
  }

  const api = { parse, combine, matchProfile, toStations, key };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).sfw = api;
})(typeof self !== 'undefined' ? self : this);
