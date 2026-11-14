// Rhino-Dateien (.3dm) lesen im Hintergrund mit rhino3dm 8.35 (MIT, Robert McNeel & Associates, siehe LICENSE.txt).
// rhino3dm kann Flächen nicht selbst vernetzen: genommen werden die Render-Netze, die Rhino in der Datei speichert.
// Fehlen sie (gespeichert mit „Nur Geometrie speichern“), wird die Fläche als Gitter abgetastet (ohne Trimmung).
// Nachricht rein: { buffer: Uint8Array }. Raus: { success, unit, meshes: [{ name, positions, indices, how }], skipped, hidden } oder { success: false, error }.
importScripts('rhino3dm.min.js');
let ready = null;
// Einheit in mm je Wert von UnitSystem (None, Å, nm, µm, mm, cm, dm, m, …, Zoll = 15, Fuss = 16)
const UNIT = { 3: 0.001, 4: 1, 5: 10, 6: 100, 7: 1000, 13: 25.4e-6, 14: 0.0254, 15: 25.4, 16: 304.8 };
const GRID = 24;

function fromMesh(m) {
  const b = m.toThreejsBuffers ? m.toThreejsBuffers(false) : null;
  if (b && b.position && b.index) return { positions: Float32Array.from(b.position), indices: Uint32Array.from(b.index) };
  const j = m.toThreejsJSON(false), d = j.data || j;
  return { positions: Float32Array.from(d.attributes.position.array), indices: Uint32Array.from(d.index.array) };
}
// Fläche als Gitter über ihren Parameterbereich (ohne Trimmung)
function sample(srf) {
  const du = srf.domain(0), dv = srf.domain(1), pos = [], idx = [];
  for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) {
    const p = srf.pointAt(du[0] + (du[1] - du[0]) * i / GRID, dv[0] + (dv[1] - dv[0]) * j / GRID);
    pos.push(p[0], p[1], p[2]);
  }
  const k = (i, j) => i * (GRID + 1) + j;
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) idx.push(k(i, j), k(i + 1, j), k(i + 1, j + 1), k(i, j), k(i + 1, j + 1), k(i, j + 1));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
// Teilnetze zu einem Körper
function merge(list) {
  const n = list.reduce((a, q) => a + q.positions.length, 0), m = list.reduce((a, q) => a + q.indices.length, 0);
  const P = new Float32Array(n), I = new Uint32Array(m);
  let o = 0, k = 0;
  list.forEach(q => { P.set(q.positions, o); for (let i = 0; i < q.indices.length; i++) I[k + i] = q.indices[i] + o / 3; o += q.positions.length; k += q.indices.length; });
  return { positions: P, indices: I };
}

function brepParts(rh, brep) {
  const faces = brep.faces(), parts = [];
  let how = 'Render-Netz';
  for (let f = 0; f < faces.count; f++) {
    const face = faces.get(f);
    let mesh = null;
    try { mesh = face.getMesh(rh.MeshType.Any); } catch (e) { mesh = null; }
    if (mesh && mesh.faces().count > 0) parts.push(fromMesh(mesh));
    else { parts.push(sample(face)); how = 'abgetastet'; }
    mesh?.delete?.(); face.delete?.();
  }
  return { parts, how };
}

self.onmessage = async e => {
  try {
    ready = ready || rhino3dm();
    const rh = await ready;
    const doc = rh.File3dm.fromByteArray(e.data.buffer);
    if (!doc) throw new Error('3dm-Datei liess sich nicht lesen');
    const unit = UNIT[doc.settings().modelUnitSystem?.value] ?? 1;
    const layers = doc.layers(), layerOf = [];
    for (let i = 0; i < layers.count; i++) { const l = layers.get(i); layerOf[l.index ?? i] = { name: l.fullPath || l.name || '', visible: l.visible !== false }; }
    const objs = doc.objects(), meshes = [], skipped = {};
    let hidden = 0;
    const T = rh.ObjectType;
    for (let i = 0; i < objs.count; i++) {
      const o = objs.get(i), g = o.geometry(), a = o.attributes();
      const lay = layerOf[a.layerIndex] || { name: '', visible: true };
      if (a.visible === false || !lay.visible) { hidden++; continue; }
      const t = g.objectType, name = a.name || lay.name || 'Körper ' + (meshes.length + 1);
      let r = null, how = 'Netz';
      if (t === T.Mesh) r = fromMesh(g);
      else if (t === T.Brep) { const b = brepParts(rh, g); r = merge(b.parts); how = b.how; }
      else if (t === T.Extrusion) {
        const m = g.getMesh(rh.MeshType.Any);
        if (m && m.faces().count) { r = fromMesh(m); how = 'Render-Netz'; }
        else { const b = brepParts(rh, g.toBrep(true)); r = merge(b.parts); how = b.how; }
      } else if (t === T.SubD) { const b = brepParts(rh, g.toBrep()); r = merge(b.parts); how = b.how; }
      else if (t === T.Surface) { r = sample(g); how = 'abgetastet'; }
      else { const k = Object.keys(T).find(k => T[k] === t) || 'anderes'; skipped[k] = (skipped[k] || 0) + 1; }
      if (r && r.indices.length) meshes.push({ name, layer: lay.name, how, ...r });
    }
    self.postMessage({ success: true, unit, meshes, skipped, hidden }, meshes.flatMap(m => [m.positions.buffer, m.indices.buffer]));
  } catch (err) {
    self.postMessage({ success: false, error: String(err && err.message || err) });
  }
};
