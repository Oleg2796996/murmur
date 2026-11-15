#!/usr/bin/env node
// Round-trip check THROUGH THE PWA's own restore code.
//
// tools/backup-pwa-compat-check.js verifies the FILE FORMAT (decrypt + the
// rules pwa/app.js applies). This script verifies the PWA STORE side: it
// loads the real `pwa/app-store.js` under a fake IndexedDB and runs the real
// `importBackupData` on an iOS-written backup, then checks what actually
// landed in the `chats` / `kv` stores.
//
// It also runs the real `pwa/app.js` dedup rule against the restored rows:
// `loadHistory` skips a server row when `existingSigSet.has(fromNpub + ts)`,
// so a restored row whose `_sig` is NOT `from+ts` would be duplicated by the
// next poll. That rule is replayed here on the restored rows.
//
// Usage: node tools/backup-pwa-store-restore.js <backup.murmur> <password>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , file, password] = process.argv;
if (!file) {
  console.error('usage: backup-pwa-store-restore.js <backup.murmur> <password>');
  process.exit(2);
}

const REPO = path.resolve(__dirname, '..');
const PWA = path.join(REPO, 'pwa');

// --- minimal fake IndexedDB (only what app-store.js uses) ---
//
// The real app-store.js wraps every store call in a transaction and waits for
// `tx.oncomplete`; it also assigns `req.onsuccess` AFTER the request was
// created. So the fake must:
//   * deliver the request event asynchronously (setImmediate),
//   * let the caller overwrite `onsuccess` without losing our bookkeeping —
//     hence `defineProperty` with a setter that only stores the handler,
//   * fire `tx.oncomplete` once every request of that transaction has fired.
function makeFakeIDB() {
  const stores = new Map(); // storeName -> Map(key -> value)
  const ensure = (n) => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
  // The real stores use keyPath ("key" for kv, "peer" for chats, "blob_id" for
  // blobs, "endpoint" for vapid) — `store.put(record)` without an explicit key
  // must derive the key from the record.
  const KEY_PATHS = { kv: 'key', chats: 'peer', blobs: 'blob_id', vapid: 'endpoint' };

  const makeReq = (result, onFire) => {
    let handler = null;
    const r = { result, error: null };
    Object.defineProperty(r, 'onsuccess', {
      get: () => handler,
      set: (fn) => { handler = fn; },
      enumerable: true, configurable: true,
    });
    Object.defineProperty(r, 'onerror', {
      get: () => null,
      set: () => {},
      enumerable: true, configurable: true,
    });
    setImmediate(() => {
      if (handler) handler({ target: r });
      if (onFire) onFire();
    });
    return r;
  };

  const tx = () => {
    let pending = 0;
    let settled = false;
    const t = {
      oncomplete: null, onerror: null, onabort: null, error: null,
      objectStore: (n) => {
        const fire = () => {
          pending--;
          if (pending <= 0 && !settled && t.oncomplete) {
            settled = true;
            setImmediate(() => t.oncomplete());
          }
        };
        return {
          get: (k) => { pending++; return makeReq(ensure(n).get(k), fire); },
          put: (v, k) => {
            pending++;
            const key = k !== undefined ? k : (KEY_PATHS[n] ? v?.[KEY_PATHS[n]] : undefined);
            return makeReq((ensure(n).set(key, v), key), fire);
          },
          delete: (k) => { pending++; return makeReq((ensure(n).delete(k), undefined), fire); },
          getAllKeys: () => { pending++; return makeReq([...ensure(n).keys()], fire); },
          getAll: () => { pending++; return makeReq([...ensure(n).values()], fire); },
          count: () => { pending++; return makeReq(ensure(n).size, fire); },
          clear: () => { pending++; return makeReq((ensure(n).clear(), undefined), fire); },
        };
      },
    };
    return t;
  };

  const dbObj = {
    objectStoreNames: {
      contains: (n) => stores.has(n),
      get length() { return stores.size; },
      [Symbol.iterator]: function* () { yield* stores.keys(); },
    },
    createObjectStore: (n) => ({
      store: n,
      createIndex: () => ({}),
      deleteIndex: () => undefined,
    }),
    transaction: () => tx(),
  };

  return {
    _stores: stores,
    open: (name, _v) => {
      const r = {
        result: dbObj, error: null,
        onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
        transaction: null,
      };
      setImmediate(() => {
        if (r.onupgradeneeded) r.onupgradeneeded({ oldVersion: 0, target: r });
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
    deleteDatabase: () => makeReq(undefined),
  };
}

// --- decrypt the iOS-written backup (PWA's own algorithm) ---
function pwaDecrypt(raw) {
  const box = JSON.parse(raw);
  const salt = Buffer.from(box.salt, 'base64');
  const iv = Buffer.from(box.iv, 'base64');
  const data = Buffer.from(box.data, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, box.iterations || 250000, 32, 'sha256');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return { box, payload: JSON.parse(plain.toString('utf8')) };
}

const { payload } = pwaDecrypt(fs.readFileSync(file, 'utf8'));

// --- load the REAL app-store.js into a fake window ---
global.window = global;
global.indexedDB = makeFakeIDB();
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] === undefined ? null : this._s[k]; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.crypto = global.crypto || require('crypto').webcrypto;
global.IDBKeyRange = { bound: () => ({}), only: () => ({}) };
global.navigator = { userAgent: 'node' };

const src = fs.readFileSync(path.join(PWA, 'app-store.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function(src)();

async function main() {
  await window.appStore.open();
  const before = await window.appStore.kv.keys();

  // The REAL restore path (pwa/backup.js restoreFromRaw → importBackupData).
  await window.appStore.importBackupData({
    kv: payload.kv || {},
    chats: payload.chats || {},
    blobs: payload.blobs || [],
  });

  const after = await window.appStore.kv.keys();
  const peers = await window.appStore.chats.listPeers();

  console.log('=== real pwa/app-store.js importBackupData ===');
  console.log('  kv keys before:', before.length, ' after:', after.length);
  console.log('  peers restored:', peers.length);

  let failures = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
    if (!ok) failures++;
  };

  check('kv keys were written', after.length > 0, `${after.length}`);
  check('all chat peers restored',
    peers.length === Object.keys(payload.chats || {}).length,
    `${peers.length} vs ${Object.keys(payload.chats || {}).length}`);

  let totalRows = 0;
  for (const peer of peers) {
    const msgs = await window.appStore.chats.getMessages(peer);
    totalRows += msgs.length;
    for (const m of msgs) {
      if (!m || typeof m !== 'object') { check('row is an object', false, peer); break; }
      if (m.callEvent) continue;
      // The PWA dedup rule (loadHistory): sigKey = fromNpub + ts.
      if (m._sig !== (m.from || '') + m.ts) {
        check(`row _sig == from+ts (${peer.slice(0, 12)})`, false, m._sig);
        break;
      }
    }
  }
  check('every restored row keeps the PWA sig format', failures === 0);
  check('total rows restored',
    totalRows === Object.values(payload.chats || {}).reduce((a, v) => a + v.length, 0),
    `${totalRows}`);

  // --- replay the PWA dedup rule: a server row must be recognised ---
  // loadHistory: `if (!hash && existingSigSet.has(sigKey)) continue;`
  let wouldDuplicate = 0;
  for (const peer of peers) {
    const cached = await window.appStore.chats.getMessages(peer);
    const existingSigSet = new Set(cached.map(m => m._sig).filter(Boolean));
    // A server row for the same message (the relay still has it):
    //   fromNpub = the sender, ts = the message ts.
    for (const m of cached) {
      if (m.callEvent) continue;
      const sigKey = (m.from || '') + m.ts;
      if (!existingSigSet.has(sigKey)) wouldDuplicate++;
    }
  }
  check('a later poll would NOT duplicate restored messages', wouldDuplicate === 0,
    `${wouldDuplicate} would duplicate`);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERROR', e); process.exit(1); });
