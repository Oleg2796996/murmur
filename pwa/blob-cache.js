// pwa/blob-cache.js — Lesson #211 (Олег 2026-08-26 14:14): client-side decrypted blob cache.
//
// Why: renderAttachment для incoming attachments качает и расшифровывает blob
// заново при КАЖДОМ renderMessages. После 5-10 фото-сообщений это 5-10 fetch +
// 5-10 decrypt на каждое "новое сообщение в чате". На iPhone PWA это dead-lock,
// на Mac — медленная перезагрузка фото. Решение — IndexedDB cache decrypted blobs.
//
// Security model:
// - Server stores ciphertext + blob_id. Server НИКОГДА не имеет plaintext.
// - Plaintext расшифровывается только на клиенте через AES-256-GCM (ключ через ECIES).
// - IndexedDB на device тоже хранит plaintext (как и Service Worker cache, и
//   RAM в браузере). Это consistent с zero-knowledge E2E моделью.
// - Cache привязан к signing key hash — смена ключа → clear cache.
//
// Cache key: { blob_id } — server-assigned, immutable, global.
// Cache value: { blob (Blob), mime (string), ts (number), size (number) }.
// Cache eviction: LRU by ts, max total 500 MB.
//
// Public API:
//   await blobCache.open()             — открыть/создать DB (idempotent)
//   await blobCache.get(blobId)        — Blob|null from cache, also bumps ts
//   await blobCache.put(blobId, blob)  — store + LRU eviction
//   await blobCache.del(blobId)        — удалить одну запись
//   await blobCache.clear()            — clear all
//   await blobCache.stats()            — {count, bytes}
//   blobCache.isAvailable()            — IndexedDB availability check

const DB_NAME = "murmur-blob-cache";
const DB_VERSION = 1;
const STORE = "blobs";
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

let _db = null;

function isAvailable() {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function open() {
    if (!isAvailable()) {
        return Promise.reject(new Error("IndexedDB not available"));
    }
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: "blob_id" });
                store.createIndex("ts", "ts", { unique: false });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => reject(new Error("IndexedDB open failed: " + req.error?.message));
        req.onblocked = () => reject(new Error("IndexedDB blocked by old connection"));
    });
}

async function _getRecord(blobId, store) {
    return new Promise((resolve, reject) => {
        const req = store.get(blobId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

async function _putRecord(record, store) {
    return new Promise((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function _deleteRecord(blobId, store) {
    return new Promise((resolve, reject) => {
        const req = store.delete(blobId);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function _evictIfNeeded() {
    // LRU eviction: open store, count bytes, if > MAX_BYTES drop oldest by ts.
    try {
        const db = await open();
        const total = await _totalBytes(db);
        if (total <= MAX_BYTES) return;
        const toFree = total - MAX_BYTES;
        let freed = 0;
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const idx = store.index("ts");
        const cursorReq = idx.openCursor();
        cursorReq.onsuccess = () => {
            const c = cursorReq.result;
            if (!c || freed >= toFree) return;
            const rec = c.value;
            freed += (rec.size || 0);
            c.delete();
            c.continue();
        };
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        console.log("[blob-cache] evicted", Math.round(freed / 1024 / 1024), "MB");
    } catch (e) {
        console.warn("[blob-cache] eviction failed:", e);
    }
}

async function _totalBytes(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const req = store.openCursor();
        let total = 0;
        req.onsuccess = () => {
            const c = req.result;
            if (!c) { resolve(total); return; }
            total += c.value.size || 0;
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

async function get(blobId) {
    if (!isAvailable()) return null;
    try {
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const rec = await _getRecord(blobId, store);
        if (!rec) return null;
        // Bump ts для LRU
        rec.ts = Date.now();
        await _putRecord(rec, store);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return new Blob([rec.blob], { type: rec.mime || "application/octet-stream" });
    } catch (e) {
        console.warn("[blob-cache] get failed:", e);
        return null;
    }
}

async function put(blobId, blob, mime) {
    if (!isAvailable()) return false;
    try {
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const record = {
            blob_id: blobId,
            blob,
            mime: mime || blob.type || "application/octet-stream",
            size: blob.size,
            ts: Date.now(),
        };
        await _putRecord(record, store);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        // Evict old (fire-and-forget)
        _evictIfNeeded().catch(() => {});
        return true;
    } catch (e) {
        console.warn("[blob-cache] put failed:", e);
        return false;
    }
}

async function del(blobId) {
    if (!isAvailable()) return false;
    try {
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        await _deleteRecord(blobId, store);
        await new Promise((resolve) => { tx.oncomplete = () => resolve(); });
        return true;
    } catch (e) {
        return false;
    }
}

async function clear() {
    if (!isAvailable()) return false;
    try {
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        await new Promise((resolve, reject) => {
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
        console.log("[blob-cache] cleared all");
        return true;
    } catch (e) {
        console.warn("[blob-cache] clear failed:", e);
        return false;
    }
}

async function stats() {
    if (!isAvailable()) return { count: 0, bytes: 0, available: false };
    try {
        const db = await open();
        const bytes = await _totalBytes(db);
        const count = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const store = tx.objectStore(STORE);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return { count, bytes, available: true, maxBytes: MAX_BYTES };
    } catch (e) {
        return { count: 0, bytes: 0, available: false, error: String(e) };
    }
}

window.MurmurBlobCache = {
    isAvailable,
    open,
    get,
    put,
    del,
    clear,
    stats,
};
