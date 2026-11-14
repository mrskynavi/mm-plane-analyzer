// Modellrechnung im Hintergrund, damit Eingaben flüssig bleiben. Der Zwischenspeicher von modell.js
// (Profilpolaren je Station) bleibt im Worker warm, solange die Seite offen ist.
// Nachricht rein: { seq, model, profiles, nCrit }. Raus: { seq, result } oder { seq, error }.
// Druckbild (W2): { kind: 'druck', seq, model, profiles, r, states, nCrit } → je Zustand { kind: 'frame', seq, i, frame },
// zum Schluss { kind: 'done', seq }. Eine neue Druck-Anfrage bricht die laufende nach dem aktuellen Zustand ab.
// Die Seite hängt ?v=<Stand> an: so holt der Browser nach einem Update auch die Rechenkerne neu statt aus dem Zwischenspeicher.
const VQ = self.location.search || '';
importScripts(...['profil.js', 'nf-gewichte.js', 'neuralfoil.js', 'polare.js', 'projekt.js', 'vlm.js', 'rumpf.js', 'modell.js', 'kanal.js', 'druckbild.js', 'struktur.js'].map(f => f + VQ));
let druckSeq = 0;
self.onmessage = e => {
  const d = e.data;
  if (d.kind === 'druck') { druck(d); return; }
  // Festigkeit F1: { kind: 'struktur', seq, model, profiles, r, nCrit, materials } → { kind: 'struktur', seq, result | error }
  if (d.kind === 'struktur') {
    try { self.postMessage({ kind: 'struktur', seq: d.seq, result: self.MMPA.struktur.analyze(d.model, d.profiles, d.r, { nCrit: d.nCrit, project: { materials: d.materials } }) }); }
    catch (err) { self.postMessage({ kind: 'struktur', seq: d.seq, error: err.message }); }
    return;
  }
  const { seq, model, profiles, nCrit } = d;
  const t0 = performance.now();
  try {
    const result = self.MMPA.modell.analyze(model, profiles, { nCrit });
    self.postMessage({ seq, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ seq, error: err.message });
  }
};
// Zustände einzeln rechnen und zwischendurch Nachrichten annehmen (setTimeout), damit eine neue Anfrage die alte ablöst
function druck({ seq, model, profiles, r, states, nCrit }) {
  druckSeq = seq;
  let i = 0;
  const step = () => {
    if (druckSeq !== seq) return;
    if (i >= states.length) { self.postMessage({ kind: 'done', seq }); return; }
    try {
      const frame = self.MMPA.druckbild.compute(model, profiles, r, states[i], { nCrit });
      self.postMessage({ kind: 'frame', seq, i, frame });
    } catch (err) {
      self.postMessage({ kind: 'frame', seq, i, error: err.message });
    }
    i++;
    setTimeout(step, 0);
  };
  step();
}
