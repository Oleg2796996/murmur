// murmur PWA — message-cache/outbox (вынесено из app.js v160z3, 2026-09-26)
// Блок 182–574 app.js: posters-кэш, messages-cache по peer (+race guard),
// sanitize-хелперы, outbox (sig → plaintext), warmOutboxCache + loadOutboxForPeer.
// Classic script, загружается ДО app.js (index.html) — глобалы общие.

const LS_OUTBOX = "murmur.outbox";
const LS_MESSAGES_CACHE = "murmur.messages_cache";
const __murmurCacheLoading = new Map(); // peer → Promise<messages[peer] resolved>
const LS_POSTERS = "murmur.posters.v1";
const MESSAGES_CACHE_MAX_PER_PEER = 500; // MUST match app-store.js MAX_MESSAGES_PER_PEER

// Lesson #326 (Олег 2026-08-28 12:08 MSK): persistent кэш сообщений по peer.
// Раньше: messages[peer] сбрасывался при openChat → перерасшифровка всех фото.
// Теперь: при loadHistory сохраняем snapshot в localStorage. При openChat —
// загружаем snapshot, юзер видит чат мгновенно (с blob-cache HIT'ами для фото),
// параллельно идёт fetch только новых сообщений.
// v160k9c (Олег 2026-09-06 10:05): race openChat → loadHistory приходит раньше
// loadMessagesCacheForPeer и делает messages[peer] = newMsgs.concat([]) = только
// newMsgs. Потом cache-load догружает устаревший массив и перетирает новые.
// Фикс: loadHistory ждёт завершения cache-load для того же peer.

// v160p (Олег 2026-09-02 «пропало превью на отправленном видео»: постер сервер
// не видел (внутри E2E), локальные меты теряются при слиянии кэша с серверной
// строкой). Постеры в постоянном кэше по blob_id: пишем при отправке и при
// расшифровке входящих, читаем при любом рендере. ≤24 постеров (~150KB).
function savePosterToCache(blobId, dataUrl) {
    if (!blobId || !dataUrl) return;
    try {
        const store = JSON.parse(localStorage.getItem(LS_POSTERS) || "{}");
        store[blobId] = dataUrl;
        const keys = Object.keys(store);
        if (keys.length > 24) keys.slice(0, keys.length - 24).forEach((k) => delete store[k]);
        localStorage.setItem(LS_POSTERS, JSON.stringify(store));
    } catch (e) { /* quota — fail OK */ }
}
function posterFromCache(blobId) {
    if (!blobId) return null;
    try {
        const store = JSON.parse(localStorage.getItem(LS_POSTERS) || "{}");
        return store[blobId] || null;
    } catch (e) { return null; }
}
window.MurmurPosterCache = { put: savePosterToCache, get: posterFromCache };
// v160k9a: MUST match app-store.js MAX_MESSAGES_PER_PEER (500). 100 was
// silently dropping messages 101-500 on every cache save, which looked like
// 'old messages disappeared' after reload.

// v160q (Олег 2026-09-08 22:49 «превью остаётся bin» + сим-лог «loadHistory
// FAILED: keepNewestByTs is not defined»): keepNewestByTs была ОБЪЯВЛЕНА ВНУТРИ
// saveMessagesCacheForPeer (v160l), а loadHistory зовёт её на module scope →
// ReferenceError → loadHistory падал ПОСЛЕ fetch, ДО сохранения кэша и ДО
// Phase-3 decrypt (запускается только из pollHistoryForPeer). Следствия:
// открытый чат получал исходники без merge/decrypt, IDB-кэш писался только
// pollHist-путём с неотмерженной meta (f-…bin без _plainName).
// Фикс: вынесена на module scope — едина для обоих callers.
function keepNewestByTs(arr, limit) {
    if (arr.length <= limit) return arr;
    const idx = arr.map((m, i) => ({ i, ts: m.ts || 0 }));
    idx.sort((a, b) => b.ts - a.ts || a.i - b.i);
    const keepSet = new Set(idx.slice(0, limit).map(x => x.i));
    return arr.filter((_, i) => keepSet.has(i));
}

// v160o: видео/большие файлы НЕ кладём plaintext_b64 в IDB/outbox —
// 37–50MB base64-строки выдувают квоту IndexedDB/LS (iOS), после чего весь
// кэш перестаёт сохраняться (DataCloneError/QuotaExceeded) и превью пропадает
// после 2–3 перезаходов. Постер (≤150KB dataURL) оставляем — им рисуем превью
// до завершения remote-decrypt; сам plaintext доставит fetch blob (живёт 24h
// на relay — v160o). Для картинок/мелких файлов plaintext оставляем —
// мгновенный рендер без сети.
function _sanitizeAttachmentForStorage(att) {
    if (!att || typeof att !== "object") return att;
    const mime = att.mime || "";
    const big = (att.size || 0) > 1.5 * 1024 * 1024;
    if (!att.plaintext_b64 || !(mime.indexOf("video/") === 0 || big)) return att;
    const copy = Object.assign({}, att);
    delete copy.plaintext_b64;
    return copy;
}
// v160o: runtime-only поля на message-объектах (_decrypt_promise — Promise из
// decryptWithTimeout) не переживают structuredClone → DataCloneError → весь
// IDB put падает молча → кэш переписки не persists. Стримаем перед записью.
function _sanitizeMessageForStorage(m) {
    if (!m || typeof m !== "object") return m;
    // v160r: reply_to (простой объект {sig, preview, ts}) должен пережить кэш —
    // цитата рисуется после reload тоже.
    if (!m._decrypt_promise && !m.reply_to && !(Array.isArray(m.attachments_meta) && m.attachments_meta.some(_sanitizeAttachmentNeedsCopy))) return m;
    const cm = Object.assign({}, m);
    delete cm._decrypt_promise;
    if (cm.reply_to && typeof cm.reply_to === "object") cm.reply_to = Object.assign({}, cm.reply_to);
    if (Array.isArray(cm.attachments_meta)) cm.attachments_meta = cm.attachments_meta.map(_sanitizeAttachmentForStorage);
    return cm;
}
window._murmurSanitizeMessageForStorage = _sanitizeMessageForStorage; // v160s: app-store.js IDB put
function _sanitizeAttachmentNeedsCopy(att) {
    return !!att && typeof att === "object" && !!att.plaintext_b64
        && ((att.mime || "").indexOf("video/") === 0 || (att.size || 0) > 1.5 * 1024 * 1024);
}

async function saveMessagesCacheForPeer(peer) {
    const arr = messages[peer] || [];
    if (arr.length === 0) return;
    // v160k3 (Олег 2026-09-03 17:44): 🔒 NEVER в кэш. Идея Олега: кэш должен
    // хранить только расшифрованное. 🔒 placeholder — это render-заглушка,
    // не данные. Если decrypt не успел до saveMessagesCacheForPeer —
    // (1) расшифровать сейчас (body_base64 в cached msg retained),
    // (2) если decrypt снова fails — выкинуть 🔒 msg из кэша целиком:
    // после reload pollHist возьмет свежую серверную строку и decrypted
    // plaintext попадает в кэш через нормальный path.
    // v160q: keepNewestByTs вынесена на module scope (loadHistory тоже её зовёт
    // — ReferenceError тут валил весь saveMessagesCacheForPeer).
    const trimmed = [];
    for (const m of keepNewestByTs(arr, MESSAGES_CACHE_MAX_PER_PEER)) {
        const isEnc = m && typeof m.body === "string" &&
            (m.body.includes("🔒") || m.body.includes("шифрованное"));
        if (isEnc) {
            try {
                // v160k9: ciphertext lives in _server_msg.body_base64 (not on row) —
                // decrypt raw server row, otherwise ct=null → 🔒 stays forever.
                const raw = m._server_msg || m;
                const d = await decryptEnvelopeForRender(raw);
                // v160y2: пустой text + вложения = успех (фото без подписи).
                if (decryptResultHasContent(d)) {
                    // v160r: reply_to из decrypt тоже в кэш — цитата рисуется после reload.
                    const cm = _sanitizeMessageForStorage(Object.assign({}, m, { body: d.text || "", reply_to: d.reply_to || null }));
                    trimmed.push(cm);
                    continue;
                }
            } catch (e) { /* decrypt failed — keep 🔒 row with _ct/body_base64 */ }
            // v160k4: 🔒 KEEP (не выкидывать). 🔒 row carries _ct/body_base64 —
            // loadMessagesCacheForPeer расшифрует её локально после WASM init,
            // даже OFFLINE. Раньше выкидывали → после reload pollHist берет
            // fresh строку, но server TTL уже снес строки (privacy) → 🔒
            // навсегда + offline нечего расшифровать.
            trimmed.push(_sanitizeMessageForStorage(m));
            continue;
        }
        trimmed.push(_sanitizeMessageForStorage(m));
    }
    if (!window.appStore) {
        try {
            const cache = JSON.parse(localStorage.getItem(LS_MESSAGES_CACHE) || "{}");
            cache[peer] = trimmed;
            localStorage.setItem(LS_MESSAGES_CACHE, JSON.stringify(cache));
            let maxTs = 0;
            for (const m of trimmed) if ((m.ts || 0) > maxTs) maxTs = m.ts;
            if (maxTs) await updateMaxTs(peer, maxTs);
        } catch (e) { /* QuotaExceeded */ }
        return;
    }
    try {
        await window.appStore.chats.saveMessages(peer, trimmed);
        let maxTs = 0;
        for (const m of trimmed) if ((m.ts || 0) > maxTs) maxTs = m.ts;
        if (maxTs) await updateMaxTs(peer, maxTs);
    } catch (e) {
        console.warn("[murmur] appStore.chats.saveMessages failed:", e);
        try {
            localStorage.setItem("murmur.last_save_error", JSON.stringify({
                t: Date.now(), peer: peer.slice(0, 12), fn: "saveMessagesCacheForPeer",
                err: String(e && e.message || e),
            }));
        } catch (_) { /* ignore */ }
    }
}

async function loadMessagesCacheForPeer(peer) {
    // v160k9c: expose this promise so loadHistory can await it (anti-race).
    let resolveCache;
    const cacheP = new Promise(r => { resolveCache = r; });
    __murmurCacheLoading.set(peer, cacheP);
    try {
        return await _loadMessagesCacheForPeerImpl(peer, resolveCache);
    } finally {
        __murmurCacheLoading.delete(peer);
        resolveCache();
    }
}

async function _loadMessagesCacheForPeerImpl(peer, resolveCache) {
    let arr = null;
    if (window.appStore) {
        try {
            arr = await window.appStore.chats.getMessages(peer);
        } catch (e) {
            console.warn("[murmur] appStore.chats.getMessages failed:", e);
        }
    }
    if (!arr || arr.length === 0) {
        try {
            const cache = JSON.parse(localStorage.getItem(LS_MESSAGES_CACHE) || "{}");
            arr = cache[peer];
            if (Array.isArray(arr) && arr.length > 0 && window.appStore) {
                window.appStore.chats.saveMessages(peer, arr).catch(() => {});
            }
        } catch (e) { /* ignore */ }
    }
    if (Array.isArray(arr) && arr.length > 0) {
        // v160l: assign the cache to in-memory FIRST, then enrich in-place.
        // Earlier code ran outbox-merge and decrypt before assignment, creating
        // a window where loadHistory (which awaits the cache promise) could see
        // an empty messages[peer] or a partially-built array.
        messages[peer] = arr;
        let outbox = {};
        try {
            if (window.appStore) {
                outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
            } else {
                outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
            }
        } catch (e) { outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}"); }
        for (const m of arr) {
            if (m.direction !== "out") continue;
            const meta = m.attachments_meta || [];
            const hasPlaintext = meta.length > 0 && meta.every(a => !!a.plaintext_b64);
            if (hasPlaintext) continue; // уже хорошие
            // Lesson #348: перебираем ВСЕ варианты ключа outbox (_sig может быть
            // как from+ts, так и from+":"+ts в разных версиях; from может быть
            // пуст в старых записях — тогда пробуем myNpub).
            const keyCandidates = [
                m._sig,
                (m.from || "") + ":" + m.ts,
                (m.from || "") + m.ts,
                (myNpub || "") + m.ts,
            ].filter(Boolean);
            let local = null;
            for (const kk of keyCandidates) { if (outbox[kk]) { local = outbox[kk]; break; } }
            if (local && local.attachments_meta && local.attachments_meta.length) {
                m.attachments_meta = local.attachments_meta;
            }
        }
        // Resolve the cache-loading promise immediately after the in-memory
        // cache is assigned, so any waiter (e.g. loadHistory) sees messages[peer]
        // populated as soon as possible. Async enrichment (outbox, decrypt) runs
        // afterwards without blocking callers.
        resolveCache();
        // v160k4 (Олег 2026-09-03 18:23): offline-decrypt 🔒 rows из кэша.
        // 🔒 rows carry _ct/body_base64. Decrypt локально после WASM init,
        // даже OFFLINE (server TTL privacy — строки уже снесены).
        const encRows = arr.filter(m => typeof m.body === "string" &&
            (m.body.includes("🔒") || m.body.includes("шифрованное") || m._ct));
        const decryptEncRow = async (em) => {
            try {
                // v160k9: �🔒 row carries ciphertext in _server_msg.body_base64,
                // NOT on the row itself. decryptEnvelopeForRender checks env.ct /
                // env.body_base64 only → ct=null → plaintext fallback → 🔒 stays
                // навсегда. Pass _server_msg (fresh object, no memoized promise).
                const raw = em._server_msg || em;
                const d = await decryptWithTimeout(raw);
                // v160y2: пустой text + вложения = успех (фото без подписи).
                if (decryptResultHasContent(d)) {
                    em.body = d.text || "";
                    em._ct = null; // decrypted — 🔒 заглушка не нужна
                    em._decryptedOffline = true;
                    if (activePeer === peer) renderMessages();
                    saveMessagesCacheForPeer(peer);
                }
            } catch (e) { /* offline / WASM not ready — 🔒 stays until WASM ready */ }
        };
        encRows.forEach(decryptEncRow);
        // Если есть blob-cache HIT для attachments_meta, рендер сразу покажет <img>.
        // Если нет — будет placeholder пока decrypt идёт.
        renderMessages();
        scrollToBottom();
        // Lesson #332 (Олег 2026-08-28 14:36 MSK): incoming attachment decrypt
        // идёт async через renderAttachment в renderMessages. Первый renderMessages
        // мог показать только placeholder пока renderAttachment не отработал.
        // Повторные renderMessages через короткие интервалы — чтобы обновить
        // bubble после async decrypt (memoization в decryptWithTimeout гарантирует
        // что второй+ вызов мгновенный).
        if (peer === (typeof activePeer !== "undefined" ? activePeer : null)) {
            for (const delay of [100, 400, 1200, 3000, 6000]) {
                setTimeout(() => {
                    if (typeof activePeer !== "undefined" && activePeer === peer) {
                        renderMessages();
                    }
                }, delay);
            }
        }
    }
}

async function saveToOutbox(msg, plaintext, attachmentsPlaintext) {
    const key = msg._sig || (msg.from + ":" + msg.ts);
    const entry = {
        body: plaintext,
        attachments: msg.attachments || [],
        // v160o: видео plaintext НЕ пишем в IDB/LS (квота, см. комментарий
        // у _sanitizeAttachmentForStorage); постер остаётся — превью рисуется,
        // plaintext доставит remote-decrypt (blob живёт 24h на relay).
        attachments_meta: (attachmentsPlaintext || []).map(_sanitizeAttachmentForStorage),
        // v160y50 (Олег 23:44: «когда отвечаешь на конкретное сообщение (цитата),
        // у того кто отправляет после обновления в чате остается только
        // отправленное сообщение без привязи к сообщению на которое он
        // ответил»): reply_to в outbox — иначе loadHistory outbox-путь
        // (isOutgoing local-branch) собирает msg без reply_to → цитата
        // теряется при первом полле/reload, остаётся текст без привязки.
        reply_to: msg.reply_to || null,
        ts: msg.ts,
        from: msg.from,
        to: msg.to,
        sig: msg.sig,
        _hash: msg._hash,
        savedAt: Date.now(),
    };
    if (window.appStore) {
        try {
            const outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
            outbox[key] = entry;
            const keys = Object.keys(outbox);
            if (keys.length > 200) {
                keys.sort((a, b) => (outbox[a].ts || 0) - (outbox[b].ts || 0));
                keys.slice(0, keys.length - 200).forEach((k) => delete outbox[k]);
            }
            await window.appStore.kv.set(LS_OUTBOX, outbox);
            _outboxKVCache = outbox; // Lesson #346: keep sync cache fresh
        } catch (e) {
            console.warn("[murmur] saveToOutbox appStore failed:", e);
        }
    }
    try {
        const outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        outbox[key] = entry;
        const keys = Object.keys(outbox);
        if (keys.length > 200) {
            keys.sort((a, b) => (outbox[a].ts || 0) - (outbox[b].ts || 0));
            const toDelete = keys.slice(0, keys.length - 200);
            toDelete.forEach(k => delete outbox[k]);
        }
        localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox));
    } catch (e) { /* QuotaExceeded — fallback fail OK */ }
}

// Lesson #347 (Олег 2026-08-30 15:40 MSK): ⚠️ ЛАТЕНТНАЯ РАССИНХРОНИЗАЦИЯ.
// saveToOutbox пишет в _outboxKVCache при appStore ИЛИ в LS. НО:
// - до v143 outbox _hash update после send писал ТОЛЬКО в LS (не в IDB);
// - loadOutboxForPeer читает _outboxKVCache (IDB), а если он пуст — LS;
// - поллистовый pollHist matchивает outbox entry по o._hash === serverHash.
// Держать оба представления в согласии — теперь миграция = склейка IDB+LS
// (mergeUnion: IDB побеждает для plaintext, потому что LS может быть урезан
// квотой). См. _mergeOutboxStores().
// История: loadOutboxForPeer была async, её переписывали в v139/140, а
// вызовы в loadHistory (1717) и pollHistoryForPeer (2963) остались СИНКОВЫМИ
// и получили Promise. Promise.find === undefined → «outbox.find is not a
// function» → loadHistory падал ПОЛНОСТЬЮ → пустой чат/«No messages yet»
// после reload. Это и был главный «reload ломает всё» баг.
// Теперь функция синхронная: читает appStore cache (прогретый на init) или LS.
let _outboxKVCache = null;
async function warmOutboxCache() {
    try {
        if (window.appStore) {
            _outboxKVCache = (await window.appStore.kv.get(LS_OUTBOX)) || {};
        }
    } catch (e) { _outboxKVCache = null; }
}
function loadOutboxForPeer(peerNpub) {
    let outbox = {};
    if (window.appStore) {
        try {
            outbox = _outboxKVCache || {};
        } catch (e) { outbox = {}; }
    }
    // Lesson #347: merge LS поверх IDB — LS может содержать записи, которых
    // нет в IDB (например, _hash updating писало только в LS до v143), и
    // наоборот. Merge: IDB базовый, LS заполняет пробелы, НЕ затирая plaintext.
    try {
        const ls = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        for (const [k, v] of Object.entries(ls || {})) {
            if (!outbox[k]) { outbox[k] = v; continue; }
            // оба есть: склейка — _hash может быть только в LS-версии, plaintext
            // обычно в IDB-версии. Берём поле _hash из любого где он есть.
            const merged = { ...outbox[k] };
            if (!merged._hash && v._hash) merged._hash = v._hash;
            // v160y52: reply_to тоже переносим при склейке (цитата после перезахода)
            if (!merged.reply_to && v.reply_to) merged.reply_to = v.reply_to;
            if (!merged.attachments_meta?.length && v.attachments_meta?.length) merged.attachments_meta = v.attachments_meta;
            if (!merged.attachments?.length && v.attachments?.length) merged.attachments = v.attachments;
            if (merged.body === undefined && v.body !== undefined) merged.body = v.body;
            outbox[k] = merged;
        }
    } catch (e) { /* LS unavailable/garbage — idb only */ }
    if (Object.keys(outbox).length === 0) return [];
    const result = [];
    for (const [key, m] of Object.entries(outbox)) {
        if (m.from === peerNpub || m.to === peerNpub) {
            result.push({
                ...m,
                _sig: key,
                // Lesson #343 (Олег 2026-08-30 13:29 MSK): было инвертировано
                // (from === peerNpub ? "out" : "in") — исходящие от себя
                // показывались слева как входящие.
                direction: m.from === peerNpub ? "in" : "out",
            });
        }
    }
    return result;
}
// v160t: WS endpoint — /ws (роутинг CF-туннеля + nginx → 8443). Корень ведёт
// на push HTTP (8444), WS туда не подключается (200 fallback → handshake fail).
