// Reiter „Festigkeit“ (F1): Aufbau je Flügel/HLW, Materialien, Lastfälle und die Lasten daraus (Q, M, T, Verbinder, Anlenkungen).
// Läuft nach dem Hauptskript und nutzt dessen globale Helfer ($, fmt, esc, css, chart, curModel, lastModel, persist, project, lab, viewOn, setZoom).
// Gerechnet wird in einem eigenen Worker (core/modell-worker.js, Nachricht kind 'struktur').
(function () {
  'use strict';
  const S = window.MMPA.struktur;
  const IN = $('festIn'), OUT = $('festOut');
  const NAME = { wing: 'Flügel', tail: 'Höhenleitwerk' };
  let part = 'wing', worker = null, seq = 0, timer = null, last = null, lastErr = '', busy = false, showMat = false;

  // ---------- Eingaben ----------
  const num = (label, k, v, unit = '', step = 1, extra = '') => `<label class="field"><span>${label}</span><span class="row"><input class="num" type="number" step="${step}" data-k="${k}" value="${v ?? ''}" ${extra}>${unit ? `<span class="u">${unit}</span>` : ''}</span></label>`;
  const seg = (label, k, v, opts) => `<div class="field"><span>${label}</span><span class="seg" data-seg="${k}">${opts.map(([id, t]) => `<button type="button" data-v="${id}" aria-pressed="${id === v}">${t}</button>`).join('')}</span></div>`;
  const matSel = (k, v, mats) => {
    const groups = {};
    Object.values(mats).forEach(m => (groups[m.group] = groups[m.group] || []).push(m));
    return `<select data-k="${k}">${Object.entries(groups).map(([g, l]) => `<optgroup label="${esc(g)}">${l.map(m => `<option value="${esc(m.id)}"${m.id === v ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  };
  const matField = (label, k, v, mats) => `<label class="field"><span>${label}</span>${matSel(k, v, mats)}</label>`;

  function renderIn() {
    const m = curModel(); if (!m) return;
    const mats = S.materials(project), L = S.loadsOf(m), st = S.structOf(m, part), j = st.joiner;
    const round = j.form === 'rund' || j.form === 'rohr';
    IN.innerHTML = `
<section class="pol-box">
  <div class="pol-head"><h2 class="hi">Lasten <button type="button" class="iconbtn sm" data-finfo aria-expanded="false" aria-label="So wird gerechnet">i</button></h2><span class="status" id="festStatus"></span></div>
  <div class="infopop" id="festInfo" hidden>
    <p>Die Lasten kommen aus dem Wirbelgitter des Modells: Auftrieb je Streifen beim Lastvielfachen n, abzüglich der Masse der Fläche selbst (Massenentlastung). Daraus Querkraft Q, Biegemoment M und Torsion T um die Holmachse (Profilmoment plus Auftrieb mal Abstand zum Holm, positiv dreht die Nase hoch).</p>
    <p>„Abfangen bei Ca max“ rechnet bei der Fahrt, ab der n gerade erreichbar ist. Ist n bis V max nicht erreichbar, weil der Flügel vorher abreisst, wird das erreichbare n genommen. Die Böe folgt n = 1 + ρ·V·U·a / (2·G/S).</p>
    <p>Anlenkungen: Scharniermoment der Klappe aus der Druckverteilung hinter der Scharnierlinie bei V max und vollem Ausschlag. Kraft im Gestänge = Moment / Ruderhornlänge, Servomoment = Kraft × Servoarm. Gerechnet je Streifen ohne 3D-Entlastung, also eher zu hoch.</p>
    <p>Steifigkeit: EI aus Gurten, Steg und Schale um die Biegeachse, GJ nach Bredt für den geschlossenen Kasten (ganze Schale oder D-Box mit dem Steg als Rückwand). Der Flügel ist ein Balken, an der Wurzel eingespannt. Daraus Durchbiegung, Verwindung und die Dehnung in jedem Bauteil. Reserve = zulässige durch vorhandene Spannung.</p>
    <p>Aeroelastik: Das Moment um den Holm verdreht den Flügel, die Verdrehung ändert den Auftrieb und damit wieder das Moment. Gerechnet je Streifen mit der Drehsteifigkeit GJ. Divergenz ist der Staudruck, bei dem das keine Lösung mehr hat. Ruderwirksamkeit ist das Rollmoment des verdrehten Flügels im Verhältnis zum starren. Der Flatter-Richtwert folgt der Näherung von Theodorsen und Garrick aus der Torsionsfrequenz, der Masse und der Lage des Schwerpunkts im Schnitt. Rudermassen, Spiel in der Anlenkung und der Leitwerksträger sind nicht enthalten.</p>
    <p>Nicht geprüft sind Beulen der Schale, Knicken des Druckgurts, Klebungen und Krafteinleitungen. Die Materialwerte sind Richtwerte und lassen sich unten ändern.</p>
  </div>
  <div class="form">
    ${num('Lastvielfaches n', 'loads.n', L.n, 'g', 1, 'min="1"')}
    ${num('V max', 'loads.vMaxKmh', Math.round(L.vMax * 3.6), 'km/h', 5, 'min="20"')}
    ${num('Böe senkrecht', 'loads.gust', L.gust, 'm/s', 1, 'min="0"')}
    ${num('n bei der Landung', 'loads.nLand', L.nLand, 'g', 1, 'min="1"')}
    ${num('Seilzug Hochstart', 'loads.tow', L.tow, 'N', 10, 'min="0" title="0 = ohne Hochstart"')}
    ${num('Klappen voll', 'loads.flap', L.flap, '°', 1, 'min="0"')}
    ${num('Höhenruder voll', 'loads.elev', L.elev, '°', 1, 'min="0"')}
  </div>
</section>
<section class="pol-box">
  <div class="pol-head"><h2 class="hi">Aufbau</h2><span class="seg" data-part>${Object.entries(NAME).map(([k, t]) => `<button type="button" data-v="${k}" aria-pressed="${k === part}">${t}</button>`).join('')}</span></div>
  <div class="form">
    ${seg('Vorlage', 'template', st.template, Object.entries(S.TEMPLATES).map(([k, t]) => [k, t.label]))}
    ${num('Holmlage', 'spar.pos', st.spar.pos, '% Tiefe', 1, 'min="5" max="70"')}
    ${matField('Gurt Material', 'spar.mat', st.spar.mat, mats)}
    ${num('Gurtbreite', 'spar.b', st.spar.b, 'mm', 0.5, 'min="0"')}
    ${num('Gurtdicke Wurzel', 'spar.t0', st.spar.t0, 'mm', 0.1, 'min="0"')}
    ${num('Gurtdicke Rand', 'spar.t1', st.spar.t1, 'mm', 0.1, 'min="0"')}
    ${matField('Steg Material', 'web.mat', st.web.mat, mats)}
    ${num('Stegdicke', 'web.t', st.web.t, 'mm', 0.5, 'min="0"')}
    ${seg('Torsionskasten', 'shell.box', st.shell.box, [['voll', 'ganze Schale'], ['dbox', 'D-Box bis Holm']])}
    ${seg('Füllung', 'fill', st.fill, [['hohl', 'hohl'], ['styro', 'Styro'], ['rippen', 'Rippen']])}
    ${num('Masse gewogen', 'mass', st.mass ?? '', 'g', 10, 'min="0" placeholder="gerechnet" title="Beide Hälften. Leer = aus dem Aufbau gerechnet"')}
  </div>
  <h3 class="sub">Schale, Lagen von aussen nach innen</h3>
  <div class="tablewrap"><table><thead><tr><th>Material</th><th>Gewicht / Dicke</th><th>Faser</th><th></th></tr></thead><tbody>
    ${st.shell.layers.map((l, i) => `<tr><td>${matSel('layer.' + i + '.mat', l.mat, mats)}</td><td>${S.fabric(l.mat) ? `<span class="row"><input class="num" type="number" step="1" min="0" data-k="layer.${i}.g" value="${l.g}" title="Flächengewicht des trockenen Gewebes"><span class="u">g/m²</span></span><span class="hint" style="display:block">= ${fmt(l.t, 2)} mm Laminat</span>` : `<span class="row"><input class="num" type="number" step="0.1" min="0" data-k="layer.${i}.t" value="${l.t}"><span class="u">mm</span></span>`}</td><td><select data-k="layer.${i}.angle"><option value="0"${+l.angle === 0 ? ' selected' : ''}>0/90°</option><option value="45"${+l.angle === 45 ? ' selected' : ''}>±45°</option></select></td><td><button type="button" class="iconbtn sm" data-del="${i}" aria-label="Lage löschen">×</button></td></tr>`).join('')}
  </tbody></table></div>
  <div class="btnrow"><button type="button" class="btn ghost" data-add>+ Lage</button></div>
  <h3 class="sub">Verbinder</h3>
  <div class="form">
    ${matField('Material', 'joiner.mat', j.mat, mats)}
    <label class="field"><span>Form</span><select data-k="joiner.form">${Object.entries(S.FORMS).map(([k, t]) => `<option value="${k}"${k === j.form ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    ${round ? num('Durchmesser', 'joiner.d', j.d, 'mm', 0.5, 'min="0"') : num('Breite', 'joiner.b', j.b, 'mm', 0.5, 'min="0"') + num('Höhe', 'joiner.h', j.h, 'mm', 0.5, 'min="0"')}
    ${j.form === 'rohr' ? num('Innendurchmesser', 'joiner.di', j.di, 'mm', 0.5, 'min="0"') : ''}
    ${j.form === 'vierkantrohr' ? num('Wandstärke', 'joiner.t', j.t, 'mm', 0.1, 'min="0"') : ''}
    ${num('Länge im Flügel', 'joiner.len', j.len, 'mm', 5, 'min="0"')}
    ${num('Anzahl', 'joiner.n', j.n, '', 1, 'min="1"')}
  </div>
  <h3 class="sub">Aeroelastik und Messung</h3>
  <div class="form">
    ${num('Schwerpunkt im Schnitt', 'aero.cg', st.aero.cg, '% Tiefe', 1, 'min="15" max="60" title="Massenschwerpunkt des Flügelschnitts in Tiefenrichtung, für den Flatter-Richtwert. Schalenflügel liegen bei 38 bis 45 %."')}
    ${num('Biegeprobe: Gewicht', 'aero.bendMass', st.aero.bendMass, 'g', 50, 'min="0" placeholder="–" title="Flügelhälfte an der Wurzel eingespannt, Gewicht angehängt"')}
    ${num('… angehängt bei y', 'aero.bendY', st.aero.bendY, 'mm', 10, 'min="0" placeholder="Randbogen"')}
    ${num('… Durchbiegung dort', 'aero.bendW', st.aero.bendW, 'mm', 1, 'min="0" placeholder="–"')}
    ${num('Drehprobe: Moment', 'aero.torsM', st.aero.torsM, 'N·cm', 5, 'min="0" placeholder="–" title="Zum Beispiel 200 g an einem 100 mm langen Hebel = 19,6 N·cm"')}
    ${num('… angesetzt bei y', 'aero.torsY', st.aero.torsY, 'mm', 10, 'min="0" placeholder="Randbogen"')}
    ${num('… Verdrehung dort', 'aero.torsPhi', st.aero.torsPhi, '°', 0.1, 'min="0" placeholder="–"')}
  </div>
  <h3 class="sub">Anlenkung</h3>
  <div class="form">
    ${num('Ruderhorn', 'link.horn', st.link.horn, 'mm', 1, 'min="1" title="Abstand Scharnier bis Gestänge"')}
    ${num('Servoarm', 'link.arm', st.link.arm, 'mm', 1, 'min="1"')}
    <label class="field"><span>Ruder trennen bei y</span><span class="row"><input class="txt" data-k="link.cuts" value="${esc((st.link.cuts || []).join(', '))}" placeholder="z. B. 900, 1700" title="Spannweitenlage der Trennstellen zwischen den Rudern, mit Komma getrennt. Jedes Stück hat ein Servo."><span class="u">mm</span></span></label>
  </div>
</section>
<section class="pol-box">
  <div class="pol-head"><h2 class="hi">Materialien</h2><button type="button" class="btn ghost" data-mats>${showMat ? 'zuklappen' : 'Werte ändern'}</button></div>
  ${showMat ? `<p class="hint">Richtwerte in N/mm², Dichte in kg/m³. Geänderte Werte gelten für dieses Projekt. Bei Rovings zählt der Laminatwert, nicht der Faserwert.</p>
  <div class="tablewrap"><table><thead><tr><th>Material</th><th>E</th><th>G</th><th>σ Zug</th><th>σ Druck</th><th>τ</th><th>Dichte</th><th></th></tr></thead><tbody>
    ${Object.values(mats).map(q => `<tr><td>${q.own ? `<input class="txt" data-mk="${esc(q.id)}.name" value="${esc(q.name)}">` : esc(q.name)}${q.changed ? ' <small>geändert</small>' : ''}</td>${S.MAT_FIELDS.map(f => `<td><input class="num" type="number" min="0" step="any" data-mk="${esc(q.id)}.${f}" value="${q[f]}"></td>`).join('')}<td>${q.own || q.changed ? `<button type="button" class="iconbtn sm" data-mreset="${esc(q.id)}" title="${q.own ? 'löschen' : 'zurück auf Richtwert'}">${q.own ? '×' : '↺'}</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="btnrow"><button type="button" class="btn ghost" data-madd>+ eigenes Material</button></div>` : ''}
</section>`;
    status();
  }

  function setStruct(path, v) {
    const m = curModel(), s = m[part].struct = m[part].struct || {};
    const [a, b, c] = path.split('.');
    if (a === 'layer') {
      const cur = S.structOf(m, part).shell.layers;
      const l = cur[+b], was = !!S.fabric(l.mat);
      l[c] = c === 'mat' ? v : +v;
      if (c === 'mat' && was !== !!S.fabric(v)) { if (was) { delete l.g; l.t = 1; } else l.g = 49; } // Gewebe ↔ Holz: sinnvoller Startwert
      s.shell = { ...(s.shell || {}), layers: cur };
    } else if (a === 'template') {
      // neue Vorlage: Holm, Steg, Schale und Füllung von dort, Verbinder und Anlenkung bleiben
      m[part].struct = { template: v, joiner: s.joiner, link: s.link, mass: s.mass };
      if (!m[part].struct.joiner) delete m[part].struct.joiner;
      if (!m[part].struct.link) delete m[part].struct.link;
      if (m[part].struct.mass == null) delete m[part].struct.mass;
    } else if (b) { s[a] = { ...(s[a] || {}), [b]: v }; }
    else if (v === '' || v == null || (a === 'mass' && !(+v > 0))) delete s[a];
    else s[a] = v;
  }
  function changed(rerender) { persist(); if (rerender) renderIn(); schedule(); }

  IN.addEventListener('change', e => {
    const t = e.target, m = curModel();
    if (t.dataset.k) {
      const k = t.dataset.k, isNum = t.type === 'number', v = isNum ? (t.value === '' ? '' : +t.value) : t.value;
      if (isNum && v !== '' && !Number.isFinite(v)) return;
      if (k.startsWith('loads.')) {
        const f = k.slice(6); m.loads = { ...(m.loads || {}) };
        if (v === '') delete m.loads[f === 'vMaxKmh' ? 'vMax' : f];
        else if (f === 'vMaxKmh') m.loads.vMax = v / 3.6; else m.loads[f] = v;
        changed(false);
      } else if (k === 'link.cuts') {
        setStruct(k, t.value.split(/[;,\s]+/).map(x => parseFloat(x)).filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)); changed(true);
      } else { setStruct(k, v); changed(k === 'joiner.form' || k.startsWith('layer.')); }
    } else if (t.dataset.mk) {
      const [id, f] = t.dataset.mk.split('.');
      project.materials = project.materials || {};
      project.materials[id] = { ...(project.materials[id] || {}), [f]: f === 'name' ? t.value : +t.value };
      changed(f === 'name' || !!S.MATERIALS[id]);
    }
  });
  IN.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const m = curModel();
    if (b.closest('[data-part]')) { part = b.dataset.v; renderIn(); renderOut(); return; }
    const sg = b.closest('[data-seg]');
    if (sg) { setStruct(sg.dataset.seg, b.dataset.v); changed(true); return; }
    if (b.dataset.finfo != null) { const p = $('festInfo'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); return; }
    if (b.dataset.add != null || b.dataset.del != null) {
      const cur = S.structOf(m, part).shell.layers;
      if (b.dataset.del != null) cur.splice(+b.dataset.del, 1); else cur.push({ mat: 'gfk-gewebe', g: 49, angle: 45 });
      const s = m[part].struct = m[part].struct || {}; s.shell = { ...(s.shell || {}), layers: cur };
      changed(true); return;
    }
    if (b.dataset.mats != null) { showMat = !showMat; renderIn(); return; }
    if (b.dataset.madd != null) {
      project.materials = project.materials || {};
      let n = 1; while (project.materials['eigen-' + n]) n++;
      project.materials['eigen-' + n] = { name: 'Eigenes Material ' + n, group: 'Eigene', E: 10000, G: 1000, sigT: 100, sigC: 100, tau: 10, rho: 1000 };
      changed(true); return;
    }
    if (b.dataset.mreset) { delete project.materials[b.dataset.mreset]; changed(true); }
  });

  // ---------- Rechnung ----------
  function status() { const s = $('festStatus'); if (s) s.textContent = busy ? 'rechnet …' : lastErr ? 'nicht möglich: ' + lastErr : ''; }
  // Stand der Eingaben, für die das letzte Ergebnis gilt (die 3D-Ansicht fragt über need() nach)
  let lastKey = null, lastR = null;
  const waiters = [];
  const keyOf = m => JSON.stringify([m && m.id, m && m.wing.struct, m && m.tail.struct, m && m.loads, m && m.mass, project.materials]);
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 150); }
  function run() {
    const m = curModel(), r = lastModel, k0 = keyOf(m);
    if (!m || !r || !r.load) { last = null; lastErr = r ? '' : 'Modellrechnung fehlt'; renderOut(); status(); return; }
    const my = ++seq, msg = { kind: 'struktur', seq: my, model: m, profiles: project.profiles, r, nCrit: lab.nCrit, materials: project.materials || {} };
    let watch = null;
    const done = (res, err) => { clearTimeout(watch); if (my !== seq) return; busy = false; last = res || null; lastKey = res ? k0 : null; lastR = r; lastErr = err || ''; status(); renderOut(); waiters.splice(0).forEach(f => f(last)); };
    // Ohne Worker, bei einem alten Worker aus dem Zwischenspeicher (kennt 'struktur' nicht) oder wenn er nicht antwortet: in der Seite rechnen
    const inPage = () => { if (worker && worker.cb) delete worker.cb[my]; if (my !== seq) return; try { done(S.analyze(m, project.profiles, r, { nCrit: lab.nCrit, project })); } catch (e2) { done(null, e2.message); } };
    busy = true; status();
    try {
      if (!worker) {
        worker = new Worker('core/modell-worker.js?v=' + (window.MMPA_BUILD || ''));
        worker.cb = {};
        worker.onmessage = e => {
          const d = e.data, cb = worker.cb[d.seq]; if (!cb) return;
          delete worker.cb[d.seq];
          if (d.kind === 'struktur') cb.done(d.result, d.error); else cb.inPage();
        };
        worker.onerror = e => { e.preventDefault(); const cbs = Object.values(worker.cb); worker.terminate(); worker = null; cbs.forEach(c => c.inPage()); };
      }
      worker.cb[my] = { done, inPage }; worker.postMessage(msg);
      watch = setTimeout(inPage, 12000);
    } catch (err) { inPage(); }
  }

  // ---------- Ergebnisse ----------
  OUT.innerHTML = `
<section class="pol-box rv-sec"><div class="pol-head"><h2 class="hi" id="festTitle">Lastfälle</h2><span class="status" id="festMeta"></span></div>
  <div class="tablewrap"><table id="festCases"></table></div><p class="hint" id="festHint"></p></section>
<div class="charts">
  <div class="cbox"><div class="ct">Biegemoment <span>M in Nm <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festM"></canvas></div><div class="legend cleg" id="festLeg"></div></div>
  <div class="cbox"><div class="ct">Querkraft <span>Q in N <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festQ"></canvas></div></div>
  <div class="cbox"><div class="ct">Torsion um den Holm <span>T in Nm <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festT"></canvas></div></div>
</div>
<section class="pol-box rv-sec"><div class="pol-head"><h3 class="sub">Ausnutzung</h3><span class="status" id="festWorst"></span></div><div class="tablewrap"><table id="festUse"></table></div><p class="hint">Reserve = zulässig / vorhanden, über alle Lastfälle. Ab 1,5 grün, unter 1 bricht es rechnerisch. Beulen der Schale und Knicken des Druckgurts sind nicht geprüft, ebenso Krafteinleitungen.</p></section>
<div class="charts">
  <div class="cbox"><div class="ct">Durchbiegung <span>w in mm <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festW"></canvas></div></div>
  <div class="cbox"><div class="ct">Verwindung <span>φ in °, + Nase hoch <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festPhi"></canvas></div></div>
  <div class="cbox"><div class="ct">Reserve <span>min. <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festR"></canvas></div><div class="legend cleg" id="festRLeg"></div></div>
  <div class="cbox"><div class="ct">Steifigkeit <span>EI und GJ in N·m² <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festEI"></canvas></div><div class="legend cleg" id="festEILeg"></div></div>
</div>
<section class="pol-box rv-sec" id="festAero"><div class="pol-head"><h3 class="sub">Aeroelastik Flügel</h3><span class="status" id="festAeroMeta"></span></div>
  <div class="tablewrap"><table id="festAeroLim"></table></div><p class="hint" id="festAeroHint"></p>
  <div class="tablewrap"><table id="festAeroSweep"></table></div><p class="hint" id="festAeroNote"></p></section>
<div class="charts" id="festAeroCharts">
  <div class="cbox"><div class="ct">Ruderwirksamkeit <span>Rollmoment elastisch / starr in % <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festEta"></canvas></div></div>
  <div class="cbox"><div class="ct">Verwindung im Geradeausflug <span>θ in °, + Nase hoch <button type="button" class="zoom" aria-label="Diagramm gross" title="Gross / klein">⤢</button></span></div><div class="cv"><canvas id="festTw"></canvas></div><div class="legend cleg" id="festTwLeg"></div></div>
</div>
<section class="pol-box rv-sec"><h3 class="sub">Verbinder</h3><div class="tablewrap"><table id="festJoin"></table></div></section>
<section class="pol-box rv-sec"><h3 class="sub">Anlenkungen: Kraft am Servo</h3><div class="tablewrap"><table id="festServo"></table></div><p class="hint" id="festServoHint"></p></section>
<section class="pol-box rv-sec"><h3 class="sub">Aufbau und Masse je Station</h3><div class="tablewrap"><table id="festSt"></table></div><p class="hint" id="festMass"></p></section>`;
  OUT.querySelectorAll('.zoom').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setZoom(b.closest('.cbox')); }));

  const COLS = ['--accent', '--bad', '--warn', '--good', '--violet', '--muted'];
  const lamp = v => `<td class="${v >= 1.5 ? 'best' : v >= 1 ? 'warn' : ''}" ${v < 1 ? 'style="color:var(--bad);font-weight:600"' : ''}>${fmt(v, 2)}</td>`;

  function renderOut() {
    if (!viewOn('fest')) return;
    const a = last, P = a && a[part];
    $('festTitle').textContent = 'Lastfälle ' + NAME[part];
    if (!P) {
      $('festCases').innerHTML = `<tbody><tr><td>${busy ? 'rechnet …' : esc(lastErr || 'noch keine Rechnung')}</td></tr></tbody>`;
      ['festJoin', 'festServo', 'festSt', 'festUse'].forEach(id => { $(id).innerHTML = ''; });
      return;
    }
    const me = a.meta;
    $('festMeta').textContent = `Ca max ${fmt(me.clMax, 2)} · V min ${fmt(me.vS * 3.6, 0)} km/h · n ${fmt(me.loads.n, 0)} ab ${fmt(me.vA * 3.6, 0)} km/h`;
    $('festCases').innerHTML = `<thead><tr><th>Lastfall</th><th>n</th><th>km/h</th><th>Ca</th><th>Q Wurzel N</th><th>M Wurzel Nm</th><th>T Wurzel Nm</th><th>Rand mm</th><th>Verwindung °</th><th>Reserve</th><th style="text-align:left">Bemerkung</th></tr></thead><tbody>` +
      P.cases.map((c, i) => `<tr><td><span class="sw" style="background:${css(COLS[i % COLS.length])}"></span>${esc(c.label)}</td><td>${fmt(c.n, 1)}</td><td>${c.v ? fmt(c.v * 3.6, 0) : '–'}</td><td>${c.v ? fmt(c.cl, 2) : '–'}</td><td>${fmt(c.rootQ, 0)}</td><td>${fmt(c.rootM, 1)}</td><td>${fmt(c.rootT, 2)}</td><td>${fmt(c.tipW, 0)}</td><td>${fmt(c.tipPhi, 2)}</td>${lamp(c.worst.reserve)}<td style="text-align:left;white-space:normal">${esc(c.note || '')}</td></tr>`).join('') + '</tbody>';
    $('festHint').textContent = `Je Hälfte, an der Wurzel (Rumpfmitte). Flugmasse ${fmt(me.mass, 2)} kg, Böe ergibt n ${fmt(me.nGust, 1)}, bei V max erreichbar n ${fmt(me.nReach, 1)}.`;
    const line = (c, i, arr) => ({ label: c.label, data: P.ys.map((y, k) => ({ x: y, y: arr[k] })), showLine: true, borderColor: css(COLS[i % COLS.length]), backgroundColor: css(COLS[i % COLS.length]), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 });
    chart('festM', 'y in mm', 'M in Nm', P.cases.map((c, i) => line(c, i, c.M)));
    chart('festQ', 'y in mm', 'Q in N', P.cases.map((c, i) => line(c, i, c.Q)));
    chart('festT', 'y in mm', 'T in Nm', P.cases.map((c, i) => line(c, i, c.T)));
    $('festLeg').innerHTML = P.cases.map((c, i) => `<span><i style="background:${css(COLS[i % COLS.length])}"></i>${esc(c.label)}</span>`).join('');

    // Ausnutzung, Verformung, Steifigkeit (F2)
    const wst = P.worst;
    $('festWorst').innerHTML = Number.isFinite(wst.reserve) ? `kritisch: ${esc(wst.what)} bei y ${fmt(wst.y, 0)} mm, ${esc(wst.case)}, Reserve <b style="color:${wst.reserve >= 1.5 ? 'var(--good)' : wst.reserve >= 1 ? 'var(--warn)' : 'var(--bad)'}">${fmt(wst.reserve, 2)}</b>` : '';
    $('festUse').innerHTML = `<thead><tr><th>Bauteil</th><th>Reserve</th><th>bei y mm</th><th style="text-align:left">Lastfall</th></tr></thead><tbody>` +
      P.use.map((u, i) => `<tr><td><span class="sw" style="background:${css(COLS[i % COLS.length])}"></span>${esc(u.label)}</td>${Number.isFinite(u.reserve) ? lamp(u.reserve) : '<td>–</td>'}<td>${u.y == null ? '–' : fmt(u.y, 0)}</td><td style="text-align:left">${esc(u.case)}</td></tr>`).join('') + '</tbody>';
    chart('festW', 'y in mm', 'w in mm', P.cases.map((c, i) => line(c, i, c.w)));
    chart('festPhi', 'y in mm', 'φ in °', P.cases.map((c, i) => line(c, i, c.phi)));
    const col = i => css(COLS[i % COLS.length]);
    const plain = (label, i, arr, o = {}) => ({ label, data: P.ys.map((y, k) => ({ x: y, y: arr[k] })).filter(q => Number.isFinite(q.y)), showLine: true, borderColor: col(i), backgroundColor: col(i), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, ...o });
    // Reserve bis 5 zeigen, darüber ist es ohnehin gut
    chart('festR', 'y in mm', 'Reserve', [...P.use.map((u, i) => plain(u.label, i, u.env.map(v => Math.min(v, 5)))), { label: 'Grenze', data: [{ x: 0, y: 1 }, { x: P.ys[P.ys.length - 1], y: 1 }], showLine: true, borderColor: css('--bad'), borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 }], { y: { min: 0, max: 5 } });
    $('festRLeg').innerHTML = P.use.map((u, i) => `<span><i style="background:${col(i)}"></i>${esc(u.label)}</span>`).join('');
    chart('festEI', 'y in mm', 'N·m²', [plain('EI Biegung', 0, P.EI), plain('GJ Torsion', 2, P.GJ)]);
    $('festEILeg').innerHTML = `<span><i style="background:${col(0)}"></i>EI Biegung</span><span><i style="background:${col(2)}"></i>GJ Torsion</span>`;

    renderAero(a, P);

    const j = P.joiner;
    $('festJoin').innerHTML = `<thead><tr><th>${esc(j.mat)}</th><th>W mm³</th><th>M Nm</th><th>σ N/mm²</th><th>zulässig</th><th>Reserve</th><th>τ N/mm²</th><th>Lochleibung N/mm²</th><th>Masse g</th></tr></thead>
<tbody><tr><td>${esc(j.case)}</td><td>${fmt(j.W, 1)}</td><td>${fmt(j.M, 1)}</td><td>${fmt(j.sigma, 0)}</td><td>${fmt(j.allow, 0)}</td>${lamp(j.reserve)}<td>${fmt(j.tau, 1)}</td><td>${j.bearing == null ? '–' : fmt(j.bearing, 1)}</td><td>${fmt(j.mass, 0)}</td></tr></tbody>`;

    const sv = a.servo;
    $('festServo').innerHTML = sv.length ? `<thead><tr><th>Ruder</th><th>von–bis mm</th><th>Tiefe %</th><th>Ausschlag</th><th>Scharniermoment Nm</th><th>Kraft im Gestänge N</th><th>Servomoment Ncm</th><th>kg·cm</th></tr></thead><tbody>` +
      sv.map(s => `<tr><td>${esc(s.name)}</td><td>${fmt(s.y0, 0)}–${fmt(s.y1, 0)}</td><td>${fmt(s.depth, 0)}</td><td>±${fmt(s.defl, 0)}°</td><td>${fmt(Math.abs(s.moment), 3)}</td><td>${fmt(s.force, 1)}</td><td>${fmt(s.torque, 1)}</td><td>${fmt(s.kgcm, 2)}</td></tr>`).join('') + '</tbody>'
      : '<tbody><tr><td>Keine Klappen eingetragen (Klappentiefe in der Stationstabelle).</td></tr></tbody>';
    $('festServoHint').textContent = sv.length ? `Bei ${fmt(me.loads.vMax * 3.6, 0)} km/h, je Hälfte und Ruder, der grössere Wert aus Ausschlag nach oben und unten. Ruderhorn, Servoarm und Trennstellen aus „Anlenkung“: jede Zeile ist ein Ruder mit einem Servo. Ein Servo sollte etwa das Doppelte halten.` : '';

    $('festSt').innerHTML = `<thead><tr><th>y mm</th><th>Tiefe mm</th><th>Holmhöhe mm</th><th>Gurtdicke mm</th><th>Gurtfläche mm²</th><th>Steghöhe mm</th><th>Schale mm</th><th>EI N·m²</th><th>GJ N·m²</th><th>Masse g/m</th></tr></thead><tbody>` +
      P.stations.map(s => `<tr><td>${fmt(s.y, 0)}</td><td>${fmt(s.chord, 0)}</td><td${s.hOut < 2 * s.tCap ? ' class="warn" title="Gurte passen nicht in die Profilhöhe"' : ''}>${fmt(s.hOut, 1)}</td><td>${fmt(s.tCap, 2)}</td><td>${fmt(s.aCap, 1)}</td><td>${fmt(s.hWeb, 1)}</td><td>${fmt(s.tShell, 2)}</td><td>${fmt(s.EI / 1e6, 1)}</td><td>${fmt(s.GJ / 1e6, 1)}</td><td>${fmt(s.massPerM * P.scale, 0)}</td></tr>`).join('') + '</tbody>';
    $('festMass').textContent = `${NAME[part]} beide Hälften: ${fmt(P.massCalc, 0)} g aus dem Aufbau gerechnet${P.struct.mass ? `, gewogen ${fmt(P.struct.mass, 0)} g (Verteilung darauf skaliert)` : ''}, ohne Verbinder, Servos und Harz für Verklebungen.`;
  }

  // Aeroelastik (F3): Grenzen, Verwindung im Flug, Ruderwirksamkeit, Eichung an der Messung
  function renderAero(a, P) {
    const A = a.aero, show = part === 'wing' && !!A;
    $('festAero').hidden = !show; $('festAeroCharts').hidden = !show || !A.ok;
    if (!show) return;
    const kmh = v => fmt(v * 3.6, 0), vM = A.vMax;
    const cal = P.calib || {}, calTxt = [];
    if (cal.bend) calTxt.push(`Biegeprobe: gerechnet ${fmt(cal.bend.calc, 1)} mm, gemessen ${fmt(cal.bend.meas, 1)} mm → EI × ${fmt(cal.kEI, 2)}`);
    if (cal.tors) calTxt.push(`Drehprobe: gerechnet ${fmt(cal.tors.calc, 2)}°, gemessen ${fmt(cal.tors.meas, 2)}° → GJ × ${fmt(cal.kGJ, 2)}`);
    $('festAeroMeta').textContent = Number.isFinite(A.fh) ? `Eigenfrequenz Biegung ${fmt(A.fh, 1)} Hz${Number.isFinite(A.ft) ? ' · Torsion ' + fmt(A.ft, 0) + ' Hz' : ''}` : '';
    const row = (name, v, note) => `<tr><td>${name}</td><td>${v ? kmh(v) : '–'}</td>${v ? lamp(v / vM) : '<td>–</td>'}<td style="text-align:left;white-space:normal">${note}</td></tr>`;
    const ail = A.aileron;
    $('festAeroLim').innerHTML = A.ok ? `<thead><tr><th>Grenze</th><th>km/h</th><th>÷ V max</th><th style="text-align:left">Bedeutung</th></tr></thead><tbody>` +
      row('Divergenz', A.div && A.div.v, A.div ? 'Der Auftrieb dreht den Flügel schneller auf, als er sich wehrt. Holm weiter vorn oder mehr ±45°-Gewebe hilft.' : 'tritt nicht auf (Holm bei oder vor t/4)') +
      row('Ruderumkehr', ail && ail.rev, ail ? (ail.rev ? `Ruder ${fmt(ail.y0, 0)}–${fmt(ail.y1, 0)} mm wirkt ab hier verkehrt.` : 'bis zum Dreifachen von V max keine Umkehr') + (ail.etaMax > 0 ? ` Bei V max bleiben ${fmt(100 * ail.etaMax, 0)} % der Wirkung.` : ' Bei V max wirkt es schon verkehrt.') : 'keine Klappe eingetragen') +
      row('Flattern (Richtwert)', A.flutter && A.flutter.v, A.flutter && A.flutter.v ? `Biegung und Torsion schaukeln sich auf. Schnitt bei y ${fmt(A.flutter.y, 0)} mm, Schwerpunkt ${fmt(A.xcg * 100, 0)} % Tiefe.` : 'klassisches Biege-Torsions-Flattern tritt nicht auf (Schwerpunkt bei oder vor t/4)') + '</tbody>' : '';
    $('festAeroHint').textContent = A.ok ? `Die Grenzen sollten mindestens das 1,2-Fache von V max (${kmh(vM)} km/h) erreichen. Elastische Achse = Holmlage ${fmt(A.xs * 100, 0)} % Tiefe.${calTxt.length ? ' ' + calTxt.join(' · ') + '.' : ' Ohne Messung gelten die gerechneten Steifigkeiten: eine Biege- und eine Drehprobe am gebauten Flügel (links unter „Aeroelastik und Messung“) eicht sie.'}` : '';
    const sw = (A.sweep || []);
    $('festAeroSweep').innerHTML = sw.length ? `<thead><tr><th>km/h</th><th>Ca</th><th>Verwindung Rand °</th><th>ohne Rückkopplung °</th><th>M Wurzel</th><th>Gleitzahl starr</th><th>verformt</th></tr></thead><tbody>` +
      sw.map(q => q.diverged ? `<tr><td>${kmh(q.v)}</td><td>${fmt(q.cl, 2)}</td><td colspan="5" style="text-align:left;color:var(--bad)">über der Divergenz</td></tr>`
        : `<tr><td>${kmh(q.v)}</td><td>${fmt(q.cl, 2)}</td><td${Math.abs(q.phi) > 8 ? ' style="color:var(--bad);font-weight:600"' : ''}>${fmt(q.phi, 2)}</td><td>${fmt(q.phiRigid, 2)}</td><td>${Math.abs(q.phi) > 8 ? '–' : (q.dM >= 0 ? '+' : '') + fmt(100 * q.dM, 0) + ' %'}</td><td>${Number.isFinite(q.E) ? fmt(q.E, 1) : '–'}</td><td>${Number.isFinite(q.E2) ? fmt(q.E2, 1) : '–'}</td></tr>`).join('') + '</tbody>' : '';
    $('festAeroNote').textContent = [sw.length ? 'Geradeausflug mit n = 1. Negative Verwindung dreht die Nase aussen nach unten: der Auftrieb wandert nach innen, das Biegemoment sinkt, die Gleitzahl leidet über den induzierten Widerstand. Über etwa 8° ist die Rechnung nur noch ein Warnzeichen.' : '', ...(A.notes || [])].filter(Boolean).join(' ');
    if (!A.ok) return;
    const col = i => css(COLS[i % COLS.length]);
    const ds = [];
    if (ail) ds.push({ label: 'Ruderwirksamkeit', data: ail.curve.filter(q => Number.isFinite(q.eta) && q.eta > -1).map(q => ({ x: q.v * 3.6, y: 100 * q.eta })), showLine: true, borderColor: col(0), backgroundColor: col(0), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 });
    ds.push({ label: 'V max', data: [{ x: vM * 3.6, y: 0 }, { x: vM * 3.6, y: 100 }], showLine: true, borderColor: css('--bad'), borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 });
    chart('festEta', 'km/h', '%', ds, { y: { min: -100, max: 100 } });
    const tw = sw.filter(q => !q.diverged && Math.abs(q.phi) < 30);
    chart('festTw', 'y in mm', 'θ in °', tw.map((q, i) => ({ label: kmh(q.v) + ' km/h', data: A.ys.map((y, k) => ({ x: y, y: q.theta[k] })), showLine: true, borderColor: col(i), backgroundColor: col(i), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 })));
    $('festTwLeg').innerHTML = tw.map((q, i) => `<span><i style="background:${col(i)}"></i>${kmh(q.v)} km/h</span>`).join('');
  }

  window.MMPAFest = {
    // Nach jeder Modellrechnung und beim Öffnen des Reiters
    update() { if (!viewOn('fest')) return; renderIn(); renderOut(); schedule(); },
    // Ergebnis für das aktuelle Modell, rechnet wenn nötig (auch wenn der Reiter nicht offen ist)
    need(cb) {
      if (last && lastR === lastModel && lastKey === keyOf(curModel())) { cb(last); return; }
      waiters.push(cb); if (waiters.length === 1 || !busy) run();
    },
  };
  if (viewOn('fest')) window.MMPAFest.update();
})();
