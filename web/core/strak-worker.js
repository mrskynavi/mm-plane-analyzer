// Strak-Optimierer im Hintergrund: rechnet Generation um Generation und meldet den Fortschritt.
// Nachricht rein: { model, profiles, settings }. Raus: { type: 'progress' | 'done' | 'error', … }.
importScripts('profil.js', 'nf-gewichte.js', 'neuralfoil.js', 'polare.js', 'projekt.js', 'vlm.js', 'rumpf.js', 'modell.js', 'strak.js');
self.onmessage = e => {
  const { model, profiles, settings } = e.data;
  try {
    const opt = self.MMPA.strak.optimizer(model, profiles, settings);
    self.postMessage({ type: 'progress', progress: opt.progress(), dims: opt.dims });
    while (!opt.done) self.postMessage({ type: 'progress', progress: opt.step(), dims: opt.dims });
    self.postMessage({ type: 'done', result: opt.result() });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
