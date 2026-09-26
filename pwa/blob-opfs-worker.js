// blob-opfs-worker.js — этап 1 плана «вложения = текст» (Олег 2026-09-23 15:45).
// Dedicated worker: синхронная OPFS-запись надёжна в WebKit ТОЛЬКО из worker
// (синхронные FileSystemSyncAccessHandle — spec: whatwg/fs). Из главного потока
// createWritable → DataCloneError-семейство у нас уже горело на >1.5 МБ.
//
// Протокол: postMessage({op:"put", id, mime, buf(ArrayBuffer)}) → {ok, id, sha256, size}
//           postMessage({op:"get", id}) → {ok, id, mime, buf} | {ok:false, id, err}
//           postMessage({op:"del", id}) → {ok, id}
//           postMessage({op:"has", id}) → {ok, id, has}
//           postMessage({op:"list"})    → {ok, entries:[{id,size,mime}]}
//           postMessage({op:"stats"})   → {ok, count, bytes}
//
// Хранение: /murmur-blobs/<id> (бинарь) + /murmur-blobs/<id>.meta (JSON: mime, size, sha256).
// SHA-256 через crypto.subtle (в worker доступен) — контрольная сумма после записи.

const DIR = "murmur-blobs";

let rootHandle = null;

async function ensureRoot() {
    if (rootHandle) return rootHandle;
    const origin = await navigator.storage.getDirectory();
    rootHandle = await origin.getDirectoryHandle(DIR, { create: true });
    return rootHandle;
}

async function put(msg) {
    const h = await ensureRoot();
    const buf = msg.buf;
    if (!(buf instanceof ArrayBuffer)) throw new Error("buf must be ArrayBuffer");
    // sha256 от исходных байт
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    // запись: sync access handle (надёжно в WebKit из worker)
    const fh = await h.getFileHandle(msg.id, { create: true });
    const sync = await fh.createSyncAccessHandle();
    try {
        sync.truncate(0);
        const bytes = new Uint8Array(buf);
        sync.write(bytes, { at: 0 });
        sync.flush();
    } finally {
        sync.close();
    }
    // meta: mime + size + sha256
    const meta = { mime: msg.mime || "application/octet-stream", size: buf.byteLength, sha256, ts: Date.now() };
    const mf = await h.getFileHandle(msg.id + ".meta", { create: true });
    const ms = await mf.createSyncAccessHandle();
    try {
        const enc = new TextEncoder().encode(JSON.stringify(meta));
        ms.truncate(0);
        ms.write(enc, { at: 0 });
        ms.flush();
    } finally {
        ms.close();
    }
    // верификация: перечитать и сверить размер (checksum сверяет вызывающий при get)
    const vf = await h.getFileHandle(msg.id, { create: false });
    const vfile = await vf.getFile();
    if (vfile.size !== buf.byteLength) throw new Error("verify failed: size mismatch " + vfile.size + " != " + buf.byteLength);
    return { ok: true, id: msg.id, sha256, size: buf.byteLength };
}

async function get(msg) {
    const h = await ensureRoot();
    let fh;
    try {
        fh = await h.getFileHandle(msg.id, { create: false });
    } catch (e) {
        return { ok: false, id: msg.id, err: "not found" };
    }
    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    // контрольная сумма после чтения (детект битой записи/порчи)
    let meta = null;
    try {
        const mf = await h.getFileHandle(msg.id + ".meta", { create: false });
        const mfile = await mf.getFile();
        meta = JSON.parse(await mfile.text());
    } catch (e) { /* meta нет — старая запись */ }
    if (meta && meta.sha256) {
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const sha256 = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
        if (sha256 !== meta.sha256) {
            return { ok: false, id: msg.id, err: "checksum mismatch" };
        }
    }
    return { ok: true, id: msg.id, mime: meta ? meta.mime : "application/octet-stream", buf, size: buf.byteLength, sha256: meta ? meta.sha256 : null };
}

async function del(msg) {
    const h = await ensureRoot();
    try { await h.removeEntry(msg.id); } catch (e) { /* уже нет */ }
    try { await h.removeEntry(msg.id + ".meta"); } catch (e) { /* уже нет */ }
    return { ok: true, id: msg.id };
}

async function has(msg) {
    const h = await ensureRoot();
    try {
        await h.getFileHandle(msg.id, { create: false });
        return { ok: true, id: msg.id, has: true };
    } catch (e) {
        return { ok: true, id: msg.id, has: false };
    }
}

async function list() {
    const h = await ensureRoot();
    const entries = [];
    for await (const [name, handle] of h.entries()) {
        if (name.endsWith(".meta")) continue;
        let meta = null;
        try {
            const mf = await h.getFileHandle(name + ".meta", { create: false });
            meta = JSON.parse(await (await mf.getFile()).text());
        } catch (e) { /* нет meta */ }
        entries.push({ id: name, size: meta ? meta.size : null, mime: meta ? meta.mime : null });
    }
    return { ok: true, entries };
}

async function stats() {
    const h = await ensureRoot();
    let count = 0, bytes = 0;
    for await (const [name, handle] of h.entries()) {
        if (name.endsWith(".meta")) continue;
        count++;
        const file = await handle.getFile();
        bytes += file.size;
    }
    return { ok: true, count, bytes };
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        let res;
        switch (msg.op) {
            case "put": res = await put(msg); break;
            case "get": res = await get(msg); break;
            case "del": res = await del(msg); break;
            case "has": res = await has(msg); break;
            case "list": res = await list(); break;
            case "stats": res = await stats(); break;
            default: throw new Error("unknown op: " + msg.op);
        }
        res.reqId = msg.reqId; // v160y26: эхо reqId — обёртка матчит запрос-ответ
        self.postMessage(res);
    } catch (err) {
        self.postMessage({ ok: false, id: msg && msg.id, reqId: msg && msg.reqId, err: String(err && err.message || err) });
    }
};
