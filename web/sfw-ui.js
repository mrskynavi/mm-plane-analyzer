// SFW laden: StepFour-Flügeldateien als Stationen von Flügel oder Höhenleitwerk übernehmen.
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, toast, curModel, persist, project, stationTable …).
(function () {
  'use strict';
  const S = window.MMPA.sfw, LIB = window.MMPA.bibliothek, PRJ = window.MMPA.projekt;
  const dlg = $('sfwDlg');
  const st = { part: 'wing', parts: [], files: [], rows: [], notes: [] };
  const NAME = { wing: 'Flügel', tail: 'Höhenleitwerk' };

  document.querySelectorAll('[data-sfw]').forEach(b => b.addEventListener('click', () => {
    st.part = b.dataset.sfw; st.parts = []; st.files = []; st.rows = []; st.notes = [];
    const old = curModel()[st.part].stations;
    $('sfwTitle').textContent = `${NAME[st.part]} aus SFW laden`;
    $('sfwRoot').value = old[window.MMPA.fusion.firstStation(old)].y;
    $('sfwFiles').textContent = ''; render();
    dlg.showModal();
    $('sfwFile').click();
  }));
  $('sfwPick').addEventListener('click', () => $('sfwFile').click());
  $('sfwCancel').addEventListener('click', () => dlg.close());
  $('sfwRoot').addEventListener('input', render);
  $('sfwFile').addEventListener('change', async e => {
    const fs = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    e.target.value = '';
    if (!fs.length) return;
    st.parts = []; st.files = []; st.notes = [];
    for (const f of fs) {
      try { const p = S.parse(await f.text()); st.parts.push(p); st.files.push(f.name); st.notes.push(...p.notes.map(n => `${f.name}: ${n}`)); }
      catch (err) { st.notes.push(`${f.name}: ${err.message}`); }
    }
    const c = st.parts.length ? S.combine(st.parts) : { rows: [], notes: [] };
    st.rows = c.rows; st.notes.push(...c.notes);
    $('sfwFiles').textContent = st.files.map((n, i) => `${n}${st.parts[i].name ? ' (' + st.parts[i].name + ')' : ''}`).join(' + ');
    render();
  });

  const rootY = () => Math.max(0, parseFloat($('sfwRoot').value) || 0);
  // Profil je Name: im Projekt, sonst aus der Bibliothek (wird beim Übernehmen angelegt), sonst wie bisher
  function profileInfo(name) {
    const m = S.matchProfile(name, project.profiles, Object.keys(LIB));
    return m?.profile ? { text: m.profile.name, ok: true } : m?.lib ? { text: `${name} aus Bibliothek`, ok: true } : { text: `${name} fehlt, bleibt wie bisher`, ok: false };
  }

  function render() {
    const rows = st.rows, y0 = rootY();
    $('sfwGo').disabled = rows.length < 2;
    if (!rows.length) { $('sfwTable').innerHTML = ''; $('sfwInfo').textContent = st.notes.join(' · '); return; }
    const head = '<thead><tr><th>#</th><th>y mm</th><th>Tiefe mm</th><th>Pfeilung mm</th><th>Profil</th><th>Dicke %</th><th>Wölbung %</th><th>Schränkung °</th></tr></thead>';
    const list = (y0 > 0 ? [{ ...rows[0], y: -y0, inFus: true }] : []).concat(rows);
    $('sfwTable').innerHTML = head + '<tbody>' + list.map((r, i) => {
      const p = profileInfo(r.profile);
      return `<tr><td>${i + 1}</td><td>${fmt(y0 + r.y, 0)}${r.inFus ? ' <small>(Rumpf)</small>' : ''}</td><td>${fmt(r.chord, 1)}</td><td>${fmt(r.offset, 1)}</td>` +
        `<td${p.ok ? '' : ' style="color:var(--bad)"'}>${esc(p.text)}</td><td>${fmt(r.thickness, 1)}</td><td>${r.camber ? fmt(r.camber, 1) : 'wie Profil'}</td><td>${fmt(r.twist || 0, 1)}</td></tr>`;
    }).join('') + '</tbody>';
    const span = y0 + rows[rows.length - 1].y;
    $('sfwInfo').textContent = [`Halbspannweite ${fmt(span, 0)} mm, Spannweite ${fmt(2 * span, 0)} mm. V-Form steht nicht in der SFW-Datei: Sie bleibt, wo eine Station schon an derselben Stelle lag, sonst 0. Klappen kommen von der ähnlichsten bisherigen Station.`, ...st.notes].join(' · ');
  }

  $('sfwGo').addEventListener('click', () => {
    const m = curModel(), part = st.part, old = m[part].stations;
    if (window.histMark) window.histMark(`vor SFW-Import ${NAME[part]}`);
    const added = [];
    const profileId = name => {
      const r = S.matchProfile(name, project.profiles, Object.keys(LIB));
      if (r?.profile) return r.profile.id;
      if (r?.lib) { const p = PRJ.addProfile(project, { datText: LIB[r.lib], source: 'bibliothek' }); added.push(p.name); return p.id; }
      return null;
    };
    m[part].stations = S.toStations(st.rows, old, { rootY: rootY(), profileId });
    persist(); syncModelForm(); stationTable(part); scheduleModel();
    if (added.length && typeof renderAll === 'function') renderAll();
    dlg.close();
    toast(`${NAME[part]} aus ${st.files.join(' + ')}: ${m[part].stations.length} Stationen` + (added.length ? ` · Profil ${added.join(', ')} aus der Bibliothek angelegt` : ''));
  });
})();
