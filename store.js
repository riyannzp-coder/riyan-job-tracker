/* Data Store client — Google Sheets through the Apps Script web app in apps-script/Code.gs.
 *
 * - The script URL and API key live only in this browser's localStorage (never in the repo).
 * - Every application is also cached locally, so the dashboard opens instantly and works offline.
 * - Writes and deletes go into a local queue first and are sent in order; anything unsent is
 *   retried when the connection comes back or the page is opened again.
 * All requests are POST with a text/plain body, which keeps them "simple" (no CORS preflight)
 * and keeps the key out of the URL.
 */
(function (root) {
  'use strict';
  const CFG = 'jt-sheets-config', CACHE = 'jt-cache', QUEUE = 'jt-queue';
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let cache = read(CACHE, {});          // id → application
  let ready = null, flushing = null;
  const listeners = new Set();
  const emit = (state, detail) => listeners.forEach(fn => { try { fn(state, detail); } catch {} });

  const config = () => read(CFG, null);
  const configured = () => { const c = config(); return !!(c && c.url && c.key); };

  async function call(action, extra, cfg = config()) {
    if (!cfg || !cfg.url || !cfg.key) throw new Error('not_configured');
    const res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ key: cfg.key, action, ...extra }) });
    if (!res.ok) throw new Error('http_' + res.status);
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'failed');
    return out;
  }

  // queued edits win over the server copy until they are flushed
  const applyQueue = next => {
    read(QUEUE, []).forEach(q => { if (q.op === 'delete') delete next[q.id]; else next[q.id] = q.data; });
    return next;
  };

  // full snapshot from the sheet → cache
  async function pull() {
    const out = await call('all');
    const next = {};
    (out.apps || []).forEach(a => { if (a && a.id) next[a.id] = a; });
    cache = applyQueue(next); write(CACHE, cache);
  }

  function load() {
    if (!ready) ready = (async () => {
      if (!configured()) return { source: 'local' };
      try { await pull(); flush().catch(() => {}); return { source: 'sheets' }; }
      catch (e) { emit('offline', e); return { source: 'cache', error: e }; }
    })();
    return ready;
  }

  function flush() {
    if (flushing || !configured()) return flushing || Promise.resolve();
    flushing = (async () => {
      let q = read(QUEUE, []);
      while (q.length) {
        const item = q[0];
        try {
          if (item.op === 'delete') await call('delete', { id: item.id });
          else await call('set', { app: item.data });
        } catch (e) { emit('pending', { count: q.length, error: e }); throw e; }
        q = read(QUEUE, []).filter(x => !(x.id === item.id && x.at === item.at));
        write(QUEUE, q);
      }
      emit('synced');
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function enqueue(op, id, data) {
    const q = read(QUEUE, []).filter(x => x.id !== id);   // keep only the newest change per application
    q.push({ op, id, data, at: Date.now() });
    write(QUEUE, q);
    return flush();
  }

  async function set(app) {
    cache[app.id] = app; write(CACHE, cache);
    if (!configured()) return;
    return enqueue('set', app.id, app);
  }

  async function remove(id) {
    delete cache[id]; write(CACHE, cache);
    if (!configured()) return;
    return enqueue('delete', id);
  }

  async function all() { await load(); return Object.values(cache); }

  // move a "Backup JSON" (array of applications) into the sheet, in small batches so no single
  // request gets large; a failed batch is retried once and then reported. Returns { total, failed }.
  async function importApps(apps, onProgress) {
    const CHUNK = 10, failed = [];
    let total = null;
    for (let i = 0; i < apps.length; i += CHUNK) {
      const part = apps.slice(i, i + CHUNK);
      try { total = (await call('import', { apps: part })).total; }
      catch (e1) {
        try { total = (await call('import', { apps: part })).total; }
        catch (e2) { failed.push({ ids: part.map(a => a.company || a.id), error: e2.message }); }
      }
      onProgress && onProgress(Math.min(apps.length, i + CHUNK), apps.length);
    }
    ready = null; await load();
    return { total, failed };
  }

  async function connect(url, key) {
    const cfg = { url: String(url).trim(), key: String(key).trim() };
    const out = await call('ping', {}, cfg);          // throws with a reason when URL or key is wrong
    write(CFG, cfg); ready = null;
    return out;
  }
  function disconnect() { try { localStorage.removeItem(CFG); } catch {} ready = null; }

  root.addEventListener && root.addEventListener('online', () => flush().catch(() => {}));
  setInterval(() => { if (read(QUEUE, []).length) flush().catch(() => {}); }, 30000);

  root.SheetStore = {
    configured, config, connect, disconnect, load, all, set, remove, flush, importApps,
    pending: () => read(QUEUE, []).length,
    on: fn => listeners.add(fn),
  };
})(typeof window !== 'undefined' ? window : globalThis);
