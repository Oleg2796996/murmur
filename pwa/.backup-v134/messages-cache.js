// pwa/messages-cache.js — Lesson #331 (Олег 2026-08-28 13:50 MSK): persistent
// IndexedDB source of truth для всей переписки + attachments.
//
// Зачем: localStorage (5MB quota, sync) и messages_cache в нём терял
// attachments_meta с plaintext_b64 при определённых race'ах. IndexedDB —
// async, persistent, переживает close tab, без quota проблем, отдельный
// от service worker cache. Cold start: открыл чат → getMessagesFromCache(peer)
// → render за миллисекунды, без fetch /api/history для старых сообщений.
//
// Архитектура:
//   DB `murmur-messages`, version 1:
//     store `messages`     key=peer (npub), value=[msg, msg, ...]
//                          msg содержит attachments_meta с plaintext_b64
//                          для outgoing, или blob_id+wrapped_key для incoming
//     store `outbox`       key=sig (`fromNpub:ts`), value={body, attachments_meta (plaintext_b64)}
//                          отдельно от messages для быстрого поиска при decrypt fail
//     store `attachment_blobs`  key=blob_id, value={blob, mime, ts, size}
//                          (опционально, для локальных attachments без ECIES)
//
// API:
//   await msgCache.open()
//   await msgCache.saveMessages(peer, messages[])      // весь peer array
//   await msgCache.appendMessage(peer, msg)            // один msg
//   await msgCache.getMessages(peer)                   // [] | messages[]
//   await msgCache.clearMessages(peer)
//   await msgCache.saveOutbox(key, {body, attachments_meta})
//   await msgCache.getOutbox(key)
//   await msgCache.getAllOutboxForPeer(peer)           // для cold start outgoing render
//   await msgCache.clearAll()
//   msgCache.isAvailable()

const DB_NAME = "murmur-messages";
const DB_VERSION = 1;
const STORE_MESSAGES = "messages";
const STORE_OUTBOX = "outbox";
const STORE_ATTACHMENT_BLOBS = "attachment_blobs";

const MAX_MESSAGES_PER_PEER = 200; // hard cap (iOS Safari IDB лимит)

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
            if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
                db.createObjectStore(STORE_MESSAGES, { keyPath: "peer" });
            }
            if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
                db.createObjectStore(STORE_OUTBOX, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(STORE_ATTACHMENT_BLOBS)) {
                db.createObjectStore(STORE_ATTACHMENT_BLOBS, { keyPath: "blob_id" });
            }
        };
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => reject(new Error("IndexedDB open failed: " + (req.error?.message || "unknown")));
        req.onblocked = () => reject(new Error("IndexedDB blocked by old connection"));
    });
}

async function _tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(new Error("IDB tx error: " + tx.error?.message));
        tx.onabort = () => reject(new Error("IDB tx aborted: " + tx.error?.message));
    });
}

// === Messages ===

async function saveMessages(peer, msgs) {
    if (!Array.isArray(msgs) || msgs.length === 0) return;
    // Trim до MAX_MESSAGES_PER_PEER
    const trimmed = msgs.slice(-MAX_MESSAGES_PER_PEER);
    // Strip heavy fields перед сохранением (plaintext_b64 → Blob в outbox)
    const clean = trimmed.map((m) => ({
        from: m.from, to: m.to, body: m.body, ts: m.ts,
        direction: m.direction,
        sig: m.sig, _sig: m._sig, _hash: m._hash,
        isBinary: m.isBinary, status: m.status,
        attachments: m.attachments || [],
        // Lesson #331: attachments_meta — ЕДИНСТВЕННЫЙ источник истины для outgoing render.
        // plaintext_b64 в нём — для self-render без decrypt round-trip.
        attachments_meta: m.attachments_meta || [],
    }));
    return _tx(STORE_MESSAGES, "readwrite", (store) => {
        store.put({ peer, messages: clean, updatedAt: Date.now() });
    });
}

async function appendMessage(peer, msg) {
    const existing = (await getMessages(peer)) || [];
    existing.push(msg);
    return saveMessages(peer, existing);
}

async function getMessages(peer) {
    return _tx(STORE_MESSAGES, "readonly", (store) => {
        return new Promise((resolve, reject) => {
            const req = store.get(peer);
            req.onsuccess = () => resolve(req.result ? req.result.messages : []);
            req.onerror = () => reject(req.error);
        });
    });
}

async function clearMessages(peer) {
    return _tx(STORE_MESSAGES, "readwrite", (store) => {
        store.delete(peer);
    });
}

// === Outbox (plaintext cache для outgoing render) ===

async function saveOutbox(key, value) {
    return _tx(STORE_OUTBOX, "readwrite", (store) => {
        store.put({ key, ...value, savedAt: Date.now() });
    });
}

async function getOutbox(key) {
    return _tx(STORE_OUTBOX, "readonly", (store) => {
        return new Promise((resolve, reject) => {
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    });
}

async function getAllOutbox() {
    return _tx(STORE_OUTBOX, "readonly", (store) => {
        return new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => {
                const arr = req.result || [];
                // Превращаем [{key, body, attachments_meta, ...}] в {key: {...}}
                const map = {};
                for (const row of arr) {
                    const { key, ...rest } = row;
                    map[key] = rest;
                }
                resolve(map);
            };
            req.onerror = () => reject(req.error);
        });
    });
}

async function deleteOutbox(key) {
    return _tx(STORE_OUTBOX, "readwrite", (store) => {
        store.delete(key);
    });
}

// === Attachment Blobs (опционально, для incoming encrypted blob cache) ===

async function saveAttachmentBlob(blobId, blob, mime, size) {
    return _tx(STORE_ATTACHMENT_BLOBS, "readwrite", (store) => {
        store.put({ blob_id: blobId, blob, mime, size, ts: Date.now() });
    });
}

async function getAttachmentBlob(blobId) {
    return _tx(STORE_ATTACHMENT_BLOBS, "readonly", (store) => {
        return new Promise((resolve, reject) => {
            const req = store.get(blobId);
            req.onsuccess = () => resolve(req.result ? req.result.blob : null);
            req.onerror = () => reject(req.error);
        });
    });
}

// === Global ===

async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_MESSAGES, STORE_OUTBOX, STORE_ATTACHMENT_BLOBS], "readwrite");
        tx.objectStore(STORE_MESSAGES).clear();
        tx.objectStore(STORE_OUTBOX).clear();
        tx.objectStore(STORE_ATTACHMENT_BLOBS).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

async function stats() {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_MESSAGES, STORE_OUTBOX, STORE_ATTACHMENT_BLOBS], "readonly");
        const out = { messages: 0, outbox: 0, attachmentBlobs: 0 };
        tx.objectStore(STORE_MESSAGES).count().onsuccess = (e) => { out.messages = e.target.result; };
        tx.objectStore(STORE_OUTBOX).count().onsuccess = (e) => { out.outbox = e.target.result; };
        tx.objectStore(STORE_ATTACHMENT_BLOBS).count().onsuccess = (e) => { out.attachmentBlobs = e.target.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
    });
}

window.msgCache = {
    isAvailable,
    open,
    saveMessages,
    appendMessage,
    getMessages,
    clearMessages,
    saveOutbox,
    getOutbox,
    getAllOutbox,
    deleteOutbox,
    saveAttachmentBlob,
    getAttachmentBlob,
    clearAll,
    stats,
};

console.log("[msgCache] module loaded");
