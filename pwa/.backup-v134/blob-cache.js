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
        // Lesson #312 (Олег 2026-08-28 06:30 MSK): cache.get() делает READ-ONLY tx,
        // отдаёт blob СРАЗУ, а LRU bump (rec.ts = now) — fire-and-forget в фоне.
        // Раньше было readwrite tx + bump ts синхронно: на Safari PWA это 200-400мс
        // на каждый cache HIT (запись blob'а обратно в IDB медленная). 10 фото в чате
        // = 2-4 секунды чисто на write tx + двойной Blob-wrap в `new Blob([rec.blob])`.
        // Fix: read-only + bump async → HIT стоит ~5мс вместо 300мс.
        const db = await open();
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const rec = await _getRecord(blobId, store);
        if (!rec) return null;
        // Lesson #313 (Олег 2026-08-28 06:32 MSK): rec.blob — ArrayBuffer (сохранили
        // через blob.arrayBuffer() в put()). new Blob([ab], {type}) — единственный
        // Blob-wrap → Safari не делает двойную перекодировку (Lesson #294).
        // Lesson #314 (Олег 2026-08-28 06:33 MSK): rec.mime — сохранённый mime.
        // Lesson #323 (Олег 2026-08-28 09:35 MSK): обратная совместимость со
        // СТАРЫМИ записями (где rec.blob = Blob, не ArrayBuffer). Браузер умеет
        // передавать Blob в new Blob([...]) — Safari unwrap'ит вложенный Blob.
        const blob = new Blob([rec.blob], { type: rec.mime || "application/octet-stream" });
        // LRU bump в фоне — не блокируем return. Fire-and-forget tx.
        bumpTs(blobId).catch(() => {});
        return blob;
    } catch (e) {
        console.warn("[blob-cache] get failed:", e);
        return null;
    }
}

async function bumpTs(blobId) {
    if (!isAvailable()) return;
    try {
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const rec = await _getRecord(blobId, store);
        if (!rec) return;
        rec.ts = Date.now();
        await _putRecord(rec, store);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        // best-effort — eviction может не быть точным на одну запись
    }
}

async function put(blobId, blob, mime) {
    if (!isAvailable()) return Promise.resolve(false);
    // Lesson #322 (Олег 2026-08-28 09:30 MSK): put() — FIRE-AND-FORGET.
    // НЕ блокируем UI на await blob.arrayBuffer() (для 4MB photo ~100-200мс
    // на полную копию bytes в ArrayBuffer). Это Bug C — регресс скорости
    // после v127. Caller уже имеет blob в памяти, renderAttachment сразу
    // даёт URL.createObjectURL — пользователь видит фото. IDB put в фоне.
    putInBackground(blobId, blob, mime).catch((e) => {
        console.warn("[blob-cache] background put failed:", e);
    });
    return Promise.resolve(true); // optimistic: "принято к записи"
}

async function putInBackground(blobId, blob, mime) {
    try {
        // Lesson #315 (Олег 2026-08-28 06:35 MSK): сохраняем ArrayBuffer,
        // не Blob. Blob из Web Crypto API → blob.arrayBuffer() → ArrayBuffer.
        // Преимущества:
        // 1. Safari WebKit не делает двойную перекодировку Blob в IDB
        //    (Blob stored as-is, на get() — единственный new Blob([ab], {type})).
        // 2. ArrayBuffer сериализуется в IDB чисто, без opaque-handle issues.
        // 3. get() быстрее — нет blob.arrayBuffer() внутри (уже готовый ab).
        const ab = await blob.arrayBuffer();
        const db = await open();
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const record = {
            blob_id: blobId,
            blob: ab,
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
    } catch (e) {
        // Already logged in main wrapper, swallow here.
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
