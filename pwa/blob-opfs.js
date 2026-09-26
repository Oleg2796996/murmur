// blob-opfs.js — этап 1 плана «вложения = текст» (Олег 2026-09-23 15:45).
// Promise-обёртка над blob-opfs-worker.js (dedicated worker + OPFS sync handles).
// API: window.MurmurBlobOPFS = { isAvailable, put, get, del, has, list, stats }
//
// isAvailable(): navigator.storage.getDirectory + createSyncAccessHandle (worker).
// put/get/del/has/list/stats — один запрос = один ответ, reqId матчинг.

(function () {
    let worker = null;
    let seq = 0;
    const pending = new Map(); // reqId → {resolve, reject}

    function ensureWorker() {
        if (worker) return worker;
        worker = new Worker("blob-opfs-worker.js");
        worker.onmessage = (e) => {
            const res = e.data;
            const p = pending.get(res.reqId);
            if (!p) return;
            pending.delete(res.reqId);
            if (res.ok) p.resolve(res);
            else p.reject(new Error(res.err || "OPFS error"));
        };
        worker.onerror = (e) => {
            // воркер упал — reject всех ждущих
            const err = new Error("OPFS worker error: " + (e.message || "unknown"));
            for (const [, p] of pending) p.reject(err);
            pending.clear();
            worker = null;
        };
        return worker;
    }

    function call(op, params) {
        return new Promise((resolve, reject) => {
            const w = ensureWorker();
            const reqId = ++seq;
            pending.set(reqId, { resolve, reject });
            w.postMessage(Object.assign({ op, reqId }, params || {}));
        });
    }

    async function isAvailable() {
        try {
            if (!navigator.storage || !navigator.storage.getDirectory) return false;
            // createSyncAccessHandle существует только в worker — проверяем间接:
            // попытка реально вызова put делается на этапе интеграции.
            // Здесь — структурная проверка.
            return typeof Worker !== "undefined";
        } catch (e) {
            return false;
        }
    }

    window.MurmurBlobOPFS = {
        isAvailable,
        put: (id, blobOrBuf, mime) => {
            // принимает Blob или ArrayBuffer
            if (blobOrBuf instanceof Blob) {
                return blobOrBuf.arrayBuffer().then(buf => call("put", { id, mime, buf }));
            }
            return call("put", { id, mime: mime || "application/octet-stream", buf: blobOrBuf });
        },
        get: (id) => call("get", { id }),
        del: (id) => call("del", { id }),
        has: (id) => call("has", { id }),
        list: () => call("list", {}),
        stats: () => call("stats", {}),
    };
})();
