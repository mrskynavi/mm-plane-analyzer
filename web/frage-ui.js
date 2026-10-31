// Fragemodus: Schalter „? Fragen“ oben, dann Klick auf Feld, Tabellenzeile, Kennzahl oder Grafik.
// Daneben öffnet sich eine Sprechblase; die Frage geht mit dem Angeklickten und den Modelldaten an
// die Claude API (eigener Schlüssel in den Einstellungen) oder wird in die Zwischenablage kopiert.
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, store, toast, esc, project, lab, curModel …).
(function () {
  'use strict';
  const FQ = window.MMPA.frage;
  const KEY = 'mmpa.claudeKey', MODEL = 'mmpa.claudeModel';
  const getKey = () => (store.get(KEY) || '').trim();
  const getModel = () => FQ.modelOf(store.get(MODEL)).id;
  const ask = { on: false, pop: null, target: null, ctx: null, data: null, history: [], busy: null };
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const num = v => (typeof v === 'number' ? +v.toPrecision(4) : v);

  // ---------- Was wurde angeklickt? ----------
  function pick(t) {
    if (!t || !t.closest) return null;
    let el;
    if ((el = t.closest('.cbox'))) return { el, kind: 'chart' };
    if ((el = t.closest('table tr')) && el.closest('.tablewrap, table')) return { el, kind: 'row' };
    if ((el = t.closest('.kpi'))) return { el, kind: 'kpi' };
    if ((el = t.closest('.score dd, .score .big'))) return { el, kind: 'kpi' };
    if ((el = t.closest('.field, .sl, .setform .chk'))) return { el, kind: 'field' };
    if ((el = t.closest('.pol-log, .libitem'))) return { el, kind: 'item' };
    if ((el = t.closest('.infopop, .hint, .card, .pol-box, section, .tab, .topics button, .rtabs button'))) return { el, kind: 'area' };
    return null;
  }
  function sectionOf(el) {
    const box = el.closest('.pol-box, .pol-logs, .card, section');
    const h = box && box.querySelector('h2, h3');
    return h ? headText(h) : '';
  }
  function viewText() {
    if (ui.tab !== 'modell') return 'Profil-Labor' + (document.querySelector('#lViews [aria-selected="true"]') ? ' › ' + txt(document.querySelector('#lViews [aria-selected="true"]')) : '');
    const tp = document.querySelector('#mTopics [aria-current="true"] span'), vw = document.querySelector('#mViews [aria-selected="true"]');
    return ['Modell', tp && 'Eingaben ' + txt(tp), vw && 'Ergebnis ' + txt(vw)].filter(Boolean).join(' › ');
  }
  function explain(el) {
    const box = el.closest('.pol-box, .pol-logs, .rview, .topic');
    const pops = box ? [...box.querySelectorAll('.infopop')] : [];
    const s = pops.map(p => p.textContent.replace(/\s+/g, ' ').trim()).join(' ');
    return s ? 'Erklärung der App zu diesem Abschnitt: ' + clip(s, 2500) : '';
  }
  function fieldCtx(el) {
    const lab = el.querySelector(':scope > span:first-child') || el;
    const label = el.matches('.chk') ? txt(el) : txt(lab);
    const vals = [], tips = [];
    el.querySelectorAll('input, select, .seg').forEach(x => {
      if (x.matches('.seg')) { const b = x.querySelector('[aria-pressed="true"]'); if (b) { vals.push(txt(b)); if (b.title) tips.push(b.title); } return; }
      if (x.closest('.seg')) return;
      if (x.type === 'range' && el.querySelector('input.num')) return;
      if (x.type === 'checkbox') { vals.push((x.checked ? 'an' : 'aus')); return; }
      if (x.tagName === 'SELECT') { vals.push(txt(x.selectedOptions[0]) || '–'); return; }
      vals.push(x.value !== '' ? x.value : (x.placeholder ? `leer (${x.placeholder})` : 'leer'));
    });
    const unit = [...el.querySelectorAll('.u')].map(txt).filter(u => u && u !== 'bis').pop() || '';
    if (el.title) tips.push(el.title);
    return { title: label, label, value: vals.join(' bis '), unit, detail: tips.length ? 'Hinweis in der App: ' + tips.join(' / ') : '' };
  }
  function rowCtx(el) {
    const table = el.closest('table'), box = el.closest('.tbox');
    const title = box ? txt(box.querySelector('.ttl')) : sectionOf(el);
    const headRows = table.tHead ? [...table.tHead.rows] : [];
    const heads = headRows.length ? [...headRows[headRows.length - 1].cells].map(txt) : [];
    const cells = [...el.cells].map(c => txt(c) || (c.querySelector('input') ? c.querySelector('input').value : ''));
    const isHead = el.parentElement && el.parentElement.tagName === 'THEAD';
    const pairs = cells.map((c, i) => (heads[i] && heads.length === cells.length ? `${heads[i]}: ${c}` : c)).join(' | ');
    const rows = [...table.rows].slice(0, 45).map(r => [...r.cells].map(c => txt(c) || (c.querySelector('input') ? c.querySelector('input').value : '')).join('\t'));
    const all = 'Ganze Tabelle (tabulatorgetrennt' + (table.rows.length > 45 ? `, erste 45 von ${table.rows.length} Zeilen` : '') + '):\n' + rows.join('\n');
    return { title, label: isHead ? 'Kopfzeile' : 'Zeile', value: clip(pairs, 600), detail: clip(all, 7000) };
  }
  function chartCtx(el, ev) {
    const ct = el.querySelector('.ct');
    const title = ct ? [...ct.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() : 'Grafik';
    const sub = ct ? txt(ct.querySelector('em.sub')) || txt(ct.querySelector('.legend')) : '';
    const cv = el.querySelector('canvas'), L = [];
    if (sub) L.push('Untertitel: ' + sub);
    const ch = cv && window.Chart && Chart.getChart(cv);
    let value = '';
    if (ch) {
      const sc = ch.options.scales || {};
      const ax = k => (sc[k] && sc[k].title && sc[k].title.text) || k;
      L.push(`Achsen: x = ${ax('x')}, y = ${ax('y')}`);
      try {
        const hit = ev && ch.getElementsAtEventForMode(ev, 'nearest', { intersect: false }, false)[0];
        if (hit) {
          const ds = ch.data.datasets[hit.datasetIndex], p = ds.data[hit.index];
          const xy = p && typeof p === 'object' ? `x ${num(p.x)}, y ${num(p.y)}` : `${ch.data.labels ? ch.data.labels[hit.index] : hit.index}: ${num(p)}`;
          value = `nächster Punkt bei Klick: ${ds.label || 'Kurve ' + (hit.datasetIndex + 1)}, ${xy}`;
        }
      } catch (e) { /* ohne Punkt */ }
      ch.data.datasets.forEach((ds, i) => {
        if (!ch.isDatasetVisible(i) || !ds.data || !ds.data.length) return;
        const d = ds.data, step = Math.max(1, Math.ceil(d.length / 25)), pts = [];
        for (let k = 0; k < d.length; k += step) {
          const p = d[k];
          pts.push(p && typeof p === 'object' ? `${num(p.x)};${num(p.y)}` : `${ch.data.labels ? ch.data.labels[k] : k};${num(p)}`);
        }
        L.push(`Kurve „${ds.label || 'ohne Namen'}“ (${d.length} Punkte, x;y${step > 1 ? ', ausgedünnt' : ''}): ${pts.join(' ')}`);
      });
    } else if (cv) L.push('Gezeichnete Grafik: ' + (cv.getAttribute('aria-label') || title));
    return { title, label: '', value, detail: clip(L.join('\n'), 9000) };
  }
  function kpiCtx(el) {
    if (el.matches('.kpi')) return { title: txt(el.querySelector('.l')), label: txt(el.querySelector('.l')), value: txt(el.querySelector('.v')), detail: txt(el.querySelector('.d')) ? 'Zusatz: ' + txt(el.querySelector('.d')) : '' };
    const dt = el.matches('dd') ? el.previousElementSibling : el.querySelector('.l');
    const v = el.matches('dd') ? el : el.querySelector('.v');
    const card = el.closest('.card');
    return { title: txt(dt), label: txt(dt), value: txt(v), detail: card ? 'Karte ' + txt(card.querySelector('.badge')) + ': ' + (card.querySelector('select') ? txt(card.querySelector('select').selectedOptions[0]) : '') : '' };
  }
  function describe(p, ev) {
    const base = { kind: p.kind, section: sectionOf(p.el), view: viewText() };
    let c;
    if (p.kind === 'field') c = fieldCtx(p.el);
    else if (p.kind === 'row') c = rowCtx(p.el);
    else if (p.kind === 'chart') c = chartCtx(p.el, ev);
    else if (p.kind === 'kpi') c = kpiCtx(p.el);
    else c = { title: p.kind === 'item' ? clip(txt(p.el.querySelector('.nm, b') || p.el), 80) : (p.el.querySelector('h2,h3') ? headText(p.el.querySelector('h2,h3')) : ''), detail: 'Text: ' + clip(txt(p.el), 1500) };
    const ex = explain(p.el);
    if (ex) c.detail = [c.detail, ex].filter(Boolean).join('\n');
    return { ...base, ...c };
  }

  // ---------- Daten aus der App ----------
  function appData() {
    const names = Object.fromEntries(project.profiles.map(p => [p.id, p.name]));
    const swap = o => JSON.parse(JSON.stringify(o, (k, v) => (/profileId$/i.test(k) && names[v] ? names[v] : v)));
    const out = { app: 'MM Plane Analyzer', ansicht: viewText(), profile: project.profiles.map(p => p.name) };
    if (ui.tab === 'modell') {
      const m = curModel();
      out.modell = FQ.slim(swap(m));
      out.kennzahlen = [...document.querySelectorAll('#mKpis .kpi')].map(k => `${txt(k.querySelector('.l'))}: ${txt(k.querySelector('.v'))} ${txt(k.querySelector('.d'))}`.trim());
      const r = typeof lastModel !== 'undefined' && lastModel && lastModelId === m.id ? lastModel : null;
      if (r) {
        const pickT = t => t && { ca: t.cl, v_ms: t.v, alpha: t.alpha, E: t.E, sinken_ms: t.sink, cw: t.cd, ewd: t.ewdCur };
        out.ergebnis = FQ.slim({
          neutralpunkt_mm: r.xNP, schwerpunkt_mm: r.xCG, stabilitaetsmass: r.sigma, dCa_dalpha_proGrad: r.CLalpha, trimm: r.trim,
          flaechenbelastung: r.wingLoading, leitwerksvolumen: r.tailVolume, besteGleitzahl: pickT(r.best), geringstesSinken: pickT(r.minSink),
          abrissAusnutzung: r.stall, abrissOrt: r.stallAt, rumpf: r.fuselage,
          fluegel: r.wing && { flaeche: r.wing.area, mac: r.wing.mac, spannweiteProjiziert: r.wing.projSpan },
          leitwerk: r.tail && { flaeche: r.tail.area, mac: r.tail.mac },
          polare: (r.table || []).filter((t, i, a) => a.length <= 16 || i % Math.ceil(a.length / 16) === 0).map(pickT),
        }, { maxArr: 40 });
      }
    } else {
      out.labor = FQ.slim(swap(lab));
    }
    let s = JSON.stringify(out);
    if (s.length > 60000) { delete out.ergebnis; s = JSON.stringify(out); }
    if (s.length > 60000) out.modell = '[zu gross, ausgelassen]';
    return out;
  }

  // ---------- Modus und Hervorhebung ----------
  const hl = document.createElement('div'); hl.className = 'askhl'; hl.hidden = true; document.body.appendChild(hl);
  const banner = document.createElement('div'); banner.className = 'askbanner'; banner.hidden = true;
  banner.innerHTML = '<b>Fragemodus</b> Klick auf ein Feld, eine Tabellenzeile, eine Kennzahl oder eine Grafik. <kbd>Esc</kbd> beendet.';
  document.body.appendChild(banner);
  function frame(box, el) {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    box.hidden = false;
  }
  function setMode(on) {
    ask.on = on;
    document.body.classList.toggle('asking', on);
    $('askToggle').setAttribute('aria-pressed', on);
    banner.hidden = !on; hl.hidden = true;
    if (!on) closePop();
  }
  $('askToggle').addEventListener('click', e => { e.stopPropagation(); setMode(!ask.on); });
  const inside = t => t.closest && (t.closest('.askpop') || t.closest('#askToggle') || t.closest('dialog') || t.closest('.askbanner'));
  document.addEventListener('mousemove', e => {
    if (!ask.on || inside(e.target)) { hl.hidden = true; return; }
    const p = pick(e.target);
    if (p) frame(hl, p.el); else hl.hidden = true;
  }, { passive: true });
  // Im Fragemodus wirkt ein Klick nicht auf die App (keine Schieber, keine Knöpfe), er öffnet die Blase
  const block = e => { if (ask.on && !inside(e.target) && pick(e.target)) { e.preventDefault(); e.stopPropagation(); } };
  ['pointerdown', 'mousedown', 'touchstart', 'dblclick'].forEach(t => document.addEventListener(t, block, { capture: true, passive: false }));
  document.addEventListener('click', e => {
    if (!ask.on || e.defaultPrevented || inside(e.target)) return;
    const p = pick(e.target);
    if (!p) return;
    e.preventDefault(); e.stopPropagation();
    openPop(p, e);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (ask.pop) { closePop(); e.stopPropagation(); } else if (ask.on) setMode(false);
  }, true);
  addEventListener('scroll', () => { if (ask.pop && ask.target) place(); hl.hidden = true; }, true);
  addEventListener('resize', () => { if (ask.pop) place(); });

  // ---------- Sprechblase ----------
  function modelOptions() {
    return FQ.MODELS.map(m => `<option value="${m.id}" ${m.id === getModel() ? 'selected' : ''}>${m.label}</option>`).join('');
  }
  function openPop(p, ev) {
    closePop();
    ask.target = p.el; ask.ctx = describe(p, ev); ask.data = appData(); ask.history = [];
    p.el.classList.add('asktarget');
    const pop = document.createElement('div');
    pop.className = 'askpop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Frage an Claude');
    pop.innerHTML = `<div class="ah"><span class="actx" title="${esc(FQ.contextText(ask.ctx))}">${esc(FQ.contextShort(ask.ctx))}</span><button type="button" class="x" aria-label="Schliessen" title="Schliessen (Esc)">×</button></div>
      <div class="alog" aria-live="polite"></div>
      <textarea rows="2" placeholder="Deine Frage … (Enter sendet, Shift+Enter neue Zeile)"></textarea>
      <div class="arow"><button type="button" class="btn sm" data-a="ask">Fragen</button><button type="button" class="btn ghost sm" data-a="copy" title="Frage, Kontext und Modelldaten in die Zwischenablage, zum Einfügen in claude.ai">Kopieren</button>
      <select class="sel amodel" aria-label="Modell">${modelOptions()}</select><span class="acost"></span></div>
      <p class="hint anokey" hidden>Ohne API-Schlüssel: „Kopieren“ legt Frage und Daten in die Zwischenablage. Dann in <a href="https://claude.ai/new" target="_blank" rel="noopener">claude.ai</a> einfügen. Den Schlüssel trägst Du unter ⚙ Einstellungen ein.</p>`;
    document.body.appendChild(pop);
    ask.pop = pop;
    const ta = pop.querySelector('textarea');
    pop.querySelector('.x').onclick = closePop;
    pop.querySelector('[data-a="ask"]').onclick = () => (ask.busy ? ask.busy.abort() : send());
    pop.querySelector('[data-a="copy"]').onclick = copy;
    pop.querySelector('.amodel').onchange = e => { store.set(MODEL, e.target.value); syncPop(); };
    ta.addEventListener('input', syncPop);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); getKey() ? (ask.busy || send()) : copy(); } });
    syncPop(); place(); ta.focus();
  }
  function closePop() {
    if (ask.busy) ask.busy.abort();
    if (ask.pop) ask.pop.remove();
    if (ask.target) ask.target.classList.remove('asktarget');
    ask.pop = null; ask.target = null;
  }
  function place() {
    const pop = ask.pop, r = ask.target.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 12, vw = innerWidth, vh = innerHeight;
    let left, top;
    if (r.right + gap + w <= vw - 8) left = r.right + gap;
    else if (r.left - gap - w >= 8) left = r.left - gap - w;
    else { left = Math.min(Math.max(8, r.left), vw - w - 8); top = r.bottom + gap + h <= vh - 8 ? r.bottom + gap : Math.max(8, r.top - gap - h); }
    if (top == null) top = Math.min(Math.max(8, r.top), vh - h - 8);
    pop.style.left = Math.max(8, left) + 'px'; pop.style.top = Math.max(8, top) + 'px';
  }
  function syncPop() {
    const pop = ask.pop; if (!pop) return;
    const key = getKey(), q = pop.querySelector('textarea').value.trim();
    pop.querySelector('[data-a="ask"]').hidden = !key;
    pop.querySelector('.amodel').hidden = !key;
    pop.querySelector('.anokey').hidden = !!key;
    pop.querySelector('[data-a="ask"]').textContent = ask.busy ? 'Stopp' : 'Fragen';
    pop.querySelector('[data-a="ask"]').disabled = !ask.busy && !q;
    if (key && !ask.busy) {
      const est = FQ.estimate(getModel(), FQ.buildMessages(ask.history, q || '…', ask.ctx, ask.data));
      pop.querySelector('.acost').textContent = `geschätzt ca. ${FQ.fmtUSD(est.usd)}`;
      pop.querySelector('.acost').title = `etwa ${est.inTok.toLocaleString('de-CH')} Token hinein, ${est.outTok.toLocaleString('de-CH')} heraus (Schätzung)`;
    }
  }
  function addEntry(cls, html) {
    const d = document.createElement('div'); d.className = 'aq ' + cls; d.innerHTML = html;
    ask.pop.querySelector('.alog').appendChild(d);
    return d;
  }
  async function writeClip(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove(); return ok;
    }
  }
  async function copy() {
    const q = ask.pop.querySelector('textarea').value.trim();
    const ok = await writeClip(FQ.copyText(q, ask.ctx, ask.data, ask.history));
    toast(ok ? 'Kopiert. In claude.ai einfügen (Ctrl+V) und abschicken.' : 'Kopieren hat nicht geklappt. Der Browser hat den Zugriff auf die Zwischenablage verweigert.');
  }

  async function send() {
    const pop = ask.pop, ta = pop.querySelector('textarea'), q = ta.value.trim(), key = getKey();
    if (!q || !key) return;
    const model = getModel(), messages = FQ.buildMessages(ask.history, q, ask.ctx, ask.data);
    addEntry('q', esc(q));
    const a = addEntry('a', '<span class="adots">Claude denkt nach …</span>');
    ta.value = '';
    const ctl = new AbortController(); ask.busy = ctl; syncPop();
    const st = FQ.sseState();
    const log = pop.querySelector('.alog');
    try {
      let withFb = true, res;
      for (;;) {
        res = await fetch(FQ.API_URL, { method: 'POST', headers: FQ.requestHeaders(key, model, withFb), body: JSON.stringify(FQ.requestBody(model, messages, withFb)), signal: ctl.signal });
        if (res.ok) break;
        let msg = ''; try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* kein JSON */ }
        // Ältere Konten kennen die automatische Ausweichregel nicht: ohne sie nochmals
        if (withFb && res.status === 400 && /fallback|anthropic-beta|beta/i.test(msg)) { withFb = false; continue; }
        throw Object.assign(new Error(FQ.errorText(res.status, msg)), { shown: true });
      }
      const rd = res.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        if (FQ.sseFeed(st, dec.decode(value, { stream: true }))) { a.innerHTML = FQ.markdown(st.text); log.scrollTop = log.scrollHeight; }
        if (st.error) throw Object.assign(new Error(FQ.errorText(0, st.error)), { shown: true });
      }
      if (st.stop === 'refusal') a.innerHTML = FQ.markdown(st.text) + '<p class="aerr">Claude hat diese Antwort abgebrochen. Formuliere die Frage etwas anders.</p>';
      else if (st.stop === 'max_tokens') a.innerHTML = FQ.markdown(st.text) + '<p class="aerr">Die Antwort wurde wegen der Länge abgeschnitten.</p>';
      else a.innerHTML = FQ.markdown(st.text) || '<p class="aerr">Keine Antwort erhalten.</p>';
      if (st.text) ask.history = [...messages, { role: 'assistant', content: st.text }];
    } catch (e) {
      if (e.name === 'AbortError') a.innerHTML = (st.text ? FQ.markdown(st.text) : '') + '<p class="aerr">Abgebrochen.</p>';
      else a.innerHTML = '<p class="aerr">' + esc(e.shown ? e.message : 'Keine Verbindung zu Claude: ' + e.message) + '</p>';
    } finally {
      if (st.inTok || st.outTok) {
        const usd = FQ.costUSD(model, st.inTok + st.cacheIn, st.outTok);
        addEntry('c', `${esc(FQ.modelOf(model).label)} · ${st.inTok.toLocaleString('de-CH')} Token hinein, ${st.outTok.toLocaleString('de-CH')} heraus · Kosten ca. ${FQ.fmtUSD(usd)}`);
      }
      ask.busy = null;
      if (ask.pop === pop) { syncPop(); place(); log.scrollTop = log.scrollHeight; ta.placeholder = 'Nachfrage … (Enter sendet)'; ta.focus(); }
    }
  }

  // ---------- Einstellungen: Schlüssel und Modell ----------
  const segM = $('setModel');
  segM.innerHTML = FQ.MODELS.map(m => `<button type="button" data-v="${m.id}" title="${m.hint}: ${m.in.toLocaleString('de-CH')} $ / ${m.out.toLocaleString('de-CH')} $ pro Million Token hinein / heraus">${m.label}</button>`).join('');
  function syncSet() {
    const k = getKey();
    $('setKey').value = k;
    $('setKeyState').textContent = k ? `Schlüssel gespeichert (…${k.slice(-4)})` : 'Kein Schlüssel. Der Fragemodus kopiert dann in die Zwischenablage.';
    $('setKeyClear').hidden = !k;
    segM.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === getModel()));
    const typical = { inTok: 9000, outTok: FQ.OUT_GUESS };
    $('setCost').textContent = 'Eine typische Frage kostet etwa ' + FQ.MODELS.map(m => `${m.label} ${FQ.fmtUSD(FQ.costUSD(m.id, typical.inTok, typical.outTok))}`).join(', ') + ' (geschätzt).';
  }
  $('openSettings').addEventListener('click', syncSet);
  $('setKey').addEventListener('change', () => {
    const v = $('setKey').value.trim();
    if (v && !/^sk-ant-/.test(v)) toast('Der Schlüssel sieht ungewöhnlich aus. Er beginnt normalerweise mit sk-ant-.');
    store.set(KEY, v); syncSet(); syncPop();
  });
  $('setKeyClear').onclick = () => { try { localStorage.removeItem(KEY); } catch (e) { /* egal */ } syncSet(); syncPop(); toast('Schlüssel gelöscht'); };
  segM.onclick = e => { const b = e.target.closest('button'); if (!b) return; store.set(MODEL, b.dataset.v); syncSet(); };
  syncSet();
})();
