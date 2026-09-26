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

// v160y24: НЕ хардкод — RELAY из app.js (single source of truth), см. attachments.js.
const ATTACH_API_BASE = (typeof RELAY !== "undefined" && RELAY) ? RELAY : "https://murmur.senswifi.ru";

function b64decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// 1. Fetch blob ciphertext from server (v160p Phase 2: bearer token required —
// att.blob_token arrives inside sealed envelope; server verifies SHA-256 hash).
async function fetchBlob(blobId, abortSignal, blobToken) {
    const tqs = blobToken ? `?t=${encodeURIComponent(blobToken)}` : "";
    const r = await fetch(`${ATTACH_API_BASE}/api/blob/${blobId}${tqs}`, {
        method: "GET",
        credentials: "omit",
        // Lesson #210 (Олег 2026-08-26 13:38): pass abort signal to fetch so a
        // newer renderMessages call can cancel our inflight ciphertext download.
        signal: abortSignal || undefined,
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
async function eciesUnwrapKey(wrappedKeyB64, opts) {
    // Lesson #349: wrapped_key может быть (а) чистый base64 sealed (legacy v146 и
    // ранее), (б) base64(JSON {r:<sealed для получателя>, s:<sealed для себя>}).
    // opts.self=true (рендер ИСХОДЯЩИХ) → берём s; иначе (входящие) → r.
    // JSON-парс всегда: incoming тоже получает двойной формат от v147+ клиентов.
    let target = wrappedKeyB64;
    try {
        const bin = atob(wrappedKeyB64);
        const json = new TextDecoder().decode(new Uint8Array(bin.split("").map(c => c.charCodeAt(0))));
        if (json.charAt(0) === "{") {
            const parsed = JSON.parse(json);
            const pick = (opts && opts.self) ? (parsed.s || parsed.r) : (parsed.r || parsed.s);
            if (pick) target = pick;
        }
    } catch (_e) { /* legacy чистый sealed — используем как есть */ }
    const unwrapped = await window.decryptEnvelope(target);
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

// v160y26: ArrayBuffer из Uint8Array без copy (structured-clone безопасно).
function plainBytesToAb(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// v160y26 (этап 3): POST /api/blob/receipt/{blob_id}?t=<token> — квитанция
// «blob скачан». Сервер удаляет серверную копию сразу после квитанции
// (потолок 24ч остаётся для «никогда не забрали»). Ответ: {ok, deleted}.
async function sendBlobReceipt(blobId, blobToken) {
    const tqs = blobToken ? `?t=${encodeURIComponent(blobToken)}` : "";
    const r = await fetch(`${ATTACH_API_BASE}/api/blob/receipt/${blobId}${tqs}`, {
        method: "POST",
        credentials: "omit",
    });
    if (!r.ok) {
        throw new Error(`blob receipt HTTP ${r.status}`);
    }
    const j = await r.json();
    console.log("[attach-opfs] receipt ok, deleted:", j.deleted);
    return j;
}

// 4. Main: decrypt + render
async function renderAttachment(att, containerEl, abortSignal) {
    if (!att || !att.blob_id || !att.wrapped_key || !att.iv) {
        const err = document.createElement("div");
        err.className = "attach-error";
        err.textContent = "⚠️ attachment incomplete";
        containerEl.appendChild(err);
        return err;
    }

    const placeholder = document.createElement("div");
    placeholder.className = "attach-decrypting";
    // v160ka: для больших файлов показываем размер — юзер понимает что это fetch,
    // не зависший decrypt.
    const _fmt = (n) => n < 1024 ? n + " B" : (n < 1024*1024*1024 ? (n/(1024*1024)).toFixed(1) + " MB" : (n/(1024*1024*1024)).toFixed(2) + " GB");
    const _sz = att._plainSize || att.size || 0;
    const _szTxt = _sz > 1024*1024 ? " (" + _fmt(_sz) + ")" : "";
    placeholder.textContent = "🔓 расшифровка…" + _szTxt;
    containerEl.appendChild(placeholder);

    // Lesson #318 (Олег 2026-08-28 06:42 MSK): 12s safety net — если placeholder
    // висит дольше 12s (fetch + decrypt через CF tunnel), заменить на
    // "retry" вместо зависшего "🔓 расшифровка…". Это не убивает основной
    // renderAttachment (тот продолжает до 45s+15s), но юзер видит retry.
    // v160ka (Олег 2026-09-03 20:50 «файлы под 35 мб плохо ходят»: скрин
    // «расшифровка идёт долго… ↻ повторить» на 35.2 MB видео). 12s safety net
    // fires MID-download на больших файлах → юзер видет «повторить», хотя
    // decrypt жив и прогресс идёт. Safety net теперь proportional to size:
    //   <1MB  → 12s (было), 1–5MB → 30s, >5MB → 60s (fetch 45s + decrypt).
    const _sizeBytes = att._plainSize || att.size || 0;
    const safetyMs = _sizeBytes > 5*1024*1024 ? 60000 : (_sizeBytes > 1024*1024 ? 30000 : 12000);
    const safetyNetId = setTimeout(() => {
        if (!placeholder.isConnected) return; // уже заменили — ок
        if (placeholder.parentNode) {
            const errEl = document.createElement("div");
            errEl.className = "attach-error";
            errEl.innerHTML = `🔒 расшифровка идёт долго…<br><button class="link-btn" style="margin-top:6px;font-size:0.85em">↻ повторить</button>`;
            placeholder.replaceWith(errEl);
            errEl.querySelector("button").addEventListener("click", async () => {
                errEl.remove();
                const cache = window.MurmurBlobCache;
                if (cache && cache.isAvailable && cache.isAvailable()) {
                    await cache.del(att.blob_id).catch(() => {});
                }
                if (typeof window.__retryAttachment === "function") {
                    window.__retryAttachment(att, containerEl, abortSignal);
                } else {
                    // Fallback: recursive call (свежий placeholder)
                    try {
                        await renderAttachment(att, containerEl, abortSignal);
                    } catch (e) { /* ignore */ }
                }
            });
        }
    }, safetyMs);

    let blobUrl = null;
    try {
        // Lesson #210 (Олег 2026-08-26 13:38): AbortSignal support — abortable fetch
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }

        // v160y40 (Олег 21:06 «идею с консервацией оставляем — так гораздо
        // шустрее работает»): OPFS-plaintext ПЕРВЫЙ слой (не фолбэк). Гарантия:
        // OPFS — файл на диске, переживает evict WebKit; IDB-блоб — backing
        // эвиктится в standalone PWA (WebKit), метадата может остаться честной
        // (size > 0) → валидация по size пропускает битый блоб → VERR code=4.
        // Плюс шустрее: render сразу из OPFS без IDB-roundtrip и decrypt.
        try {
            if (window.MurmurBlobOPFS && typeof window.MurmurBlobOPFS.isAvailable === "function" && window.MurmurBlobOPFS.isAvailable()) {
                const opfsPlainFirst = await window.MurmurBlobOPFS.get("attp-" + att.blob_id);
                if (opfsPlainFirst && opfsPlainFirst.ok && opfsPlainFirst.buf) {
                    const mime = att._plainMime || att.mime || "application/octet-stream";
                    const blob = new Blob([opfsPlainFirst.buf], { type: mime });
                    blobUrl = URL.createObjectURL(blob);
                    const displayName = att._plainName || att.name;
                    const el = renderByMime({ mime, name: displayName, blobUrl, size: blob.size, poster: att._plainPoster || att.poster_data_url || posterFromCache(att.blob_id) || null, att });
                    placeholder.replaceWith(el);
                    clearTimeout(safetyNetId);
                    console.log("[attach-opfs] PLAINTEXT FIRST", att.blob_id.slice(0, 8), "size=", blob.size);
                    return el;
                }
            }
        } catch (e) { console.warn("[attach-opfs] first-layer failed:", e); }

        // Lesson #211 (Олег 2026-08-26 14:14): CACHE-FIRST lookup.
        // Если blob уже расшифрован и сохранён в IndexedDB — просто показываем.
        // Иначе fetch + decrypt + save в cache.
        const cache = window.MurmurBlobCache;
        if (cache && cache.isAvailable && cache.isAvailable()) {
            const _attSize = Number(att.size || 0);
            let cachedBlob = await cache.get(att.blob_id);
            const _attSizeExp = Number(att.size || 0);
            if (cachedBlob && (cachedBlob.size === 0 || (_attSizeExp > 1024 && Math.abs(cachedBlob.size - _attSizeExp) > _attSizeExp * 0.05))) {
                console.warn("[attach-cache] DEAD blob (size=", cachedBlob.size, "expected=", _attSizeExp, ") → treat as MISS", att.blob_id.slice(0, 8));
                try { if (cache && cache.del) await cache.del(att.blob_id); } catch (e) {}
                cachedBlob = null;
            }
            if (cachedBlob) {
                if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
                blobUrl = URL.createObjectURL(cachedBlob);
                // Privacy v154: real filename from decrypted ct (merged by app.js),
                // neutral f-…bin otherwise.
                const displayName = att._plainName || att.name;
                const mime = att._plainMime || att.mime || cachedBlob.type || "application/octet-stream";
                const el = renderByMime({ mime, name: displayName, blobUrl, size: cachedBlob.size, poster: att._plainPoster || att.poster_data_url || posterFromCache(att.blob_id) || null, att });
                placeholder.replaceWith(el);
                clearTimeout(safetyNetId); // Lesson #319: safety net отработал — снимаем
                console.log("[attach-cache] HIT", att.blob_id.slice(0, 8), "size=", cachedBlob.size);
                return el;
            }
            console.log("[attach-cache] MISS", att.blob_id.slice(0, 8));
        }

        // v160y37 (Олег 2026-09-24 «после перезахода в pwa ни превью, ни
        // проигрывания»): IDB cache может быть пуст (evict при 50MB / put
        // не дошёл), а серверная копия УЖЕ удалена квитанцией (sendBlobReceipt
        // после OPFS-сохранения) → fetch 404 → навсегда chip. OPFS хранит
        // plaintext ("attp-") и ciphertext ("att-") — рендерим из OPFS без сети.
        try {
            if (window.MurmurBlobOPFS && typeof window.MurmurBlobOPFS.isAvailable === "function" && window.MurmurBlobOPFS.isAvailable()) {
                const opfsPlain = await window.MurmurBlobOPFS.get("attp-" + att.blob_id);
                if (opfsPlain && opfsPlain.ok && opfsPlain.buf) {
                    const mime = att._plainMime || att.mime || "application/octet-stream";
                    const blob = new Blob([opfsPlain.buf], { type: mime });
                    blobUrl = URL.createObjectURL(blob);
                    const displayName = att._plainName || att.name;
                    const el = renderByMime({ mime, name: displayName, blobUrl, size: blob.size, poster: att._plainPoster || att.poster_data_url || posterFromCache(att.blob_id) || null, att });
                    placeholder.replaceWith(el);
                    clearTimeout(safetyNetId);
                    console.log("[attach-opfs] PLAINTEXT HIT", att.blob_id.slice(0, 8));
                    return el;
                }
                const opfsCt = await window.MurmurBlobOPFS.get("att-" + att.blob_id);
                if (opfsCt && opfsCt.ok && opfsCt.buf) {
                    const key = await withTimeout(eciesUnwrapKey(att.wrapped_key, { self: !!(att && att._selfKey) }), 15000, "eciesUnwrap");
                    const iv = b64decode(att.iv);
                    const plain = await aesDecrypt({ ciphertext: new Uint8Array(opfsCt.buf), key, iv });
                    const mime = att._plainMime || att.mime || "application/octet-stream";
                    const blob = new Blob([plain], { type: mime });
                    if (cache && cache.isAvailable && cache.isAvailable()) cache.put(att.blob_id, blob, mime).catch(() => {});
                    blobUrl = URL.createObjectURL(blob);
                    const displayName = att._plainName || att.name;
                    const el = renderByMime({ mime, name: displayName, blobUrl, size: plain.length, poster: att._plainPoster || att.poster_data_url || posterFromCache(att.blob_id) || null, att });
                    placeholder.replaceWith(el);
                    clearTimeout(safetyNetId);
                    console.log("[attach-opfs] CT HIT + decrypt", att.blob_id.slice(0, 8));
                    return el;
                }
            }
        } catch (e) { console.warn("[attach-opfs] fallback failed:", e); }

        // Lesson #237 (Олег 2026-08-26 21:42 MSK): 45s для blob fetch (было 30s).
        // CF tunnel cold-start на медленном инете может быть 30-40s.
        // Плюс — уже cache HIT выше (строка 95-105), если blob в IndexedDB,
        // fetch не вызывается ВООБЩЕ. Это решает "3+ фото + reload не видны".
        // v160ka: 45s hard cap fails mid-download на 35MB через CF tunnel.
        // >5MB → 90s fetch window.
        const fetchMs = _sz > 5*1024*1024 ? 90000 : 45000;
        const ct = await withTimeout(fetchBlob(att.blob_id, abortSignal, att.blob_token), fetchMs, "fetchBlob");
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
        // a2. v160y26 (Олег 2026-09-23 16:20): OPFS-сохранение СРАЗУ после fetch
        // (этап 2 плана «вложения = текст»). SHA-256 checksum в worker — битая
        // запись детектится. После успешной put шлём квитанцию «blob скачан» →
        // сервер удаляет серверную копию (этап 3). Fire-and-forget: не блокирует
        // рендер. OPFS.put принимает ArrayBuffer; конверт внутри sealed ct.
        try {
            if (window.MurmurBlobOPFS && ct.length) {
                window.MurmurBlobOPFS.put("att-" + att.blob_id, plainBytesToAb(ct), "application/octet-stream")
                    .then((r) => {
                        if (r && r.ok && r.sha256) {
                            console.log("[attach-opfs] saved + verified", att.blob_id.slice(0, 8));
                            // Квитанция скачивания — только после подтверждённой записи.
                            return sendBlobReceipt(att.blob_id, att.blob_token);
                        }
                    })
                    .catch((e) => console.warn("[attach-opfs] save/receipt failed (blob живёт до 24ч, не критично):", e));
            }
        } catch (e) { console.warn("[attach-opfs] setup failed:", e); }
        // b. Unwrap AES key (ECIES)
        const key = await withTimeout(eciesUnwrapKey(att.wrapped_key, { self: !!(att && att._selfKey) }), 15000, "eciesUnwrap");
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
        // c. Decrypt
        const iv = b64decode(att.iv);
        const plain = await aesDecrypt({ ciphertext: ct, key, iv });
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
        // d. Blob + URL
        const mime = att._plainMime || att.mime || "application/octet-stream";
        const blob = new Blob([plain], { type: mime });
        // Lesson #211: save to cache for next render (fire-and-forget)
        // v160p: входящие мелкие файлы (<1.5MB) — plaintext в blob-cache, рендер
        // после reload мгновенный, без fetch+decrypt (Олег 2026-09-02).
        if (window.MurmurPosterCache) { /* poster cache marker */ }
        if (cache && cache.isAvailable && cache.isAvailable()) {
            cache.put(att.blob_id, blob, mime).catch(e => console.warn("[attach-cache] put failed", e));
        }
        // v160y37: plaintext OPFS-копия — рендер после перезахода без
        // fetch/decrypt, даже если IDB cache evicted и серверная копия
        // удалена квитанцией. put fire-and-forget.
        try {
            if (window.MurmurBlobOPFS && plain.length) {
                window.MurmurBlobOPFS.put("attp-" + att.blob_id, plainBytesToAb(plain), mime).catch(() => {});
            }
        } catch (e) {}
        blobUrl = URL.createObjectURL(blob);
        // e. Render based on mime
        const el = renderByMime({ mime, name: att._plainName || att.name, blobUrl, size: plain.length, poster: att._plainPoster || att.poster_data_url || posterFromCache(att.blob_id) || null, att });
        placeholder.replaceWith(el);
        clearTimeout(safetyNetId); // Lesson #319: safety net отработал — снимаем
        return el;
    } catch (err) {
        // Lesson #210: not a real error if we were aborted (normal cleanup).
        if (abortSignal && abortSignal.aborted) {
            clearTimeout(safetyNetId);
            placeholder.remove();
            return null;
        }
        // Lesson #244 (Олег 2026-08-26 22:46): retry button + clearer error message.
        // Oleg: 'тут тоже первые фото после обновления перестали отображаться'.
        // Если blob fetch или decrypt упал — пользователь должен иметь возможность
        // повторить, не дожидаясь полного reload.
        const errEl = document.createElement("div");
        errEl.className = "attach-error";
        const errMsg = err.message || "не удалось расшифровать";
        errEl.innerHTML = `🔒 ${errMsg}<br><button class="link-btn" style="margin-top:6px;font-size:0.85em">↻ повторить</button>`;
        placeholder.replaceWith(errEl);
        clearTimeout(safetyNetId); // Lesson #319: safety net отработал — снимаем
        // Retry handler: clear cache (in case stale), re-run renderAttachment.
        errEl.querySelector("button").addEventListener("click", async () => {
            errEl.remove();
            const cache = window.MurmurBlobCache;
            if (cache && cache.isAvailable && cache.isAvailable()) {
                await cache.delete(att.blob_id).catch(() => {});
            }
            // Re-render — renderMessages calls renderAttachment again.
            // We need to find the bubble and trigger re-render.
            if (typeof window.__retryAttachment === "function") {
                window.__retryAttachment(att, containerEl, abortSignal);
            } else {
                // Fallback: clear placeholder, call recursively with fresh
                const freshPlaceholder = document.createElement("div");
                freshPlaceholder.className = "attach-decrypting";
                freshPlaceholder.textContent = "🔓 расшифровка…";
                containerEl.appendChild(freshPlaceholder);
                try {
                    await renderAttachment(att, containerEl, abortSignal);
                } catch (e) { /* ignore */ }
            }
        });
        return errEl;
    }
    // Note: blobUrl lifetime is tied to the rendered element. Caller can
    // revoke when element is removed from DOM (e.g., message deletion).
}

function renderByMime({ mime, name, blobUrl, size, poster, att }) {
    const figure = document.createElement("figure");
    figure.className = "attach-figure";
    // v160k9d: friendly name для ВСЕХ веток (не только файлов). Если real name
    // (_plainName) не доехал после reload, f-xxx.bin → f-xxx.jpg/pdf по mime.
    const displayName = deriveFriendlyName(name, mime);
    if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = blobUrl;
        img.alt = displayName || "image";
        img.loading = "lazy";
        img.className = "attach-image";
        img.onclick = (ev) => {
            // v160y27 (Олег 19:31 «тап по фото → потом reply-бар»): тап по фото =
            // ТОЛЬКО fullscreen. stopPropagation — событие не доходит до
            // messages-area слушателя, reply-бар не появляется. Reply на фото —
            // долгим нажатием (wireLongPressReply).
            ev.stopPropagation();
            ev.preventDefault();
            openFullscreen(blobUrl, mime);
        };
        // v160p7 diag + v160p9 FIX (Олег 20:40 «на маке опять мелки превью»):
        // bubble (fit-content) схлопывается по ширине подписи до load img,
        // max-width:100% зажимает img в эту ширину навсегда. Фикс: явная
        // width из natural-размера (height CSS-capped 280px) — bubble растянется.
        img.addEventListener("load", () => {
            console.log("[attach-img] loaded", att && att.blob_id ? att.blob_id.slice(0, 8) : "?",
                "natural=", img.naturalWidth + "x" + img.naturalHeight,
                "rendered=", img.clientWidth + "x" + img.clientHeight,
                "blobSize=", size);
            const nw = img.naturalWidth, nh = img.naturalHeight;
            if (nw && nh) {
                let w = nw;
                if (nh > 280) w = Math.round(nw * 280 / nh);
                img.style.width = w + "px";
            }
            // v160y51: высота картинки изменилась после первого скролла — доводим
            // низ, если до роста были на нём (pin-bottom, app.js).
            try { if (window.__murmurPinBottom) window.__murmurPinBottom(); } catch (e) {}
        });
        // Lesson #225 (Олег 2026-08-26 16:05): register img element → blob URL
        // для MutationObserver auto-revoke на detach.
        if (window.__murmurBlobOwners) {
            window.__murmurBlobOwners.set(img, blobUrl);
        }
        figure.appendChild(img);
    } else if (mime.startsWith("video/")) {
        // v160 (Олег 2026-09-01): превью-кадр + play-кнопка вместо чёрного
        // <video controls> (iOS не показывает первый кадр при preload=metadata).
        // Тап по превью → полноэкранный плеер с контролами.
        // v160b: iOS Safari не рисует кадр с blob-URL (игнорирует preload=metadata
        // и #t=0.1) → canvas-фоллбек: рисуем кадр сами через drawImage(video).
        const wrap = document.createElement("div");
        wrap.className = "video-preview";
        const thumb = document.createElement("video");
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = "metadata";
        thumb.className = "video-thumb";
        thumb.src = blobUrl + "#t=0.1";
        // v160d: постер-кадр от отправителя (работает на iOS без декодирования).
        if (poster) thumb.poster = poster;
        const playBtn = document.createElement("div");
        playBtn.className = "video-play-btn";
        playBtn.textContent = "▶";
        wrap.appendChild(thumb);
        wrap.appendChild(playBtn);
        // v160y34: fallback-чип «🎥 видео» если за 3.5с ни постера, ни кадра
        // (вместо пустого чёрного квадрата). rVFC (murmurSetupVideoPreview)
        // снимает чип video-frame-ready когда кадр показан.
        setTimeout(() => {
            if (!wrap.classList.contains("video-frame-ready") && !thumb.poster) {
                wrap.classList.add("video-fallback-chip");
            }
        }, 3500);
        wrap.onclick = (ev) => {
            // v160y27: тап по видео = только fullscreen (reply долгим нажатием).
            ev.stopPropagation();
            ev.preventDefault();
            openVideoFullscreen(blobUrl, mime, displayName, att);
        };
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(thumb, blobUrl);
        figure.appendChild(wrap);
        // v160c: общий сетап превью — реализация в window.murmurSetupVideoPreview
        // (ниже в этом файле). Чинит регресс v160b: video+canvas оба absolute
        // → wrap схлопывался в 0 высоты (на маке «показался и пропал»).
        if (window.murmurSetupVideoPreview) window.murmurSetupVideoPreview(wrap, thumb, blobUrl);
        // v160y38-diag: честная диагностика видео на телефоне (?diag=1 / #diag).
        try {
            if (location.search.indexOf("diag=1") >= 0 || location.hash.indexOf("diag") >= 0) {
                const dg = document.createElement("div");
                dg.style.cssText = "position:absolute;left:2px;top:2px;z-index:5;background:rgba(0,0,0,.75);color:#4f4;font:9px/1.3 monospace;padding:3px 5px;border-radius:4px;pointer-events:none;white-space:pre;";
                const src2 = blobUrl.startsWith("blob:") ? "blob-url" : blobUrl.slice(0, 24);
                dg.textContent = "att=" + (att && att.blob_id ? att.blob_id.slice(0, 8) : "?") + "\nsrc=" + src2 + "\nmime=" + mime + "\nsize=" + (blob.size || _sizeBytes) + "\nselfKey=" + !!(att && att._selfKey);
                wrap.appendChild(dg);
                thumb.addEventListener("playing", () => { dg.textContent += "\nPLAYING"; }, { once: true });
                thumb.addEventListener("error", () => { dg.textContent += "\nVERROR"; }, { once: true });
                thumb.addEventListener("stalled", () => { dg.textContent += "\nSTALLED"; }, { once: true });
            }
        } catch (e) {}
    } else if (mime.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = blobUrl;
        a.controls = true;
        a.preload = "metadata";
        a.className = "attach-audio";
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(a, blobUrl);
        figure.appendChild(a);
    } else {
        const link = document.createElement("a");
        link.href = blobUrl;
        // Privacy v156 (Олег «PDF приходят как *.bin»): если real name из
        // расшифрованного ct не доехал (_plainName отсутствует — например,
        // decrypt тела не удался), а нейтральное имя — f-…bin, выводим
        // человекочитаемое имя с расширением из mime — иначе файл не
        // открывается по клику. Если real name есть — он приоритетен.
        const dlName = deriveFriendlyName(name, mime);
        link.download = dlName;
        link.className = "attach-file";
        link.textContent = `📎 ${dlName} (${formatSize(size)})`;
        figure.appendChild(link);
    }
    if (name && mime.startsWith("image/")) {
        const cap = document.createElement("figcaption");
        cap.textContent = displayName;
        figure.appendChild(cap);
    }
    return figure;
}

function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Privacy v156: если у чипа только нейтральное серверное имя (f-…bin),
// а mime известен — строим нейтральное, но ОТКРЫВАЕМОЕ имя (file.pdf,
// file.docx…). Real name из расшифровки не трогаем (приоритет у него).
function deriveFriendlyName(name, mime) {
    const n = name || "";
    const hasRealExt = n && !n.endsWith(".bin") && n.includes(".");
    if (hasRealExt || !mime || mime === "application/octet-stream") return n || "file";
    const extMap = {
        "application/pdf": "pdf",
        "text/plain": "txt",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "application/zip": "zip",
        "application/json": "json",
        "text/csv": "csv",
        "application/epub+zip": "epub",
        "application/rtf": "rtf",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif",
        "video/quicktime": "mov",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "audio/wav": "wav",
    };
    const ext = extMap[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
    const base = (n.replace(/\.bin$/i, "") || "file");
    return base + "." + ext;
}

// Fullscreen lightbox for images
// blob URL НЕ ревокается — он принадлежит аттачу в чате (auto-revoke
// через __murmurBlobOwners при удалении сообщения). Ревок здесь ломал
// исходящие превью после закрытия fullscreen (v160y22fix2).
function openFullscreen(blobUrl, mime) {
    const overlay = document.createElement("div");
    overlay.className = "fullscreen-overlay";
    overlay.onclick = () => {
        overlay.remove();
    };
    const img = document.createElement("img");
    img.src = blobUrl;
    img.className = "fullscreen-image";
    overlay.appendChild(img);
    document.body.appendChild(overlay);
}

// v160: полноэкранный видеоплеер (tap по превью в чате).
// blob URL НЕ ревокается — он принадлежит аттачу в чате (auto-revoke
// через __murmurBlobOwners при удалении сообщения).
function openVideoFullscreen(blobUrl, mime, name, att) {
    const overlay = document.createElement("div");
    overlay.className = "fullscreen-overlay";
    const v = document.createElement("video");
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.className = "fullscreen-video";
    v.src = blobUrl;
    // v160p self-healing: при ошибке src — fresh URL. v160y35 (Олег 2026-09-24
    // «бегунок внизу бежит, а на экране черный квадрат»): у岗位职责
    // «играет-но-кадра-нет» onerror НЕ стреляет (meta/звук декодируются,
    // video-трек нет) — нужен rVFC-watchdog: если играет, но кадр не доставлен
    // за ~4.5с → re-resolve ИЗ СЕРВЕРА (bypass кэша — suspect-блоб удаляется)
    // + повтор; вторая неудача подряд → error-чип «не декодируется» + retry.
    if (att && att.blob_id) {
        let reResolving = false;
        const reResolve = async (bypassCache) => {
            if (reResolve) return;
            reResolve = true;
            console.warn("[v160y35] fullscreen re-resolving, bypassCache=", bypassCache, att.blob_id.slice(0, 8));
            try {
                const cache = window.MurmurBlobCache;
                // v160y40: OPFS plaintext ПЕРВЫЙ (Олег: «консервацию оставляем —
                // шустрее работает») — надежнее IDB в WebKit standalone PWA.
                let blob = null;
                try {
                    if (window.MurmurBlobOPFS && typeof window.MurmurBlobOPFS.isAvailable === "function" && window.MurmurBlobOPFS.isAvailable()) {
                        const opfsPlain = await window.MurmurBlobOPFS.get("attp-" + att.blob_id);
                        if (opfsPlain && opfsPlain.ok && opfsPlain.buf) {
                            blob = new Blob([opfsPlain.buf], { type: att._plainMime || att.mime || "application/octet-stream" });
                        }
                    }
                } catch (e) {}
                if (!blob && !bypassCache && cache && cache.isAvailable && cache.isAvailable()) {
                    blob = await cache.get(att.blob_id);
                    // v160y39: WebKit-порча Blob-хендлов после рестарта PWA —
                    // мёртвый/битый блоб из кэша → re-resolve из OPFS/сети.
                    const _as = Number(att.size || 0);
                    if (blob && (blob.size === 0 || (_as > 1024 && Math.abs(blob.size - _as) > _as * 0.05))) {
                        console.warn("[v160y39] fullscreen cache blob DEAD (size=", blob.size, "expected=", _as, ") → bypass");
                        await cache.del(att.blob_id).catch(() => {});
                        blob = null;
                    }
                }
                if (!blob) {
                    const ct = await withTimeout(fetchBlob(att.blob_id, null, att.blob_token), 45000, "fetchBlob");
                    const key = await withTimeout(eciesUnwrapKey(att.wrapped_key, { self: !!att._selfKey }), 15000, "eciesUnwrap");
                    const iv = b64decode(att.iv);
                    const plain = await aesDecrypt({ ciphertext: ct, key, iv });
                    const mime2 = att._plainMime || att.mime || "application/octet-stream";
                    blob = new Blob([plain], { type: mime2 });
                    if (cache && cache.isAvailable && cache.isAvailable()) {
                        cache.put(att.blob_id, blob, mime2).catch(() => {});
                    }
                }
                v.src = URL.createObjectURL(blob);
                v.load();
                const p = v.play();
                if (p && p.catch) p.catch(() => {});
                console.log("[v160y35] fullscreen re-resolved OK");
            } catch (e) {
                console.warn("[v160y35] fullscreen re-resolve failed:", e);
                // v160y37: OPFS ciphertext-фолбэк (сервер 404 после квитанции).
                try {
                    if (window.MurmurBlobOPFS && typeof window.MurmurBlobOPFS.isAvailable === "function" && window.MurmurBlobOPFS.isAvailable()) {
                        const opfsCt = await window.MurmurBlobOPFS.get("att-" + att.blob_id);
                        if (opfsCt && opfsCt.ok && opfsCt.buf) {
                            const key = await withTimeout(eciesUnwrapKey(att.wrapped_key, { self: !!att._selfKey }), 15000, "eciesUnwrap");
                            const iv = b64decode(att.iv);
                            const plain = await aesDecrypt({ ciphertext: new Uint8Array(opfsCt.buf), key, iv });
                            const mime2 = att._plainMime || att.mime || "application/octet-stream";
                            v.src = URL.createObjectURL(new Blob([plain], { type: mime2 }));
                            v.load();
                            const p = v.play();
                            if (p && p.catch) p.catch(() => {});
                            return;
                        }
                    }
                } catch (e2) {}
                showFsError();
            } finally {
                setTimeout(() => { reResolve = false; }, 800);
            }
        };
        const showFsError = () => {
            try {
                if (overlay.querySelector(".fs-error-chip")) return;
                const chip = document.createElement("div");
                chip.className = "fs-error-chip";
                chip.innerHTML = `⚠️ видео не декодируется<br><button class="fs-error-retry">↻ повторить</button>`;
                overlay.appendChild(chip);
                chip.querySelector(".fs-error-retry").addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    chip.remove();
                    reResolve(true);
                });
            } catch (e) {}
        };
        v.onerror = () => reResolve(false);
        // v160y38-diag: статус fullscreen видео (?diag=1 / #diag)
        try {
            if (location.search.indexOf("diag=1") >= 0 || location.hash.indexOf("diag") >= 0) {
                const fd = document.createElement("div");
                fd.style.cssText = "position:fixed;left:4px;top:60px;z-index:99999;background:rgba(0,0,0,.8);color:#4f4;font:10px/1.4 monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;";
                fd.textContent = "FS src=" + String(v.src || "-").slice(0, 40);
                document.body.appendChild(fd);
                overlay.__fsDiag = fd;
                v.addEventListener("playing", () => { fd.textContent += "\nPLAYING t=" + v.currentTime.toFixed(1); }, { once: true });
                v.addEventListener("loadeddata", () => { fd.textContent += "\nLOADED"; }, { once: true });
                v.addEventListener("error", () => { fd.textContent += "\nVERR code=" + (v.error && v.error.code); }, { once: true });
                if (typeof v.requestVideoFrameCallback === "function") {
                    v.requestVideoFrameCallback(() => { fd.textContent += "\nRVFC-OK"; });
                }
            }
        } catch (e) {}
        // rVFC-watchdog: играет, но кадр не доставлен → suspect-блоб → bypass.
        let gotFrame = false;
        try {
            if (typeof v.requestVideoFrameCallback === "function") {
                v.requestVideoFrameCallback(() => { gotFrame = true; });
            }
        } catch (e) {}
        let wdFails = 0;
        const wd = setInterval(() => {
            try {
                if (!v.isConnected) { clearInterval(wd); return; }
                if (gotFrame) { clearInterval(wd); return; } // кадр доставлен — ок
                if (v.paused && v.currentTime === 0) return; // ещё не стартовал
                if (!v.paused && v.currentTime > 0) {
                    // играет, кадра нет — ретри-счёт; 2 прохода (~4.5с) → bypass
                    if (++wdFails >= 2) {
                        clearInterval(wd);
                        reResolve(true);
                    }
                }
            } catch (e) {}
        }, 2200);
        overlay.__fsWatchdog = wd; // для очистки при закрытии
    }
    overlay.appendChild(v);
    overlay.onclick = (e) => {
        if (e.target === overlay) { // клик по фону, не по контролам
            v.pause();
            try { if (overlay.__fsWatchdog) clearInterval(overlay.__fsWatchdog); } catch (err) {}
            if (overlay.__fsDiag) { try { overlay.__fsDiag.remove(); } catch (e2) {} }
            overlay.remove();
        }
    };
    document.body.appendChild(overlay);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderAttachment };
}
window.MurmurRenderAttachments = { renderAttachment };
window.openFullscreen = openFullscreen;
window.openVideoFullscreen = openVideoFullscreen;

// ═══════════════════════════════════════════════════════════════════
// v160c: общий сетап видео-превью (входящие + исходящие).
//
// Стратегия:
//   1. video остаётся В ПОТОКЕ (не absolute!) — wrap не схлопывается.
//   2. Высота обёртки: aspect-ratio по реальным пропорциям видео
//      (фиксирует размер до загрузки; при неизвестных пропорциях — 16/9).
//   3. Кадр: на маке/Android Safari/Chrome рисует видео сам. Для iOS
//      включаем muted-автопроигрывание — iOS показывает текущий кадр,
//      и НЕ рисуем canvas вовсе (v160b canvas-слой был причиной регресса).
//      iOS: видео остаётся играет (muted, loop, без контролов) — кадр живой.
//   4. requestVideoFrameCallback (Safari 15.4+) — надёжный сигнал «кадр
//      реально показан»; если он есть — вообще без таймеров.
//
// Урок v160b: НЕ вставлять под видео absolute-слои — выносит из потока.
// ═══════════════════════════════════════════════════════════════════
window.murmurSetupVideoPreview = function (wrap, thumb, blobUrl) {
    if (!wrap || !thumb) return;

    // 1. Гарантированная высота: фиксируем пропорции сразу.
    thumb.addEventListener("loadedmetadata", () => {
        const w = thumb.videoWidth || 16;
        const h = thumb.videoHeight || 9;
        if (w && h) wrap.style.aspectRatio = `${w} / ${h}`;
        // v160y51: реальные пропорции изменили высоту wrap после первого скролла —
        // доводим низ, если до роста были на нём (pin-bottom, app.js).
        try { if (window.__murmurPinBottom) window.__murmurPinBottom(); } catch (e) {}
    });
    // До загрузки — дефолт 16/9, чтобы было куда рисовать кадр.
    if (!wrap.style.aspectRatio) wrap.style.aspectRatio = "16 / 9";

    // 2. Динамическое превью (Олег 2026-09-24 «несколько первых секунд видео»):
    //    muted/loop автоплей ВСЕГДА — юзер видит живой кадр вместо статичного
    //    постера (и вместо чёрного квадрата, когда постер не доехал). iOS
    //    разрешает muted-автопроигрывание без жеста (Lesson v160c). CPU-цена
    //    ограничена: ПАУЗА через IntersectionObserver — видео играет только
    //    когда превью видно на экране (не в скролле за пределами вьюпорта).
    thumb.loop = true;
    let playBlocked = false; // v160y36: play() отклонён (iOS Low Power Mode)
    const tryPlay = () => {
        const p = thumb.play();
        if (p && p.catch) p.catch(() => { playBlocked = true; });
    };
    thumb.addEventListener("canplay", tryPlay, { once: true });
    setTimeout(tryPlay, 800); // страховка: canplay может не прийти на iOS
    // Пауза/плей по видимости (CPU/батарея: не декодируем за экраном).
    // v160y44: координатор — одно видимое превью играет, остальные на паузе
    // (несколько живых превью дерутся за декодер iOS → другие глючат/чернеют).
    window.__vpRegistry = window.__vpRegistry || [];
    window.__vpRegistry.push({ thumb, wrap });
    let vis = null;
    try {
        if (typeof IntersectionObserver === "function") {
            vis = new IntersectionObserver((entries) => {
                for (const en of entries) {
                    if (en.isIntersecting) {
                        for (const other of window.__vpRegistry) {
                            if (other.wrap !== wrap && other.wrap.isConnected && other.thumb && !other.thumb.paused) {
                                try { other.thumb.pause(); } catch (e) {}
                            }
                        }
                        tryPlay();
                    }
                    else { try { thumb.pause(); } catch (e) {} }
                }
            }, { threshold: 0.3 });
            vis.observe(wrap);
        }
    } catch (e) {}

    // 3. requestVideoFrameCallback — если доступен, ничего больше не нужно:
    //    кадр отрисуется браузером (и на iOS при активном воспроизведении).
    if (typeof thumb.requestVideoFrameCallback === "function") {
        thumb.requestVideoFrameCallback(() => {
            wrap.classList.add("video-frame-ready");
        });
    }

    // 4. v160y36 (Олег 2026-09-24 «только один кадр в первую, а не движение»):
    //    iOS Low Power Mode / standalone PWA блокирует muted-autoplay —
    //    play() молча отклоняется, превью замирает на первом кадре/постере.
    //    Фолбэк: seek-приводимый canvas — seeking разрешён на iOS БЕЗ жеста:
    //    шагаем кадры вручную (0.25s шаг, первые ~3s) и рисуем в canvas
    //    поверх видео. Canvas absolute ВНУТРИ wrap безопасен: wrap имеет
    //    aspect-ratio (п.1) — регресс v160b (0 высоты) не воспроизводится.
    let seekPreviewOn = false;
    const startSeekPreview = () => {
        if (seekPreviewOn) return;
        const w = thumb.videoWidth, h = thumb.videoHeight;
        if (!w || !h) { setTimeout(startSeekPreview, 500); return; }
        seekPreviewOn = true;
        // v160y44 (Олег 21:31 «мигает, вертикальный меняется с квадратом»):
        // двойной рендер — нижнее видео продолжало играть (cover-кроп, зум)
        // и просвечивало через letterbox-полосы canvas (contain) → чередование
        // «вертикальный↔квадрат» на каждом redraw. Пауза нижнего видео.
        try { thumb.pause(); } catch (e) {}
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.className = "video-seek-preview";
        wrap.appendChild(cv);
        wrap.classList.add("video-frame-ready");
        // Свой observer: управляет паузой цикла (не декодируем за экраном).
        let visible = true;
        try { if (vis) vis.disconnect(); } catch (e) {}
        try {
            const vis2 = new IntersectionObserver((entries) => {
                for (const en of entries) visible = en.isIntersecting;
            }, { threshold: 0.3 });
            vis2.observe(wrap);
        } catch (e) {}
        const dur = isFinite(thumb.duration) && thumb.duration > 0 ? Math.min(thumb.duration, 3) : 3;
        let t = 0.1;
        const step = () => {
            if (!cv.isConnected) return; // wrap перерисован — цикл умер
            if (!visible) { setTimeout(step, 500); return; }
            const onSeeked = () => {
                thumb.removeEventListener("seeked", onSeeked);
                try { cv.getContext("2d").drawImage(thumb, 0, 0, w, h); } catch (e) {}
                t += 0.1;
                if (t >= dur) t = 0.1; // loop первых ~3с
                setTimeout(step, 80);
            };
            thumb.addEventListener("seeked", onSeeked);
            try { thumb.currentTime = t; }
            catch (e) { thumb.removeEventListener("seeked", onSeeked); }
        };
        step();
    };
    // Если видео всё же стартовало (autoplay прошёл / retry) — canvas не нужен.
    thumb.addEventListener("playing", () => {
        if (seekPreviewOn) {
            const cv = wrap.querySelector(".video-seek-preview");
            if (cv) cv.remove();
            seekPreviewOn = false;
        }
    });
    setTimeout(() => {
        if (playBlocked) startSeekPreview();
        // v160y48 (Олег 22:43 «превью дёрганые, пропускаются кадры, нет
        // плавности»): было «playBlocked || thumb.paused» — координатор (v160y44)
        // ставит превью на паузу при скролле за экран, и на такой НЕИГРАЮЩЕЙ
        // thumbnail стартовал 8-fps seek-цикл вместо плавного видео при
        // возврате в видимость. Seek-цикл теперь ТОЛЬКО при реально
        // заблокированном play (Low Power Mode). Плюс плавнее: шаг 0.1с/80мс
        // (~12fps вместо ~8fps).
        if (thumb.paused && !playBlocked) tryPlay(); // возврат в видимость — плавный play
    }, 1500);
};