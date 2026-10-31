// Gemessene Polaren aus dem MM Flight Analyzer (polaren.lua, MacCready-Widget):
// Sinken (m/s) = a·v² + b·v + c oder physikalisch A·v³ + B/v, v in m/s, gültig von vMin bis vMax.
// Der Flight Analyzer schreibt das Sinken je nach Version positiv oder negativ (Variometer-Vorzeichen):
// ist die Kurve nach unten gekrümmt und liegt in der Mitte des Bereichs unter null, wird sie als „Sinken negativ“ gelesen und umgedreht.
// Im Projekt liegen sie unter project.measured, jede mit dem Modell, dem sie zugewiesen ist (modelId).
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const KEYS = ['a', 'b', 'c', 'vMin', 'vMax'], CUBE = ['A', 'B', 'vMin', 'vMax'];

  // Lua-Tabelle der Form ["SB-10"] = { a = 0.0072, b = -0.16, c = 1.5, vMin = 6.7, vMax = 18.9 },
  // Reihenfolge der Felder egal, Kommentare (--) werden übersprungen. Auch Name = { … } ohne Klammern.
  function parseLua(text) {
    const src = String(text).replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
    const out = [];
    const re = /(?:\[\s*(["'])((?:\\.|(?!\1).)*)\1\s*\]|([A-Za-z_][\w]*))\s*=\s*\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const name = (m[2] ?? m[3]).replace(/\\(.)/g, '$1').trim();
      const body = m[4], val = k => {
        const f = new RegExp(`(?:^|[,{\\s])${k}\\s*=\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)`).exec(body);
        return f ? +f[1] : NaN;
      };
      const q = { name }, c3 = { name, form: 'cube' };
      for (const k of KEYS) q[k] = val(k);
      for (const k of CUBE) c3[k] = val(k);
      if (KEYS.every(k => Number.isFinite(q[k]))) out.push(q);
      else if (CUBE.every(k => Number.isFinite(c3[k]))) out.push(c3);
    }
    if (!out.length) throw new Error('Keine Polare gefunden (erwartet ["Name"] = { a = …, b = …, c = …, vMin = …, vMax = … })');
    return out;
  }

  const raw = (p, v) => p.form === 'cube' ? p.A * v * v * v + p.B / v : p.a * v * v + p.b * v + p.c;
  // −1, wenn die Datei das Sinken negativ schreibt (Kurve nach unten gekrümmt und in der Bereichsmitte unter null)
  const sign = p => (p.form === 'cube' ? p.A : p.a) < 0 && raw(p, (p.vMin + p.vMax) / 2) < 0 ? -1 : 1;
  const sink = (p, v) => sign(p) * raw(p, v);
  // Krümmung der Sinkkurve, wie gerechnet wird: muss nach oben offen sein
  const opensUp = p => p.form === 'cube' ? sign(p) * p.A > 0 && sign(p) * p.B > 0 : sign(p) * p.a > 0;

  // Kurve im gültigen Bereich; E nur dort, wo das Modell sinkt
  function curve(p, n = 48) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const v = p.vMin + (p.vMax - p.vMin) * i / n, s = sink(p, v);
      pts.push({ v, sink: s, E: s > 0 ? v / s : NaN });
    }
    return pts;
  }

  // Beste Gleitzahl und geringstes Sinken im gültigen Bereich (fein abgetastet, auch bei schiefen Parabeln)
  function summary(p) {
    const pts = curve(p, 400);
    const pos = pts.filter(t => t.sink > 0);
    const best = pos.length ? pos.reduce((b, t) => t.E > b.E ? t : b) : null;
    const minSink = pos.length ? pos.reduce((b, t) => t.sink < b.sink ? t : b) : null;
    return { best, minSink, edgeBest: !!best && (best === pos[0] || best === pos[pos.length - 1]), edgeMin: !!minSink && (minSink === pos[0] || minSink === pos[pos.length - 1]) };
  }

  // Plausibilität: was an der Formel physikalisch nicht stimmen kann
  function check(p) {
    const w = [];
    if (!(p.vMax > p.vMin) || p.vMin <= 0) w.push({ level: 'err', text: 'Geschwindigkeitsbereich ungültig (vMin muss kleiner als vMax und positiv sein).' });
    if (!opensUp(p)) w.push({ level: 'err', text: 'Kurve nach unten gekrümmt: das Sinken nähme bei hoher Fahrt wieder ab. Eine echte Polare ist nach oben offen, die Messung ist so nicht brauchbar.' });
    const pts = curve(p, 100), neg = pts.filter(t => t.sink <= 0);
    if (neg.length === pts.length) w.push({ level: 'err', text: 'Sinken im ganzen Bereich null oder negativ: das Modell würde bei jeder Fahrt steigen. Vermutlich in Steigluft (Thermik, Hang) gemessen oder ein Vorzeichenfehler.' });
    else if (neg.length) w.push({ level: 'err', text: `Sinken zwischen ${Math.round(neg[0].v * 3.6)} und ${Math.round(neg[neg.length - 1].v * 3.6)} km/h null oder negativ (Steigen). Vermutlich in Steigluft gemessen.` });
    if (!w.length) {
      const s = summary(p);
      if (s.edgeMin) w.push({ level: 'info', text: 'Geringstes Sinken liegt am Rand des Messbereichs: der Bereich deckt das Minimum nicht ab.' });
      if (sign(p) < 0) w.push({ level: 'info', text: 'Sinken in der Datei negativ geschrieben (wie am Vario), für die App umgedreht.' });
      if (s.best && s.best.E > 80) w.push({ level: 'info', text: `Gleitzahl ${Math.round(s.best.E)} ist für ein Modell unrealistisch hoch.` });
    }
    return w;
  }

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Modell, dessen Name zum Eintrag passt (SB-10 → „SB-10 M1:5“), nur wenn es genau eines ist
  function guessModel(name, models) {
    const n = norm(name);
    if (!n) return null;
    const hit = models.filter(m => norm(m.name).includes(n) || (norm(m.name) && n.includes(norm(m.name))));
    return hit.length === 1 ? hit[0].id : null;
  }

  // Einträge ins Projekt übernehmen. Gleicher Name wird ersetzt, die Zuweisung bleibt.
  function importInto(project, entries, file = '') {
    const list = project.measured = project.measured || [];
    const res = { added: 0, updated: 0, assigned: 0 };
    for (const e of entries) {
      const old = list.find(x => x.name === e.name);
      const vals = { ...(e.form === 'cube' ? { form: 'cube', A: e.A, B: e.B } : { a: e.a, b: e.b, c: e.c }), vMin: e.vMin, vMax: e.vMax, file, imported: new Date().toISOString() };
      if (old) { for (const k of ['form', 'a', 'b', 'c', 'A', 'B']) delete old[k]; Object.assign(old, vals); res.updated++; }
      else { list.push({ id: uid(), name: e.name, modelId: null, ...vals }); res.added++; }
      const it = old || list[list.length - 1];
      if (!it.modelId || !(project.models || []).some(m => m.id === it.modelId)) {
        it.modelId = guessModel(e.name, project.models || []);
        if (it.modelId) res.assigned++;
      }
    }
    return res;
  }

  const forModel = (project, modelId) => (project.measured || []).filter(x => x.modelId === modelId);

  const formula = p => p.form === 'cube' ? `A·v³ + B/v mit A = ${p.A}, B = ${p.B}` : `a·v² + b·v + c mit a = ${p.a}, b = ${p.b}, c = ${p.c}`;
  const api = { parseLua, sink, sign, formula, curve, summary, check, guessModel, importInto, forModel };
  if (isNode) module.exports = api;
  else (root.MMPA = root.MMPA || {}).messpolare = api;
})(typeof self !== 'undefined' ? self : this);
