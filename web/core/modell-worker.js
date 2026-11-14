// Modellrechnung im Hintergrund, damit Eingaben flüssig bleiben. Der Zwischenspeicher von modell.js
// (Profilpolaren je Station) bleibt im Worker warm, solange die Seite offen ist.
// Nachricht rein: { seq, model, profiles, nCrit }. Raus: { seq, result } oder { seq, error }.
importScripts('profil.js', 'nf-gewichte.js', 'neuralfoil.js', 'polare.js', 'projekt.js', 'vlm.js', 'rumpf.js', 'modell.js');
self.onmessage = e => {
  const { seq, model, profiles, nCrit } = e.data;
  const t0 = performance.now();
  try {
    const result = self.MMPA.modell.analyze(model, profiles, { nCrit });
    self.postMessage({ seq, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ seq, error: err.message });
  }
};
