// STEP lesen im Hintergrund mit OpenCascade (occt-import-js 0.0.23, LGPL-2.1, siehe license.*.txt).
// Die 7,6 MB WebAssembly werden erst beim ersten STEP-Import geladen.
// Nachricht rein: { buffer: Uint8Array, params }. Raus: das Ergebnis von ReadStepFile oder { error }.
importScripts('occt-import-js.js');
let ready = null;
self.onmessage = async e => {
  try {
    ready = ready || occtimportjs({ locateFile: p => p });
    const occt = await ready;
    const r = occt.ReadStepFile(e.data.buffer, e.data.params || null);
    self.postMessage(r);
  } catch (err) {
    self.postMessage({ success: false, error: String(err && err.message || err) });
  }
};
