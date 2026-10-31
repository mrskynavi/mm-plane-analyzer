// Fragemodus: Bausteine ohne DOM. Frage, Kontext (worauf geklickt wurde) und Modelldaten werden
// zu einer Anfrage an die Claude API (Messages) oder zu einem Text für die Zwischenablage.
// Der API-Schlüssel liegt nur im localStorage des Browsers und wird nur an api.anthropic.com geschickt.
(function (root) {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  // Preise in US-Dollar pro Million Token (Anthropic-Preisliste, Stand Oktober 2026)
  const MODELS = [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'schnell und sehr günstig', in: 0.10, out: 0.50, fallbacks: false },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Standard', in: 2.00, out: 10.00, fallbacks: true },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'gründlicher, teurer', in: 4.00, out: 20.00, fallbacks: true },
  ];
  const DEFAULT_MODEL = 'claude-sonnet-5-5';
  const modelOf = id => MODELS.find(m => m.id === id) || MODELS.find(m => m.id === DEFAULT_MODEL);
  // Antwort mit Nachdenken: für die Schätzung typische Länge der Ausgabe
  const OUT_GUESS = 1500;
  const MAX_TOKENS = 16000;

  const SYSTEM = [
    'Du bist ein erfahrener Berater für Modellflug-Aerodynamik und hilfst Christoph Mächler (Mächler Modelle) beim Auslegen seiner Modellflugzeuge mit der App „MM Plane Analyzer“. Sprich ihn mit Du an und antworte auf Deutsch (Schweizer Schreibweise, also ss statt ß).',
    'Die App rechnet Profilpolaren mit NeuralFoil (neuronales Netz, trainiert auf XFOIL), den Flügel und das Leitwerk mit dem Wirbelgitterverfahren (VLM) wie XFLR5, den Rumpfwiderstand nach Hoerner und das Rumpfmoment nach Multhopp. Typische Grössen: Ca (Auftriebsbeiwert), Cw (Widerstandsbeiwert), Cm (Momentenbeiwert), Re (Reynoldszahl), EWD (Einstellwinkeldifferenz Flügel minus Höhenleitwerk), Stabilitätsmass σ (Abstand Schwerpunkt zum Neutralpunkt in % der mittleren Flügeltiefe), Wölbklappen, Schränkung, Ncrit.',
    'Mit jeder Frage bekommst Du, worauf Christoph in der App geklickt hat (Feld, Tabellenzeile oder Grafik mit Werten und Einheiten), und die Daten des aktuellen Modells oder Profil-Labors als JSON. Stütze Dich auf diese Zahlen und nenne sie, wenn Du sie verwendest.',
    'Alle Werte der App sind Rechenwerte und damit Schätzungen. Sag das, wo es für die Entscheidung zählt, und nenne, wo die Rechnung typisch danebenliegt (zum Beispiel kleine Re, Ablöseblasen, Bauungenauigkeit, Rumpf-Flügel-Übergang, Spalte). Wenn eine Frage aus den Daten nicht sicher zu beantworten ist, sag das offen und schlag vor, was er prüfen oder ausprobieren kann.',
    'Antworte knapp und praktisch: zuerst die Antwort, dann die Begründung in wenigen Sätzen. Formeln nur, wenn sie helfen. Einfache Markdown-Formatierung (fett, Listen) ist erlaubt, keine Tabellen über fünf Spalten.',
  ].join('\n\n');

  // Grobe Schätzung: deutsche Texte und JSON mit Zahlen ergeben etwa 3 Zeichen pro Token
  const estimateTokens = text => Math.ceil(String(text || '').length / 3);
  const costUSD = (modelId, inTok, outTok) => { const m = modelOf(modelId); return (inTok * m.in + outTok * m.out) / 1e6; };
  function estimate(modelId, messages) {
    const chars = SYSTEM.length + messages.reduce((s, m) => s + String(m.content).length, 0);
    const inTok = Math.ceil(chars / 3);
    return { inTok, outTok: OUT_GUESS, usd: costUSD(modelId, inTok, OUT_GUESS) };
  }
  function fmtUSD(v) {
    if (!Number.isFinite(v)) return '–';
    const d = v < 0.01 ? 4 : v < 1 ? 3 : 2;
    return v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' $';
  }

  // Daten verschlanken: lange Zahlenreihen (Koordinaten, Polaren) zusammenfassen, lange Texte kürzen
  function slim(value, opt = {}) {
    const maxArr = opt.maxArr ?? 24, maxStr = opt.maxStr ?? 300;
    const drop = new Set(opt.drop || ['coords', 'datText', 'dat', 'raw', 'upper', 'lower']);
    const walk = (v, depth) => {
      if (v == null || typeof v === 'boolean') return v;
      if (typeof v === 'number') return Number.isFinite(v) ? +v.toPrecision(5) : null;
      if (typeof v === 'string') return v.length > maxStr ? v.slice(0, maxStr) + ' …' : v;
      if (depth > 8) return '…';
      if (Array.isArray(v)) {
        if (v.length > maxArr && v.every(x => typeof x === 'number' || Array.isArray(x))) return `[${v.length} Werte ausgelassen]`;
        const a = v.slice(0, 60).map(x => walk(x, depth + 1));
        if (v.length > 60) a.push(`[${v.length - 60} weitere ausgelassen]`);
        return a;
      }
      if (typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
          if (drop.has(k) || typeof x === 'function') continue;
          const w = walk(x, depth + 1);
          if (w !== undefined) o[k] = w;
        }
        return o;
      }
      return undefined;
    };
    return walk(value, 0);
  }

  // Angeklicktes als lesbarer Text; ctx = { kind, title, label, value, unit, detail, section, view }
  function contextText(ctx) {
    const L = [];
    const kinds = { field: 'Eingabefeld', row: 'Tabellenzeile', chart: 'Grafik', kpi: 'Kennzahl', item: 'Eintrag', area: 'Bereich' };
    if (ctx.view) L.push(`Ansicht: ${ctx.view}`);
    if (ctx.section) L.push(`Abschnitt: ${ctx.section}`);
    L.push(`Angeklickt: ${kinds[ctx.kind] || 'Element'}${ctx.title ? ' „' + ctx.title + '“' : ''}`);
    if (ctx.label || ctx.value) L.push(`${ctx.label || 'Wert'}: ${ctx.value ?? ''}${ctx.unit ? ' ' + ctx.unit : ''}`.trim());
    if (ctx.detail) L.push(ctx.detail);
    return L.join('\n');
  }
  // Kurzform für die Kopfzeile der Sprechblase
  function contextShort(ctx) {
    const kinds = { field: 'Feld', row: 'Zeile', chart: 'Grafik', kpi: 'Kennzahl', item: 'Eintrag', area: 'Bereich' };
    let s = kinds[ctx.kind] || 'Element';
    const name = ctx.title || ctx.label;
    if (name) s += ' · ' + name;
    if (ctx.kind !== 'chart' && ctx.value != null && ctx.value !== '') s += ' = ' + ctx.value + (ctx.unit ? ' ' + ctx.unit : '');
    return s.length > 90 ? s.slice(0, 89) + '…' : s;
  }

  function firstMessage(question, ctx, data) {
    return [
      '<kontext>', contextText(ctx), '</kontext>', '',
      '<daten format="json">', JSON.stringify(data), '</daten>', '',
      'Frage: ' + question,
    ].join('\n');
  }
  // Verlauf [{role, content}] mit der ersten Nachricht inklusive Kontext und Daten
  function buildMessages(history, question, ctx, data) {
    if (!history.length) return [{ role: 'user', content: firstMessage(question, ctx, data) }];
    return [...history, { role: 'user', content: question }];
  }

  function requestBody(modelId, messages, withFallbacks = true) {
    const m = modelOf(modelId);
    const body = {
      model: m.id, max_tokens: MAX_TOKENS, stream: true,
      system: SYSTEM, messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    };
    if (withFallbacks && m.fallbacks) body.fallbacks = 'default';
    return body;
  }
  function requestHeaders(key, modelId, withFallbacks = true) {
    const h = {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (withFallbacks && modelOf(modelId).fallbacks) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  // Server-Sent Events der Messages API: Text, Token und Abbruchgrund sammeln
  function sseState() { return { buf: '', text: '', inTok: 0, outTok: 0, cacheIn: 0, stop: null, model: null, error: null }; }
  function sseFeed(st, chunk) {
    st.buf += chunk;
    let i, added = '';
    while ((i = st.buf.indexOf('\n\n')) >= 0) {
      const block = st.buf.slice(0, i); st.buf = st.buf.slice(i + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'message_start' && ev.message) {
        const u = ev.message.usage || {};
        st.inTok = (u.input_tokens || 0); st.cacheIn = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        st.outTok = u.output_tokens || 0; st.model = ev.message.model || st.model;
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        st.text += ev.delta.text; added += ev.delta.text;
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) st.stop = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) st.outTok = ev.usage.output_tokens;
        if (ev.usage?.input_tokens != null) st.inTok = ev.usage.input_tokens;
      } else if (ev.type === 'error') {
        st.error = ev.error?.message || 'Fehler beim Streamen';
      }
    }
    return added;
  }

  function errorText(status, msg) {
    const m = String(msg || '');
    if (status === 401) return 'Der API-Schlüssel wird nicht akzeptiert. Prüfe ihn unter ⚙ Einstellungen.';
    if (status === 403) return 'Der Schlüssel darf dieses Modell nicht nutzen. ' + m;
    if (/credit|balance|billing/i.test(m)) return 'Das Guthaben im API-Konto reicht nicht. Lade es unter console.anthropic.com → Billing auf. ' + m;
    if (status === 429) return 'Zu viele Anfragen in kurzer Zeit. Warte eine Minute und frag nochmals.';
    if (status === 529 || status >= 500) return 'Claude ist gerade überlastet. Versuch es gleich nochmals.';
    return `Fehler ${status || ''}: ${m}`.trim();
  }

  // Sehr kleines Markdown: Absätze, Listen, fett, kursiv, Code, Überschriften
  function markdown(src) {
    const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const inline = s => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    const out = []; let list = null, para = [];
    const flushP = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushL = () => { if (list) { out.push(`<${list.t}>` + list.items.map(x => '<li>' + inline(x) + '</li>').join('') + `</${list.t}>`); list = null; } };
    for (const line of String(src || '').split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), h = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (ul || ol) {
        flushP(); const t = ul ? 'ul' : 'ol';
        if (list && list.t !== t) flushL();
        if (!list) list = { t, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (h) { flushP(); flushL(); out.push('<p class="h">' + inline(h[1]) + '</p>'); }
      else if (!line.trim()) { flushP(); flushL(); }
      else { flushL(); para.push(line); }
    }
    flushP(); flushL();
    return out.join('');
  }

  // Ohne Schlüssel: alles als Text zum Einfügen in claude.ai
  function copyText(question, ctx, data, history = []) {
    const L = [
      'Ich arbeite mit meiner App „MM Plane Analyzer“ (Auslegung von Modellflugzeugen) und habe eine Frage zu einer Stelle in der App.',
      'Bitte antworte auf Deutsch, sprich mich mit Du an, und denk daran, dass alle Werte der App Rechenwerte und damit Schätzungen sind.', '',
      contextText(ctx), '',
    ];
    for (const m of history) L.push((m.role === 'user' ? 'Frühere Frage: ' : 'Frühere Antwort: ') + (m.role === 'user' && m === history[0] ? m.content.split('Frage: ').pop() : m.content), '');
    L.push('Frage: ' + (question || '(hier Frage eintragen)'), '', 'Daten aus der App (JSON):', '```json', JSON.stringify(data, null, 1), '```');
    return L.join('\n');
  }

  const api = {
    API_URL, MODELS, DEFAULT_MODEL, MAX_TOKENS, OUT_GUESS, SYSTEM, modelOf,
    estimateTokens, costUSD, estimate, fmtUSD, slim, contextText, contextShort,
    buildMessages, requestBody, requestHeaders, sseState, sseFeed, errorText, markdown, copyText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).frage = api;
})(typeof self !== 'undefined' ? self : this);
