// GitHub-Sync in der Oberfläche: Einstellungen (Repo + Schlüssel), automatisches Speichern nach
// Änderungen, Abgleich beim Start, beim Zurückkehren in die App und wenn die Verbindung wiederkommt,
// Projektliste und Konfliktfrage.
// Offline: Alle Projekte aus dem Repo liegen zusätzlich auf dem Gerät (IndexedDB „mmpa-spiegel“).
// Ohne Verbindung öffnet und bearbeitet man diese Kopien; sobald GitHub wieder erreichbar ist,
// gleicht die App jedes Projekt ab (core/cloud.js: plan/syncAll) und fragt nur, wenn ein Projekt
// hier und auf einem anderen Gerät geändert wurde.
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, store, toast, esc, project, PR, persist, renderAll …).
(function () {
  'use strict';
  const CL = window.MMPA.cloud;
  const K = { token: 'mmpa.ghToken', repo: 'mmpa.ghRepo', shas: 'mmpa.ghShas', last: 'mmpa.ghLast' };
  const DELAY = 4000, EVERY = 5 * 60 * 1000;

  const cfg = () => ({ token: (store.get(K.token) || '').trim(), repo: (store.get(K.repo) || '').trim() });
  const active = () => { const c = cfg(); return !!(c.token && CL.parseRepo(c.repo)); };
  const online = () => navigator.onLine !== false;
  const gh = () => CL.client(cfg());
  const shas = () => { try { return JSON.parse(store.get(K.shas) || '{}'); } catch { return {}; } };
  const knownSha = path => shas()[path] || null;
  function setSha(path, sha) { const m = shas(); if (sha) m[path] = sha; else delete m[path]; store.set(K.shas, JSON.stringify(m)); }
  const bases = { get: knownSha, set: setSha, del: p => setSha(p, null) };
  const curPath = () => CL.pathOf(project.name);
  const local = () => PR.serialize(project);

  const st = { timer: null, mirrorTimer: null, busy: null, paused: false, state: 'off', msg: '', later: new Set(), dlg: Promise.resolve() };

  // ---------- Kopien aller Projekte auf dem Gerät ----------
  const spiegel = (() => {
    const mem = new Map();
    let dbp = null;
    const db = () => dbp || (dbp = new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      try {
        const rq = indexedDB.open('mmpa-spiegel', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('projekte', { keyPath: 'path' });
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => resolve(null);
      } catch { resolve(null); }
    }));
    const run = async (mode, fn) => {
      const d = await db();
      if (!d) return fn(null);
      return new Promise((resolve, reject) => {
        const tx = d.transaction('projekte', mode), os = tx.objectStore('projekte');
        let out;
        const r = fn(os);
        if (r) r.onsuccess = () => { out = r.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    };
    return {
      all: () => run('readonly', os => os ? os.getAll() : null).then(x => x || [...mem.values()]),
      get: path => run('readonly', os => os ? os.get(path) : null).then(x => x || mem.get(path) || null),
      put: rec => run('readwrite', os => { const x = { path: rec.path, text: rec.text, at: Date.now() }; if (os) return os.put(x); mem.set(x.path, x); return null; }),
      del: path => run('readwrite', os => { if (os) return os.delete(path); mem.delete(path); return null; }),
    };
  })();
  // Das offene Projekt in die Kopien schreiben (nach Änderungen und bevor ein anderes geöffnet wird)
  function mirrorCurrent() {
    clearTimeout(st.mirrorTimer); st.mirrorTimer = null;
    if (!active()) return Promise.resolve();
    return spiegel.put({ path: curPath(), text: local() }).catch(() => {});
  }

  // ---------- Status neben „Speichern“ ----------
  const ICON = { off: '', ok: '☁ ✓', dirty: '☁ …', busy: '☁ ⟳', error: '☁ !', conflict: '☁ ⚠', offline: '☁ offline' };
  const OFFLINE = 'Offline: Änderungen bleiben auf diesem Gerät und gehen auf GitHub, sobald wieder eine Verbindung da ist';
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
    if (e.kind === 'offline') return show('offline', OFFLINE);
    show('error', e.message);
    toast(`GitHub-Sync: ${e.message}`);
  }

  // ---------- Speichern ----------
  async function push(loud) {
    if (!active() || st.paused) return;
    await mirrorCurrent();
    if (!online()) { show('offline', OFFLINE); if (loud) toast('Offline: gespeichert auf diesem Gerät. Auf GitHub kommt es, sobald wieder eine Verbindung da ist.'); return; }
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
    if (!active()) return;
    clearTimeout(st.mirrorTimer);
    st.mirrorTimer = setTimeout(mirrorCurrent, 500);
    if (st.paused) return;
    if (!online()) { show('offline', OFFLINE); return; }
    if (st.state !== 'busy') show('dirty', 'Änderung wird gleich auf GitHub gespeichert');
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      // Beim Umbenennen nicht für jeden Buchstaben eine Datei anlegen
      if ($('settingsDlg').open) return;
      st.timer = null;
      push(false);
    }, DELAY);
  }
  function flush() {
    if (st.mirrorTimer) mirrorCurrent();
    if (st.timer && active() && !$('settingsDlg').open) { clearTimeout(st.timer); st.timer = null; push(false); }
  }

  // ---------- Abgleich des offenen Projekts ----------
  // Vergleicht den lokalen Stand, den zuletzt gesehenen Stand und den auf GitHub:
  // nur GitHub neuer → laden; nur lokal neuer → hochladen; beide geändert → nachfragen.
  async function reconcile(quiet) {
    if (!active()) return;
    if (!online()) { show('offline', OFFLINE); return; }
    return exclusive(async () => {
      show('busy', 'Gleicht mit GitHub ab …');
      const path = curPath(), text = local(), known = knownSha(path);
      const remote = await gh().get(path);
      const mine = await CL.blobSha(text);
      const what = CL.plan(mine, known, remote && remote.sha);
      if (what === 'up') { setSha(path, await gh().put(path, text, remote ? remote.sha : null)); st.paused = false; show('ok', `Auf GitHub gespeichert (${time()})`); return; }
      if (what === 'same' || what === 'removeLocal') {
        // removeLocal: anderswo gelöscht, hier unverändert und offen → wieder hochladen statt schliessen
        if (!remote) setSha(path, await gh().put(path, text, null)); else setSha(path, mine);
        st.paused = false; show('ok', `Auf GitHub aktuell (${time()})`); return;
      }
      if (what === 'down') { load(remote, 'Neuerer Stand von GitHub geladen'); return; }
      st.paused = true;
      show('conflict', 'Auf GitHub gibt es einen anderen Stand. Bitte wählen.');
      if (!(quiet && st.later.has(path))) askCurrent(remote);
    }).catch(fail);
  }

  // ---------- Abgleich aller anderen Projekte ----------
  async function syncOthers(quiet) {
    if (!active() || !online()) return;
    let r;
    try { r = await exclusive(() => CL.syncAll(gh(), spiegel, bases, [curPath()])); }
    catch (e) { return fail(e); }
    const n = r.up.length + r.down.length + r.removed.length;
    if (n) {
      const parts = [r.up.length && `${r.up.length} hochgeladen`, r.down.length && `${r.down.length} von GitHub geholt`, r.removed.length && `${r.removed.length} anderswo gelöscht`].filter(Boolean);
      toast(`GitHub-Sync, andere Projekte: ${parts.join(', ')}`);
    }
    for (const c of r.conflicts) {
      if (quiet && st.later.has(c.path)) continue;
      await askOther(c);
    }
    if (r.conflicts.some(c => st.later.has(c.path)) && st.state === 'ok') show('conflict', 'Bei anderen Projekten gibt es offene Fragen. Antippen zum Entscheiden.');
  }

  async function syncNow(quiet) {
    if (!active()) return;
    if (!online()) { show('offline', OFFLINE); return; }
    await mirrorCurrent();
    await reconcile(quiet);
    await syncOthers(quiet);
  }

  function load(remote, msg) {
    // Den bisherigen Stand behalten, bevor ein anderes Projekt geladen wird
    if (active() && CL.pathOf(project.name) !== remote.path) spiegel.put({ path: curPath(), text: local() }).catch(() => {});
    if (remote.sha !== undefined) setSha(remote.path, remote.sha);
    project = PR.parse(remote.text);
    spiegel.put({ path: remote.path, text: remote.text }).catch(() => {});
    ui.varOff.clear();
    if (window.histChanged) window.histChanged('vor Laden von GitHub');
    st.paused = false;
    clearTimeout(saveTimer); store.set('mmpa.projekt', PR.serialize(project));
    if (typeof autoSave === 'function') autoSave();
    renderAll();
    if (online()) show('ok', `Von GitHub geladen (${time()})`); else show('offline', OFFLINE);
    if (msg) toast(`${msg}: ${project.name}`);
  }

  // ---------- Konflikte ----------
  // Ein Dialog nach dem anderen; Antwort: take | keep | both | later
  function choose(text) {
    const p = st.dlg.then(() => new Promise(resolve => {
      const dlg = $('cloudDlg');
      $('cloudDlgText').textContent = text;
      let res = 'later';
      const pick = v => () => { res = v; dlg.close(); };
      $('cloudTake').onclick = pick('take');
      $('cloudKeep').onclick = pick('keep');
      $('cloudBoth').onclick = pick('both');
      $('cloudLater').onclick = pick('later');
      dlg.onclose = () => resolve(res);
      dlg.showModal();
    }));
    st.dlg = p.catch(() => {});
    return p;
  }
  // Eigenen Stand unter neuem Namen auf GitHub und auf dem Gerät ablegen; gibt den Namen zurück
  async function saveCopy(text) {
    const pj = PR.parse(text);
    pj.name = CL.copyName(pj.name);
    const t = PR.serialize(pj), path = CL.pathOf(pj.name);
    const ex = await gh().get(path);
    setSha(path, await gh().put(path, t, ex ? ex.sha : null, `${pj.name} angelegt (beide Stände behalten)`));
    await spiegel.put({ path, text: t });
    return pj.name;
  }
  const LATER = 'Später entscheiden: der Stand auf diesem Gerät bleibt, GitHub wird für dieses Projekt nicht überschrieben. Zum Entscheiden die Wolke neben „Speichern“ antippen.';

  async function askCurrent(remote) {
    const path = remote.path;
    const a = await choose(`Für „${project.name}“ liegt auf GitHub ein anderer Stand als hier, vermutlich von einem anderen Gerät. Auf diesem Gerät gibt es aber auch Änderungen, die noch nicht auf GitHub sind (zum Beispiel aus der Zeit ohne Verbindung). Welchen Stand willst du behalten?`);
    if (curPath() !== path) return;
    if (a === 'later') { st.later.add(path); toast(LATER); return; }
    st.later.delete(path);
    try {
      await exclusive(async () => {
        const fresh = await gh().get(path);
        if (a === 'keep') {
          show('busy', 'Speichert auf GitHub …');
          setSha(path, await gh().put(path, local(), fresh ? fresh.sha : null, `${project.name} gespeichert (anderen Stand überschrieben)`));
          st.paused = false;
          show('ok', `Auf GitHub gespeichert (${time()})`);
          toast('Dein Stand ist jetzt auf GitHub. Der andere bleibt in der Versionsgeschichte des Repos.');
          return;
        }
        if (a === 'both') {
          const n = await saveCopy(local());
          toast(`Dein Stand liegt jetzt als „${n}“ daneben`);
        }
        if (fresh) load(fresh, 'Stand von GitHub geladen');
      });
    } catch (e) { fail(e); }
  }

  async function askOther(c) {
    const name = CL.nameOf(c.path);
    const a = await choose(`„${name}“ wurde auf diesem Gerät geändert (zum Beispiel ohne Verbindung) und inzwischen auch auf GitHub, vermutlich von einem anderen Gerät. Welchen Stand willst du behalten?`);
    if (a === 'later') { st.later.add(c.path); return; }
    st.later.delete(c.path);
    try {
      await exclusive(async () => {
        const fresh = await gh().get(c.path);
        if (a === 'keep') {
          setSha(c.path, await gh().put(c.path, c.text, fresh ? fresh.sha : null, `${name} gespeichert (anderen Stand überschrieben)`));
          toast(`Dein Stand von „${name}“ ist jetzt auf GitHub. Der andere bleibt in der Versionsgeschichte des Repos.`);
          return;
        }
        if (a === 'both') { const n = await saveCopy(c.text); toast(`Dein Stand von „${name}“ liegt jetzt als „${n}“ daneben`); }
        if (fresh) { await spiegel.put({ path: c.path, text: fresh.text }); setSha(c.path, fresh.sha); }
        else { await spiegel.del(c.path); setSha(c.path, null); }
      });
    } catch (e) { fail(e); }
  }

  $('cloudState').onclick = () => {
    if (st.state === 'conflict' || st.state === 'error') { st.paused = false; st.later.clear(); syncNow(false); }
    else if (st.state === 'offline' && online()) syncNow(false);
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
    await mirrorCurrent();
    let remote = null;
    if (online()) {
      try { remote = await exclusive(() => gh().list()); }
      catch (e) { if (e.kind !== 'offline') { fail(e); return origOpen(); } show('offline', OFFLINE); }
    }
    const here = await spiegel.all().catch(() => []);
    const byPath = new Map();
    for (const f of remote || []) byPath.set(f.path, { path: f.path, name: f.name, size: f.size, sha: f.sha, remote: true });
    for (const x of here) {
      const e = byPath.get(x.path) || { path: x.path, name: CL.nameOf(x.path), size: x.text.length, remote: false };
      e.text = x.text;
      e.dirty = await CL.blobSha(x.text) !== knownSha(x.path);
      // Offline kennt die Liste GitHub nicht; was schon einmal dort war, gilt als „auf GitHub“
      if (!remote && knownSha(x.path)) e.remote = true;
      byPath.set(x.path, e);
    }
    let files = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    $('openDir').textContent = remote ? `GitHub ${CL.parseRepo(cfg().repo)} · alle Projekte liegen auch auf diesem Gerät` : 'Offline: Projekte auf diesem Gerät. Änderungen gehen auf GitHub, sobald wieder eine Verbindung da ist.';
    const D = window.MMPAdel;
    const info = f => [`${Math.round(f.size / 1024)} kB`, !f.remote ? 'nur auf diesem Gerät' : f.dirty ? 'noch nicht auf GitHub' : ''].filter(Boolean).join(' · ');
    const render = () => {
      $('openList').innerHTML = files.length
        ? files.map((f, i) => D.openRow(i, f.name, info(f), f.path === curPath())).join('')
        : '<p class="hint">Auf GitHub liegt noch kein Projekt. Mit „Speichern“ legst du das aktuelle dort ab.</p>';
    };
    render();
    $('openList').onclick = async e => {
      const d = e.target.closest('[data-del]');
      if (d) {
        const f = files[+d.dataset.del];
        if (f.remote && !online()) { toast('Löschen geht nur mit Verbindung zu GitHub, sonst käme das Projekt beim nächsten Abgleich zurück'); return; }
        const ok = await D.askDelete(f.name, f.remote ? 'auf GitHub und auf diesem Gerät' : 'auf diesem Gerät'); if (!ok) return;
        try {
          let text = f.text || '';
          if (f.remote) {
            const r = await exclusive(() => gh().get(f.path));
            if (r) { text = text || r.text; await exclusive(() => gh().remove(f.path, r.sha)); }
          }
          await spiegel.del(f.path); setSha(f.path, null);
          const p = ok.local && text ? await D.purgeLocal(f.name, text) : null;
          files = files.filter(x => x !== f); render();
          toast(`${f.name} gelöscht${D.purgeMsg(p) ? ` (dazu ${D.purgeMsg(p)} auf diesem Gerät)` : ''}.${f.remote ? ' In der Versionsgeschichte des Repos bleibt es zurückholbar.' : ''}`);
        } catch (err) {
          if (err.kind === 'conflict') toast('Ein anderes Gerät hat dieses Projekt inzwischen geändert. Liste neu öffnen und nochmals löschen.');
          else toast(`Löschen ging nicht: ${err.message}`);
        }
        return;
      }
      const b = e.target.closest('.libitem'); if (!b) return;
      const f = files[+b.dataset.i];
      // Erst den offenen Stand sichern, dann wechseln
      clearTimeout(st.timer); st.timer = null;
      await push(false);
      try {
        if (f.text != null) {
          // Kopie auf dem Gerät öffnen; der Abgleich holt danach einen neueren Stand von GitHub
          $('openDlg').close();
          load({ path: f.path, text: f.text }, 'Geöffnet');
          if (online()) reconcile(false);
          return;
        }
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
      st.paused = false; st.later.clear();
      await syncNow(false);
      if (st.state === 'ok') toast(`Mit ${repo} verbunden`);
    } catch (e) { show(active() ? 'error' : 'off', e.message); toast(`GitHub: ${e.message}`); }
    finally { $('ghConnect').disabled = false; renderSettings(); }
  };
  $('ghOff').onclick = async () => {
    // Kopien, die schon auf GitHub sind, wegräumen; offline Geändertes bleibt auf dem Gerät
    const m = shas();
    for (const x of await spiegel.all().catch(() => [])) {
      if (m[x.path] && await CL.blobSha(x.text) === m[x.path]) await spiegel.del(x.path).catch(() => {});
    }
    try { localStorage.removeItem(K.token); localStorage.removeItem(K.shas); } catch { /* egal */ }
    clearTimeout(st.timer); show('off'); toast('GitHub-Sync auf diesem Gerät ausgeschaltet');
  };
  $('openSettings').addEventListener('click', renderSettings);
  $('settingsDlg').addEventListener('close', () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; push(false); } });

  // ---------- Lebenszyklus ----------
  window.cloudChanged = changed;
  // Vor dem Wechsel auf ein anderes Projekt (Datei öffnen, neues Projekt) den bisherigen Stand behalten
  window.cloudBeforeSwitch = () => { if (active()) { clearTimeout(st.timer); st.timer = null; mirrorCurrent(); } };
  const idle = () => active() && !st.paused && !st.timer && !st.busy;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (idle()) syncNow(true);
  });
  addEventListener('pagehide', flush);
  addEventListener('online', () => { if (active()) { st.paused = false; syncNow(true); } });
  addEventListener('offline', () => { if (active()) show('offline', OFFLINE); });
  setInterval(() => { if (document.visibilityState === 'visible' && online() && idle()) syncNow(true); }, EVERY);
  if (active()) syncNow(true); else show('off');
})();
