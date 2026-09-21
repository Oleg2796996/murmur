// blob-cache.js — Lesson #334 (Олег 2026-08-28 15:09 MSK): proxy к appStore.blobs.
// Реальная логика хранения расшифрованных blob'ов теперь в app-store.js
// (DB murmur-store, store `blobs`). Этот файл — backward compat layer
// для кода который импортирует window.MurmurBlobCache.{isAvailable, open, get,
// put, del, clear, stats}.

(function () {
    function isAvailable() {
        return window.appStore && typeof window.appStore.isAvailable === "function" && window.appStore.isAvailable();
    }

    async function open() {
        if (!isAvailable()) throw new Error("IndexedDB not available");
        return window.appStore.open();
    }

    async function get(blobId) {
        return window.appStore.blobs.get(blobId);
    }

    async function put(blobId, blob, mime) {
        return window.appStore.blobs.put(blobId, blob, mime);
    }

    async function del(blobId) {
        return window.appStore.blobs.del(blobId);
    }

    async function clear() {
        return window.appStore.blobs.clear();
    }

    async function stats() {
        return window.appStore.blobs.stats();
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
})();