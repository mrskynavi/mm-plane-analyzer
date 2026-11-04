// GitHub-Sync in der Oberfläche: Einstellungen (Repo + Schlüssel), automatisches Speichern nach
// Änderungen, Abgleich beim Start und beim Zurückkehren in die App, Projektliste und Konfliktfrage.
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, store, toast, esc, project, PR, persist, renderAll …).
(function () {
  'use strict';
  const CL = window.MMPA.cloud;
  const K = { token: 'mmpa.ghToken', repo: 'mmpa.ghRepo', shas: 'mmpa.ghShas', last: 'mmpa.ghLast' };
  const DELAY = 4000;

  const cfg = () => ({ token: (store.get(K.token) || '').trim(), repo: (store.get(K.repo) || '').trim() });
  const active = () => { const c = cfg(); return !!(c.token && CL.parseRepo(c.repo)); };
  const gh = () => CL.client(cfg());
  const shas = () => { try { return JSON.parse(store.get(K.shas) || '{}'); } catch { return {}; } };
  const knownSha = path => shas()[path] || null;
  function setSha(path, sha) { const m = shas(); m[path] = sha; store.set(K.shas, JSON.stringify(m)); }
  const curPath = () => CL.pathOf(project.name);
  const local = () => PR.serialize(project);

  const st = { timer: null, busy: null, again: false, paused: false, state: 'off', msg: '' };

  // ---------- Status neben „Speichern“ ----------
  const ICON = { off: '', ok: '☁ ✓', dirty: '☁ …', busy: '☁ ⟳', error: '☁ !', conflict: '☁ ⚠' };
  function show(state, msg) {
    st.state = state; st.msg = msg || '';
    const el = $('cloudState');
    el.hidden = state === 'off';
    el.textContent = ICON[state] || '';
    el.dataset.state = state;
    el.title = msg || '';
    if (state === 'ok') store.set(K.last, new Date().toISOString());
    renderSettings();
  }
  const time = () => new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

  // Nacheinander, nie zwei Anfragen gleichzeitig
  async function exclusive(fn) {
    while (st.busy) { try { await st.busy; } catch { /* egal */ } }
    st.busy = fn();
    try { return await st.busy; } finally { st.busy = null; }
  }

  function fail(e) {
    if (e.kind === 'conflict') return reconcile(false);
    show('error', e.message);
    if (e.kind !== 'offline') toast(`GitHub-Sync: ${e.message}`);
  }

  // ---------- Speichern ----------
  async function push(loud) {
    if (!active() || st.paused) return;
    return exclusive(async () => {
      const path = curPath(), text = local(), sha = knownSha(path);
      if (sha && await CL.blobSha(text) === sha) { show('ok', `Auf GitHub aktuell (${time()})`); if (loud) toast('Auf GitHub ist schon dieser Stand'); return; }
      show('busy', 'Speichert auf GitHub …');
      const neu = await gh().put(path, text, sha);
      setSha(path, neu);
      show('ok', `Auf GitHub gespeichert (${time()})`);
      if (loud) toast(`${project.name} auf GitHub gespeichert`);
    }).catch(fail);
  }
  function changed() {
    if (!active() || st.paused) return;
    if (st.state !== 'busy') show('dirty', 'Änderung wird gleich auf GitHub gespeichert');
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      // Beim Umbenennen nicht für jeden Buchstaben eine Datei anlegen
      if ($('settingsDlg').open) return;
      st.timer = null;
      push(false);
    }, DELAY);
  }
  function flush() { if (st.timer && active() && !$('settingsDlg').open) { clearTimeout(st.timer); st.timer = null; push(false); } }

  // ---------- Abgleich (Start, Zurückkehren in die App) ----------
  // Vergleicht den lokalen Stand, den zuletzt gesehenen Stand und den auf GitHub:
  // nur GitHub neuer → laden; nur lokal neuer → hochladen; beide geändert → nachfragen.
  async function reconcile(quiet) {
    if (!active()) return;
    return exclusive(async () => {
      show('busy', 'Gleicht mit GitHub ab …');
      const path = curPath(), text = local(), known = knownSha(path);
      const remote = await gh().get(path);
      const mine = await CL.blobSha(text);
      if (!remote) { setSha(path, await gh().put(path, text, null)); show('ok', `Auf GitHub gespeichert (${time()})`); return; }
      if (remote.sha === mine) { setSha(path, mine); st.paused = false; show('ok', `Auf GitHub aktuell (${time()})`); return; }
      if (known && remote.sha === known) { setSha(path, await gh().put(path, text, known)); show('ok', `Auf GitHub gespeichert (${time()})`); return; }
      if (known && mine === known) { load(remote, 'Neuerer Stand von GitHub geladen'); return; }
      st.paused = true;
      show('conflict', 'Auf GitHub gibt es einen anderen Stand. Bitte wählen.');
      ask(remote, quiet);
    }).catch(fail);
  }

  function load(remote, msg) {
    setSha(remote.path, remote.sha);
    project = PR.parse(remote.text);
    ui.varOff.clear();
    if (window.histChanged) window.histChanged('vor Laden von GitHub');
    st.paused = false;
    clearTimeout(saveTimer); store.set('mmpa.projekt', PR.serialize(project));
    if (typeof autoSave === 'function') autoSave();
    renderAll();
    show('ok', `Von GitHub geladen (${time()})`);
    if (msg) toast(`${msg}: ${project.name}`);
  }

  // ---------- Konflikt ----------
  function ask(remote) {
    const dlg = $('cloudDlg');
    $('cloudDlgText').textContent = `Für „${project.name}“ liegt auf GitHub ein anderer Stand als hier, vermutlich von einem anderen Gerät. Auf diesem Gerät gibt es aber auch Änderungen, die noch nicht auf GitHub sind. Welchen Stand willst du behalten?`;
    $('cloudTake').onclick = () => { dlg.close(); load(remote, 'Stand von GitHub geladen'); };
    $('cloudKeep').onclick = () => {
      dlg.close();
      exclusive(async () => {
        show('busy', 'Speichert auf GitHub …');
        setSha(remote.path, await gh().put(remote.path, local(), remote.sha, `${project.name} gespeichert (anderen Stand überschrieben)`));
        st.paused = false;
        show('ok', `Auf GitHub gespeichert (${time()})`);
        toast('Dein Stand ist jetzt auf GitHub. Der andere bleibt in der Versionsgeschichte des Repos.');
      }).catch(fail);
    };
    $('cloudLater').onclick = () => { dlg.close(); toast('GitHub-Sync pausiert, bis du entscheidest (Wolke neben „Speichern“ antippen)'); };
    if (!dlg.open) dlg.showModal();
  }
  $('cloudState').onclick = () => {
    if (st.state === 'conflict' || st.state === 'error') { st.paused = false; reconcile(false); }
    else toast(st.msg || 'GitHub-Sync');
  };

  // ---------- Speichern / Öffnen ----------
  const origSave = $('saveBtn').onclick, origOpen = $('openBtn').onclick;
  $('saveBtn').onclick = () => {
    if (!active()) return origSave();
    clearTimeout(st.timer); st.timer = null; st.paused = false;
    push(true);
  };
  $('openBtn').onclick = async () => {
    if (!active()) return origOpen();
    let files;
    try { files = await gh().list(); } catch (e) { fail(e); return origOpen(); }
    $('openDir').textContent = `GitHub ${CL.parseRepo(cfg().repo)}`;
    $('openList').innerHTML = files.length
      ? files.map((f, i) => `<button type="button" class="libitem" data-i="${i}"><b>${esc(f.name)}</b>${Math.round(f.size / 1024)} kB${f.name === project.name ? ' · offen' : ''}</button>`).join('')
      : '<p class="hint">Auf GitHub liegt noch kein Projekt. Mit „Speichern“ legst du das aktuelle dort ab.</p>';
    $('openList').onclick = async e => {
      const b = e.target.closest('.libitem'); if (!b) return;
      const f = files[+b.dataset.i];
      // Erst den offenen Stand sichern, dann wechseln
      clearTimeout(st.timer); st.timer = null;
      await push(false);
      try {
        const r = await exclusive(() => gh().get(f.path));
        if (!r) { toast('Die Datei gibt es nicht mehr'); return; }
        $('openDlg').close();
        load(r, 'Geöffnet');
      } catch (err) { fail(err); }
    };
    $('openDlg').showModal();
  };

  // ---------- Einstellungen ----------
  function renderSettings() {
    if (!$('ghRepo')) return;
    const c = cfg(), on = active();
    if (document.activeElement !== $('ghRepo')) $('ghRepo').value = c.repo;
    $('ghToken').placeholder = c.token ? 'gespeichert (zum Ändern neu einfügen)' : 'github_pat_…';
    $('ghOff').hidden = !on;
    $('ghConnect').textContent = on ? 'Prüfen und abgleichen' : 'Verbinden';
    const last = store.get(K.last);
    $('ghState').textContent = !on
      ? 'Aus. Dann bleibt das Projekt nur auf diesem Gerät (und im Projektordner, falls gewählt).'
      : `${CL.parseRepo(c.repo)}: ${st.msg || 'verbunden'}${last && st.state !== 'ok' ? ` · zuletzt synchron ${new Date(last).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}` : ''}`;
  }
  $('ghConnect').onclick = async () => {
    const repo = CL.parseRepo($('ghRepo').value), tok = $('ghToken').value.trim() || cfg().token;
    if (!repo) { toast('Repo bitte als „besitzer/name“ eintragen, z. B. mrskynavi/mm-plane-daten'); return; }
    if (!tok) { toast('Bitte den Zugangsschlüssel einfügen'); return; }
    $('ghConnect').disabled = true;
    try {
      const info = await CL.client({ repo, token: tok }).check();
      if (!info.push) throw new CL.SyncError('Der Schlüssel darf in dieses Repo nicht schreiben (Contents: Read and write fehlt)', 403, 'forbidden');
      store.set(K.repo, repo); store.set(K.token, tok); $('ghToken').value = '';
      if (!info.private) toast(`Achtung: ${repo} ist öffentlich. Für eigene Konstruktionen besser ein privates Repo nehmen.`);
      st.paused = false;
      await reconcile(false);
      if (st.state === 'ok') toast(`Mit ${repo} verbunden`);
    } catch (e) { show(active() ? 'error' : 'off', e.message); toast(`GitHub: ${e.message}`); }
    finally { $('ghConnect').disabled = false; renderSettings(); }
  };
  $('ghOff').onclick = () => {
    try { localStorage.removeItem(K.token); localStorage.removeItem(K.shas); } catch { /* egal */ }
    clearTimeout(st.timer); show('off'); toast('GitHub-Sync auf diesem Gerät ausgeschaltet');
  };
  $('openSettings').addEventListener('click', renderSettings);
  $('settingsDlg').addEventListener('close', () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; push(false); } });

  // ---------- Lebenszyklus ----------
  window.cloudChanged = changed;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (active() && !st.paused && !st.timer) reconcile(true);
  });
  addEventListener('pagehide', flush);
  if (active()) reconcile(true); else show('off');
})();
