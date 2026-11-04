// Verlauf: Rückgängig/Wiederholen (↶ ↷, Strg+Z) und Zwischenstände (Dialog „Verlauf“).
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, store, toast, esc, project, PR, persist, renderAll …).
(function () {
  'use strict';
  const VL = window.MMPA.verlauf;
  const AUTO_EVERY = 10 * 60e3;     // automatischer Zwischenstand beim Arbeiten
  const MERGE_MS = 700;             // Änderungen kurz nacheinander sind ein Schritt

  const H = VL.createHistory(PR.serialize(project));
  let histProj = project, histName = project.name, timer = null, pendingReason = null, applying = false;
  let started = false, lastAuto = 0, lastSaved = null, failed = false;

  // ---------- Zwischenstände speichern ----------
  function save(name, text, label, kind = 'auto') {
    if (kind === 'auto' && text === lastSaved) return Promise.resolve(null);
    if (kind === 'auto') lastSaved = text;
    return VL.add(name, text, { kind, label }).catch(e => {
      if (!failed) toast('Zwischenstand konnte nicht gespeichert werden: ' + e.message);
      failed = true; return null;
    });
  }
  // aktuellen Stand vor einem grossen Schritt sichern
  window.histMark = label => { flush(); started = true; lastAuto = Date.now(); return save(project.name, PR.serialize(project), label); };

  // ---------- Änderungen aufzeichnen ----------
  window.histChanged = reason => {
    if (applying) return;
    if (reason) pendingReason = reason;
    clearTimeout(timer); timer = setTimeout(commit, MERGE_MS);
  };
  function flush() { if (timer) commit(); }
  function commit() {
    clearTimeout(timer); timer = null;
    const reason = pendingReason; pendingReason = null;
    const text = PR.serialize(project);
    if (project !== histProj) {
      // anderes Projekt geöffnet oder neu geladen: alten Stand sichern, Schritte neu beginnen
      if (text !== H.current) save(histName, H.current, reason || (project.name === histName ? 'vor Öffnen einer anderen Datei' : `vor Wechsel zu ${project.name}`));
      histProj = project; histName = project.name; H.reset(text);
      started = false; showButtons(); return;
    }
    const prev = H.current;
    if (!H.record(text)) return;
    const now = Date.now();
    if (!started) { started = true; lastAuto = now; save(histName, prev, 'beim Öffnen'); }
    else if (now - lastAuto >= AUTO_EVERY) { lastAuto = now; save(project.name, text, 'beim Arbeiten'); }
    histName = project.name;
    showButtons();
  }

  // ---------- Rückgängig / Wiederholen ----------
  function apply(text) {
    applying = true;
    try { project = PR.parse(text); histProj = project; histName = project.name; persist(); renderAll(); }
    finally { applying = false; }
    showButtons();
    if ($('histDlg').open) renderDlg();
  }
  function go(dir) {
    flush();
    const from = H.current, to = dir < 0 ? H.undo() : H.redo();
    if (to == null) return;
    apply(to);
    toast(`${dir < 0 ? 'Rückgängig' : 'Wiederholt'}: ${VL.describe(from, to)}`);
  }
  const stepText = dir => {
    const t = dir < 0 ? H.peekUndo() : H.peekRedo();
    return t == null ? null : (dir < 0 ? VL.describe(t, H.current) : VL.describe(H.current, t));
  };
  function showButtons() {
    const u = stepText(-1), r = stepText(1);
    $('undoBtn').disabled = u == null; $('redoBtn').disabled = r == null;
    $('undoBtn').title = u == null ? 'Nichts zum Rückgängigmachen' : `Rückgängig: ${u} (Strg+Z)`;
    $('redoBtn').title = r == null ? 'Nichts zum Wiederholen' : `Wiederholen: ${r} (Strg+Umschalt+Z)`;
  }
  $('undoBtn').onclick = () => go(-1);
  $('redoBtn').onclick = () => go(1);
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    if (document.querySelector('dialog[open]')) return;
    // in Eingabefeldern bleibt das Rückgängig des Browsers für den Text
    if (e.target.closest && e.target.closest('input,select,textarea,[contenteditable]')) return;
    e.preventDefault();
    go(k === 'y' || e.shiftKey ? 1 : -1);
  });

  // ---------- Dialog ----------
  const when = t => {
    const d = new Date(t), today = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    return today ? `heute ${hm}` : `${d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric', year: '2-digit' })} ${hm}`;
  };
  let rows = [];
  async function renderDlg() {
    flush();
    const u = H.sizes;
    $('histSteps').innerHTML = `<button type="button" class="btn ghost sm" data-go="-1" ${u.undo ? '' : 'disabled'}>↶ Rückgängig</button><button type="button" class="btn ghost sm" data-go="1" ${u.redo ? '' : 'disabled'}>↷ Wiederholen</button>`
      + `<span>${u.undo ? `${u.undo} Schritt${u.undo === 1 ? '' : 'e'} zurück möglich` : 'Noch keine Änderung in dieser Sitzung'}${u.redo ? `, ${u.redo} vor` : ''}</span>`;
    const all = $('histAll').checked;
    try { rows = await VL.list(all ? null : project.name); }
    catch (e) { $('histList').innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
    $('histList').innerHTML = rows.length ? rows.map((s, i) => {
      const named = s.kind === 'named';
      const title = named ? s.label : 'Automatisch' + (s.label ? ' ' + s.label : '');
      const info = [when(s.time), Math.max(1, Math.round(s.size / 1024)) + ' kB'];
      if (all) info.push(s.project);
      return `<div class="histrow${named ? ' named' : ''}" data-i="${i}"><div class="hl"><b>${named ? '★ ' : ''}${esc(title)}</b><span>${esc(info.join(' · '))}</span></div>`
        + `<div class="ha"><button type="button" class="btn sm" data-act="back">Zurückholen</button>`
        + `<button type="button" class="btn ghost sm" data-act="name">${named ? 'Umbenennen' : 'Behalten …'}</button>`
        + `<button type="button" class="btn ghost sm" data-act="file" title="Als Projektdatei herunterladen">Datei</button>`
        + `<button type="button" class="btn ghost sm" data-act="del" title="Diesen Stand löschen" aria-label="Löschen">✕</button></div></div>`;
    }).join('') : '<p class="hint">Noch keine Zwischenstände. Der erste entsteht automatisch bei der ersten Änderung, oder Du merkst Dir den aktuellen Stand oben mit einem Namen.</p>';
  }
  $('histBtn').onclick = () => { $('histName').value = ''; renderDlg(); $('histDlg').showModal(); };
  $('histClose').onclick = () => $('histDlg').close();
  $('histAll').onchange = renderDlg;
  $('histSteps').onclick = e => { const b = e.target.closest('[data-go]'); if (b) go(+b.dataset.go); };
  $('histNew').onsubmit = async e => {
    e.preventDefault(); flush();
    const name = $('histName').value.trim() || `Stand ${when(Date.now())}`;
    const s = await save(project.name, PR.serialize(project), name, 'named');
    if (s) { $('histName').value = ''; toast(`Gemerkt: ${name}`); renderDlg(); }
  };
  $('histList').onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.histrow'), s = rows[+row.dataset.i];
    const act = b.dataset.act;
    if (act === 'del') {
      if (s.kind === 'named' && !confirm(`Stand „${s.label}“ löschen?`)) return;
      await VL.remove(s.id).catch(err => toast(err.message)); renderDlg(); return;
    }
    if (act === 'name') { nameRow(row, s); return; }
    const full = await VL.get(s.id).catch(err => { toast(err.message); return null; });
    if (!full) return;
    if (act === 'file') {
      const blob = new Blob([full.text], { type: 'application/json' }), a = document.createElement('a');
      const stamp = new Date(s.time).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
      a.href = URL.createObjectURL(blob); a.download = window.MMPA.ordner.fileName(`${s.project} ${stamp}`);
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    restore(full, s);
  };
  function nameRow(row, s) {
    const hl = row.querySelector('.hl b');
    const inp = document.createElement('input');
    inp.className = 'txt'; inp.value = s.kind === 'named' ? s.label : ''; inp.placeholder = 'Name für diesen Stand'; inp.maxLength = 80;
    hl.replaceWith(inp); inp.focus();
    let done = false;
    const finish = async ok => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (ok && v) { await VL.update(s.id, { kind: 'named', label: v }).catch(err => toast(err.message)); }
      renderDlg();
    };
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } });
    inp.addEventListener('blur', () => finish(true));
  }
  async function restore(full, s) {
    let p;
    try { p = PR.parse(full.text); } catch (e) { toast(e.message); return; }
    flush();
    if (full.text === PR.serialize(project)) { toast('Das ist schon der aktuelle Stand'); return; }
    const same = p.name === project.name;
    if (same) { await window.histMark('vor Zurückholen'); }
    project = p;
    if (same) histProj = p;            // gleiches Projekt: ein Schritt, der sich mit ↶ zurücknehmen lässt
    else pendingReason = 'vor Zurückholen eines anderen Projekts';
    ui.varOff.clear(); persist(); renderAll(); flush();
    $('histDlg').close();
    const title = s.kind === 'named' ? `„${s.label}“` : `von ${when(s.time)}`;
    toast(`Stand ${title} zurückgeholt.` + (same ? ' Mit ↶ kommst Du wieder zum vorherigen.' : ''));
  }

  showButtons();
})();
