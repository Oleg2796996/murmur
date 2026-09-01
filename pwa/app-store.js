// app-store.js — Lesson #334 (Олег 2026-08-28 15:09 MSK): УНИВЕРСАЛЬНОЕ хранилище
// Murmur PWA. Один файл, одна DB, schema v2. Заменяет 12 localStorage ключей +
// 3 IDB stores (messages, outbox, attachment_blobs).
//
// Архитектура:
//   DB `murmur-store`, version 2:
//     store `kv`             keyPath: key
//                            value: { key, value }
//                            Для простых KV: identity (npub, sk, name),
//                            contact names, unread, hidden_peers, deleted_ts,
//                            messages_max_ts (для incremental fetch)
//
//     store `chats`          keyPath: peer
//                            value: { peer, messages: [], updatedAt }
//                            messages: [{direction, body, ts, from, to,
//                                       _hash, _sig, sig,
//                                       attachments_meta: [{blob_id, wrapped_key,
//                                                            mime, name, size,
//                                                            plaintext_b64}],
//                                       status: "sent"|"pending"}]
//                            MAX 200 msgs/peer (iOS Safari quota)
//
//     store `blobs`          keyPath: blob_id
//                            value: { blob_id, data (ArrayBuffer), mime, size, ts, hits }
//                            LRU по ts, ~50MB max, readonly tx для get
//                            (Safari WebKit 240216 fix, Lesson #294)
//
//     store `vapid`          keyPath: endpoint
//                            value: { endpoint, p256dh, auth }
//
// API:
//   await store.open()
//   await store.kv.get(key) / .set(key, value) / .del(key) / .keys()
//   await store.chats.getMessages(peer) / .saveMessages(peer, arr) /
//            .appendMessage(peer, msg) / .updateMessage(peer, _hash, patch) /
//            .deleteMessages(peer) / .listPeers()
//   await store.blobs.get(blob_id) / .put(blob_id, blob, mime) / .del(blob_id) /
//            .clear() / .stats()
//   await store.vapid.get(endpoint) / .set(record) / .del(endpoint)
//
// Все KV-операции через один `kv` store. Преимущество:
// - один IDB connection
// - один upgrade путь (v1 → v2 мигрирует localStorage → kv)
// - удобная отладка через DevTools (видно все данные приложения)

const DB_NAME = "murmur-store";
const DB_VERSION = 2;

const STORE_KV = "kv";
const STORE_CHATS = "chats";
const STORE_BLOBS = "blobs";
const STORE_VAPID = "vapid";

const MAX_MESSAGES_PER_PEER = 200;
const MAX_BLOB_CACHE_BYTES = 50 * 1024 * 1024; // 50MB

// Список всех localStorage ключей для миграции v1→v2
const LEGACY_LS_KEYS = [
    "murmur.npub",
    "murmur.sk",
    "murmur.name",
    "murmur.contact_names",
    "murmur.outbox",
    "murmur.messages_cache",
    "murmur.messages_max_ts",
    "murmur_unread_v1",
    "murmur_maxts_v1",
    "murmur_hidden_peers_v1",
    "murmur_deleted_ts_v1",
    "murmur.vapid",
];

let _db = null;
let _migrating = false;
let _migrationDone = false;

function isAvailable() {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function open() {
    if (!isAvailable()) {
        return Promise.reject(new Error("IndexedDB not available"));
    }
    if (_db) return Promise.resolve(_db);
    if (_migrating) {
        return new Promise((resolve, reject) => {
            const check = () => {
                if (_db) return resolve(_db);
                if (!_migrating) return reject(new Error("Migration aborted"));
                setTimeout(check, 50);
            };
            check();
        });
    }
    _migrating = true;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = async (ev) => {
            const db = req.result;
            const oldVersion = ev.oldVersion;
            // v1 → v2: добавить stores если их нет
            if (oldVersion < 1) {
                if (!db.objectStoreNames.contains(STORE_KV)) {
                    db.createObjectStore(STORE_KV, { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains(STORE_CHATS)) {
                    const s = db.createObjectStore(STORE_CHATS, { keyPath: "peer" });
                    s.createIndex("updatedAt", "updatedAt", { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_BLOBS)) {
                    const s = db.createObjectStore(STORE_BLOBS, { keyPath: "blob_id" });
                    s.createIndex("ts", "ts", { unique: false });
                    s.createIndex("size", "size", { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_VAPID)) {
                    db.createObjectStore(STORE_VAPID, { keyPath: "endpoint" });
                }
            }
            // Миграция из старых DB (murmur-messages, murmur-blob-cache) — async после onupgradeneeded
            if (oldVersion < 2) {
                // Запускаем миграцию после open — см. _migrateFromV1 ниже
                ev.target._pendingMigration = true;
            }
        };
        req.onsuccess = async () => {
            _db = req.result;
            _migrating = false;
            resolve(_db);
            // Async миграция если есть pending
            if (req.transaction && req.transaction.db) {
                const tx = req.transaction;
                if (tx.db._pendingMigration) {
                    _migrateFromV1().catch((e) => console.warn("[appStore] migration:", e));
                }
            }
            // Также мигрируем из localStorage
            _migrateFromLocalStorage().catch((e) => console.warn("[appStore] LS migration:", e));
        };
        req.onerror = () => {
            _migrating = false;
            reject(new Error("IndexedDB open failed: " + (req.error?.message || "unknown")));
        };
        req.onblocked = () => {
            _migrating = false;
            reject(new Error("IndexedDB blocked by old connection"));
        };
    });
}

async function _tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        Promise.resolve(fn(store, tx)).then((r) => {
            result = r;
        }).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
}

// ============= KV STORE =============

const kv = {
    async get(key) {
        return _tx(STORE_KV, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ? req.result.value : null);
            req.onerror = () => reject(req.error);
        }));
    },
    async set(key, value) {
        return _tx(STORE_KV, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.put({ key, value });
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async del(key) {
        return _tx(STORE_KV, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async keys() {
        return _tx(STORE_KV, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        }));
    },
};

// ============= CHATS STORE =============

const chats = {
    async getMessages(peer) {
        return _tx(STORE_CHATS, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.get(peer);
            req.onsuccess = () => resolve(req.result ? req.result.messages : []);
            req.onerror = () => reject(req.error);
        }));
    },
    async saveMessages(peer, messages) {
        if (!Array.isArray(messages) || messages.length === 0) return;
        const trimmed = messages.slice(-MAX_MESSAGES_PER_PEER);
        const record = { peer, messages: trimmed, updatedAt: Date.now() };
        return _tx(STORE_CHATS, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async appendMessage(peer, msg) {
        return _tx(STORE_CHATS, "readwrite", (store, tx) => new Promise(async (resolve, reject) => {
            const getReq = store.get(peer);
            getReq.onsuccess = () => {
                const record = getReq.result || { peer, messages: [], updatedAt: 0 };
                record.messages.push(msg);
                if (record.messages.length > MAX_MESSAGES_PER_PEER) {
                    record.messages = record.messages.slice(-MAX_MESSAGES_PER_PEER);
                }
                record.updatedAt = Date.now();
                const putReq = store.put(record);
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
            tx.oncomplete = () => resolve();
        }));
    },
    async updateMessage(peer, _hash, patch) {
        return _tx(STORE_CHATS, "readwrite", (store) => new Promise((resolve, reject) => {
            const getReq = store.get(peer);
            getReq.onsuccess = () => {
                const record = getReq.result;
                if (!record) return resolve();
                const idx = record.messages.findIndex((m) => m._hash === _hash);
                if (idx < 0) return resolve();
                record.messages[idx] = { ...record.messages[idx], ...patch };
                record.updatedAt = Date.now();
                const putReq = store.put(record);
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
        }));
    },
    async deleteMessages(peer) {
        return _tx(STORE_CHATS, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.delete(peer);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async listPeers() {
        return _tx(STORE_CHATS, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        }));
    },
};

// ============= BLOBS STORE =============

const blobs = {
    async get(blobId) {
        return _tx(STORE_BLOBS, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.get(blobId);
            req.onsuccess = () => {
                const rec = req.result;
                if (!rec) return resolve(null);
                // Bump ts fire-and-forget (Lesson #312)
                _bumpBlobTs(blobId).catch(() => {});
                // Backward compat: rec.data = ArrayBuffer (v1+) или rec.blob = Blob (legacy)
                if (rec.data) return resolve(new Blob([rec.data], { type: rec.mime || "application/octet-stream" }));
                if (rec.blob) return resolve(new Blob([rec.blob], { type: rec.mime || "application/octet-stream" }));
                resolve(null);
            };
            req.onerror = () => reject(req.error);
        }));
    },
    async put(blobId, blob, mime) {
        const size = blob.size;
        // v160j (Олег: «мак завис при приёме видео»): большие блобы НЕ читаем в
        // ArrayBuffer на главном потоке (сотни МБ → фриз+GC-шторм). Кладём Blob
        // как есть (IDB умеет хранить Blob нативно); get() отдаёт через rec.blob.
        const LARGE = 8 * 1024 * 1024;
        const record = (size <= LARGE)
            ? { blob_id: blobId, data: await blob.arrayBuffer(), mime: mime || "application/octet-stream", size, ts: Date.now(), hits: 0 }
            : { blob_id: blobId, blob: blob, mime: mime || "application/octet-stream", size, ts: Date.now(), hits: 0 };
        // Fire-and-forget — не блокируем UI (Lesson #322)
        _tx(STORE_BLOBS, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.put(record);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
        })).then(() => _evictIfNeeded()).catch((e) => console.warn("[appStore] blob put:", e));
        return true;
    },
    async del(blobId) {
        return _tx(STORE_BLOBS, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.delete(blobId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async clear() {
        return _tx(STORE_BLOBS, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async stats() {
        return _tx(STORE_BLOBS, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => {
                const all = req.result || [];
                const bytes = all.reduce((sum, r) => sum + (r.size || 0), 0);
                resolve({ count: all.length, bytes, available: true, maxBytes: MAX_BLOB_CACHE_BYTES });
            };
            req.onerror = () => reject(req.error);
        }));
    },
};

async function _bumpBlobTs(blobId) {
    return _tx(STORE_BLOBS, "readwrite", (store) => new Promise((resolve, reject) => {
        const getReq = store.get(blobId);
        getReq.onsuccess = () => {
            const rec = getReq.result;
            if (!rec) return resolve();
            rec.ts = Date.now();
            rec.hits = (rec.hits || 0) + 1;
            const putReq = store.put(rec);
            putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
    }));
}

async function _evictIfNeeded() {
    try {
        const stats = await blobs.stats();
        if (stats.bytes <= MAX_BLOB_CACHE_BYTES) return;
        // Evict oldest 10% by ts
        const all = await _tx(STORE_BLOBS, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        }));
        all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const evictCount = Math.max(1, Math.floor(all.length * 0.1));
        const toEvict = all.slice(0, evictCount).map((r) => r.blob_id);
        await _tx(STORE_BLOBS, "readwrite", (store) => new Promise((resolve, reject) => {
            toEvict.forEach((id) => store.delete(id));
            resolve();
        }));
        console.log("[appStore] evicted", evictCount, "oldest blobs");
    } catch (e) {
        console.warn("[appStore] evict failed:", e);
    }
}

// ============= VAPID STORE =============

const vapid = {
    async get(endpoint) {
        return _tx(STORE_VAPID, "readonly", (store) => new Promise((resolve, reject) => {
            const req = store.get(endpoint);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        }));
    },
    async set(record) {
        return _tx(STORE_VAPID, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
    async del(endpoint) {
        return _tx(STORE_VAPID, "readwrite", (store) => new Promise((resolve, reject) => {
            const req = store.delete(endpoint);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        }));
    },
};

// ============= MIGRATION =============

async function _migrateFromLocalStorage() {
    if (_migrationDone) return;
    if (typeof localStorage === "undefined") return;
    _migrationDone = true;
    let migrated = 0;
    for (const key of LEGACY_LS_KEYS) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) continue;
            const value = raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')
                ? JSON.parse(raw)
                : raw;
            await kv.set(key, value);
            migrated++;
            console.log("[appStore] migrated LS key:", key);
        } catch (e) {
            console.warn("[appStore] failed to migrate", key, e);
        }
    }
    if (migrated > 0) {
        console.log("[appStore] migrated", migrated, "keys from localStorage to IDB");
    }
}

async function _migrateFromV1() {
    // Миграция из старых DB `murmur-messages` (v133) и `murmur-blob-cache` (v127)
    if (typeof indexedDB === "undefined") return;
    const sources = [
        { name: "murmur-messages", version: 1, stores: ["messages", "outbox"] },
        { name: "murmur-blob-cache", version: 1, stores: ["blobs"] },
    ];
    for (const src of sources) {
        try {
            const req = indexedDB.open(src.name);
            req.onsuccess = () => {
                const oldDb = req.result;
                try {
                    if (src.name === "murmur-messages") {
                        _migrateMessagesDb(oldDb);
                    } else if (src.name === "murmur-blob-cache") {
                        _migrateBlobsDb(oldDb);
                    }
                } catch (e) {
                    console.warn("[appStore] v1 migration:", e);
                }
                oldDb.close();
                // Удалить старую DB
                indexedDB.deleteDatabase(src.name);
                console.log("[appStore] removed old DB:", src.name);
            };
            req.onerror = () => { /* ignore */ };
        } catch (e) {
            console.warn("[appStore] v1 migration open:", e);
        }
    }
}

function _migrateMessagesDb(oldDb) {
    // messages store → chats store
    if (oldDb.objectStoreNames.contains("messages")) {
        const tx = oldDb.transaction("messages", "readonly");
        const store = tx.objectStore("messages");
        store.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const peer = cursor.key;
            const messages = cursor.value;
            chats.saveMessages(peer, messages).catch(() => {});
            cursor.continue();
        };
    }
    // outbox store → kv (хранится как `outbox`)
    if (oldDb.objectStoreNames.contains("outbox")) {
        const tx = oldDb.transaction("outbox", "readonly");
        const store = tx.objectStore("outbox");
        store.getAll().onsuccess = (ev) => {
            const all = ev.target.result || [];
            const outboxMap = {};
            for (const entry of all) outboxMap[entry.key] = entry;
            kv.set("murmur.outbox", outboxMap).catch(() => {});
        };
    }
}

function _migrateBlobsDb(oldDb) {
    if (oldDb.objectStoreNames.contains("blobs")) {
        const tx = oldDb.transaction("blobs", "readonly");
        const store = tx.objectStore("blobs");
        store.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            // rec.blob — старый формат (Blob); rec.data — новый (ArrayBuffer)
            if (rec.blob && !rec.data) {
                rec.blob.arrayBuffer().then((ab) => {
                    rec.data = ab;
                    delete rec.blob;
                    blobs.put(rec.blob_id, new Blob([ab], { type: rec.mime }), rec.mime).catch(() => {});
                });
            } else {
                // Skip — пусть новый cache работает
            }
            cursor.continue();
        };
    }
}

// ============= EXPORTS =============

window.appStore = {
    isAvailable,
    open,
    kv,
    chats,
    blobs,
    vapid,
    MAX_MESSAGES_PER_PEER,
    MAX_BLOB_CACHE_BYTES,
    stats: () => Promise.all([kv.keys(), chats.listPeers(), blobs.stats()]).then(([kvKeys, peers, blobStats]) => ({
        kvKeys: kvKeys.length,
        peers: peers.length,
        blobs: blobStats,
    })),
};

console.log("[appStore] module loaded (DB murmur-store v" + DB_VERSION + ")");