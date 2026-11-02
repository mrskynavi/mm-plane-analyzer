// GitHub-Sync: Projekte als Dateien in einem eigenen (privaten) GitHub-Repo speichern, damit alle
// Geräte (PC, iPad, …) denselben Stand sehen. Nutzt die GitHub-REST-API (Contents) direkt aus dem
// Browser; der Zugangsschlüssel (fine-grained Token, nur dieses Repo, Contents: Lesen und Schreiben)
// liegt nur im localStorage des Geräts und geht nur an api.github.com.
// Jede Datei trägt einen sha. Beim Schreiben schickt die App den zuletzt gesehenen sha mit; hat ein
// anderes Gerät inzwischen gespeichert, lehnt GitHub ab (409) und die App fragt nach, statt zu überschreiben.
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const FOLDER = 'projekte';
  const EXT = '.mmpa.json';

  const fileName = name => (String(name || '').trim() || 'Projekt').replace(/[\\/:*?"<>|#%]+/g, '_') + EXT;
  const pathOf = name => FOLDER + '/' + fileName(name);
  const nameOf = path => String(path).split('/').pop().replace(/\.mmpa\.json$|\.json$/i, '');

  // "owner/name", auch aus einer kopierten URL
  function parseRepo(s) {
    const m = String(s || '').trim().replace(/\.git$/, '').match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
    return m ? m[1] + '/' + m[2] : null;
  }

  // UTF-8 ⇄ Base64 (Umlaute in Namen und Notizen)
  function toB64(text) {
    const bytes = new TextEncoder().encode(text);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  class SyncError extends Error {
    constructor(msg, status, kind) { super(msg); this.status = status; this.kind = kind; }
  }

  const encPath = p => p.split('/').map(encodeURIComponent).join('/');

  function client(cfg, fetchFn) {
    const f = fetchFn || (typeof fetch === 'function' ? fetch.bind(root) : null);
    const repo = parseRepo(cfg.repo);
    if (!repo) throw new SyncError('Repo bitte als „besitzer/name“ angeben', 0, 'config');
    if (!cfg.token) throw new SyncError('Es fehlt der Zugangsschlüssel', 0, 'config');

    async function call(method, url, body) {
      let r;
      try {
        r = await f(API + url, {
          method,
          cache: 'no-store',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer ' + cfg.token,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new SyncError('Keine Verbindung zu GitHub', 0, 'offline');
      }
      if (r.ok) return r.status === 204 ? null : r.json();
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch { /* egal */ }
      const kind = r.status === 401 ? 'auth'
        : r.status === 404 ? 'missing'
        : r.status === 409 || (r.status === 422 && /sha/i.test(msg)) ? 'conflict'
        : r.status === 403 && /rate limit/i.test(msg) ? 'rate'
        : r.status === 403 ? 'forbidden' : 'http';
      const text = {
        auth: 'Der Zugangsschlüssel stimmt nicht oder ist abgelaufen',
        missing: 'Nicht gefunden',
        conflict: 'Ein anderes Gerät hat inzwischen gespeichert',
        rate: 'GitHub bremst gerade (zu viele Anfragen), bitte später nochmals',
        forbidden: 'Der Schlüssel darf in dieses Repo nicht schreiben',
        http: `GitHub meldet ${r.status}${msg ? ': ' + msg : ''}`,
      }[kind];
      throw new SyncError(text, r.status, kind);
    }

    return {
      repo,
      // Repo prüfen: gibt es es, darf der Schlüssel schreiben, ist es privat?
      async check() {
        let info;
        try { info = await call('GET', `/repos/${repo}`); }
        catch (e) { if (e.kind === 'missing') throw new SyncError(`Repo ${repo} nicht gefunden (oder der Schlüssel darf es nicht sehen)`, 404, 'missing'); throw e; }
        return { private: !!info.private, push: !info.permissions || !!info.permissions.push, branch: info.default_branch };
      },
      // Projekte im Ordner, ohne Inhalt
      async list() {
        let items;
        try { items = await call('GET', `/repos/${repo}/contents/${FOLDER}`); }
        catch (e) { if (e.kind === 'missing') return []; throw e; }
        return (Array.isArray(items) ? items : [])
          .filter(x => x.type === 'file' && /\.json$/i.test(x.name))
          .map(x => ({ path: x.path, name: nameOf(x.path), sha: x.sha, size: x.size }))
          .sort((a, b) => a.name.localeCompare(b.name, 'de'));
      },
      // Inhalt und sha; null, wenn es die Datei nicht gibt
      async get(path) {
        let x;
        try { x = await call('GET', `/repos/${repo}/contents/${encPath(path)}`); }
        catch (e) { if (e.kind === 'missing') return null; throw e; }
        // Über 1 MB liefert die Contents-API keinen Inhalt, dann über den Blob
        const b64 = x.content ? x.content : (await call('GET', `/repos/${repo}/git/blobs/${x.sha}`)).content;
        return { path: x.path, sha: x.sha, text: fromB64(b64) };
      },
      // Schreiben; sha = zuletzt gesehener Stand (null für eine neue Datei). Gibt den neuen sha zurück.
      async put(path, text, sha, message) {
        const body = { message: message || `${nameOf(path)} gespeichert`, content: toB64(text) };
        if (sha) body.sha = sha;
        const r = await call('PUT', `/repos/${repo}/contents/${encPath(path)}`, body);
        return r.content.sha;
      },
    };
  }

  // Git-Blob-sha eines Texts, um ohne Download zu sehen, ob der lokale Stand dem auf GitHub entspricht
  async function blobSha(text) {
    const body = new TextEncoder().encode(text);
    const head = new TextEncoder().encode(`blob ${body.length}\0`);
    const all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    const subtle = (root.crypto && root.crypto.subtle) || (typeof require === 'function' ? require('node:crypto').webcrypto.subtle : null);
    const h = new Uint8Array(await subtle.digest('SHA-1', all));
    return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  }

  const api = { API, FOLDER, EXT, fileName, pathOf, nameOf, parseRepo, toB64, fromB64, client, blobSha, SyncError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.MMPA = root.MMPA || {}).cloud = api;
})(typeof self !== 'undefined' ? self : this);
