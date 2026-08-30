// pwa/attachments.js — Variant Б: client-side encryption + separate upload.
//
// Pipeline:
//   1. file → AES-256-GCM(key, iv=random12) → ciphertext+tag
//   2. sha256(ciphertext) integrity check
//   3. key wrap: ECIES(npub_peer, key_b64) → wrapped_key (base64)
//   4. POST /api/upload?sha256=...&mime=...&name=...&size=...&wrapped_key=...
//      body: ciphertext
//   5. Returns blob_id
//
// Public API:
//   attachEncryptAndUpload({ file, peerNpub, onProgress }) → Promise<{ blob_id, sha256, size, mime, wrapped_key, name }>
//
// Anti-patterns avoided (per agency-agents feedback):
//   ❌ Inline base64 in envelope (Lesson #165)
//   ❌ localStorage for blob (Lesson #167) — blob never stored locally, only blob_id
//   ❌ Encrypt own outgoing for render (Lesson #155) — outgoing rendered from local object URL
//   ❌ HEIC — filtered in file picker (Lesson #169)
//   ❌ Inline data: URLs for render (Lesson #170) — uses createObjectURL after decrypt

const ATTACH_API_BASE = "https://murmur.senswifi.ru";

function b64encode(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}

function b64decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64UrlSafe(b) {
    return b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 1. SHA-256 of ArrayBuffer (for upload integrity check)
async function sha256Hex(buf) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// 1.5. compressImageIfLarge (Lesson #327, Олег 2026-08-28 12:15 MSK)
// Сжимает фото > 1MB через canvas до 1024px JPEG q=0.7.
// Типично: 4MB HEIC-like JPEG → 300-500KB. Уменьшает upload в 8-10x
// и значительно ускоряет ECIES encrypt (CPU bound на bytes).
// Не сжимает: PNG с прозрачностью (потеряем alpha), видео, аудио, уже мелкие файлы.
async function compressImageIfLarge(file) {
    if (!file || !file.type) return file;
    if (!file.type.startsWith("image/")) return file;
    if (file.type === "image/png" || file.type === "image/gif") return file; // сохраняем alpha
    if (file.size <= 1 * 1024 * 1024) return file; // <= 1MB не трогаем
    if (typeof createImageBitmap === "undefined" && typeof document === "undefined") return file;
    try {
        const ab = await file.arrayBuffer();
        let bitmap;
        if (typeof createImageBitmap !== "undefined") {
            bitmap = await createImageBitmap(new Blob([ab], { type: file.type }));
        } else {
            // Fallback: img.decode()
            const blob = new Blob([ab], { type: file.type });
            const url = URL.createObjectURL(blob);
            const im = new Image();
            await new Promise((resolve, reject) => {
                im.onload = resolve;
                im.onerror = reject;
                im.src = url;
            });
            bitmap = im;
            URL.revokeObjectURL(url);
        }
        const MAX_DIM = 1024;
        let w = bitmap.width || bitmap.naturalWidth;
        let h = bitmap.height || bitmap.naturalHeight;
        if (w > MAX_DIM || h > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        // dataUrl → Blob
        const b64 = dataUrl.split(",")[1];
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        const compressedBlob = new Blob([out], { type: "image/jpeg" });
        // Если сжатие не помогло (было уже оптимально) — возвращаем оригинал.
        if (compressedBlob.size >= file.size) {
            return file;
        }
        console.log("[attach-compress]", file.name, file.size, "→", compressedBlob.size,
            "(" + Math.round(compressedBlob.size / file.size * 100) + "%)");
        // Возвращаем File (чтобы сохранить .name)
        return new File([compressedBlob], file.name.replace(/\.[^.]+$/, ".jpg"), {
            type: "image/jpeg",
            lastModified: file.lastModified || Date.now(),
        });
    } catch (e) {
        console.warn("[attach-compress] failed, using original:", e);
        return file;
    }
}

// 2. AES-256-GCM encrypt → returns {ciphertext, iv, key} (all Uint8Array, key=32B, iv=12B)
async function aesEncrypt(plaintext) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
    );
    const ctBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        cryptoKey,
        plaintext
    );
    return { ciphertext: new Uint8Array(ctBuf), iv, key };
}

// 3. ECIES wrap key via WASM (murmur_id_wasm).
// Note: window.encryptForRecipient (from app.js) returns the wrapped-key
// base64 string directly, NOT a {ok, data} envelope.
async function eciesWrapKey(recipientNpub, key) {
    const wrapped = await window.encryptForRecipient(recipientNpub, b64encode(key));
    if (typeof wrapped !== "string" || !wrapped.length) {
        throw new Error("ECIES wrap failed: empty result");
    }
    return wrapped;
}

// 4. POST /api/upload with binary body + query params.
// Uses XHR (not fetch) to get upload progress events.
function uploadCiphertext({ sha256Hex, mime, name, size, wrappedKey, ciphertext, onProgress }) {
    return new Promise((resolve, reject) => {
        const url = new URL(ATTACH_API_BASE + "/api/upload");
        url.searchParams.set("sha256", sha256Hex);
        url.searchParams.set("mime", mime || "application/octet-stream");
        url.searchParams.set("name", name);
        url.searchParams.set("size", String(size));
        url.searchParams.set("wrapped_key", wrappedKey);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", url.toString());
        xhr.responseType = "json";
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded, e.total);
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 201) {
                resolve(xhr.response);
            } else {
                const errMsg = xhr.response?.error || `HTTP ${xhr.status}`;
                reject(new Error("Upload failed: " + errMsg));
            }
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.ontimeout = () => reject(new Error("Upload timeout (60s)"));
        xhr.timeout = 60000;
        // Send ciphertext as binary.
        xhr.send(ciphertext);
    });
}

// Public API: encrypt + wrap + upload one file.
// Returns: { blob_id, sha256, mime, size, name, wrapped_key }
//
// On failure, throws. Caller decides UX (toast / retry / abort).
async function attachEncryptAndUpload({ file, peerNpub, onProgress }) {
    // a. Compress if large image (Lesson #327 — speed)
    const compressedFile = await compressImageIfLarge(file);
    // b. Read file as ArrayBuffer
    const ab = await compressedFile.arrayBuffer();
    // b. SHA-256 (for integrity check before upload)
    const sha = await sha256Hex(ab);
    // c. AES-256-GCM encrypt
    const { ciphertext, key, iv } = await aesEncrypt(ab);
    // d. ECIES wrap key (recipient-bound)
    const wrappedKey = await eciesWrapKey(peerNpub, key);
    // e. Upload ciphertext + wrapped_key + meta
    // Note: server checks SHA-256 against uploaded body, so pass ciphertext's SHA.
    const ciphertextSha = await sha256Hex(ciphertext);
    const resp = await uploadCiphertext({
        sha256Hex: ciphertextSha,
        mime: compressedFile.type || "application/octet-stream",
        name: compressedFile.name,
        size: ciphertext.length,
        wrappedKey,
        ciphertext,
        onProgress,
    });
    // f. Return reference for envelope attachments_meta.
    // iv MUST be sent to recipient — AES-GCM requires it for decryption.
    // Without iv, recipient cannot decrypt the blob (this was a v1 bug —
    // Lesson #182 — fixed by including iv in attachments_meta).
    //
    // plaintext_b64 is for local outbox cache only — used to render outgoing
    // message without WASM decrypt round-trip (Lesson #155). NOT sent to server.
    return {
        blob_id: resp.blob_id,
        sha256: resp.sha256,
        mime: resp.mime,
        size: resp.size,
        name: file.name,
        wrapped_key: wrappedKey, // for recipient to unwrap with own privkey
        iv: b64encode(iv), // base64 — recipient decodes to 12-byte IV
        plaintext_b64: b64encode(new Uint8Array(ab)), // local cache for outgoing render
    };
}

// Export for ES module use, and global fallback for service-worker.
if (typeof module !== "undefined" && module.exports) {
    module.exports = { attachEncryptAndUpload };
}
window.MurmurAttachments = { attachEncryptAndUpload };
