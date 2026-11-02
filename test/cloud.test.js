const test = require('node:test');
const assert = require('node:assert');
const CL = require('../web/core/cloud.js');

// Kleiner Ersatz für die GitHub-API: Dateien im Speicher, sha = Git-Blob-sha
function fakeGitHub() {
  const files = new Map();
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  async function fetchFn(url, o) {
    calls.push({ url, method: o.method, body: o.body && JSON.parse(o.body) });
    assert.strictEqual(o.headers.Authorization, 'Bearer tok');
    const u = url.replace(CL.API, '');
    if (u === '/repos/me/daten') return res(200, { private: true, permissions: { push: true }, default_branch: 'main' });
    let m = u.match(/^\/repos\/me\/daten\/contents\/(.+)$/);
    if (m) {
      const path = m[1].split('/').map(decodeURIComponent).join('/');
      if (o.method === 'GET') {
        if (path === 'projekte') return files.size ? res(200, [...files].map(([p, f]) => ({ type: 'file', name: p.split('/').pop(), path: p, sha: f.sha, size: f.text.length }))) : res(404, { message: 'Not Found' });
        const f = files.get(path);
        if (!f) return res(404, { message: 'Not Found' });
        return res(200, { path, sha: f.sha, content: f.big ? '' : CL.toB64(f.text) });
      }
      const b = JSON.parse(o.body), cur = files.get(path);
      if (cur && !b.sha) return res(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (cur && b.sha !== cur.sha) return res(409, { message: 'is at abc but expected def' });
      const text = CL.fromB64(b.content), sha = await CL.blobSha(text);
      files.set(path, { text, sha });
      return res(cur ? 200 : 201, { content: { path, sha } });
    }
    m = u.match(/^\/repos\/me\/daten\/git\/blobs\/(\w+)$/);
    if (m) { const f = [...files.values()].find(x => x.sha === m[1]); return res(200, { content: CL.toB64(f.text) }); }
    return res(404, { message: 'Not Found' });
  }
  return { files, calls, fetchFn };
}

test('Repo-Angabe aus Name oder URL', () => {
  assert.strictEqual(CL.parseRepo('mrskynavi/mm-plane-daten'), 'mrskynavi/mm-plane-daten');
  assert.strictEqual(CL.parseRepo('https://github.com/mrskynavi/mm-plane-daten.git'), 'mrskynavi/mm-plane-daten');
  assert.strictEqual(CL.parseRepo(' https://github.com/a/b/ '), 'a/b');
  assert.strictEqual(CL.parseRepo('nur-ein-name'), null);
});

test('Dateipfad aus dem Projektnamen', () => {
  assert.strictEqual(CL.pathOf('SB-10 Strak'), 'projekte/SB-10 Strak.mmpa.json');
  assert.strictEqual(CL.pathOf('a/b#c'), 'projekte/a_b_c.mmpa.json');
  assert.strictEqual(CL.nameOf('projekte/Flügel v4.mmpa.json'), 'Flügel v4');
});

test('Base64 mit Umlauten hin und zurück', () => {
  const t = 'Flügel „Hörner“ – Wölbung ' + 'x'.repeat(70000);
  assert.strictEqual(CL.fromB64(CL.toB64(t)), t);
});

test('Blob-sha wie git hash-object', async () => {
  assert.strictEqual(await CL.blobSha('Hällo\n'), 'bcfc23b37150ecb2df3169555f542fa556b1cd10');
});

test('Speichern, Laden, Liste', async () => {
  const gh = fakeGitHub();
  const c = CL.client({ repo: 'me/daten', token: 'tok' }, gh.fetchFn);
  assert.deepStrictEqual(await c.list(), []);
  assert.strictEqual(await c.get('projekte/X.mmpa.json'), null);
  const sha = await c.put('projekte/Flügel.mmpa.json', '{"name":"Flügel"}', null);
  assert.strictEqual(sha, await CL.blobSha('{"name":"Flügel"}'));
  assert.ok(gh.calls.at(-1).url.endsWith('/contents/projekte/Fl%C3%BCgel.mmpa.json'));
  const r = await c.get('projekte/Flügel.mmpa.json');
  assert.deepStrictEqual(r, { path: 'projekte/Flügel.mmpa.json', sha, text: '{"name":"Flügel"}' });
  const l = await c.list();
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].name, 'Flügel');
  assert.deepStrictEqual(await c.check(), { private: true, push: true, branch: 'main' });
});

test('Grosse Datei kommt über den Blob', async () => {
  const gh = fakeGitHub();
  const c = CL.client({ repo: 'me/daten', token: 'tok' }, gh.fetchFn);
  await c.put('projekte/G.mmpa.json', 'gross', null);
  gh.files.get('projekte/G.mmpa.json').big = true;
  assert.strictEqual((await c.get('projekte/G.mmpa.json')).text, 'gross');
});

test('Anderes Gerät war schneller: Konflikt statt Überschreiben', async () => {
  const gh = fakeGitHub();
  const a = CL.client({ repo: 'me/daten', token: 'tok' }, gh.fetchFn);
  const s1 = await a.put('projekte/P.mmpa.json', 'v1', null);
  await a.put('projekte/P.mmpa.json', 'v2 vom iPad', s1);
  await assert.rejects(a.put('projekte/P.mmpa.json', 'v2 vom PC', s1), e => e.kind === 'conflict');
  await assert.rejects(a.put('projekte/P.mmpa.json', 'neu ohne sha', null), e => e.kind === 'conflict');
  assert.strictEqual(gh.files.get('projekte/P.mmpa.json').text, 'v2 vom iPad');
});

test('Fehlermeldungen', async () => {
  const mk = (status, message) => CL.client({ repo: 'me/x', token: 't' }, async () => ({ ok: false, status, json: async () => ({ message }) }));
  await assert.rejects(mk(401, 'Bad credentials').list(), e => e.kind === 'auth');
  await assert.rejects(mk(403, 'Resource not accessible').put('p', 'x'), e => e.kind === 'forbidden');
  await assert.rejects(mk(404, 'Not Found').check(), e => e.kind === 'missing' && /me\/x/.test(e.message));
  const off = CL.client({ repo: 'me/x', token: 't' }, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(off.list(), e => e.kind === 'offline');
  assert.throws(() => CL.client({ repo: 'x', token: 't' }), e => e.kind === 'config');
});
