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
async function fetchBlob(blobId, abortSignal) {
    const r = await fetch(`${ATTACH_API_BASE}/api/blob/${blobId}`, {
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
    placeholder.textContent = "🔓 расшифровка…";
    containerEl.appendChild(placeholder);

    // Lesson #318 (Олег 2026-08-28 06:42 MSK): 12s safety net — если placeholder
    // висит дольше 12s (fetch + decrypt через CF tunnel), заменить на
    // "retry" вместо зависшего "🔓 расшифровка…". Это не убивает основной
    // renderAttachment (тот продолжает до 45s+15s), но юзер видит retry.
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
    }, 12000);

    let blobUrl = null;
    try {
        // Lesson #210 (Олег 2026-08-26 13:38): AbortSignal support — abortable fetch
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }

        // Lesson #211 (Олег 2026-08-26 14:14): CACHE-FIRST lookup.
        // Если blob уже расшифрован и сохранён в IndexedDB — просто показываем.
        // Иначе fetch + decrypt + save в cache.
        const cache = window.MurmurBlobCache;
        if (cache && cache.isAvailable && cache.isAvailable()) {
            const cachedBlob = await cache.get(att.blob_id);
            if (cachedBlob) {
                if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
                blobUrl = URL.createObjectURL(cachedBlob);
                // Privacy v154: real filename from decrypted ct (merged by app.js),
                // neutral f-…bin otherwise.
                const displayName = att._plainName || att.name;
                const mime = att._plainMime || att.mime || cachedBlob.type || "application/octet-stream";
                const el = renderByMime({ mime, name: displayName, blobUrl, size: cachedBlob.size });
                placeholder.replaceWith(el);
                clearTimeout(safetyNetId); // Lesson #319: safety net отработал — снимаем
                console.log("[attach-cache] HIT", att.blob_id.slice(0, 8), "size=", cachedBlob.size);
                return el;
            }
            console.log("[attach-cache] MISS", att.blob_id.slice(0, 8));
        }

        // Lesson #237 (Олег 2026-08-26 21:42 MSK): 45s для blob fetch (было 30s).
        // CF tunnel cold-start на медленном инете может быть 30-40s.
        // Плюс — уже cache HIT выше (строка 95-105), если blob в IndexedDB,
        // fetch не вызывается ВООБЩЕ. Это решает "3+ фото + reload не видны".
        const ct = await withTimeout(fetchBlob(att.blob_id, abortSignal), 45000, "fetchBlob");
        if (abortSignal && abortSignal.aborted) { clearTimeout(safetyNetId); placeholder.remove(); return null; }
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
        if (cache && cache.isAvailable && cache.isAvailable()) {
            cache.put(att.blob_id, blob, mime).catch(e => console.warn("[attach-cache] put failed", e));
        }
        blobUrl = URL.createObjectURL(blob);
        // e. Render based on mime
        const el = renderByMime({ mime, name: att._plainName || att.name, blobUrl, size: plain.length });
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
        const playBtn = document.createElement("div");
        playBtn.className = "video-play-btn";
        playBtn.textContent = "▶";
        wrap.appendChild(thumb);
        wrap.appendChild(playBtn);
        wrap.onclick = () => openVideoFullscreen(blobUrl, mime, name);
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(thumb, blobUrl);
        figure.appendChild(wrap);
        // v160c: общий сетап превью — реализация в window.murmurSetupVideoPreview
        // (ниже в этом файле). Чинит регресс v160b: video+canvas оба absolute
        // → wrap схлопывался в 0 высоты (на маке «показался и пропал»).
        if (window.murmurSetupVideoPreview) window.murmurSetupVideoPreview(wrap, thumb, blobUrl);
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
    };
    const ext = extMap[mime] || (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
    const base = (n.replace(/\.bin$/i, "") || "file");
    return base + "." + ext;
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

// v160: полноэкранный видеоплеер (tap по превью в чате).
// blob URL НЕ ревокается — он принадлежит аттачу в чате (auto-revoke
// через __murmurBlobOwners при удалении сообщения).
function openVideoFullscreen(blobUrl, mime, name) {
    const overlay = document.createElement("div");
    overlay.className = "fullscreen-overlay";
    const v = document.createElement("video");
    v.src = blobUrl;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.className = "fullscreen-video";
    overlay.appendChild(v);
    overlay.onclick = (e) => {
        if (e.target === overlay) { // клик по фону, не по контролам
            v.pause();
            overlay.remove();
        }
    };
    document.body.appendChild(overlay);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderAttachment };
}
window.MurmurRenderAttachments = { renderAttachment };

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
    });
    // До загрузки — дефолт 16/9, чтобы было куда рисовать кадр.
    if (!wrap.style.aspectRatio) wrap.style.aspectRatio = "16 / 9";

    // 2. iOS: muted-автопроигрывание — единственный надёжный способ показать
    //    кадр (preload=metadata и #t=0.1 iOS игнорирует на blob-URL).
    //    loop чтобы кадр не замирал на последнем кадре.
    thumb.loop = true;
    const tryPlay = () => {
        const p = thumb.play();
        if (p && p.catch) p.catch(() => {
            // Автоплей заблокирован — пробуем по первому тапу (wrap.onclick
            // открывает fullscreen, но play() внутри жеста разрешён; кадр
            // останется чёрным только до тапа).
        });
    };
    thumb.addEventListener("canplay", tryPlay, { once: true });
    setTimeout(tryPlay, 800); // страховка: canplay может не прийти на iOS

    // 3. requestVideoFrameCallback — если доступен, ничего больше не нужно:
    //    кадр отрисуется браузером (и на iOS при активном воспроизведении).
    if (typeof thumb.requestVideoFrameCallback === "function") {
        thumb.requestVideoFrameCallback(() => {
            wrap.classList.add("video-frame-ready");
        });
    }
};