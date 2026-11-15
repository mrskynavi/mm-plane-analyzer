const test = require('node:test');
const assert = require('node:assert');
const PR = require('../web/core/projekt.js');
const BIB = require('../web/core/bibliothek.js');
const M = require('../web/core/modell.js');
const DB = require('../web/core/druckbild.js');
const N = require('../web/core/nachlauf.js');

function setup() {
  const project = PR.createProject();
  const e = PR.addProfile(project, { datText: BIB.e374 }), h = PR.addProfile(project, { datText: BIB.ht14 });
  const m = PR.createModel('Test', e.id, h.id);
  const r = M.analyze(m, project.profiles, { nCrit: 9 });
  const st = DB.states(m, r)[0];
  return { project, m, r, st };
}
const S = setup();
const W = N.build(S.m, S.project.profiles, S.r, S.st), W0 = N.build(S.m, S.project.profiles, S.r, S.st, { iter: 0 });

test('Nachlauf: weit vor dem Modell ungestörte Anströmung', () => {
  const v = N.velocity(W, [-50 * W.semi, 0.3 * W.semi, 0]);
  assert.ok(Math.abs(v[0] - W.vinf[0]) < 1e-3 && Math.abs(v[2] - W.vinf[2]) < 1e-3 && Math.abs(v[1]) < 1e-3);
});

test('Nachlauf: Abwind am Leitwerk in der Grössenordnung 2·Ca/(π·Λ)', () => {
  const eps = N.tailDownwash(W), ref = 2 * S.st.cl / (Math.PI * S.r.wing.aspect) * 180 / Math.PI;
  assert.ok(eps > 0.5 * ref && eps < 2.5 * ref, eps + ' vs ' + ref);
  // freier und gerader Nachlauf liegen beim Segler nahe beieinander
  assert.ok(Math.abs(eps - N.tailDownwash(W0)) < 0.3 * eps);
});

test('Nachlauf: Randwirbel wandert nach innen, Schicht sinkt gegenüber der Anströmung ab', () => {
  const wing = W.fils.filter(f => f.surf === 0), tip = wing[wing.length - 1], K = W.K;
  assert.ok(tip.p[K * 3 + 1] < tip.te[1] - 0.005 * W.semi, 'Randfaden innen');
  const inner = wing[Math.floor(wing.length / 4)], straight = W0.fils.filter(f => f.surf === 0)[Math.floor(wing.length / 4)];
  assert.ok(inner.p[K * 3 + 2] < straight.p[K * 3 + 2] - 1, 'Schicht sinkt');
  // Fäden bleiben auf ihrer Seite der Symmetrieebene und laufen nach hinten
  W.fils.forEach(f => { for (let k = 0; k < K; k++) { assert.ok(f.p[k * 3 + 1] >= 0); assert.ok(f.p[k * 3 + 3] > f.p[k * 3]); assert.ok(Number.isFinite(f.p[k * 3 + 2])); } });
});

test('Rauchfäden laufen um das Profil, nicht hindurch', () => {
  const up = N.smoke(W, N.rake(W, { mode: 'quer', h: 3, n: 5 })), dn = N.smoke(W, N.rake(W, { mode: 'quer', h: -12, n: 5 }));
  const check = lines => lines.forEach(l => {
    assert.ok(l.length / 3 > 20);
    for (let i = 0; i < l.length; i += 3) {
      const o = N.over(W.sheets[0], l[i], l[i + 1]);
      if (o && o.ht > 0.5) assert.ok(Math.abs(l[i + 2] - o.zs) >= 0.5 * o.ht, 'Faden im Profil bei x ' + l[i]);
    }
    assert.ok(l[l.length - 3] > W.xEnd, 'Faden läuft bis hinter das Leitwerk');
  });
  check(up.slice(0, 4)); check(dn.slice(0, 4));
  // weit über und unter der Fläche bleibt der Faden auf seiner Seite
  const far = N.smoke(W, N.rake(W, { mode: 'quer', h: 40, n: 3 }))[1];
  for (let i = 0; i < far.length; i += 3) { const o = N.over(W.sheets[0], far[i], far[i + 1]); if (o) assert.ok(far[i + 2] > o.zs); }
});

test('Abwind-Ebene: Abwind hinter dem Flügel, Aufwind ausserhalb des Randwirbels', () => {
  const { out } = N.compute(S.m, S.project.profiles, S.r, S.st, { want: { plane: true } }, W);
  const P = out.plane, ny = P.ys.length, j = Math.floor(P.zs.length / 2);
  assert.ok(P.eps[j * ny + 3] > 0, 'innen Abwind');
  assert.ok(P.eps[j * ny + ny - 1] < 0, 'aussen Aufwind');
  assert.ok(Number.isFinite(out.info.epsTail) && out.info.core.y > 0.6 * W.semi && out.info.core.y < 1.05 * W.semi);
});
