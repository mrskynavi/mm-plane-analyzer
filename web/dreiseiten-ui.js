// 3-Seitenansicht laden: Merkpunkte (Claude oder von Hand), Linien nachfahren, Tabellen korrigieren, übernehmen.
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, store, toast, curModel, persist, syncModelForm …).
(function () {
  'use strict';
  const TS = window.MMPA.dreiseiten, FQ = window.MMPA.frage;
  const KEY = 'mmpa.claudeKey', MODEL = 'mmpa.claudeModel';
  const ORDER = [
    ['nose', 'Draufsicht: Rumpfspitze'], ['tail', 'Draufsicht: hinterstes Rumpfende (Ruder) auf der Mittellinie'],
    ['rootLE', 'Draufsicht: Flügelnasenleiste an der Wurzel (auf der Mittellinie)'], ['rootTE', 'Draufsicht: Flügelendleiste an der Wurzel'],
    ['tipLE', 'Draufsicht: Nasenleiste ganz aussen an der Flügelspitze'],
    ['side.nose', 'Seitenansicht: Rumpfspitze'], ['side.tail', 'Seitenansicht: Rumpfende auf Höhe des Leitwerksträgers'],
  ];
  const st = { img: null, W: 0, H: 0, M: null, P: null, fus: [], wing: [], placing: -1, drag: null, note: '' };
  const cv = $('tsvCv'), dlg = $('tsvDlg');
  const msg = t => { $('tsvMsg').textContent = t; };
  const get = (P, k) => k.startsWith('side.') ? P.side?.[k.slice(5)] : P[k];
  const set = (P, k, v) => { if (k.startsWith('side.')) { P.side = P.side || {}; P.side[k.slice(5)] = v; } else P[k] = v; };
  const spanMm = () => { const v = parseFloat($('tsvSpan').value); return v > 0 ? v : 2 * curModel().wing.stations.at(-1).y; };

  $('tsvOpen').addEventListener('click', () => {
    const m = curModel();
    $('tsvSpan').value = Math.round(2 * m.wing.stations.at(-1).y);
    dlg.showModal(); draw();
  });
  $('tsvClose').addEventListener('click', () => dlg.close());
  $('tsvPick').addEventListener('click', () => $('tsvFile').click());
  $('tsvFile').addEventListener('change', () => { const f = $('tsvFile').files[0]; if (f) load(f); $('tsvFile').value = ''; });
  $('tsvSpan').addEventListener('change', () => { if (st.P) trace(); });

  // Bild auf höchstens 1600 px verkleinern (so sieht es auch Claude), Graubild und Linienmaske bilden
  function load(file) {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1600 / Math.max(im.width, im.height)), W = Math.round(im.width * k), H = Math.round(im.height * k);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(im, 0, 0, W, H);
      URL.revokeObjectURL(url);
      Object.assign(st, { img: c, W, H, M: TS.maskOf(TS.grayOf(g.getImageData(0, 0, W, H))), P: null, fus: [], wing: [], placing: -1 });
      $('tsvAuto').disabled = false; $('tsvManual').disabled = false;
      msg(store.get(KEY) ? 'Bild geladen. „Erkennen mit Claude“ sucht die Merkpunkte, oder setz sie mit „Punkte von Hand“.' : 'Bild geladen. Ohne Claude-Schlüssel setzt Du die Merkpunkte mit „Punkte von Hand“ (Schlüssel unter Einstellungen).');
      tables(); draw();
    };
    im.onerror = () => { URL.revokeObjectURL(url); msg('Das Bild liess sich nicht öffnen.'); };
    im.src = url;
  }

  // Claude sucht die Merkpunkte; die genaue Kontur fährt danach die App selber nach
  $('tsvAuto').addEventListener('click', async () => {
    const key = store.get(KEY);
    if (!key) { msg('Für die Erkennung braucht es Deinen Claude-Schlüssel (Einstellungen → Claude API). Oder setz die Punkte von Hand.'); return; }
    const model = store.get(MODEL) || FQ.DEFAULT_MODEL, b64 = st.img.toDataURL('image/jpeg', 0.9).split(',')[1];
    $('tsvAuto').disabled = true; msg('Claude sucht die Merkpunkte … (etwa 10–30 Sekunden)');
    try {
      const res = await fetch(FQ.API_URL, { method: 'POST', headers: FQ.requestHeaders(key, model, false), body: JSON.stringify(TS.visionBody(model, b64, 'image/jpeg', st.W, st.H)) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(FQ.errorText ? FQ.errorText(res.status, j.error?.message || '') : (j.error?.message || 'HTTP ' + res.status));
      const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      const P = TS.parsePoints(text);
      st.P = P; st.note = P.note;
      trace();
      const sc = P.span_m ? ` Gezeichnete Spannweite ${P.span_m} m, Massstab etwa 1 : ${(P.span_m * 1000 / spanMm()).toFixed(1)}.` : '';
      msg(`Erkannt.${sc} Prüf die Punkte im Bild (ziehen zum Verschieben) und die Kontur; Werte in den Tabellen kannst Du ändern.${P.note ? ' Claude: ' + P.note : ''}`);
    } catch (e) {
      msg('Erkennen ging nicht: ' + e.message + ' Setz die Punkte dann von Hand.');
    } finally { $('tsvAuto').disabled = false; }
  });

  // Punkte der Reihe nach anklicken; die Seitenansicht lässt sich überspringen
  $('tsvManual').addEventListener('click', () => { st.P = { side: null }; st.fus = []; st.wing = []; st.placing = 0; tables(); prompt(); draw(); });
  function prompt() {
    if (st.placing < 0) return;
    const [, txt] = ORDER[st.placing];
    msg(`Punkt ${st.placing + 1} von ${ORDER.length}: ${txt}.` + (st.placing >= 5 ? ' Ohne Seitenansicht: Esc oder nochmals „Punkte von Hand“ … dann rechnet die App die Höhe aus der Breite.' : ''));
  }
  dlg.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.placing >= 5) { e.preventDefault(); st.placing = -1; st.P.side = null; trace(); }
  });

  // Linien nachfahren und Tabellen füllen
  function trace() {
    const P = st.P;
    if (!P || !['nose', 'tail', 'rootLE', 'rootTE', 'tipLE'].every(k => P[k])) return;
    if (P.side && !(P.side.nose && P.side.tail)) P.side = null;
    try {
      st.fus = TS.fuselage(st.M, P, spanMm(), 30);
      st.wing = TS.wing(st.M, P, spanMm());
    } catch (e) { msg('Nachfahren ging nicht: ' + e.message); }
    if (st.placing < 0 && !st.note) msg('Kontur nachgefahren. Prüf sie im Bild; Punkte ziehen oder Werte in den Tabellen ändern.');
    st.note = '';
    tables(); draw();
  }

  // Tabellen: jede Zahl änderbar, die Überlagerung folgt
  function tables() {
    const inp = (arr, i, k) => `<input type="number" data-a="${arr}" data-i="${i}" data-k="${k}" value="${st[arr][i][k]}">`;
    $('tsvFus').innerHTML = st.fus.length ? '<thead><tr><th>x</th><th>Breite</th><th>Höhe</th></tr></thead><tbody>' +
      st.fus.map((r, i) => `<tr><td>${inp('fus', i, 'x')}</td><td>${inp('fus', i, 'w')}</td><td>${inp('fus', i, 'h')}</td></tr>`).join('') + '</tbody>' : '';
    $('tsvWing').innerHTML = st.wing.length ? '<thead><tr><th>y</th><th>Tiefe</th><th>Versatz</th></tr></thead><tbody>' +
      st.wing.map((r, i) => `<tr><td>${inp('wing', i, 'y')}</td><td>${inp('wing', i, 'chord')}</td><td>${inp('wing', i, 'offset')}</td></tr>`).join('') + '</tbody>' : '';
    $('tsvUseFus').disabled = st.fus.length < 3; $('tsvUseWing').disabled = st.wing.length < 2;
  }
  dlg.addEventListener('change', e => {
    const t = e.target; if (!t.dataset?.a) return;
    const v = parseFloat(t.value), r = st[t.dataset.a][+t.dataset.i];
    if (!Number.isFinite(v)) { t.value = r[t.dataset.k]; return; }
    if (t.dataset.k === 'h' && r.h > 0) { const f = v / r.h; r.zt = Math.round(r.zt * f); r.zb = v - r.zt; }
    else if (t.dataset.k === 'h') { r.zt = Math.round(v / 2); r.zb = v - r.zt; }
    r[t.dataset.k] = v; draw();
  });

  $('tsvUseFus').addEventListener('click', () => {
    const m = curModel(), old = m.fuselage || {};
    m.fuselage = { ...old, type: 'kontur', finish: old.finish || (FU.of(m).type === 'oldtimer' ? 'oldtimer' : 'modern'), table: st.fus.map(r => ({ x: r.x, w: r.w, h: r.h })) };
    persist(); syncModelForm(); scheduleModel();
    toast('Rumpf als Kontur übernommen');
  });
  $('tsvUseWing').addEventListener('click', () => {
    const m = curModel();
    if (!confirm(`Flügel von „${m.name}“ durch ${st.wing.length} Stationen aus der Zeichnung ersetzen? Profile und Klappen kommen von der jeweils ähnlichsten alten Station.`)) return;
    m.wing.stations = TS.applyWing(m.wing.stations, st.wing);
    persist(); syncModelForm(); stationTable('wing'); scheduleModel();
    toast('Flügel-Grundriss übernommen');
  });

  // Zeichnen: Bild, Kontur aus den Tabellen, Merkpunkte
  function draw() {
    if (!dlg.open) return;
    const box = cv.parentElement, w = box.clientWidth || 800;
    const W = st.W || 1600, H = st.H || 900, k = w / W, dpr = devicePixelRatio || 1;
    cv.style.height = Math.round(H * k) + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(H * k * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr * k, 0, 0, dpr * k, 0, 0); g.clearRect(0, 0, W, H);
    if (!st.img) { g.fillStyle = '#888'; g.font = `${16 / k}px sans-serif`; g.fillText('Noch kein Bild', 20 / k, 30 / k); return; }
    g.drawImage(st.img, 0, 0);
    const P = st.P, lw = 2 / k;
    if (P && st.fus.length && ['nose', 'tail', 'rootLE', 'tipLE'].every(q => P[q])) {
      const T = TS.toImage(P, spanMm());
      const path = (pts, col) => { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.strokeStyle = col; g.lineWidth = lw; g.stroke(); };
      const fus = [...st.fus].sort((a, b) => a.x - b.x);
      path(fus.map(r => T.top(r.x, r.w / 2)), '#e5484d'); path(fus.map(r => T.top(r.x, -r.w / 2)), '#e5484d');
      if (T.side) { path(fus.map(r => T.side(r.x, r.zt ?? r.h / 2)), '#e5484d'); path(fus.map(r => T.side(r.x, -(r.zb ?? r.h / 2))), '#e5484d'); }
      if (st.wing.length) {
        const x0 = 0, wg = st.wing;
        path(wg.map(r => T.top(x0 + r.offset, r.y)), '#0090ff'); path(wg.map(r => T.top(x0 + r.offset + r.chord, r.y)), '#0090ff');
        g.globalAlpha = 0.5; wg.forEach(r => path([T.top(r.offset, r.y), T.top(r.offset + r.chord, r.y)], '#0090ff')); g.globalAlpha = 1;
      }
    }
    if (P) for (const [key, txt] of ORDER) {
      const p = get(P, key); if (!p) continue;
      g.beginPath(); g.arc(p[0], p[1], 6 / k, 0, 2 * Math.PI); g.fillStyle = 'rgba(255,170,0,.35)'; g.fill();
      g.strokeStyle = '#d97706'; g.lineWidth = lw; g.stroke();
      g.font = `600 ${11 / k}px sans-serif`; g.fillStyle = '#b45309'; g.fillText(txt.split(': ')[1].split(' (')[0].replace('hinterstes ', ''), p[0] + 8 / k, p[1] - 8 / k);
    }
  }
  new ResizeObserver(() => draw()).observe(cv.parentElement);

  // Punkte setzen und ziehen (Maus, Stift, Finger)
  const imgPt = e => { const r = cv.getBoundingClientRect(), k = r.width / st.W; return [(e.clientX - r.left) / k, (e.clientY - r.top) / k, k]; };
  cv.addEventListener('pointerdown', e => {
    if (!st.img || !st.P) return;
    const [x, y, k] = imgPt(e);
    if (st.placing >= 0) {
      set(st.P, ORDER[st.placing][0], [x, y]);
      st.placing++;
      if (st.placing >= ORDER.length) { st.placing = -1; trace(); } else { prompt(); draw(); }
      return;
    }
    let best = null, bd = 16 / k;
    for (const [key] of ORDER) { const p = get(st.P, key); if (p && Math.hypot(p[0] - x, p[1] - y) < bd) { bd = Math.hypot(p[0] - x, p[1] - y); best = key; } }
    if (best) { st.drag = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  cv.addEventListener('pointermove', e => { if (!st.drag) return; const [x, y] = imgPt(e); set(st.P, st.drag, [x, y]); draw(); });
  const end = () => { if (st.drag) { st.drag = null; trace(); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
})();
