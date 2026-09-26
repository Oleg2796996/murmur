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

// v160y24: НЕ хардкод — RELAY из app.js (single source of truth).
// 23.09 инцидент: три независимых хардкода (RELAY в app.js + ATTACH_API_BASE в 2 файлах)
// рассинхронились при деплое — фото с прода уходило на тест-релей.
const ATTACH_API_BASE = (typeof RELAY !== "undefined" && RELAY) ? RELAY : "https://murmur.senswifi.ru";

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
async function eciesWrapKey(recipientNpub, key, selfNpub) {
    // Lesson #349 (Олег 2026-08-30 16:20 MSK): AES-ключ файла заворачивается
    // ДВАЖДЫ — для получателя (r) И для себя (s). Без self-wrap исходящее фото
    // живёт ТОЛЬКО в локальном plaintext-кэше (outbox): второе устройство с тем
    // же npub (Mac↔iPhone), WS-push своего сообщения и любой сбой кэша дают
    // вечные чипы «📎 ...» вместо фото. С self-wrap исходящие рендерятся тем же
    // remote-decrypt путём, что и входящие.
    const wrapOne = async (npub, tag) => {
        const sealed = await window.encryptForRecipient(npub, b64encode(key));
        if (typeof sealed !== "string" || !sealed.length) {
            throw new Error("ECIES wrap failed (" + tag + "): empty result");
        }
        return sealed;
    };
    const r = await wrapOne(recipientNpub, "recipient");
    let result;
    if (selfNpub && selfNpub === recipientNpub) {
        // Отправка самому себе — один и тот же wrapped key.
        result = { r, s: r };
    } else if (selfNpub) {
        const s = await wrapOne(selfNpub, "self");
        result = { r, s };
    } else {
        // Fallback: нет myNpub (не должно случаться) — legacy single wrap.
        result = { r };
    }
    // Формат: base64(JSON {r, s}) — render-attachments разворачивает по роли.
    return b64encode(new TextEncoder().encode(JSON.stringify(result)));
}

// 4. POST /api/upload with binary body + query params.
// Uses XHR (not fetch) to get upload progress events.
// Privacy (Олег 2026-08-31): в query ушдет ТОЛЬКО нейтральное имя f-XXXXXXXX.bin.
// Настоящее filename не покидает устройство: оно внутри sealed envelope
// (encryptForRecipient → attachments[].name) — релей его не видит.
function uploadCiphertext({ sha256Hex, mime, name, size, wrappedKey, ciphertext, onProgress }) {
    return new Promise((resolve, reject) => {
        const url = new URL(ATTACH_API_BASE + "/api/upload");
        url.searchParams.set("sha256", sha256Hex);
        url.searchParams.set("mime", mime || "application/octet-stream");
        // Privacy v154: сюда приходит уже сгенерированное нейтральное имя
        // (f-XXXXXXXX.bin) из attachEncryptAndUpload. Никаких настоящих filename.
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
        // v160y28: таймаут пропорционален размеру. Жёсткие 60с рвали большие видео
        // (23.2 МБ через CF-туннель на сотовом/Wi-Fi > 60с → «Upload timeout (60s)»).
        // Расчёт: ~50 КБ/с эффективной скорости, ×2 запас, минимум 60с. 23 МБ → ~15 мин.
        const uploadTimeoutMs = Math.max(60000, Math.ceil((size || 0) / 51200) * 1000 * 2);
        xhr.ontimeout = () => reject(new Error("Upload timeout (" + Math.round(uploadTimeoutMs / 1000) + "s)"));
        xhr.timeout = uploadTimeoutMs;
        // Send ciphertext as binary.
        xhr.send(ciphertext);
    });
}

// Public API: encrypt + wrap + upload one file.
// Returns: { blob_id, sha256, mime, size, name, wrapped_key }
//
// On failure, throws. Caller decides UX (toast / retry / abort).
// v160d: постер-кадр для видео. Вызывается У ОТПРАВИТЕЛЯ в момент выбора
// файла (юзер-жест → iOS разрешает декодирование blob-video и drawImage).
// Получатель ставит кадр как video.poster — iOS показывает постер ВСЕГДА,
// без декодирования (preload/#t на iPhone игнорируются — Lesson v160b/c).
// Возврат: data:image/jpeg;base64,… или null (не критично — мак рисует сам).
async function extractVideoPoster(file) {
    return new Promise((resolve) => {
        let settled = false;
        let playRetry = null;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (playRetry) clearInterval(playRetry);
            try { v && v.parentNode && v.parentNode.removeChild(v); } catch (e) {}
            try { URL.revokeObjectURL(url); } catch (e) {}
            resolve(val);
        };
        const url = URL.createObjectURL(file);
        // v160k: 4K/HEVC .MOV на реальном iPhone декодируется дольше — 15 c.
        const timer = setTimeout(() => finish(null), 15000);
        let v = null;
        try {
            v = document.createElement("video");
            // v160k (реальный iPhone: «превью по-прежнему нет» при зелёном симе):
            // iOS Safari НЕ начинает загрузку медиа у <video> вне DOM —
            // loadeddata не приходит, до seek/grab дело не доходит →
            // 10s timeout → poster=null → превью нет. Playwright WebKit на HP
            // так себя не ведёт, поэтому v160j в симуляции зелёный, а на телефоне
            // нет. Фикс: вставляем элемент в DOM оф-скрин (НЕ display:none —
            // он глушит декодирование).
            v.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0.01;pointer-events:none;";
            document.body.appendChild(v);
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.src = url;
            try { v.load(); } catch (e) {}
            // v160j (Олег: «по прежнему нет превью на телефоне»): iOS декодирует
            // видео ТОЛЬКО после начала воспроизведения — drawImage по неиграющему
            // видео даёт чёрный кадр (браковался → poster=null → превью нет).
            // Фикс: сразу muted-play (iOS разрешает без жеста; Lesson v160c),
            // ждём первый декодированный кадр (rVFC), потом seek → grab.
            let playStarted = false;
            const tryPlay = () => {
                if (playStarted) return;
                playStarted = true;
                const p = v.play();
                if (p && p.catch) p.catch(() => {
                    // Low Power Mode / нет жеста — сбрасываем флаг, ретраи
                    // попытаются снова (v160k).
                    playStarted = false;
                });
            };
            // v160k: играть СРАЗУ после установки src (v160j звал tryPlay только
            // внутри loadeddata — на iOS loadeddata может не прийти до старта
            // воспроизведения) + ретраи каждую секунду.
            tryPlay();
            playRetry = setInterval(tryPlay, 1000);
            setTimeout(() => { if (playRetry) { clearInterval(playRetry); playRetry = null; } }, 10000);
            let grabTries = 0;
            const grab = () => {
                try {
                    // v160j hardening: на холодном декодере seeked может прийти
                    // раньше, чем decodeThread выдаст кадры (наблюдаемо в WebKit
                    // headless) — не бракуем сразу, ретраим до 1.5с.
                    if ((!v.videoWidth || !v.videoHeight) && grabTries++ < 5) {
                        return setTimeout(grab, 300);
                    }
                    if (!v.videoWidth || !v.videoHeight) return finish(null);
                    // v160l: постер НЕ в разрешении видео. 4K .MOV давал
                    // 2160x3840 JPEG ≈ 1.5 MB → в sealed ct → тяжёлый envelope,
                    // медленный ECIES на телефоне, жирный /api/history.
                    // Даунскейл до 640px по длинной стороне (~50–150 KB).
                    const MAXP = 640;
                    const scale = Math.min(1, MAXP / Math.max(v.videoWidth, v.videoHeight));
                    const cv = document.createElement("canvas");
                    cv.width = Math.max(1, Math.round(v.videoWidth * scale));
                    cv.height = Math.max(1, Math.round(v.videoHeight * scale));
                    const ctx = cv.getContext("2d");
                    ctx.drawImage(v, 0, 0, cv.width, cv.height);
                    // Чёрный кадр = декод не удался (iOS до play) — бракуем.
                    const px = ctx.getImageData(
                        cv.width >> 1, cv.height >> 1, 1, 1).data;
                    if (px[0] + px[1] + px[2] < 12) {
                        // Возможно, кадр ещё не декодирован — одна ретра-попытка.
                        if (grabTries++ < 5) return setTimeout(grab, 300);
                        return finish(null);
                    }
                    try { v.pause(); } catch (e) {}
                    finish(cv.toDataURL("image/jpeg", 0.6));
                } catch (e) { finish(null); }
            };
            let seekScheduled = false;
            const scheduleSeek = () => {
                if (seekScheduled) return;
                seekScheduled = true;
                const t = Math.min(0.5, (v.duration || 1) * 0.25);
                const doSeek = () => {
                    v.addEventListener("seeked", grab, { once: true });
                    try { v.currentTime = t; } catch (e) { grab(); }
                };
                if (typeof v.requestVideoFrameCallback === "function") {
                    // iOS: ждём РЕАЛЬНО декодированный кадр, потом seek.
                    v.requestVideoFrameCallback(() => doSeek());
                    setTimeout(doSeek, 1500); // страховка, если rVFC завис
                } else {
                    setTimeout(doSeek, 600);
                }
            };
            v.addEventListener("loadeddata", () => {
                tryPlay();
                scheduleSeek();
            }, { once: true });
            // v160k: если loadeddata так и не пришёл (iOS без старта загрузки —
            // наш основной подозреваемый), всё равно пробуем seek по таймеру.
            setTimeout(scheduleSeek, 3000);
            v.addEventListener("error", () => finish(null), { once: true });
        } catch (e) { finish(null); }
    });
}

// v160y40: транскод видео перед шифрованием (Олег 2026-09-24 21:00:
// «можем ли мы на устройстве пользователя форматировать видео и ужимать
// его размер?»). Большие/quicktime видео (>8MB, .MOV с мака) после reload
// ломаются: (1) IDB хранит >8MB как нативный Blob → WebKit эвиктит backing
// после рестарта PWA → мёртвый блоб → VERR code=4; (2) .MOV/HEVC декодируется
// не на всех платформах. Транскод в mp4/webm ≤ ~7MB через MediaRecorder:
// canvas.captureStream + аудио через AudioContext → Recording → Blob.
// Нормализованный файл хранится как ArrayBuffer (rec.data ≤8MB — переживает
// evict) и декодируется везде. Фолбэк — оригинал при любой неудаче.
async function transcodeVideoForSend(file) {
    // v160y55b (Олег 25.09 13:51: «Галочки появились! Ура!!!! Но новый баг
    // с отправкой видео. Давай уберем консервацию видео перед отправкой»):
    // транскод ПЕРЕД отправкой УБИРАЕМ полностью — отправляем оригинал
    // на всех платформах (WebCodecs/MediaRecorder-консервация давала баг
    // при отправке видео). Сохранность после reload обеспечивают
    // OPFS-first (v160y41) + blob-cache, декодирование нативное.
    if (!file || !file.type || !file.type.startsWith("video/")) return file;
    return file;
}

async function attachEncryptAndUpload({ file, peerNpub, selfNpub, onProgress, onStage }) {
    // a. Compress if large image (Lesson #327 — speed)
    const compressedFile = await compressImageIfLarge(file);
    // v160y45 (Олег 21:40 «видео на 40mb висит»): транскод 40MB 4K идёт
    // real-time (минутный ролик = минута ожидания), а чип без индикации
    // (счётчик % стартует только на этапе загрузки). Stage-коллбек на всех
    // этапах: «конвертация…» → «кадр превью…» → «шифрование…» → % загрузки.
    if (onStage) try { onStage("конвертация видео"); } catch (e) {}
    // v160y40: транскод видео (>8MB / .MOV) в mp4 ≤~7MB — нормализованный
    // файл хранится как ArrayBuffer (rec.data) и декодируется везде.
    const preparedFile = await transcodeVideoForSend(compressedFile);
    // v160d: постер для видео — снимаем ДО шифрования, у отправителя.
    if (onStage) try { onStage("кадр превью"); } catch (e) {}
    const posterDataUrl = (preparedFile.type && preparedFile.type.startsWith("video/"))
        ? await extractVideoPoster(preparedFile)
        : null;
    // b. Read file as ArrayBuffer
    if (onStage) try { onStage("шифрование"); } catch (e) {}
    const ab = await preparedFile.arrayBuffer();
    // v160y56-fastpath: ab-sha УБРАН — сервер проверяет sha ТОЛЬКО загруженного
    // тела (ciphertext), ab-sha был мёртвым грузом: лишний проход по 36MB
    // (200-800ms на больших файлах). Не используется нигде (grep: sha =).
    // c. AES-256-GCM encrypt
    const { ciphertext, key, iv } = await aesEncrypt(ab);
    // d. ECIES wrap key (recipient-bound)
    const wrappedKey = await eciesWrapKey(peerNpub, key, selfNpub);
    // e. Upload ciphertext + wrapped_key + meta
    // Note: server checks SHA-256 against uploaded body, so pass ciphertext's SHA.
    // Privacy v154: сервер видит ТОЛЬКО нейтральное имя f-XXXXXXXX.bin — random
    // 4 байта, никак не связанное с настоящим filename. Реальное имя едет внутри
    // sealed envelope (encryptForRecipient → attachments[].name) и подставляется
    // в UI получателя после расшифровки (decryptEnvelopeForRender merge).
    const rnd = new Uint8Array(4); crypto.getRandomValues(rnd);
    const publicName = "f-" + Array.from(rnd).map(b => b.toString(16).padStart(2, "0")).join("") + ".bin";
    const ciphertextSha = await sha256Hex(ciphertext);
    if (onStage) try { onStage(null); } catch (e) {} // дальше % загрузки
    const resp = await uploadCiphertext({
        sha256Hex: ciphertextSha,
        mime: preparedFile.type || "application/octet-stream",
        name: publicName,
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
    // publicName — нейтральное имя, под которым блоб зарегистрирован на сервере
    // (вырезано из uploadCiphertext); идёт в attachments_meta, видимую релею.
    // NOTE: resp.name — это то, что сервер записал у себя (нейтральное f-…bin).
    // Настоящее имя файла НИКОГДА не уходит на сервер: оно едет внутри sealed ct
    // (encryptForRecipient), sender отдаёт его получателю через attachments[].name.
    return {
        blob_id: resp.blob_id,
        sha256: resp.sha256,
        mime: resp.mime,
        size: resp.size,
        name: preparedFile.name,
        publicName: publicName, // neutral f-…bin (тот же, что зарегистрирован на сервере)
        // v160p Phase 2: bearer token for blob download. Goes INSIDE sealed ct
        // (attachments_meta server-side copy carries it too — relay already
        // knows the token hash, no extra leak). Recipient presents it at
        // /api/blob/{id}?t=...
        blob_token: resp.blob_token || null,
        wrapped_key: wrappedKey, // for recipient to unwrap with own privkey
        iv: b64encode(iv), // base64 — recipient decodes to 12-byte IV
        plaintext_b64: b64encode(new Uint8Array(ab)), // local cache for outgoing render
        poster_data_url: posterDataUrl, // v160d: JPEG-кадр для превью (в sealed ct)
    };
}

// Export for ES module use, and global fallback for service-worker.
if (typeof module !== "undefined" && module.exports) {
    module.exports = { attachEncryptAndUpload, extractVideoPoster, transcodeVideoForSend };
}
window.MurmurAttachments = { attachEncryptAndUpload, extractVideoPoster, transcodeVideoForSend };

// v160y56-fastpath (Олег 25.09 14:59: «36 мб грузится больше минуты»):
// sha256 ПОЛНОГО файла (36MB ≈ 200-800ms) + crypto.subtle.encrypt (36MB
// ≈ 300-600ms) на новом железе быстрые, НО b64encode полного ArrayBuffer
// (String.fromCharCode-чанк 0x8000 → JS-строка → btoa) на 36MB = ~150MB
// JS-строки + UTF-16 → ~2-4s. ГЛАВНАЯ задержка — send(ciphertext) через
// CF-туннель: HP→CF→VPS сотовый/Wi-Fi ~1-5 МБ/с → 36MB(ct+IV) = 7-36с
// НА ЗАГРУЗКУ (замер VPS: loopback 104 МБ/с, CF-edge 3.6-5.9 МБ/с).
// Вывод: сетевой путь = 90%+ времени. Оптимизация — WS-путь позже;
// сейчас: не трогаем (сеть), но убираем 2 лишних sha256 (полный файл
// считался ДВАЖДЫ: sha = sha256Hex(ab) для integrity + ciphertextSha
// для upload — ab-sha НЕ нужен серверу, только ciphertext-sha).
