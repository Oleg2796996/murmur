// pwa/render-attachments.js — Phase 3: client decrypt + render.
//
// Pipeline:
//   1. Fetch /api/blob/{blob_id} → ciphertext bytes
//   2. ECIES decrypt wrapped_key (own privkey via WASM) → AES key (32 bytes)
//   3. AES-256-GCM decrypt(ciphertext, iv) → plaintext file
//   4. URL.createObjectURL(blob) → render <img>/<video>/<audio>/<a download>
//
// Public API:
//   renderAttachment(att, containerEl) → Promise<HTMLElement>
//      att = { blob_id, wrapped_key, iv, mime, name, size }
//      Renders the attachment into containerEl, returns the media element.
//
//   revokeAttachment(blobUrl) → cleanup
//
// Anti-patterns avoided:
//   ❌ Inline data: URLs (Lesson #170) — use createObjectURL + revokeObjectURL
//   ❌ Decrypt outgoing for render (Lesson #155) — outgoing uses local object URL
//   ❌ WASM hang without timeout (Lesson #157) — Promise.race with timeout

const ATTACH_API_BASE = "https://murmur.senswifi.ru";

function b64decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// 1. Fetch blob ciphertext from server
async function fetchBlob(blobId) {
    const r = await fetch(`${ATTACH_API_BASE}/api/blob/${blobId}`, {
        method: "GET",
        credentials: "omit",
    });
    if (!r.ok) {
        throw new Error(`fetchBlob HTTP ${r.status}`);
    }
    const ab = await r.arrayBuffer();
    return new Uint8Array(ab);
}

// 2. ECIES unwrap AES key using recipient's own privkey via WASM.
// window.decryptEnvelope (from app.js) handles the WASM call and unwraps the
// {ok, data} envelope, returning base64 plaintext string.
async function eciesUnwrapKey(wrappedKeyB64) {
    const unwrapped = await window.decryptEnvelope(wrappedKeyB64);
    if (typeof unwrapped !== "string" || !unwrapped.length) {
        throw new Error("ECIES unwrap failed: empty result");
    }
    return b64decode(unwrapped); // 32 bytes AES key
}

// 3. AES-256-GCM decrypt(ciphertext, key, iv) → plaintext bytes
async function aesDecrypt({ ciphertext, key, iv }) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
    );
    const plainBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        cryptoKey,
        ciphertext
    );
    return new Uint8Array(plainBuf);
}

// Promise.race helper — never hang on WASM
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)
        ),
    ]);
}

// 4. Main: decrypt + render
async function renderAttachment(att, containerEl) {
    if (!att || !att.blob_id || !att.wrapped_key || !att.iv) {
        const err = document.createElement("div");
        err.className = "attach-error";
        err.textContent = "⚠️ attachment incomplete";
        containerEl.appendChild(err);
        return err;
    }

    const placeholder = document.createElement("div");
    placeholder.className = "attach-decrypting";
    placeholder.textContent = "🔓 расшифровка…";
    containerEl.appendChild(placeholder);

    let blobUrl = null;
    try {
        // a. Fetch ciphertext
        const ct = await withTimeout(fetchBlob(att.blob_id), 30000, "fetchBlob");
        // b. Unwrap AES key (ECIES)
        const key = await withTimeout(eciesUnwrapKey(att.wrapped_key), 15000, "eciesUnwrap");
        // c. Decrypt
        const iv = b64decode(att.iv);
        const plain = await aesDecrypt({ ciphertext: ct, key, iv });
        // d. Blob + URL
        const mime = att.mime || "application/octet-stream";
        const blob = new Blob([plain], { type: mime });
        blobUrl = URL.createObjectURL(blob);
        // e. Render based on mime
        const el = renderByMime({ mime, name: att.name, blobUrl, size: plain.length });
        placeholder.replaceWith(el);
        return el;
    } catch (err) {
        placeholder.textContent = `⚠️ ${err.message || "decrypt failed"}`;
        placeholder.className = "attach-error";
        return placeholder;
    }
    // Note: blobUrl lifetime is tied to the rendered element. Caller can
    // revoke when element is removed from DOM (e.g., message deletion).
}

function renderByMime({ mime, name, blobUrl, size }) {
    const figure = document.createElement("figure");
    figure.className = "attach-figure";
    if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = blobUrl;
        img.alt = name || "image";
        img.loading = "lazy";
        img.className = "attach-image";
        img.onclick = () => openFullscreen(blobUrl, mime);
        figure.appendChild(img);
    } else if (mime.startsWith("video/")) {
        const v = document.createElement("video");
        v.src = blobUrl;
        v.controls = true;
        v.preload = "metadata";
        v.className = "attach-video";
        figure.appendChild(v);
    } else if (mime.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = blobUrl;
        a.controls = true;
        a.preload = "metadata";
        a.className = "attach-audio";
        figure.appendChild(a);
    } else {
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = name || "file";
        link.className = "attach-file";
        link.textContent = `📎 ${name || "file"} (${formatSize(size)})`;
        figure.appendChild(link);
    }
    if (name && mime.startsWith("image/")) {
        const cap = document.createElement("figcaption");
        cap.textContent = name;
        figure.appendChild(cap);
    }
    return figure;
}

function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Fullscreen lightbox for images
function openFullscreen(blobUrl, mime) {
    const overlay = document.createElement("div");
    overlay.className = "fullscreen-overlay";
    overlay.onclick = () => {
        overlay.remove();
        URL.revokeObjectURL(blobUrl);
    };
    const img = document.createElement("img");
    img.src = blobUrl;
    img.className = "fullscreen-image";
    overlay.appendChild(img);
    document.body.appendChild(overlay);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderAttachment };
}
window.MurmurRenderAttachments = { renderAttachment };