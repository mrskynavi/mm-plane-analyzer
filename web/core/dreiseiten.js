// 3-Seitenansicht: Konturen von Rumpf und Flügel aus einer Strichzeichnung lesen.
// Ablauf: wenige Merkpunkte (Nase, Rumpfende, Flügelwurzel, Flügelspitze; von Claude erkannt oder von Hand
// gesetzt), dann fährt die App die Linien im Bild selber nach. Ergebnis sind Tabellen in mm im Massstab des
// Modells: Rumpf je Station x Breite (Draufsicht) und Höhe (Seitenansicht), Flügel je Station Lage, Tiefe, Versatz.
// x in mm ab der Nasenleiste der Flügelwurzel, nach hinten positiv (wie im Modell).
(function (root) {
  'use strict';

  // Graubild { width, height, gray: Uint8Array } aus RGBA-Bilddaten
  function grayOf(img) {
    const n = img.width * img.height, g = new Uint8Array(n), d = img.data;
    if (d.length === n) g.set(d);
    else for (let i = 0; i < n; i++) g[i] = (d[4 * i] * 0.3 + d[4 * i + 1] * 0.59 + d[4 * i + 2] * 0.11) | 0;
    return { width: img.width, height: img.height, gray: g };
  }
  // Maske der dunklen Linien: Schwelle aus dem Median (Papier) und dem dunkelsten Prozent (Tusche).
  // Schwach gedruckte Schraffuren und Raster im Hintergrund fallen weg.
  function maskOf(g, level = 0.5) {
    const h = new Uint32Array(256);
    for (const v of g.gray) h[v]++;
    const n = g.gray.length, q = p => { let s = 0; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= p * n) return v; } return 255; };
    const paper = q(0.5), ink = q(0.01), thr = ink + level * (paper - ink);
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = g.gray[i] < thr ? 1 : 0;
    return { width: g.width, height: g.height, m, thr };
  }
  const isDark = (M, x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = xi + dx, b = yi + dy;
      if (a >= 0 && b >= 0 && a < M.width && b < M.height && M.m[b * M.width + a] && (dx === 0 || dy === 0)) return true;
    }
    return false;
  };

  // Eine Linie nachfahren: entlang u (Einheitsvektor) ab o in n Schritten der Länge step, quer dazu in Richtung v
  // die Linie suchen, die am weitesten aussen liegt und nahe an der vorherigen Lage ist. lo..hi ist der Suchbereich
  // quer (px). Liefert je Schritt den Querabstand oder null (Schritt liegt auf einer Querlinie oder nichts gefunden).
  // smooth: statt der äussersten Linie die, die am besten zur bisherigen Richtung passt (Seitenansicht: Motormast,
  // Haubenrahmen, Rad und Kufe zweigen von der Rumpflinie ab, die Rumpflinie selbst hat keine Knicke)
  function track(M, { o, u, v, n, step, lo = 1, hi, start = 0, jump = 4, stopAfter = Infinity, smooth = false }) {
    const out = [];
    let prev = start, slope = 0, miss = 0;
    for (let i = 0; i <= n; i++) {
      const px = o[0] + u[0] * i * step, py = o[1] + u[1] * i * step, cand = [];
      for (let t = lo; t <= hi; t++) if (isDark(M, px + v[0] * t, py + v[1] * t)) cand.push(t);
      // Querlinie (Nasen- oder Endleiste quer über den Rumpf): fast alles dunkel um die alte Lage
      const w0 = Math.max(lo, prev - 2 * jump), w1 = Math.min(hi, prev + 4 * jump);
      const dense = cand.filter(t => t >= w0 && t <= w1).length / Math.max(1, w1 - w0 + 1);
      if (dense > 0.75) { out.push(null); continue; }
      // Striche: zusammenhängende Läufe, je Lauf die Mitte (höchstens 5 px breit gezählt)
      const runs = [];
      for (const t of cand) { const r = runs[runs.length - 1]; if (r && t === r[1] + 1) r[1] = t; else runs.push([t, t]); }
      const mids = runs.map(([a, b]) => (Math.max(a, b - 4) + b) / 2);
      const pred = prev + (smooth ? slope : 0);
      const win = mids.filter(t => t >= pred - jump && t <= pred + jump);
      let t = null;
      if (win.length) t = smooth ? win.reduce((a, b) => Math.abs(b - pred) < Math.abs(a - pred) ? b : a) : Math.max(...win);
      else if (mids.length && miss >= 2) t = mids.reduce((a, b) => Math.abs(b - pred) < Math.abs(a - pred) ? b : a); // wieder einfangen
      if (t == null) { out.push(null); prev += smooth ? slope : 0; if (++miss > stopAfter) break; continue; }
      if (i > 0 && miss === 0) slope = 0.7 * slope + 0.3 * (t - prev);
      miss = 0; prev = t; out.push(t);
    }
    return out;
  }
  // Lücken linear füllen, Ränder mit dem nächsten Wert; dann gleitender Median gegen Ausreisser
  function fill(a) {
    const r = a.slice(), idx = r.map((v, i) => v == null ? -1 : i).filter(i => i >= 0);
    if (!idx.length) return r.map(() => 0);
    for (let i = 0; i < r.length; i++) if (r[i] == null) {
      const L = idx.filter(j => j < i).pop(), R = idx.find(j => j > i);
      r[i] = L == null ? r[R] : R == null ? r[L] : r[L] + (r[R] - r[L]) * (i - L) / (R - L);
    }
    return r;
  }
  function median(a, k = 2) {
    return a.map((_, i) => { const w = a.slice(Math.max(0, i - k), i + k + 1).sort((p, q) => p - q); return w[w.length >> 1]; });
  }

  // Eingipflige Kurve unter den Messwerten: vor dem Gipfel steigt sie, danach fällt sie. Ein Rumpf hat so eine
  // Kontur; was darüber hinaussteht (Motormast, Seitenleitwerk, Rad, Kufe), wird abgeschnitten. Den Gipfel sucht ein
  // breiter Median (16 % der Länge), in dem schmale Anbauten verschwinden und nur die Haube bzw. Rumpfmitte bleibt.
  function unimodal(a) {
    const n = a.length; if (!n) return [];
    // Median mit voller Fensterbreite, ausserhalb der Kontur 0: so zählt ein Seitenleitwerk am Ende nicht als Gipfel
    const k = Math.max(2, Math.round(0.08 * n)), at = i => i < 0 || i >= n ? 0 : a[i];
    const wide = a.map((_, i) => { const w = []; for (let j = i - k; j <= i + k; j++) w.push(at(j)); return w.sort((x, y) => x - y)[k]; });
    let p = 0; for (let i = 1; i < n; i++) if (wide[i] > wide[p]) p = i;
    // Gipfelwert: nicht höher als der breite Median dort (ein Anbau genau am Gipfel zählt nicht)
    const g = new Array(n); let m = Math.min(a[p], wide[p]);
    g[p] = m; for (let i = p - 1; i >= 0; i--) { m = Math.min(m, a[i]); g[i] = m; }
    m = g[p]; for (let i = p + 1; i < n; i++) { m = Math.min(m, a[i]); g[i] = m; }
    return g;
  }
  const mean = (a, k) => a.map((_, i) => { const w = a.slice(Math.max(0, i - k), i + k + 1); return w.reduce((p, q) => p + q, 0) / w.length; });

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const unit = a => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

  // Achsen der Draufsicht: u von der Nase zum Rumpfende, rechts = Seite der Flügelspitze
  function frame(P) {
    const u = unit(sub(P.tail, P.nose)), n0 = [-u[1], u[0]];
    const right = dot(sub(P.tipLE, P.nose), n0) >= 0 ? n0 : [-n0[0], -n0[1]];
    const along = p => dot(sub(p, P.nose), u), across = p => dot(sub(p, P.nose), right);
    return { u, right, left: [-right[0], -right[1]], along, across, L: along(P.tail) };
  }
  // Massstab mm je px aus der Halbspannweite des Modells
  const scaleOf = (P, spanMm) => { const F = frame(P); return spanMm / 2 / Math.abs(F.across(P.tipLE)); };

  // Rumpf aus der Draufsicht (Breite) und, falls vorhanden, der Seitenansicht (Höhe)
  // P: { nose, tail, rootLE, rootTE, tipLE, maxHalf, side: { nose, tail, maxHeight } }
  function fuselage(M, P, spanMm, nOut = 30) {
    const F = frame(P), s = scaleOf(P, spanMm), L = F.L;
    const step = Math.max(1, L / 300), n = Math.floor(L / step);
    const hi = Math.round(Math.max(P.maxHalf || 0.08 * L, 4) * 1.4), jump = Math.max(3, 1.5 * step);
    const R = fill(track(M, { o: P.nose, u: F.u, v: F.right, n, step, hi, jump }));
    const Lf = fill(track(M, { o: P.nose, u: F.u, v: F.left, n, step, hi, jump }));
    const half = mean(unimodal(median(R.map((r, i) => (r + Lf[i]) / 2), 3)), 2);
    const x0 = F.along(P.rootLE);
    let height = null;
    if (P.side && P.side.nose && P.side.tail) {
      const u2 = unit(sub(P.side.tail, P.side.nose)), up0 = [u2[1], -u2[0]]; // im Bild ist oben y klein
      const up = up0[1] <= 0 ? up0 : [-up0[0], -up0[1]], dn = [-up[0], -up[1]];
      const L2 = Math.hypot(...sub(P.side.tail, P.side.nose)), n2 = Math.floor(L2 / step);
      const hi2 = Math.round(Math.max(P.side.maxHeight || 0.12 * L2, 4) * 1.2);
      // Über dem Flügel zeichnet die Seitenansicht die Flügelwurzel mit (Buckel): dort die Oberkante weglassen und
      // von vorn nach hinten gerade überbrücken. Bereich von der Wurzel-Nasenleiste bis zur hintersten Endleiste.
      let teMax = F.along(P.rootTE) - x0;
      try { for (const r of wing(M, P, spanMm)) teMax = Math.max(teMax, (r.offset + r.chord) / s); } catch (e) { /* nur Wurzel */ }
      const i0 = Math.max(1, Math.floor((x0 / L - 0.015) * L2 / step)), i1 = Math.min(n2 - 1, Math.ceil(((x0 + teMax) / L + 0.02) * L2 / step));
      const Traw = track(M, { o: P.side.nose, u: u2, v: up, n: n2, step, hi: hi2, jump, smooth: true });
      for (let i = i0; i <= i1 && i < Traw.length; i++) Traw[i] = null;
      const T = fill(Traw);
      const B = fill(track(M, { o: P.side.nose, u: u2, v: dn, n: n2, step, hi: hi2, jump, smooth: true }));
      // hinten weder Seitenleitwerk noch Motormast mitnehmen: oben höchstens 1,3-mal der Wert bei 55 % der Länge
      const k55 = Math.round(0.55 * n2), cap = T[k55] * 1.3;
      const Tc = T.map((t, i) => i > k55 ? Math.min(t, cap) : t);
      // gleitendes Mittel nach dem Median: die Rumpflinie hat keine Knicke (verdeckte Stellen hinter dem Mast)
      const Tm = mean(unimodal(median(Tc, 3)), 4), Bm = mean(unimodal(median(B, 3)), 4);
      height = a => { const i = Math.min(Tm.length - 1, Math.max(0, Math.round(a / step))); return [Tm[i], Bm[i]]; };
    }
    const rows = [];
    for (let k = 0; k <= nOut; k++) {
      const a = L * (1 - Math.cos(Math.PI * k / nOut)) / 2, i = Math.min(half.length - 1, Math.round(a / step));
      const w = Math.round(2 * half[i] * s), [zt, zb] = height ? height(a).map(z => Math.round(z * s)) : [Math.round(0.65 * w), Math.round(0.6 * w)];
      // zt, zb: Ober- und Unterkante über bzw. unter der Linie Nase–Rumpfende der Seitenansicht
      rows.push({ x: Math.round((a - x0) * s), w, h: zt + zb, zt, zb });
    }
    Object.assign(rows[0], { w: 0, h: 0, zt: 0, zb: 0 });
    return rows;
  }

  // Flügel aus der Draufsicht: Nasen- und Endleiste von der Wurzel zur Spitze nachfahren, dann auf wenige
  // Stationen ausdünnen (Knicke bleiben). Liefert [{ y, chord, offset }] in mm.
  function wing(M, P, spanMm, tol = 0.0025) {
    const F = frame(P), s = scaleOf(P, spanMm), b2 = Math.abs(F.across(P.tipLE));
    const le0 = F.along(P.rootLE), te0 = F.along(P.rootTE), c0 = te0 - le0;
    const y0 = Math.max(1.6 * (P.maxHalf || 0.05 * b2), 0.04 * b2), step = Math.max(1, b2 / 250), n = Math.ceil((1.05 * b2 - y0) / step);
    const fwd = [-F.u[0], -F.u[1]], at = (along, y) => [P.nose[0] + F.u[0] * along + F.right[0] * y, P.nose[1] + F.u[1] * along + F.right[1] * y];
    const span = Math.max(c0, 0.3 * b2), jump = Math.max(3, 1.5 * step);
    // Nasenleiste: vorne die äusserste Linie, gemessen ab der Wurzel-Nasenleiste nach vorn
    const LE = track(M, { o: at(le0, y0), u: F.right, v: fwd, n, step, lo: -Math.round(span), hi: Math.round(span), jump, stopAfter: 6 });
    const TE = track(M, { o: at(te0, y0), u: F.right, v: F.u, n, step, lo: -Math.round(span), hi: Math.round(span), jump, stopAfter: 6 });
    const pts = [];
    for (let i = 0; i < Math.min(LE.length, TE.length); i++) {
      if (LE[i] == null || TE[i] == null) continue;
      const y = y0 + i * step, le = le0 - LE[i], te = te0 + TE[i];
      if (te - le < 0.03 * c0 || y > 1.02 * b2) continue;
      pts.push({ y, le, te });
    }
    if (pts.length < 2) return [];
    pts.unshift({ y: 0, le: pts[0].le, te: pts[0].te });
    // Ausdünnen nach Douglas-Peucker auf Nasen- und Endleiste gemeinsam
    const keep = new Set([0, pts.length - 1]), eps = tol * 2 * b2;
    (function dp(a, b) {
      let worst = -1, d = 0;
      for (let i = a + 1; i < b; i++) {
        const t = (pts[i].y - pts[a].y) / ((pts[b].y - pts[a].y) || 1);
        const e = Math.max(Math.abs(pts[i].le - (pts[a].le + t * (pts[b].le - pts[a].le))), Math.abs(pts[i].te - (pts[a].te + t * (pts[b].te - pts[a].te))));
        if (e > d) { d = e; worst = i; }
      }
      if (d > eps) { keep.add(worst); dp(a, worst); dp(worst, b); }
    })(0, pts.length - 1);
    return [...keep].sort((a, b) => a - b).map(i => pts[i]).map(p => ({
      y: Math.round(p.y * s), chord: Math.round((p.te - p.le) * s), offset: Math.round((p.le - pts[0].le) * s),
    }));
  }

  // Neue Flügelstationen mit den Profilen, Klappen usw. der alten Station an der ähnlichsten relativen Spannweite
  function applyWing(oldStations, rows) {
    const b0 = oldStations[oldStations.length - 1].y || 1, b1 = rows[rows.length - 1].y || 1;
    return rows.map(r => {
      const rel = r.y / b1;
      const near = oldStations.reduce((a, s) => Math.abs(s.y / b0 - rel) < Math.abs(a.y / b0 - rel) ? s : a);
      return { ...JSON.parse(JSON.stringify(near)), y: r.y, chord: r.chord, offset: r.offset };
    });
  }

  // Merkpunkte von Claude: Bild (base64) und Auftrag; die Antwort ist JSON mit Pixelkoordinaten
  const VISION_PROMPT = (w, h) => [
    `Das Bild ist eine 3-Seitenansicht eines Segelflugzeugs, ${w} × ${h} Pixel. Koordinaten in Pixeln dieses Bildes, x nach rechts, y nach unten, Ursprung oben links.`,
    'Finde in der Draufsicht (Flugzeug von oben, Flügel ganz zu sehen) und in der Seitenansicht (Rumpf von der Seite) diese Punkte und gib NUR ein JSON-Objekt zurück, ohne Text davor oder danach:',
    '{"top":{"nose":[x,y],"tail":[x,y],"rootLE":[x,y],"rootTE":[x,y],"tipLE":[x,y],"maxHalf":px},"side":{"nose":[x,y],"tail":[x,y],"maxHeight":px},"span_m":Zahl|null,"note":"kurz, Deutsch"}',
    'top.nose: Rumpfspitze. top.tail: hinterstes Ende des Rumpfs bzw. Seitenruders auf der Rumpfmittellinie. top.rootLE / top.rootTE: Punkt auf der Rumpfmittellinie auf Höhe der Flügelnasenleiste bzw. Flügelendleiste an der Wurzel. top.tipLE: Nasenleiste ganz aussen an der Flügelspitze (die vollständigere Seite). top.maxHalf: halbe grösste Rumpfbreite in Pixeln.',
    'side.nose: Rumpfspitze in der Seitenansicht. side.tail: hinterstes Ende des Rumpfs (Unterkante Seitenruder) auf Höhe des Leitwerksträgers. side.maxHeight: grösste Rumpfhöhe ohne Haube und Seitenleitwerk in Pixeln. Fehlt eine Seitenansicht, side = null.',
    'span_m: Spannweite der gezeichneten Version in Metern, wenn angeschrieben, sonst null. Sei bei den Punkten so genau wie möglich (auf wenige Pixel).',
  ].join('\n');
  function visionBody(modelId, b64, mime, w, h) {
    return {
      model: modelId, max_tokens: 4000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: VISION_PROMPT(w, h) },
      ] }],
    };
  }
  // Antworttext → Merkpunkte (prüft Form, wirft bei Unbrauchbarem)
  function parsePoints(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('Claude hat keine Punkte geliefert.');
    const j = JSON.parse(text.slice(a, b + 1)), pt = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
    const t = j.top || {};
    for (const k of ['nose', 'tail', 'rootLE', 'rootTE', 'tipLE']) if (!pt(t[k])) throw new Error('Punkt in der Draufsicht fehlt: ' + k);
    const side = j.side && pt(j.side.nose) && pt(j.side.tail) ? { nose: j.side.nose, tail: j.side.tail, maxHeight: +j.side.maxHeight || null } : null;
    return { nose: t.nose, tail: t.tail, rootLE: t.rootLE, rootTE: t.rootTE, tipLE: t.tipLE, maxHalf: +t.maxHalf || null, side, span_m: +j.span_m || null, note: j.note || '' };
  }

  // Punkte der Tabellen zurück ins Bild (für die Überlagerung)
  function toImage(P, spanMm) {
    const F = frame(P), s = scaleOf(P, spanMm), x0 = F.along(P.rootLE);
    const top = (x, y) => { const a = x / s + x0, c = y / s; return [P.nose[0] + F.u[0] * a + F.right[0] * c, P.nose[1] + F.u[1] * a + F.right[1] * c]; };
    let side = null;
    if (P.side) {
      const u2 = unit(sub(P.side.tail, P.side.nose));
      side = (x, z) => { const a = x / s + x0, c = z / s; return [P.side.nose[0] + u2[0] * a + u2[1] * c, P.side.nose[1] + u2[1] * a - u2[0] * c]; };
    }
    return { top, side, s };
  }

  const api = { grayOf, maskOf, track, fill, median, unimodal, frame, scaleOf, fuselage, wing, applyWing, VISION_PROMPT, visionBody, parsePoints, toImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).dreiseiten = api;
})(typeof self !== 'undefined' ? self : this);
