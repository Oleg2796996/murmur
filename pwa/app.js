// murmur PWA - two-panel messenger
//   Identity: ed25519 npub via WASM (kept in localStorage).
//   Contacts: GET /api/contacts?npub=<me>
//   History:  GET /api/history?npub=<me>&peer=<peer>&limit=100&before_ts=...
//   Send:     POST /envelope?to=<npub> with signed JSON.
//   Realtime: WS broadcast + HTTP-polling fallback (5s).
//   Storage:  identity in localStorage, all chat state in JS memory.

// ── Error reporter (BEFORE any imports, so even module-load errors show) ──
(function () {
    const showErr = (msg, source, line, col) => {
        let div = document.getElementById("__js_error_overlay");
        if (!div) {
            div = document.createElement("div");
            div.id = "__js_error_overlay";
            div.style.cssText = "position:fixed;top:0;left:0;right:0;background:#ff3355;color:#fff;padding:12px;font-family:monospace;font-size:12px;z-index:99999;white-space:pre-wrap;max-height:50vh;overflow:auto;border-bottom:2px solid #fff;";
            (document.head || document.documentElement || document.body || document).appendChild(div);
        }
        const text = source ? `[${source}:${line}:${col}] ${msg}` : msg;
        div.textContent += "\n" + text;
    };
    window.addEventListener("error", (e) => showErr(e.message || String(e.error), e.filename, e.lineno, e.colno));
    window.addEventListener("unhandledrejection", (e) => showErr("Ошибка промиса: " + (e.reason && (e.reason.stack || e.reason.message || e.reason) || "?"))); // v157b

// Lesson #340 (Олег 2026-08-28 16:08 MSK): при deploy SW меняется — браузер
// активирует новый SW, но existing клиенты продолжают использовать
// controller от старого SW. Без явного skipWaiting + reload клиент
// застрянет на старом app.js. Принудительно обновляем регистрацию и
// при смене controller делаем reload.
// Lesson #345 (Олег 2026-08-30 14:20 MSK): SW reload — УСТАРЕЛО. SW теперь
// push-only (нет fetch-хендлера), controllerchange reload НЕ НУЖЕН
// и вызывал reload-лупы. Убрано полностью.

})();

// WASM boot via dynamic import() so this file can run as a CLASSIC script
// (no <script type="module">). iOS PWA standalone has flaky module support,
// and classic scripts with inline event handlers are 100% reliable.
//
// Lesson #308 (Олег 2026-08-27 22:10 MSK): WASM INIT RACE.
// `pkg/murmur_id_wasm.js` (wasm-bindgen 0.2) exports `default = __wbg_init`.
// The Rust functions (decrypt_envelope, encrypt_for_recipient, sign_envelope,
// identity_new, identity_restore, npub_to_pubkey_hex) call into a module-level
// `wasm` variable that is set ONLY when `__wbg_init` resolves.
//
// Раньше loadWasmModule() возвращал только импортированный module, а
// `mod.default()` (init) вызывался БЕЗ await в decrypt/encrypt/sign path.
// Это означало: WASM модуль загружен, instance ещё не initialized,
// `mod.decrypt_envelope()` обращается к undefined `wasm` → мусор или
// exception "ecies_decrypt: bad tag or wrong key".
//
// Реальный сценарий (iPhone PWA Safari, после reload):
//   1. ServiceWorker activate → клиент reload
//   2. <script> app.js грузится → loadWasmModule() стартует (suspend)
//   3. renderMessages() стартует сразу после DOMContentLoaded
//   4. pollHist() возвращает новое сообщение → decrypt
//   5. decryptEnvelope() вызывает mod.decrypt_envelope() → WASM НЕ ready
//   6. → "bad tag or wrong key" (wasm-bindgen вызывает undefined функцию)
//
// Fix: loadWasmModule() await'ит `mod.default()` (init) и возвращает
// УЖЕ initialized module. Все call sites автоматически получают race-free
// доступ. Дополнительно дедупликация через `_wasmInitPromise` promise.
let _wasmInitPromise = null;
let _wasmReady = false;
async function loadWasmModule() {
    if (_wasmInitPromise) return _wasmInitPromise;
    _wasmInitPromise = (async () => {
        const mod = await import("./pkg/murmur_id_wasm.js");
        if (!_wasmReady) {
            await mod.default();   // <-- KEY: await __wbg_init
            _wasmReady = true;
        }
        window.__murmurModuleLoaded = true;
        console.log('[murmur] WASM module initialized');
        return mod;
    })();
    return _wasmInitPromise;
}

// Backwards-compat: ensureWasm остаётся, но теперь просто loadWasmModule().
async function ensureWasm() {
    await loadWasmModule();
}

const RELAY = "https://murmur.senswifi.ru";
const LS_NPUB = "murmur.npub";
const LS_KEY = "murmur.sk";
const LS_NAME = "murmur.name";
const LS_CONTACT_NAMES = "murmur.contact_names";
// Lesson #159 (Олег 2026-08-25 08:18 MSK): после reload локальный кэш messages[peer]
// обнуляется. Без постоянного кэша исходящие на устройстве отправителя превращаются
// в «исходящее, шифрование нарушено». Решение: outbox — localStorage кэш (sig → {body,
// att, ts, from, to}) восстанавливается на init.
const LS_OUTBOX = "murmur.outbox";
// Lesson #326 (Олег 2026-08-28 12:08 MSK): persistent кэш сообщений по peer.
// Раньше: messages[peer] сбрасывался при openChat → перерасшифровка всех фото.
// Теперь: при loadHistory сохраняем snapshot в localStorage. При openChat —
// загружаем snapshot, юзер видит чат мгновенно (с blob-cache HIT'ами для фото),
// параллельно идёт fetch только новых сообщений.
const LS_MESSAGES_CACHE = "murmur.messages_cache";
const LS_MESSAGES_MAX_TS = "murmur.messages_max_ts";
const MESSAGES_CACHE_MAX_PER_PEER = 100;

async function saveMessagesCacheForPeer(peer) {
    const arr = messages[peer] || [];
    if (arr.length === 0) return;
    const trimmed = arr.slice(-MESSAGES_CACHE_MAX_PER_PEER);
    if (!window.appStore) {
        try {
            const cache = JSON.parse(localStorage.getItem(LS_MESSAGES_CACHE) || "{}");
            cache[peer] = trimmed;
            localStorage.setItem(LS_MESSAGES_CACHE, JSON.stringify(cache));
            let maxTs = 0;
            for (const m of trimmed) if ((m.ts || 0) > maxTs) maxTs = m.ts;
            const maxTss = JSON.parse(localStorage.getItem(LS_MESSAGES_MAX_TS) || "{}");
            maxTss[peer] = maxTs;
            localStorage.setItem(LS_MESSAGES_MAX_TS, JSON.stringify(maxTss));
        } catch (e) { /* QuotaExceeded */ }
        return;
    }
    try {
        await window.appStore.chats.saveMessages(peer, trimmed);
        let maxTs = 0;
        for (const m of trimmed) if ((m.ts || 0) > maxTs) maxTs = m.ts;
        const existing = (await window.appStore.kv.get(LS_MESSAGES_MAX_TS)) || {};
        existing[peer] = maxTs;
        await window.appStore.kv.set(LS_MESSAGES_MAX_TS, existing);
    } catch (e) {
        console.warn("[murmur] appStore.chats.saveMessages failed:", e);
    }
}

async function loadMessagesCacheForPeer(peer) {
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
        messages[peer] = arr;
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
        attachments_meta: attachmentsPlaintext || [],
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
const WS_URL = RELAY.replace("https://", "wss://").replace("http://", "ws://");
const POLL_INTERVAL = 5000;
const HISTORY_LIMIT = 100;
const WS_RECONNECT_BASE = 1000;
const WS_RECONNECT_MAX = 60000;

const $ = (id) => document.getElementById(id);
const identityScreen = $("identity-screen");
const messenger = $("messenger");
const sidebar = $("sidebar");
const chatPanel = $("chat-panel");
const chatList = $("chat-list");
const messagesArea = $("messages-area");
const chatView = $("chat-view");
const noChat = $("no-chat");
const inputArea = $("input-area");
const messageInput = $("message-input");
const chatPeerName = $("chat-peer-name");
const myNpubEl = $("my-npub");
const chatSearch = $("chat-search");
// const newChatInput / btnNewChat удалены 2026-08-31 вместе с UI-полем (решение Олега)
const btnSend = $("btn-send");
const btnBack = $("btn-back");
const btnDeleteChat = $("btn-delete-chat"); // Lesson #129

let myNpub = null;
let myAlias = "anon";
let signKeyHex = null;
let contacts = {};
let messages = {};
let activePeer = null;
let oldestTsForPeer = {};
// Expose for E2E test diagnostics (Олег 2026-08-26)
window.__murmurState = () => ({ messages, activePeer, contacts });

// E2E test hooks (Playwright WebKit, 2026-08-30). Только explicit evaluate.
window.__murmurTestHooks = {
    npub: () => myNpub,
    messages: () => messages[activePeer] || [],
    allMessages: () => messages,
    activePeer: () => activePeer,
    contacts: () => Object.keys(contacts || {}),
};
let pollTimer = null;
// Attachments (Олег 2026-08-24 11:00 MSK) — файлы прикрепленные к текущему сообщению.
let pendingAttachments = [];        // [{name, mime, size, data_b64}] — уйдут в зашифрованный body
let pendingAttachmentsMeta = [];   // [{name, mime, size}] — public metadata для relay
let ws = null;
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_BASE;

function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ── WASM return wrapper ─────────────────────────────────────────────
// Rust functions now return JSON-encoded strings instead of JsValue
// objects to bypass the wasm-bindgen externref shim (which surfaces as
// bare i32 table indices on iOS Safari / some WASM runtimes). We unwrap
// the JSON string on the JS side; anything else is treated as an error.
function unwrap(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); }
        catch (e) { return { ok: false, error: 'bad json: ' + raw }; }
    }
    if (raw && typeof raw === 'object') return raw; // dev mode fallback
    return { ok: false, error: 'unexpected return: ' + String(raw) };
}

function decodeBody(bodyBase64) {
    try {
        const bytes = base64ToUint8Array(bodyBase64);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        return { text: decoder.decode(bytes), isBinary: false };
    } catch {
        const bytes = base64ToUint8Array(bodyBase64);
        return { text: "[binary, " + bytes.length + " bytes]", isBinary: true };
    }
}

// Universal body extractor: handles raw JSON envelope, raw envelope object,
// already-decoded text, or base64. Always returns {text, isBinary}.
function extractBodyText(input) {
    if (input === null || input === undefined) return { text: "", isBinary: false };
    if (typeof input === "object") {
        // already parsed envelope object
        if (input.body_base64) {
            // body_base64 holds an envelope JSON (the outer body field is the JSON
            // string), so decode base64 and recurse so we can pull out .body.
            const inner = decodeBody(input.body_base64);
            return extractBodyText(inner.text);
        }
        if (typeof input.body === "string") return { text: input.body, isBinary: false };
        // E2E envelope: ct есть → плейсхолдер, async decrypt потом обновит.
        if (typeof input.ct === "string") return { text: "🔒 шифрованное сообщение", isBinary: false, _ct: input.ct, _att: input.attachments_meta || [] };
        // Some relays wrap message envelope as a separate field; the caller
        // may pass the full history row.
        if (input.envelope && typeof input.envelope === "object") {
            return extractBodyText(input.envelope);
        }
        // 🔒 Любой иной объект → плейсхолдер (не dump raw JSON на экран).
        return { text: "🔒 шифрованное сообщение", isBinary: false };
    }
    if (typeof input !== "string") return { text: "", isBinary: false };

    const s = input;
    // Try direct JSON parse (envelope stored as JSON string)
    if (s.startsWith("{") || s.startsWith("[")) {
        try {
            const parsed = JSON.parse(s);
            if (parsed && typeof parsed === "object") {
                if (parsed.body_base64) {
                    const inner = decodeBody(parsed.body_base64);
                    return extractBodyText(inner.text);
                }
                if (typeof parsed.body === "string") return { text: parsed.body, isBinary: false };
                if (typeof parsed.ct === "string") return { text: "🔒 шифрованное сообщение", isBinary: false, _ct: parsed.ct, _att: parsed.attachments_meta || [] };
                // 🔒 JSON без body/body_base64/ct → плейсхолдер.
                return { text: "🔒 шифрованное сообщение", isBinary: false };
            }
        } catch { /* fallthrough */ }
        // 🔒 Не-JSON-как-JSON (например, бинарный blob) → плейсхолдер.
        if (s.startsWith("{")) return { text: "🔒 шифрованное сообщение", isBinary: false };
    }
    // base64-decode then JSON.parse (some relays)
    try {
        const bytes = base64ToUint8Array(s);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const txt = decoder.decode(bytes);
        if (txt.startsWith("{")) {
            const parsed = JSON.parse(txt);
            if (parsed && typeof parsed === "object") {
                if (parsed.body_base64) return decodeBody(parsed.body_base64);
                if (typeof parsed.body === "string") return { text: parsed.body, isBinary: false };
                if (typeof parsed.ct === "string") return { text: "🔒 шифрованное сообщение", isBinary: false, _ct: parsed.ct, _att: parsed.attachments_meta || [] };
                // 🔒 base64→JSON envelope без ct → плейсхолдер.
                return { text: "🔒 шифрованное сообщение", isBinary: false };
            }
        }
        return { text: txt, isBinary: false };
    } catch { /* fallthrough */ }
    // Plain text
    return { text: s, isBinary: false };
}

// extractMessageText — same logic, but accepts a message row that may carry
// the actual envelope under msg.envelope OR a base64 field under msg.body_base64
// OR the envelope JSON in msg.body (string).
function extractMessageText(msg) {
    if (!msg || typeof msg !== "object") return { text: "", isBinary: false };
    if (msg.body_base64) return extractBodyText({ body_base64: msg.body_base64 });
    if (msg.body) return extractBodyText(msg.body);
    if (msg.envelope) return extractBodyText(msg.envelope);
    return { text: "", isBinary: false };
}

// ============================================================================
// E2E decrypt helpers (sync wrapper over WASM decrypt_envelope)
// ============================================================================
//
// extractBodyText — sync, но E2E decrypt — async (WASM вызов).
// Чтобы renderMessages остался sync, делаем decrypt-then-render через
// async промисификацию. Если `ct нет, возвращаем plaintext как раньше.
//
// Новый flow при приходе envelope:
//   envelope.ct (base64) → decryptEnvelope → {body, attachments} → render
//   envelope.ct отсутствует → fallback на старый plaintext path
// ============================================================================

function extractBodyTextSync(input) {
    // Синк fallback — НЕ показывать raw envelope/JSON.
    // (Privacy bug lesson #152: dump envelope JSON на экран = утечка.)
    // Если не удалось — возвращаем плейсхолдер; async decrypt потом обновит.
    if (input === null || input === undefined) return { text: "", isBinary: false };
    if (typeof input === "object") {
        if (input.body_base64) {
            const inner = decodeBody(input.body_base64);
            return extractBodyTextSync(inner.text);
        }
        if (typeof input.body === "string") return { text: input.body, isBinary: false };
        if (input.envelope && typeof input.envelope === "object") {
            return extractBodyTextSync(input.envelope);
        }
        // 🔒 Любой иной объект (включая raw envelope) → плейсхолдер, async перерисует.
        return { text: "🔒 шифрованное сообщение", isBinary: false };
    }
    if (typeof input !== "string") return { text: "", isBinary: false };
    const s = input;
    if (s.startsWith("{") || s.startsWith("[")) {
        try {
            const parsed = JSON.parse(s);
            if (parsed && typeof parsed === "object") {
                if (parsed.body_base64) {
                    const inner = decodeBody(parsed.body_base64);
                    return extractBodyTextSync(inner.text);
                }
                if (typeof parsed.body === "string") return { text: parsed.body, isBinary: false };
                // E2E: sealed envelope в поле `ct`. Не пытаемся парсить sync.
                if (typeof parsed.ct === "string") return { text: "🔒 шифрованное сообщение", isBinary: false, _ct: parsed.ct, _att: parsed.attachments_meta || [] };
                // 🔒 Любой JSON без body/body_base64/ct → плейсхолдер, async перерисует.
                return { text: "🔒 шифрованное сообщение", isBinary: false };
            }
        } catch {}
        // Не-JSON-как-JSON (например, бинарный blob) → плейсхолдер.
        if (s.startsWith("{")) return { text: "🔒 шифрованное сообщение", isBinary: false };
    }
    try {
        const bytes = base64ToUint8Array(s);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const txt = decoder.decode(bytes);
        if (txt.startsWith("{")) {
            const parsed = JSON.parse(txt);
            if (parsed && typeof parsed === "object") {
                if (parsed.body_base64) return decodeBody(parsed.body_base64);
                if (typeof parsed.body === "string") return { text: parsed.body, isBinary: false };
                if (typeof parsed.ct === "string") return { text: "🔒 шифрованное сообщение", isBinary: false, _ct: parsed.ct, _att: parsed.attachments_meta || [] };
                // 🔒 base64→JSON envelope без ct → плейсхолдер.
                return { text: "🔒 шифрованное сообщение", isBinary: false };
            }
        }
        return { text: txt, isBinary: false };
    } catch {}
    // 🔒 Fallback: не показывать raw данные.
    return { text: "🔒 шифрованное сообщение", isBinary: false };
}

/// Async decrypt: если envelope содержит `ct`, расшифровываем через WASM ECIES.
/// Plaintext fallback если нет `ct`.
///
/// Input can be either:
///   - a message row from `/api/history` (with `body_base64` field)
///   - a parsed envelope object (with `ct` and `attachments_meta` fields)
async function decryptEnvelopeForRender(env) {
    let ct = null;
    let attachmentsMeta = [];
    if (env && typeof env === "object") {
        // (1) Already-parsed envelope: ct lives directly on the object.
        if (typeof env.ct === "string") {
            ct = env.ct;
            attachmentsMeta = env.attachments_meta || [];
        }
        // (2) Message row from /api/history: envelope bytes are base64-encoded
        //     under body_base64 (relay stores raw envelope JSON + base64-wrap).
        else if (typeof env.body_base64 === "string") {
            try {
                const innerJson = atob(env.body_base64);
                const inner = JSON.parse(innerJson);
                if (inner && typeof inner === "object" && typeof inner.ct === "string") {
                    ct = inner.ct;
                    attachmentsMeta = inner.attachments_meta || [];
                }
            } catch {}
        }
    }
    if (!ct) {
        // Plaintext fallback (старый формат без E2E).
        return extractBodyTextSync(env);
    }
    try {
        const plain = await decryptEnvelope(ct);
        // plain = {body: string, attachments: [{name, mime, size, data_b64}]}
        let body = plain.body || "";
        // Privacy v154: server meta carries neutral names (f-…bin). Merge REAL
        // names/mime from decrypted ct onto attachmentsMeta (by index) so that
        // renderAttachment / download chips show the true filename.
        if (plain.attachments && plain.attachments.length && attachmentsMeta.length) {
            for (let i = 0; i < attachmentsMeta.length; i++) {
                const pa = plain.attachments[i];
                if (pa && pa.name) {
                    attachmentsMeta[i] = Object.assign({}, attachmentsMeta[i], {
                        name: pa.name,
                        _plainName: pa.name,
                        _plainMime: pa.mime || null,
                    });
                }
            }
        }
        // Render attachments inline в body.
        if (plain.attachments && plain.attachments.length) {
            for (const a of plain.attachments) {
                body += "\n📎 " + a.name + " (" + formatSize(a.size) + ")";
            }
        }
        return { text: body, isBinary: false, attachments: plain.attachments || [], attachmentsMeta };
    } catch (e) {
        console.warn("decrypt failed:", e);
        // (Олег 2026-08-25 07:55 MSK): caller в loadHistory различает исходящие
        // и входящие — для исходящих показываем attachments_meta вместо «🔒».
        return { text: "__DECRYPT_FAILED__", isBinary: false };
    }
}

// Lesson #158 (Олег 2026-08-25 08:13 MSK): WASM decrypt может зависнуть
// без exception на iPhone PWA. Per-decrypt таймаут через Promise.race.
// Вынесен в module scope — loadHistory и pollHistoryForPeer используют.
const DECRYPT_TIMEOUT_MS = 8000;
function decryptWithTimeout(m) {
    // Lesson #228 (Олег 2026-08-26 16:42): MEMOIZE per server message.
    // Без этого каждый renderMessages() call → новый decryptWithTimeout → новый
    // fetch+decrypt → 2-4 MISS подряд на cache → photo A bubble рендерится
    // только как chip (plaintext не успел), фото исчезает при следующем render.
    // Диагностика v89: 4 renderMessages() calls для 1 message, 2 attach-cache MISS подряд.
    // Memoization: первый вызов создаёт Promise, все последующие возвращают тот же.
    if (m && m._decrypt_promise) return m._decrypt_promise;
    const p = Promise.race([
        decryptEnvelopeForRender(m),
        new Promise((_, rej) => setTimeout(() => rej(new Error("decrypt timeout " + DECRYPT_TIMEOUT_MS + "ms")), DECRYPT_TIMEOUT_MS)),
    ]).catch((e) => {
        console.warn("[murmur] decrypt failed/timed out:", e.message);
        // Lesson #228: на failure очищаем cache чтобы retry мог сработать
        if (m) m._decrypt_promise = null;
        return { text: "__DECRYPT_FAILED__", isBinary: false, attachments: [] };
    });
    if (m) m._decrypt_promise = p;
    return p;
}

/// Format byte size for UI ("4.5 MB", "123 KB")
function formatSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
    if (n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + " MB";
    return (n/(1024*1024*1024)).toFixed(2) + " GB";
}

// Convert base64 string to Blob (for outgoing attachment self-render from outbox cache).
function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new Blob([out], { type: mime || "application/octet-stream" });
}

// Render an outgoing attachment from local plaintext (no decrypt round-trip).
function renderOutgoingAttachment({ mime, name, url, size }) {
    const figure = document.createElement("figure");
    figure.className = "attach-figure";
    if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = name || "image";
        img.loading = "lazy";
        img.className = "attach-image";
        // Lesson #225: register для auto-revoke на detach
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(img, url);
        figure.appendChild(img);
    } else if (mime.startsWith("video/")) {
        const v = document.createElement("video");
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        v.className = "attach-video";
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(v, url);
        figure.appendChild(v);
    } else if (mime.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = url;
        a.controls = true;
        a.preload = "metadata";
        a.className = "attach-audio";
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(a, url);
        figure.appendChild(a);
    } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = name || "file";
        link.className = "attach-file";
        link.textContent = `📎 ${name || "file"} (${formatSize(size)})`;
        figure.appendChild(link);
    }
    return figure;
}

function formatTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
    const d = new Date(ts * 1000);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return formatTime(ts);
    if (d.toDateString() === yesterday.toDateString()) return "Вчера"; // v157b
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function formatChatTime(ts) {
    const now = Date.now() / 1000;
    const d = new Date(ts * 1000);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return formatTime(ts);
    if ((now - ts) < 7 * 86400) {
        const wd = d.toLocaleDateString([], { weekday: "short" }).toUpperCase().slice(0, 3);
        return wd + " " + formatTime(ts);
    }
    return formatDate(ts);
}

function truncateNpub(npub) {
    if (!npub || npub.length <= 14) return npub || "";
    return npub.slice(0, 8) + "..." + npub.slice(-6);
}

// Защита от утечки JSON envelope в preview sidebar:
// сервер для зашифрованных сообщений должен присылать «🔒 ...», но
// старые preview в БД или кэше могут содержать сырой JSON. Заменяем на placeholder.
function sanitizePreview(p) {
    if (!p) return "";
    const s = String(p);
    if (s.startsWith("{")) return "🔒 зашифрованное сообщение";
    return s.slice(0, 80);
}

// Stable color for an avatar based on the npub (deterministic per peer).
const AVATAR_PALETTE = [
    "#5e9aff", "#7c5cff", "#ff7c5c", "#5cff9a",
    "#ffc15c", "#ff5c9a", "#5cffd6", "#9a5cff",
    "#ffae5c", "#5cffe1", "#ff5c5c", "#5c8aff",
];
function avatarColorFor(s) {
    if (!s) return AVATAR_PALETTE[0];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shortNpub(s) {
    if (!s) return "anon";
    return s.slice(0, 6) + "..." + s.slice(-4);
}

function loadContactNames() {
    try { return JSON.parse(localStorage.getItem(LS_CONTACT_NAMES) || "{}"); }
    catch (e) { return {}; }
}

function setContactName(peer, name) {
    if (!peer || !name) return;
    const map = loadContactNames();
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    // Don't overwrite an existing manual name with a generic one.
    if (map[peer] && map[peer] === trimmed) return;
    map[peer] = trimmed;
    localStorage.setItem(LS_CONTACT_NAMES, JSON.stringify(map));
}

function saveContactName(peer, name) {
    const map = loadContactNames();
    if (name) map[peer] = name;
    else delete map[peer];
    localStorage.setItem(LS_CONTACT_NAMES, JSON.stringify(map));
}

function contactDisplay(peer) {
    // Privacy v157: npub-fallback убран — без имени показываем «Без имени».
    return loadContactNames()[peer] || "Без имени";
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunk = bytes.subarray(0, Math.min(bytes.length, 0x8000));
    binary += String.fromCharCode.apply(null, chunk);
    return btoa(binary);
}

// ── Identity Screen ──
// Lesson #211 (Олег 2026-08-26 14:14): если signing key изменился, очистить cache
// (старые blobs расшифрованы для СТАРОГО privkey — новый их не прочитает).
async function invalidateCacheIfKeyChanged() {
    if (!window.MurmurBlobCache || !window.MurmurBlobCache.isAvailable || !window.MurmurBlobCache.isAvailable()) return;
    try {
        const newHash = await sha256hex(signKeyHex);
        const tag = `murmur.cache.keyhash`;
        const prev = localStorage.getItem(tag);
        if (prev && prev !== newHash) {
            console.log("[cache] signing key changed — clearing blob cache");
            await window.MurmurBlobCache.clear();
        }
        localStorage.setItem(tag, newHash);
    } catch (e) { /* ignore — cache will keep working, just may fail decrypt */ }
}

// sha256hex helper — available globally via SubtleCrypto (used for cache key hash)
async function sha256hex(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function _handleCreate() {
    // Re-entrancy guard: на #btn-create висят ДВА листенера (app.js:840 + inline
    // bindHandler в index.html) — раньше click создавал identity ДВАЖДЫ,
    // второй enterMessenger сбрасывал открытый по #invite deep-link чат (Lesson #357).
    if (_handleCreate._running) return;
    _handleCreate._running = true;
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_new());
        // WASM returns JSON-encoded string (avoids externref shim pitfalls).
        if (!res.ok) { 
            const errEl = $("identity-error");
            if (errEl) { errEl.textContent = "Ошибка создания аккаунта: " + res.error; errEl.hidden = false; } // v157b
            return; 
        }
        myNpub = res.data.npub;
        signKeyHex = res.data.signing_sk_hex;
        myAlias = myNpub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        localStorage.setItem(LS_NAME, myAlias);
        await invalidateCacheIfKeyChanged();
        enterMessenger();
    } catch (e) {
        console.error("[murmur] _handleCreate error:", e);
        const errEl = $("identity-error");
        if (errEl) {
            errEl.textContent = "Ошибка: " + (e.message || String(e)); // v157b
            errEl.hidden = false;
        }
    } finally {
        _handleCreate._running = false;
    }
}
window.__murmurCreate = _handleCreate;
// Expose handlers on window so the inline handlers in index.html can call them
// after the WASM/module has finished loading.
window._handleCreate = _handleCreate;
window._handleRestore = async function() {
    const hex = $("restore-hex").value.trim();
    if (!hex || hex.length < 60) { $("identity-error").textContent = "Введите ключ: 64 символа"; return; } // v157b
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_restore(hex));
        if (!res.ok) { $("identity-error").textContent = "Ошибка восстановления: " + res.error; return; } // v157b
        myNpub = res.data.npub;
        signKeyHex = hex;
        myAlias = res.data.npub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        localStorage.setItem(LS_NAME, myAlias);
        await invalidateCacheIfKeyChanged();
        enterMessenger();
    } catch (e) { $("identity-error").textContent = "Error: " + e.message; }
};
$("btn-create")?.addEventListener("click", _handleCreate);

$("btn-restore")?.addEventListener("click", async () => {
    const hex = $("restore-hex").value.trim();
    if (!hex || hex.length < 60) { $("identity-error").textContent = "Введите ключ: 64 символа"; return; } // v157b
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_restore(hex));
        if (!res.ok) { $("identity-error").textContent = "Ошибка восстановления: " + res.error; return; } // v157b
        myNpub = res.data.npub;
        signKeyHex = hex;
        myAlias = localStorage.getItem(LS_NAME) || myNpub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        enterMessenger();
    } catch (e) { $("identity-error").textContent = "Error: " + e.message; }
});

function enterMessenger() {
    identityScreen.style.display = "none";
    identityScreen.hidden = true;
    messenger.hidden = false;
    messenger.classList.add("active");
    // Lesson #212: show app version + SW version banner for debugging
    const banner = $("version-banner");
    if (banner) {
        // Lesson #222: 3-tier version detection — meta tag → window var → script query
        let scriptVer = "?";
        try {
            const meta = document.querySelector('meta[name="app-version"]');
            if (meta && meta.content) {
                scriptVer = meta.content.replace(/^v/i, "");
            }
        } catch (e) {}
        if (scriptVer === "?") scriptVer = window.__APP_VERSION__ || "?";
        banner.textContent = `v${scriptVer}`; // v157b: только версия — Олегу достаточно
        banner.title = `Build murmur-v${window.__APP_VERSION__ || "?"}. SW=push-only, no static control.`; // v157b
    }
    if (myNpubEl) { /* v157: элемент удалён из HTML, npub не показываем */ }
    const fullEl = $("my-npub-full");
    if (fullEl) fullEl.textContent = myNpub;
    // CRITICAL: Register alias immediately so history queries find us on either side.
    // Use the user-chosen alias if available (LS_NAME key holds the chosen
    // display name), otherwise fall back to npub for first-run. We then
    // upsert the canonical alias under both names so the relay can find us
    // regardless of whether the sender typed our display name or our npub.
    const preferredAlias = myAlias || myNpub;
    fetch(RELAY + "/api/register_alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: preferredAlias, npub: myNpub })
    }).then(r => r.json().then(j => console.log("register_alias on enter:", j)))
      .catch(e => console.warn("register_alias on enter failed:", e));
    const copyBtn = $("btn-copy-npub");
    if (copyBtn && !copyBtn.dataset.bound) {
        copyBtn.dataset.bound = "1";
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(myNpub);
                const old = copyBtn.textContent;
                copyBtn.textContent = "✓ Скопировано";
                setTimeout(() => { copyBtn.textContent = old; }, 1400);
            } catch (e) {
                // iOS Safari fallback: use a temp textarea
                const ta = document.createElement("textarea");
                ta.value = myNpub;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); copyBtn.textContent = "✓ Скопировано"; }
                catch { copyBtn.textContent = "✗ Ошибка"; }
                document.body.removeChild(ta);
                setTimeout(() => { copyBtn.textContent = "📋 Скопировать"; }, 1400);
            }
        });
    }
    // First-time hint removed: имя назначается только через «Нажмите, чтобы задать имя»
    // в заголовке чата. Никаких prompt() и LS_DISPLAY_NAME.
    if (chatView) chatView.style.display = "none";
    if (chatView) chatView.hidden = true;
    if (noChat) noChat.style.display = "flex";
    if (noChat) noChat.hidden = false;
    if (inputArea) inputArea.classList.remove("visible");
    if (inputArea) inputArea.hidden = true;
    const m = document.querySelector(".messenger");
    if (m) m.classList.remove("chat-open");
    renderChatList();
    loadContacts();
    // connectWS();  // DISABLED: WS reconnect storm blocks fetches in browsers without proxying WS.
                       // Push via WebSocket is replaced by polling (pollHistoryForPeer + pollInbox).
    startPolling();
    setupPushSubscription();
    updateBadge();
    setupInviteUI();
    // Deep-link invite: .../#invite=<npub> → открыть чат с этим контактом.
    // Выполняется после enterMessenger: identity создана/восстановлена, DOM готов.
    handleInviteHash();
}

// (старый мягкий logout-обработчик удалён 2026-08-31: кнопка btn-logout теперь
// «Удалить все данные», полный wipe в setupInviteUI — двойной обработчик давал 2 confirm-диалога)
//
// `subscribed` is true if EITHER permission="granted" in browser AND server
// has at least one subscription record for our alias. We also surface a
// short status text so it's obvious if there are duplicate records (Lesson
// #131.12 — old registrations piling up before upsert_by_endpoint).
async function updateNotifBtnState() {
    if (!notifBtn) return;
    const perm = (typeof Notification !== "undefined") ? Notification.permission : "default";
    let serverHasSub = false;
    let serverCount = 0;
    let serverEndNote = "";

    // Олег 2026-08-24 11:55 MSK: добавлена локальная проверка pushManager.getSubscription().
    // Без неё кнопка показывает выкл (без класса .on), если браузер дал granted,
    // но сервер не видит подписку. Тогда на :hover кнопка 'загорается' (accent),
    // а push всё равно приходят — путаница. Источник истины — браузерная подписка.
    let browserHasSub = false;
    if (perm === "granted" && "serviceWorker" in navigator && "PushManager" in window) {
        try {
            // Олег 2026-08-24 10:14 MSK: добавляем таймаут на SW.ready.
            // Без таймаута при первом запуске (SW ещё не зарегистрирован,
            // register() в index.html не успел) функция зависает, и кнопка
            // остаётся выкл пока пользователь не кликнет повторно.
            const reg = await Promise.race([
                navigator.serviceWorker.ready,
                new Promise((_, rej) => setTimeout(() => rej(new Error("SW.ready timeout 2s")), 2000)),
            ]);
            const sub = await reg.pushManager.getSubscription();
            browserHasSub = !!sub;
        } catch (e) { /* ignore — SW ещё не готов, считаем как нет подписки */ }
    }

    if (perm === "granted" && (myAlias || myNpub)) {
        try {
            // Try the user-chosen alias first (e.g. "Oleg"); fall back to npub
            // if the user never set a display name.
            const tried = [];
            for (const candidate of [myAlias, myNpub].filter(Boolean)) {
                const r = await fetch(RELAY + "/push/status?alias=" + encodeURIComponent(candidate), { cache: "no-store" });
                const j = await r.json();
                tried.push(candidate);
                if (j && j.subscribed) {
                    serverHasSub = true;
                    serverCount = j.count;
                    break;
                }
            }
            if (serverCount > 1) {
                serverEndNote = " · " + serverCount + " дубликатов на сервере";
            }
        } catch (e) { /* ignore */ }
    }
    // Кнопка .on если браузер видит активную подписку. Серверный статус —
    // только информативный суффикс в title.
    if (perm === "granted" && browserHasSub) {
        notifBtn.classList.add("on");
        notifBtn.title = "Уведомления включены" + serverEndNote + " — нажми чтобы отключить";
    } else if (perm === "granted") {
        notifBtn.classList.remove("on");
        notifBtn.title = "Браузер разрешил, но подписки нет — нажми чтобы переподключить";
    } else if (perm === "denied") {
        notifBtn.classList.remove("on");
        notifBtn.title = "Уведомления заблокированы в Safari — разрешите в Настройки";
    } else {
        notifBtn.classList.remove("on");
        notifBtn.title = "Включить уведомления";
    }
}
const notifBtn = $("btn-notifications");
// Lesson #211 + #215 (Олег 2026-08-26 14:14 / 14:33): manual cache stats + clear
const cacheStatsBtn = $("btn-cache-stats");
if (cacheStatsBtn && !cacheStatsBtn.dataset.bound) {
    cacheStatsBtn.dataset.bound = "1";
    const cache = window.MurmurBlobCache;
    // Lesson #215: показывать кнопку только если в cache что-то есть
    if (cache && cache.isAvailable && cache.isAvailable()) {
        cache.stats().then(s => {
            if (s.count > 0) {
                cacheStatsBtn.style.display = "";
                cacheStatsBtn.title = `Кэш: ${s.count} файлов, ${(s.bytes / 1024 / 1024).toFixed(1)} MB`;
            }
        }).catch(() => {});
    }
    cacheStatsBtn.addEventListener("click", async () => {
        cacheStatsBtn.disabled = true;
        try {
            // const cache уже объявлен снаружи (Lesson #215)
            if (!cache || !cache.isAvailable()) {
                alert("IndexedDB недоступен на этом устройстве.");
                return;
            }
            const stats = await cache.stats();
            if (stats.count === 0) {
                alert(`Кэш пуст (0 MB / ${Math.round(stats.maxBytes / 1024 / 1024)} MB лимит)`);
                return;
            }
            const mb = (stats.bytes / 1024 / 1024).toFixed(1);
            const limitMb = Math.round(stats.maxBytes / 1024 / 1024);
            if (confirm(`Кэш: ${stats.count} файлов, ${mb} MB / ${limitMb} MB.\n\nОчистить кэш? (attachments перезагрузятся при следующем просмотре)`)) {
                await cache.clear();
                alert("Кэш очищен. Перезагрузи страницу для применения.");
                // Don't auto-reload — let user decide.
                cacheStatsBtn.title = "Кэш очищен (пуст)";
            }
        } catch (e) {
            alert("Ошибка: " + e.message);
        } finally {
            cacheStatsBtn.disabled = false;
        }
    });
}
// Lesson #227 (Олег 2026-08-26 16:25): DIAGNOSTIC button — выводит
// window.__MURMUR_DIAG__ JSON в alert. Использовать для воспроизведения бага.
const diagBtn = $("btn-diag");
if (diagBtn && !diagBtn.dataset.bound) {
    diagBtn.dataset.bound = "1";
    diagBtn.style.display = "";
    diagBtn.addEventListener("click", () => {
        const d = window.__MURMUR_DIAG__ || { msg: "no diag data yet" };
        // Also collect current DOM state.
        const domState = {
            imgs_in_dom: document.querySelectorAll("img.attach-image").length,
            imgs_with_blob: Array.from(document.querySelectorAll("img.attach-image")).filter(i => i.src.startsWith("blob:")).length,
            imgs_broken: Array.from(document.querySelectorAll("img.attach-image")).filter(i => i.naturalWidth === 0 && i.src.startsWith("blob:")).length,
            bubbles_with_chip: document.querySelectorAll(".msg-attach-remote").length,
            outgoing_bubbles: document.querySelectorAll(".msg.out").length,
        };
        d.dom_now = domState;
        const text = JSON.stringify(d, null, 2);
        // Use textarea (alert can't show long text well)
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:5%;left:5%;width:90%;height:90%;z-index:99999;font-size:11px;font-family:monospace;background:#fff;color:#000;";
        ta.id = "__murmur_diag_modal__";
        const close = document.createElement("button");
        close.textContent = "✕ ЗАКРЫТЬ";
        close.style.cssText = "position:fixed;top:5%;right:5%;z-index:100000;padding:5px 10px;background:#f00;color:#fff;border:none;font-weight:bold;cursor:pointer;";
        close.onclick = () => { ta.remove(); close.remove(); };
        document.body.appendChild(ta);
        document.body.appendChild(close);
        console.log("[MURMUR-DIAG]", d);
    });
}
if (notifBtn && !notifBtn.dataset.bound) {
    notifBtn.dataset.bound = "1";
    updateNotifBtnState();
    notifBtn.addEventListener("click", async () => {
        notifBtn.disabled = true;
        try {
            // If currently enabled, click toggles off — unsubscribe on server.
            if (Notification && Notification.permission === "granted") {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    const sub = await reg.pushManager.getSubscription();
                    if (sub) {
                        await sub.unsubscribe();
                        console.log("[push] browser subscription removed");
                    }
                } catch (e) { /* ignore */ }
                // Also clear server-side records for this alias.
                if (myAlias) {
                    fetch(RELAY + "/push/unsubscribe", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ alias: myAlias }),
                    }).catch(() => {});
                }
            } else {
                await requestPushPermission();
            }
        } finally {
            await updateNotifBtnState();
            notifBtn.disabled = false;
        }
    });
}

// Олег 2026-08-24 10:14 MSK: пересчитываем кнопку при изменении подписки
// (например, после удаления PWA или logout). Без этого кнопка остаётся выкл,
// а push идут (или наоборот). Также повторяем после регистрации SW, т.к.
// init-блок выше мог запуститься до navigator.serviceWorker.ready.
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then(() => {
        updateNotifBtnState();
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "push-subscription-change") {
            updateNotifBtnState();
        }
    });
}
setTimeout(() => updateNotifBtnState(), 3000); // final fallback
//
// Lesson #125: unreadCount хранится локально (localStorage).
// Сервер — только address book (alias ↔ npub) и relay. Никакой
// server-side логики для badge — это нам неподконтрольно через CF Tunnel.
//
// Lesson #126: нормализация npub в одном каноническом виде.
// Отправитель иногда присылает peer с pipe-артефактом вроде
// "npub1u|fm6w6k3...|jn|8468es5gr..." (видно в localStorage в одном
// из контактов Олега). bech32 не должен содержать '|', значит это
// legacy-мусор, и при bumpUnread/contacts мы должны использовать
// чистый npub. Правило: если в peer есть '|' — берём самый длинный
// кусок, начинающийся с "npub1" (или "nsec1"), иначе саму строку.
function normalizePeer(peer) {
    if (!peer) return peer;
    if (peer.indexOf("|") < 0) return peer;
    // Разбиваем по '|' и ищем кусок, начинающийся с npub1 / nsec1
    const parts = peer.split("|");
    let best = null;
    for (const p of parts) {
        if (p.startsWith("npub1") || p.startsWith("nsec1")) {
            if (!best || p.length > best.length) best = p;
        }
    }
    if (best) return best;
    // Не нашли npub1/nsec1 — возвращаем как есть (для alias-имён).
    return peer;
}

const LS_UNREAD = "murmur_unread_v1";
// Lesson #127: при reload WS переотправляет «свежие» envelopes — они
// могут быть уже прочитанными (мы открыли чат и сбросили unread), но
// bumpUnread увеличивает обратно. Решение: хранить maxTs по каждому
// peer'у (самый поздний уже показанный envelope). На reload любой
// envelope с ts <= maxTs игнорируется для bumpUnread.
const LS_MAXTS = "murmur_maxts_v1";
// Lesson #129: chat delete — скрытие чата на клиенте. Peer орёт-в localStorage,
// в sidebar не показывается. На сервере ничего не удаляется (TTL 24ч удалит само).
const LS_HIDDEN_PEERS = "murmur_hidden_peers_v1";
// Lesson #132.5: tombstone при удалении чата. Карта peer -> ts удаления.
// При polling новый unhidePeer сработает ТОЛЬКО если msg.ts > tombstone[peer].
// Без этого fix'а: polling приходит с msg.ts <= tombstone и снимает скрытие,
// потому что lesson #132.1 (любое новое сообщение для peer'а) сталкивается
// с re-fetch старых envelopes в /api/history. tombstone отсекает старые.
const LS_DELETED_TS = "murmur_deleted_ts_v1";

function loadUnreadMap() {
    try {
        const raw = localStorage.getItem(LS_UNREAD) || "{}";
        const obj = JSON.parse(raw);
        // Lesson #126 cleanup: удаляем записи с пустым/мусорным значением или
        // с ключом, который после normalizePeer даёт другое имя.
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
            if (!v || v <= 0) continue;
            const nk = normalizePeer(k);
            if (nk !== k) {
                // Объединяем со старым значением, если оно уже есть.
                cleaned[nk] = (cleaned[nk] || 0) + (v || 0);
            } else {
                cleaned[nk] = (cleaned[nk] || 0) + (v || 0);
            }
        }
        if (Object.keys(cleaned).length !== Object.keys(obj).length) {
            saveUnreadMap(cleaned);
        }
        return cleaned;
    } catch { return {}; }
}
function saveUnreadMap(m) {
    try { localStorage.setItem(LS_UNREAD, JSON.stringify(m)); } catch {}
}
function getUnread(peer) {
    const m = loadUnreadMap();
    return m[peer] || 0;
}
function setUnread(peer, n) {
    const m = loadUnreadMap();
    if (n <= 0) delete m[peer]; else m[peer] = n;
    saveUnreadMap(m);
    updateBadge();
}
function bumpUnread(peer) {
    peer = normalizePeer(peer);
    const m = loadUnreadMap();
    m[peer] = (m[peer] || 0) + 1;
    saveUnreadMap(m);
    updateBadge();
}
function clearUnread(peer) {
    peer = normalizePeer(peer);
    setUnread(peer, 0);
}

function loadMaxTsMap() {
    try { return JSON.parse(localStorage.getItem(LS_MAXTS) || "{}"); } catch { return {}; }
}
function saveMaxTsMap(m) {
    try { localStorage.setItem(LS_MAXTS, JSON.stringify(m)); } catch {}
}
function getMaxTs(peer) {
    peer = normalizePeer(peer);
    const m = loadMaxTsMap();
    return m[peer] || 0;
}
function updateMaxTs(peer, ts) {
    peer = normalizePeer(peer);
    if (!ts) return;
    const m = loadMaxTsMap();
    if (ts > (m[peer] || 0)) {
        m[peer] = ts;
        saveMaxTsMap(m);
    }
}

// Lesson #129: hidden peer management.
// Массив в localStorage — потому что Set не сериализуется JSON'ом.
function loadHiddenPeers() {
    try {
        const raw = localStorage.getItem(LS_HIDDEN_PEERS) || "[]";
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.map(normalizePeer).filter(Boolean);
    } catch { return []; }
}
function saveHiddenPeers(arr) {
    try { localStorage.setItem(LS_HIDDEN_PEERS, JSON.stringify(arr)); } catch {}
}
function isHiddenPeer(peer) {
    peer = normalizePeer(peer);
    if (!peer) return false;
    return loadHiddenPeers().includes(peer);
}
function hidePeer(peer) {
    peer = normalizePeer(peer);
    if (!peer) return;
    const arr = loadHiddenPeers();
    if (!arr.includes(peer)) {
        arr.push(peer);
        saveHiddenPeers(arr);
    }
    // Lesson #132.5: tombstone — записываем ts удаления, чтобы polling
    // восстановил чат только при РЕАЛЬНО новом сообщении (ts > tombstone),
    // а не на любой re-fetch старого envelope из /api/history.
    try {
        const raw = localStorage.getItem(LS_DELETED_TS) || "{}";
        const map = JSON.parse(raw);
        map[peer] = Math.floor(Date.now() / 1000);
        localStorage.setItem(LS_DELETED_TS, JSON.stringify(map));
    } catch (e) { /* best effort */ }
    clearUnread(peer);
}
function unhidePeer(peer) {
    peer = normalizePeer(peer);
    if (!peer) return;
    const arr = loadHiddenPeers().filter(p => p !== peer);
    saveHiddenPeers(arr);
    // Lesson #132.5: tombstone снимается вместе со скрытием — чат снова живой.
    try {
        const raw = localStorage.getItem(LS_DELETED_TS) || "{}";
        const map = JSON.parse(raw);
        if (peer in map) { delete map[peer]; localStorage.setItem(LS_DELETED_TS, JSON.stringify(map)); }
    } catch (e) { /* best effort */ }
}

function getDeletedTs(peer) {
    peer = normalizePeer(peer);
    try {
        const raw = localStorage.getItem(LS_DELETED_TS) || "{}";
        const map = JSON.parse(raw);
        return map[peer] || 0;
    } catch (e) { return 0; }
}


// ─── Push notifications + badge ───
function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
    return out;
}

async function setupPushSubscription() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        console.log("[push] PushManager not supported");
        return;
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const vapidKey = await fetch(RELAY + "/vapid_public_key").then(r => r.text());
            if (!vapidKey || vapidKey.length < 20) {
                console.warn("[push] vapid key invalid:", vapidKey);
                return;
            }
            const perm = Notification.permission;
            if (perm === "denied") {
                console.warn("[push] notifications denied by user");
                return;
            }
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey),
            });
            console.log("[push] created new browser subscription");
        } else {
            console.log("[push] re-using existing browser subscription, endpoint=", sub.endpoint.slice(0, 60));
        }
        const subJson = sub.toJSON();
        // Use the user-chosen alias (e.g. "Oleg", "Ирина") so the relay can
        // match incoming envelopes whose `to_alias` is the human-readable name.
        // Fall back to npub only if no alias has been chosen yet — this keeps
        // pushes working through onboarding but breaks as soon as the user picks
        // a real alias (the old npub subscription stops matching).
        //
        // CRITICAL (Lesson #131.10): always re-register on the server, even
        // when reusing the existing browser subscription. Otherwise the server
        // keeps the old `alias = npub1...` and never matches new envelopes.
        const subAlias = myAlias || myNpub;
        const r = await fetch(RELAY + "/push/register_subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alias: subAlias, subscription: subJson }),
        });
        if (!r.ok) {
            console.warn("[push] register_subscribe HTTP", r.status, await r.text());
        } else {
            console.log("[push] registered on server as alias=", subAlias);
        }
    } catch (e) {
        console.warn("[push] setup failed:", e && e.message);
    }
}

async function requestPushPermission() {
    if (!("Notification" in window)) {
        alert("Браузер не поддерживает уведомления");
        return;
    }
    if (Notification.permission === "granted") {
        await setupPushSubscription();
        return;
    }
    if (Notification.permission === "denied") {
        alert("Уведомления заблокированы. Включите в Safari → Настройки сайтов → Уведомления.");
        return;
    }
    const result = await Notification.requestPermission();
    console.log("[push] permission:", result);
    if (result === "granted") {
        await setupPushSubscription();
    }
}

function getTotalUnread() {
    const m = loadUnreadMap();
    let total = 0;
    for (const v of Object.values(m)) total += (v || 0);
    return total;
}

async function updateBadge() {
    const total = getTotalUnread();
    try {
        if ("setAppBadge" in navigator) {
            if (total > 0) await navigator.setAppBadge(total);
            else if ("clearAppBadge" in navigator) await navigator.clearAppBadge();
        }
    } catch (e) {
        console.debug("[badge] failed:", e && e.message);
    }
}

async function loadContacts() {
    if (!myNpub) return;
    try {
        const r = await fetch(RELAY + "/api/contacts?npub=" + encodeURIComponent(myNpub) + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
        if (!r.ok) return;
        const j = await r.json();
        if (j.contacts) {
            const unreadMap = loadUnreadMap();
            for (const c of j.contacts) {
                const key = normalizePeer(c.peer);
                if (!contacts[key]) {
                    // Новый контакт — восстанавливаем unread из localStorage.
                    contacts[key] = {
                        peer: c.peer,
                        lastMessagePreview: sanitizePreview(c.last_message_preview),
                        lastTs: c.last_ts || 0,
                        unreadCount: unreadMap[key] || 0,
                    };
                } else {
                    if (c.last_ts > contacts[key].lastTs) {
                        contacts[key].lastMessagePreview = sanitizePreview(c.last_message_preview);
                        contacts[key].lastTs = c.last_ts;
                    }
                    // Не перезаписываем локальный unread с сервера — мы их считаем сами.
                }
            }
            renderChatList();
        }
    } catch (e) { console.warn("loadContacts failed:", e); }
    // Lesson #342 (Олег 2026-08-30): восстановление чатов из локальных хранилищ.
    // Если сервер не вернул контакты (alias race, network drop), чаты исчезают
    // из сайдбара хотя никуда не девались. Merge peers из IDB chats + outbox.
    try {
        const localPeers = new Set();
        if (window.appStore && window.appStore.chats.listPeers) {
            // Lesson #344 (Олег 2026-08-30 14:20 MSK): ключ chats в IDB — это
            // peer (npub БЕЗ владельца), old identities оставались в базе →
            // «12 чатов-призраков». Берём из кэша только тех peers, у которых
            // есть реальные сообщения и peer ≠ мой npub.
            for (const p of (await window.appStore.chats.listPeers())) {
                const np = normalizePeer(p);
                if (!np || np === myNpub) continue;
                const rec = await window.appStore.chats.getMessages(np);
                if (Array.isArray(rec) && rec.length > 0) localPeers.add(np);
            }
        }
        let outbox = {};
        if (window.appStore) {
            outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
        } else {
            outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        }
        for (const [k, m] of Object.entries(outbox)) {
            // Lesson #343 (Олег 2026-08-30 13:29 MSK): брать только чаты,
            // относящиеся к ТЕКУЩЕЙ личности. Раньше брали from и to всех
            // записей — в outbox оставались адресаты старых (пересозданных)
            // личностей → в сайдбаре смешивались ключи и чаты.
            if (!m || typeof m !== "object") continue;
            if (m.from === myNpub && m.to && m.to.startsWith("npub1")) localPeers.add(normalizePeer(m.to));
            if (m.to === myNpub && m.from && m.from.startsWith("npub1")) localPeers.add(normalizePeer(m.from));
        }
        let addedAny = false;
        for (const peer of localPeers) {
            if (!peer || isHiddenPeer(peer) || contacts[peer]) continue;
            contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: getUnread(peer) };
            addedAny = true;
        }
        if (addedAny) {
            console.log("[murmur] restored", localPeers.size, "local peers into contacts");
            renderChatList();
        }
    } catch (e) { console.warn("[murmur] local contact restore failed:", e); }
    // Lesson #344b (Олег 2026-08-30 14:20 MSK): зачистка кэша старых личностей.
    // IDB chats ключуется голым peer без владельца. Периодически вычищаем
    // записи, не относящиеся к текущемуmyNpub (по outbox связке from==myNpub).
    try {
        if (window.appStore && window.appStore.chats.listPeers) {
            const known = new Set(Object.keys(contacts).map(normalizePeer));
            for (const p of (await window.appStore.chats.listPeers())) {
                const np = normalizePeer(p);
                if (np && np !== myNpub && !known.has(np)) {
                    await window.appStore.chats.deleteMessages(np).catch(() => {});
                }
            }
        }
    } catch (e) { /* ignore */ }
}

function renderChatList() {
    const filter = chatSearch.value.toLowerCase().trim();
    chatList.innerHTML = "";
    const nameMap = loadContactNames();
    const sorted = Object.values(contacts)
        .filter(c => {
            // Lesson #129: hidden peers не отображаются в sidebar.
            if (isHiddenPeer(c.peer)) return false;
            if (!filter) return true;
            const display = (nameMap[c.peer] || "").toLowerCase();
            return c.peer.toLowerCase().includes(filter) || display.includes(filter);
        })
        .sort((a, b) => b.lastTs - a.lastTs);

    if (sorted.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chat-empty";
        empty.innerHTML =
            "<div class='chat-empty-title'>" +
                (filter ? "Ничего не найдено по запросу «" + escapeHtml(filter) + "»" : "Пока нет чатов") +
            "</div>" +
            "<div class='chat-empty-hint'>" +
                "Нажмите «Пригласить друга», чтобы отправить ссылку-приглашение." +
            "</div>"; // v157b: «+» убран (кнопки нет с v153), только «Пригласить друга»
        chatList.appendChild(empty);
        return;
    }

    for (const c of sorted) {
        const div = document.createElement("div");
        div.className = "chat-item" + (activePeer === c.peer ? " active" : "");
        const preview = c.lastMessagePreview
            ? (c.lastMessagePreview.length > 60 ? c.lastMessagePreview.slice(0, 60) + "…" : c.lastMessagePreview)
            : "Нет сообщений"; // v157b: без английского
        const name = nameMap[c.peer];
        // Privacy v157: npub не показываем в списке чатов. Без имени — «Без имени».
        const displayName = name || "Без имени";
        const avatarInitial = (name || "?").slice(0, 1).toUpperCase();
        const avatarColor = avatarColorFor(c.peer);
        // Lesson #v157: active-highlight работал через textContent-сравнение
        // с несуществующим классом .chat-item-peer — никогда не срабатывал.
        // Теперь: data-peer атрибут + dataset-сравнение в openChat.
        const peerDisplay = escapeHtml(displayName);
        const timeDisplay = formatChatTime(c.lastTs);
        const badge = c.unreadCount > 0 ? "<span class='chat-item-badge'>" + c.unreadCount + "</span>" : "";
        const previewEsc = escapeHtml(preview);
        div.setAttribute("data-peer", c.peer);
        div.innerHTML =
            "<div class='chat-item-avatar' style='background:" + avatarColor + "'>" + avatarInitial + "</div>" +
            "<div class='chat-item-body'>" +
                "<div class='chat-item-name'>" + peerDisplay + "</div>" +
                "<div class='chat-item-preview'>" + previewEsc + "</div>" +
            "</div>" +
            "<div class='chat-item-meta'>" +
                "<span class='chat-item-time'>" + timeDisplay + "</span>" +
                badge +
            "</div>";
        div.addEventListener("click", () => openChat(c.peer));
        chatList.appendChild(div);
    }
}

// ── UI Helpers (Invite & Logout) ───
function handleInviteHash() {
    // Deep-link вида https://host/#invite=<npub>.
    // Выполняем только когда мы в мессенджере (identity есть).
    const m = document.querySelector(".messenger");
    if (!m) return;
    const h = (location.hash || "");
    const mt = h.match(/^#invite=(npub1[a-z0-9]+)/i);
    if (!mt) return;
    const peer = mt[1];
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    // Если чат уже существует — просто открыть; иначе создать контакт и открыть.
    if (typeof openChat !== "function") return;
    if (!contacts[peer]) {
        contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        renderChatList();
    }
    openChat(peer);
    setTimeout(() => { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }, 50);
}
function setupInviteUI() {
    // Guard: enterMessenger может вызываться повторно (boot/restore/poll-reconnect).
    // Без guard'а на кнопки вешаются дубли обработчиков → двойные confirm/alert (Lesson #356).
    if (setupInviteUI._bound) return;
    setupInviteUI._bound = true;
    const btnInvite = $("btn-invite");
    const btnLogout = $("btn-logout");

    if (btnInvite) {
        btnInvite.addEventListener("click", async () => {
            const inviteLink = `${window.location.origin}${window.location.pathname}#invite=${myNpub}`;
            // Step 1: synchronous copy INSIDE the user gesture.
            // iOS Safari/PWA requires this; after any await the gesture is consumed
            // and clipboard APIs throw NotAllowedError (Lesson #355).
            const copied = legacyCopy(inviteLink);
            // Step 2: native share menu when available (mobile UX preference).
            if (navigator.share) {
                try {
                    await navigator.share({
                        title: "murmur",
                        text: "Присоединяйся в приватном мессенджере murmur!",
                        url: inviteLink,
                    });
                    return;
                } catch (e) {
                    if (e.name === "AbortError") return; // user closed the share sheet
                    // real share failure → fall through, we already tried copying
                }
            }
            // Step 3: report result
            if (copied) {
                alert("Ссылка скопирована в буфер обмена!");
            } else {
                try {
                    await navigator.clipboard.writeText(inviteLink);
                    alert("Ссылка скопирована в буфер обмена!");
                } catch (e) {
                    // Last resort: manual copy overlay (fresh gesture works there)
                    showInviteManualCopy(inviteLink);
                }
            }
        });
    }

    if (btnLogout) {
        btnLogout.addEventListener("click", async () => {
            if (!confirm("Все ваши данные (личность, ключи, история чатов) будут безвозвратно удалены с этого устройства. Продолжить?")) {
                return;
            }
            localStorage.clear();
            // For robustness: clear IDB if appStore exists (chats store + blob cache)
            if (window.appStore) {
                try {
                    for (const p of (await window.appStore.chats.listPeers())) {
                        await window.appStore.chats.deleteMessages(p);
                    }
                } catch (e) { console.warn(e); }
                try { await window.MurmurBlobCache.clear(); } catch (e) { console.warn(e); }
            }
            window.location.reload();
        });
    }
}

function legacyCopy(text) {
    // Classic textarea + execCommand — the only copy method iOS allows
    // inside a user-gesture (clipboard.writeText throws NotAllowedError in PWA).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}

function showInviteManualCopy(inviteLink) {
    let ov = document.getElementById("invite-fallback");
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.id = "invite-fallback";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;";
    const box = document.createElement("div");
    box.style.cssText = "background:#17212b;border-radius:12px;padding:18px;max-width:340px;width:100%;color:#e8edf2;font:14px -apple-system,sans-serif;box-sizing:border-box;";
    const title = document.createElement("div");
    title.textContent = "Ссылка-приглашение";
    title.style.cssText = "margin-bottom:10px;font-weight:600;font-size:15px;";
    const hint = document.createElement("div");
    hint.textContent = "Удерживайте палец на поле ниже → «Скопировать», либо нажмите кнопку.";
    hint.style.cssText = "margin-bottom:12px;color:#8a97a5;font-size:13px;line-height:1.4;";
    const inp = document.createElement("input");
    inp.readOnly = true;
    inp.value = inviteLink;
    inp.style.cssText = "width:100%;box-sizing:border-box;background:#0e1621;color:#e8edf2;border:1px solid #2a3b4d;border-radius:8px;padding:10px;font-size:13px;";
    const btnCopy = document.createElement("button");
    btnCopy.textContent = "Скопировать";
    btnCopy.style.cssText = "margin-top:12px;width:100%;background:#2b5278;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;";
    btnCopy.addEventListener("click", () => {
        inp.select();
        if (legacyCopy(inp.value)) {
            ov.remove();
            alert("Ссылка скопирована в буфер обмена!");
        }
    });
    const btnClose = document.createElement("button");
    btnClose.textContent = "Закрыть";
    btnClose.style.cssText = "margin-top:8px;width:100%;background:transparent;color:#8a97a5;border:0;padding:6px;font-size:13px;";
    btnClose.addEventListener("click", () => ov.remove());
    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(inp);
    box.appendChild(btnCopy);
    box.appendChild(btnClose);
    ov.appendChild(box);
    document.body.appendChild(ov);
    inp.focus();
    inp.select();
}

// ── Open Chat ──
function openChat(peer) {
    peer = normalizePeer(peer);
    activePeer = peer;
    const m = document.querySelector(".messenger");
    if (m) m.classList.add("chat-open");
    chatList.querySelectorAll(".chat-item").forEach(el => {
        // v157: было сравнение textContent с несуществующим .chat-item-peer
        // (всегда false → active никогда не подсвечивался). Теперь data-peer.
        el.classList.toggle("active", el.dataset && el.dataset.peer === peer);
    });
    if (contacts[peer]) contacts[peer].unreadCount = 0;
    clearUnread(peer);
    // Lesson #129: показываем кнопку «удалить чат».
    if (btnDeleteChat) btnDeleteChat.hidden = false;
    renderChatList();  // обновить бейдж в списке чатов
    chatView.style.display = "flex";
    chatView.hidden = false;
    noChat.style.display = "none";
    noChat.hidden = true;
    inputArea.hidden = false;
    inputArea.classList.add("visible");
    const nameMap = loadContactNames();
    const savedName = nameMap[peer];
    // Privacy v157 (Олег 31.08 «npub явно лишний, убрать везде»): npub больше
    // не показываем в UI. Без заданного имени — «Без имени», клик открывает
    // диалог задания имени. Полный npub остаётся только в title-тултипе
    // (не часть visual UI; полезно на десктопе для отладки).
    if (savedName) {
        chatPeerName.innerHTML =
            "<span class='peer-name-main'>" + escapeHtml(savedName) + "</span>";
    } else {
        chatPeerName.innerHTML = "<span class='peer-name-main peer-name-unnamed'>Без имени</span>";
    }
    chatPeerName.title = "Нажмите, чтобы задать имя";
    chatPeerName.onclick = () => {
        const current = loadContactNames()[peer] || "";
        const v = prompt("Название чата:", current);
        if (v === null) return;
        const trimmed = v.trim().slice(0, 24);
        saveContactName(peer, trimmed);
        openChat(peer);
    };
    // Lesson #325 (Олег 2026-08-28 12:05 MSK): НЕ ОЧИЩАЕМ messages[peer] перед loadHistory.
    // Раньше: messages[peer] = [] убивал локальный кэш (включая attachments_meta
    // с plaintext_b64) → на следующем tick loadHistory тянул всё с сервера и для
    // каждого входящего фото делал fetch+ECIES+AES-GCM (5-30с на фото = минуты
    // на refresh чата с 3+ фото). Регрессия перформанса после v105/v127.
    //
    // Новая логика:
    // 1. Загрузить кэш из IndexedDB (`messagesCache` через blob-cache.js)
    //    или из localStorage fallback. Показать СРАЗУ — юзер видит чат мгновенно.
    // 2. Параллельно делать loadHistory — incremental fetch с сервера (новые
    //    сообщения с момента последнего sync).
    // 3. Не расшифровывать повторно то что уже в кэше — blob-cache.get() HIT.
    //
    // Если первый раз открываем чат (нет кэша) — loadHistory работает как раньше.
    loadMessagesCacheForPeer(peer);
    clearUnread(peer);
    loadHistory(peer).then(() => {
        if (contacts[peer]) contacts[peer].unreadCount = 0;
        renderChatList();
        renderMessages();
        scrollToBottom();
    }).catch((e) => {
        console.warn("[murmur] openChat loadHistory failed:", e);
    });
}

// ── Load History ──
async function loadHistory(peer, beforeTs) {
    if (!myNpub) return;
    // Cache-bust every /api/* request: bypass HTTP cache, Service Worker cache,
    // and Cloudflare edge cache. Without this, browsers serve stale responses
    // from earlier deploys (when /api/history returned empty) and the chat
    // appears empty even though the DB has messages.
    let url = RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) +
              "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT +
              "&_t=" + Date.now();
    if (beforeTs) url += "&before_ts=" + beforeTs;
    const area = messagesArea;
    const loadingEl = document.createElement("div");
    loadingEl.className = "loading-spinner";
    loadingEl.textContent = "Загрузка…"; // v157b
    // Lesson #158: чистим ВСЕ предыдущие spinners, чтобы они не копились
    // при повторных openChat.
    area.querySelectorAll(".loading-spinner").forEach(el => el.remove());
    area.prepend(loadingEl);
    // Lesson #239 (Олег 2026-08-26 21:42 MSK): 45s timeout (было 25s) + exponential
    // backoff на retry + SINGLE banner вместо 5 дублей. Плохой инет + CF tunnel
    // cold-start = до 30-40s на первый запрос.
    const fetchCtrl = new AbortController();
    const timeoutId = setTimeout(() => {
        fetchCtrl.abort();
        console.warn("[murmur] loadHistory: timeout 45s");
        // Lesson #239: clearAll existing error-msg + spinner, show SINGLE banner
        area.querySelectorAll(".loading-spinner, .error-msg").forEach(el => el.remove());
        loadingEl.remove();
        const errEl = document.createElement("div");
        errEl.className = "error-msg";
        errEl.innerHTML = "⏳ Не удалось загрузить историю. Плохой инет — <button class='link-btn' onclick='openChat(\"" + peer + "\")'>повторить</button>";
        area.appendChild(errEl);
    }, 45000);
    // (Олег 2026-08-25 08:13 MSK) Lesson #158: WASM decrypt может зависнуть
    // без exception на iPhone PWA. decryptWithTimeout — per-decrypt timeout
    // wrapper (defined at module scope for reuse by pollHistoryForPeer).
    try {
        const r = await fetch(url, { cache: "no-store", credentials: "omit", signal: fetchCtrl.signal });
        clearTimeout(timeoutId);
        if (!r.ok) { console.warn("[murmur] loadHistory: HTTP", r.status, url); loadingEl.remove(); return; }
        const j = await r.json();
        console.log("[murmur] loadHistory:", peer.slice(0, 12), "got", (j.messages || []).length, "messages");
        loadingEl.remove();
        if (j.messages && j.messages.length > 0) {
            if (!messages[peer]) messages[peer] = [];
            // Lesson #128: дедуп по envelope_hash (если есть) или по ts.
            const existingSigSet = new Set(messages[peer].map(m => m._sig).filter(Boolean));
            const existingHashSet = new Set(messages[peer].map(m => m._hash).filter(Boolean));
            const newMsgs = [];
            const pDecrypt = []; // async decrypt promises
            for (const m of j.messages) {
                const fromNpub = m.from_npub || m.from;
                const toField = m.to || m.to_alias || "";
                const sigKey = (fromNpub + m.ts);
                const hash = m.envelope_hash || m.envelope_hash_hex || null;
                // Lesson #333 (Олег 2026-08-28 14:36 MSK): если hash в existingHashSet
                // но cached msg имеет body "🔒 шифрованное сообщение" — запускаем
                // decrypt для обновления body. Без этого кэш сам себя портит при
                // каждом loadHistory (msg без plaintext перезаписывается).
                if (hash && existingHashSet.has(hash)) {
                    const cachedMsg = messages[peer].find(x => x._hash === hash);
                    // Lesson #338 (Олег 2026-08-28 15:38 MSK): расширяем fix #333
                    // на оба направления. Cached msg мог быть сохранён со СТАРЫМ
                    // direction (in вместо out) из-за pre-v133 bug в loadOutboxForPeer.
                    // Также cached outgoing с "шифрованное" body — это нерасшифрованный
                    // legacy outbox без attachments_meta. Нужно либо обновить body,
                    // либо подтянуть attachments_meta с plaintext_b64 из outbox.
                    const isStaleBody = cachedMsg && cachedMsg.body &&
                        (cachedMsg.body.includes("шифрованное") || cachedMsg.body.startsWith("🔒"));
                    if (cachedMsg && isStaleBody) {
                        const apiDir = m.direction || (fromNpub === myNpub ? "out" : "in");
                        cachedMsg.direction = apiDir; // fix stale direction
                        if (apiDir === "in") {
                            // Для входящих — расшифровываем body
                            pDecrypt.push(decryptWithTimeout(m).then(({ text: newBody, attachments: newAttArr }) => {
                                if (newBody && newBody !== "__DECRYPT_FAILED__") {
                                    cachedMsg.body = newBody;
                                }
                                if (newAttArr && newAttArr.length > 0) {
                                    cachedMsg.attachments = newAttArr;
                                }
                            }).catch(() => {}));
                        } else {
                            // Для исходящих — подтягиваем attachments_meta с plaintext_b64 из outbox
                            let outbox = {};
                            try {
                                if (window.appStore) {
                                    outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
                                } else {
                                    outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
                                }
                            } catch (e) {}
                            const outboxKey = cachedMsg._sig || sigKey;
                            const outboxEntry = outbox[outboxKey] || outbox[(fromNpub || "") + ":" + m.ts];
                            if (outboxEntry) {
                                if (outboxEntry.body !== undefined) cachedMsg.body = outboxEntry.body;
                                if (outboxEntry.attachments_meta && outboxEntry.attachments_meta.length) {
                                    cachedMsg.attachments_meta = outboxEntry.attachments_meta;
                                }
                                if (outboxEntry.attachments && outboxEntry.attachments.length) {
                                    cachedMsg.attachments = outboxEntry.attachments;
                                }
                            }
                        }
                    }
                    continue;
                }
                if (!hash && existingSigSet.has(sigKey)) continue;
                // E2E async decrypt (Олег 2026-08-24 11:00 MSK)
                // Олег 2026-08-25 07:55 MSK: для исходящих от меня (fromNpub === myNpub)
                // НЕ расшифровываем — у нас есть локальный plaintext в `messages[peer]`.
                // Ищем существующий outgoing по _sig (fromNpub+ts) или _hash.
                const isOutgoing = fromNpub === myNpub;
                if (isOutgoing) {
                    // Попытка найти локальный plaintext по _sig или _hash.
                    // Lesson #159 (Олег 2026-08-25 08:18 MSK): после reload
                    // messages[peer] пуст — идём в outbox localStorage (где
                    // сохраняется с момента отправки). Это избавляет от анти-паттерна
                    // «шифровать+расшифровывать собственные исходящие».
                    let local = (messages[peer] || []).find(localMsg => {
                        if (hash && localMsg._hash === hash) return true;
                        if (localMsg._sig === sigKey) return true;
                        return false;
                    });
                    if (!local) {
                        // Fallback: outbox cache (после reload).
                        const outbox = loadOutboxForPeer(peer);
                        local = outbox.find(o => {
                            if (hash && o._hash === hash) return true;
                            // Lesson #197: _sig fallback — если outbox был сохранён ДО
                            // получения hash с сервера, _hash=null, но _sig совпадает.
                            if (o._sig === sigKey) return true;
                            return false;
                        });
                        // Lesson #198 (Олег 2026-08-26): если outbox всё ещё не нашлось
                        // (сервер мог переписать ts), попробовать найти запись с
                        // ближайшим ts (в пределах 60 секунд) — это исходящее, которое
                        // мы только что отправили, но сервер вернул с другим ts.
                        if (!local && outbox.length > 0) {
                            let best = null, bestDelta = Infinity;
                            for (const o of outbox) {
                                const delta = Math.abs((o.ts || 0) - (m.ts || 0));
                                if (delta < bestDelta && delta <= 60) {
                                    best = o;
                                    bestDelta = delta;
                                }
                            }
                            if (best) {
                                local = best;
                                console.warn("[murmur] loadHistory: outbox ts-proximity fallback for peer", peer.slice(0, 12), "delta=", bestDelta, "want_ts=", m.ts, "got_ts=", best.ts, "hash_want=", hash, "hash_got=", best._hash, "body_want=", m.body ? m.body.slice(0, 20) : null, "body_got=", best.body ? best.body.slice(0, 20) : null);
                            }
                        }
                    }
                    // Lesson #329 (Олег 2026-08-28 13:28 MSK): было `local && local.body`.
                    // Для photo-only сообщений body === "" → не проходил, падали во
                    // вторую ветку → attachments_meta без plaintext_b64 → chip.
                    // Теперь: если local есть (по sig/ts), это наше исходящее —
                    // можно доверять local.attachments_meta с plaintext_b64.
                    if (local) {
                        // Нашли локальный plaintext — используем его, не расшифровываем.
                        const msg = {
                            from: fromNpub, to: toField, body: local.body, ts: m.ts,
                            direction: "out",
                            sig: m.sig || "", _sig: sigKey, _hash: hash,
                            isBinary: false,
                            status: "sent",
                            attachments: local.attachments || [],
                            // Lesson #324 (Олег 2026-08-28 11:22 MSK): копируем
                            // attachments_meta из outbox — это ЕДИНСТВЕННЫЙ источник
                            // plaintext_b64 для рендера без decrypt. Без этого
                            // строка 1714 hasPlaintext===false и bubble рендерится
                            // как chip "IMG_4783 (4.0 MB)" без <img>.
                            attachments_meta: local.attachments_meta || [],
                        };
                        newMsgs.push(msg);
                        if (hash) existingHashSet.add(hash);
                        existingSigSet.add(sigKey);
                        return; // skip decrypt
                    }
                    // Нет локального — это сообщение отправлено с ДРУГОГО устройства
                    // или до установки PWA. Расшифровываем.
                }
                pDecrypt.push(decryptWithTimeout(m).then(async ({ text: bodyText, attachments: attArr, attachmentsMeta: mergedMeta }) => {
                    // Privacy v155: from_name из wire больше не читается — имена
                    // контактов пользователь задаёт сам, локально.
                    // Для исходящих от меня: если decrypt упал (__DECRYPT_FAILED__) —
                    // НЕ показываем «🔒 не удалось расшифровать». Вместо этого
                    // показываем attachments_meta (если есть) или короткий
                    // placeholder.
                    let finalBody = bodyText;
                    if (isOutgoing && bodyText === "__DECRYPT_FAILED__") {
                        const meta = m.attachments_meta || (m.envelope && m.envelope.attachments_meta) || [];
                        if (meta.length) {
                            finalBody = "📎 " + meta.map(a => a.name + " (" + formatSize(a.size) + ")").join(", ");
                        } else {
                            finalBody = "[исходящее, шифрование нарушено]";
                        }
                    }
                    // Lesson #328 (Олег 2026-08-28 13:25 MSK): для исходящих пробуем
                    // достать attachments_meta с plaintext_b64 из outbox по _sig
                    // или по (from + ts). Если body пустой (photo-only message),
                    // то первая ветка `if (local && local.body)` НЕ сработает и мы
                    // свалились бы сюда с attachments_meta без plaintext_b64 →
                    // рендер показал бы chip «IMG_xxx (4 MB) [шифрование нарушено]».
                    // Lesson #334: appStore.kv (IDB) priority, LS fallback.
                    let outboxAttachmentsMeta = null;
                    if (isOutgoing) {
                        let outbox = {};
                        if (window.appStore) {
                            try {
                                outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
                            } catch (e) { /* fallthrough */ }
                        }
                        if (Object.keys(outbox).length === 0) {
                            try { outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}"); } catch (e) {}
                        }
                        const local = outbox[sigKey] || outbox[(fromNpub || "") + ":" + m.ts];
                        if (local && local.attachments_meta && local.attachments_meta.length) {
                            outboxAttachmentsMeta = local.attachments_meta;
                        }
                    }
                    const msg = {
                        from: fromNpub, to: toField, body: finalBody, ts: m.ts,
                        direction: m.direction || (fromNpub === myNpub ? "out" : "in"),
                        sig: m.sig || "", _sig: sigKey, _hash: hash,
                        isBinary: false,
                        status: m.direction === "out" ? "sent" : null,
                        // Lesson #341 (Олег 2026-08-30): keep raw server row for
                        // async decrypt retry. Без этого pollHist фильтр
                        // `_server_msg` не находил кэш-сообщения с body «🔒» и
                        // они оставались зашифрованными навсегда.
                        _server_msg: m,
                        attachments: attArr || [],
                        // Phase 3: relay's attachment_refs (blob_id, wrapped_key, iv, mime, name, size).
                        // Used by renderMessages to async decrypt + render incoming attachments.
                        // Lesson #328: для исходящих подменяем на outbox-версию с plaintext_b64.
                        // Privacy v154: mergedMeta (= m/inner attachments_meta после слияния real names
                        // из ct в decryptEnvelopeForRender) — тогда чипы получают настоящее имя.
                        attachments_meta: outboxAttachmentsMeta || mergedMeta || m.attachments_meta || [],
                    };
                    newMsgs.push(msg);
                    if (hash) existingHashSet.add(hash);
                    existingSigSet.add(sigKey);
                }));
            }
            // Lesson #158: даже если per-decrypt timeout стоит, защитим Promise.all общим
    // таймаутом — иначе если один decrypt «утек» (например, бесконечный цикл в WASM),
    // loadingEl.remove() никогда не вызовется, и пользователь будет видеть спам "Loading...".
    const BATCH_TIMEOUT_MS = 20000;
    await Promise.race([
        Promise.all(pDecrypt),
        new Promise((_, rej) => setTimeout(() => rej(new Error("loadHistory batch timeout " + BATCH_TIMEOUT_MS + "ms")), BATCH_TIMEOUT_MS)),
    ]);
            if (newMsgs.length > 0) {
                messages[peer] = newMsgs.concat(messages[peer]);
                // Lesson #339 (Олег 2026-08-28 16:18 MSK): safety net.
                // Для каждого существующего кэш-сообщения сверяем direction с API.
                // Если API даёт out, а кэш имеет in → исправляем. Закрывает баг
                // когда кэш из v126-v132 содержал неправильный direction и
                // existingHashSet.has(hash) → continue пропускал обновление.
                for (const apiMsg of j.messages) {
                    const apiDir = apiMsg.direction || (apiMsg.from_npub === myNpub ? "out" : "in");
                    const apiHash = apiMsg.envelope_hash || apiMsg.envelope_hash_hex || null;
                    if (!apiHash) continue;
                    const cached = messages[peer].find(x => x._hash === apiHash);
                    if (cached && cached.direction !== apiDir) {
                        console.warn("[murmur] safety-net direction fix:", peer.slice(0, 12),
                            "cached=" + cached.direction, "→ api=" + apiDir,
                            "hash=" + apiHash.slice(0, 8));
                        cached.direction = apiDir;
                        if (apiDir === "out" && cached.body &&
                            (cached.body.includes("шифрованное") || cached.body.startsWith("🔒"))) {
                            // Подтянем attachments_meta из outbox
                            try {
                                const outbox = window.appStore
                                    ? ((await window.appStore.kv.get(LS_OUTBOX)) || {})
                                    : JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
                                const outKey = cached._sig || (apiMsg.from_npub + apiMsg.ts);
                                const entry = outbox[outKey] || outbox[(apiMsg.from_npub || "") + ":" + apiMsg.ts];
                                if (entry) {
                                    if (entry.body !== undefined) cached.body = entry.body;
                                    if (entry.attachments_meta && entry.attachments_meta.length) {
                                        cached.attachments_meta = entry.attachments_meta;
                                    }
                                    if (entry.attachments && entry.attachments.length) {
                                        cached.attachments = entry.attachments;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }

                // Lesson #241 (Олег 2026-08-26 22:15): брать САМОЕ НОВОЕ сообщение
                // по max ts, не [0]. newMsgs идёт в начало массива, но если
                // пользователь скроллит вверх (paginate) — newMsgs содержит СТАРЫЕ
                // сообщения, [0] уже не самое новое.
                let newest = null;
                for (const m of messages[peer]) {
                    if (!newest || (m.ts || 0) > (newest.ts || 0)) newest = m;
                }
                if (newest && newest.body) {
                    if (!contacts[peer]) contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
                    contacts[peer].lastTs = newest.ts;
                    // Lesson #241: НЕ обновлять preview здесь, если body
                    // ещё-зашифрованный JSON envelope. sanitizePreview вернёт
                    // '🔒 зашифрованное сообщение' что выглядит как регресс.
                    // Пусть Lesson #238 v3 (async decrypt) обновит preview
                    // после расшифровки.
                    const bodyStr = String(newest.body);
                    if (!bodyStr.startsWith("{")) {
                        // decrypted plaintext или plain text
                        contacts[peer].lastMessagePreview = bodyStr.slice(0, 80);
                    }
                    // else: оставляем предыдущий preview, async decrypt обновит
                }
            }
            if (j.next_before_ts) oldestTsForPeer[peer] = j.next_before_ts;
            renderMessages();
            renderChatList();
            resyncSidebarPreviews();
            // Lesson #326: сохраняем snapshot в localStorage для следующего openChat.
            saveMessagesCacheForPeer(peer);
        }
    } catch (e) { clearTimeout(timeoutId); loadingEl.remove(); console.warn("[murmur] loadHistory FAILED:", e.message); }
}

// ── Render Messages ──
function renderMessages() {
    if (!activePeer) return;
    const all = messages[activePeer] || [];
    const msgs = [...all].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    // Lesson #227 (Олег 2026-08-26 16:25): DIAGNOSTIC instrumentation —
    // record every renderMessages call with stack + DOM diff.
    if (typeof window.__MURMUR_DIAG__ === "undefined") {
        window.__MURMUR_DIAG__ = {
            renderMessages_count: 0,
            renderMessages_history: [],
            img_created: 0,
            img_revoked: 0,
            img_in_dom_now: 0,
            blob_urls_active: 0,
            last_render_cause: "?",
            async_races_detected: 0,
        };
    }
    const diag = window.__MURMUR_DIAG__;
    diag.renderMessages_count++;
    // Capture who triggered this render by walking call stack.
    const stack = new Error().stack || "";
    const cause = (stack.match(/at (\w+)/g) || []).slice(1, 4).join(" ← ");
    diag.last_render_cause = cause;
    diag.renderMessages_history.push({
        n: diag.renderMessages_count,
        ts: Date.now(),
        msgs_count: msgs.length,
        cause: cause,
        // Snapshot of which messages have decrypted blobs vs which don't
        with_attachments: msgs.filter(m => m.attachments_meta && m.attachments_meta.length > 0).length,
        with_plaintext: msgs.filter(m => m.attachments_meta && m.attachments_meta.every(a => a.plaintext_b64)).length,
        outgoing_with_chip: msgs.filter(m => m.direction === "out" && m._outgoing_chip_rendered).length,
    });
    // Cap history (avoid unbounded growth)
    if (diag.renderMessages_history.length > 50) diag.renderMessages_history.shift();
    console.log("[MURMUR-DIAG] renderMessages call #" + diag.renderMessages_count + " cause=" + cause + " msgs=" + msgs.length);
    // Lesson #207 (Олег 2026-08-26 12:01): clean up revoked blob URLs from previous
    // render to prevent memory leak. Each outgoing attachment creates a URL.createObjectURL
    // (Lesson #155), and they accumulate forever without revoke → iPhone PWA hang.
    if (typeof window.__murmurUrlsToRevoke === "undefined") window.__murmurUrlsToRevoke = [];
    const previousUrls = window.__murmurUrlsToRevoke;
    window.__murmurUrlsToRevoke = [];
    // Lesson #230 (Олег 2026-08-26 16:55): ONLY clear when activePeer changes
    // or renderMessages called with fundamentally different state.
    // Default: НЕ clear (preserves already-rendered imgs + their blob URLs).
    if (typeof window.__murmurLastRenderedPeer === "undefined") window.__murmurLastRenderedPeer = null;
    if (window.__murmurLastRenderedPeer !== activePeer) {
        messagesArea.innerHTML = "";
        window.__murmurLastRenderedPeer = activePeer;
        window.__murmurRenderedSigs = new Set();
    }

    let lastDay = null;
        // Lesson #230 (Олег 2026-08-26 16:55): track rendered sigs.
    // Пропускаем bubbles для уже отрисованных messages.
    if (!window.__murmurRenderedSigs) window.__murmurRenderedSigs = new Set();
    const renderedSigs = window.__murmurRenderedSigs;
    for (const m of msgs) {
        const sig = m._sig || (m.from_npub || m.from) + m.ts;
        // Lesson #320 (Олег 2026-08-28 09:00 MSK): если sig в Set, но bubble
        // существует и у него НЕТ msg-attach-list (attachments не дорисованы
        // из-за race с poll) — не skip, а найти existingBubble и дорисовать.
        // Иначе после первой неудачи attachment render bubble становится
        // "сиротой" с sig в Set → навсегда skip (Bug A от Олега 08:22).
        let div;
        let _rerenderAttachments = false;
        if (renderedSigs.has(sig)) {
            // Lesson #348 (Олег 2026-08-30 15:45 MSK): rerender-attachments
            // ранее был ТОЛЬКО для direction "in". Исходящие, отрендеренные
            // из cache ДО подклейки plaintext из outbox (loadMessagesCacheForPeer
            // repair идёт после первого render) — навсегда оставались chip'ами:
            // sig в Set → skip, а «дорисовать» проверялся только у входящих.
            // Теперь: И 'out', и 'in' с attachments_meta — дорисовываем, если у
            // bubble ещё нет НИ ОДНОГО img/figure в msg-attach-list.
            const wantsAttachments = (m.direction === "in" || m.direction === "out") &&
                m.attachments_meta && m.attachments_meta.length > 0;
            if (wantsAttachments) {
                const existingBubble = messagesArea.querySelector(`[data-sig="${CSS.escape(sig)}"]`);
                const attachList = existingBubble && existingBubble.querySelector(".msg-attach-list");
                // Lesson #350: .attach-decrypting — спиннер ЕЩЁ крутится (async
                // renderAttachment в работе). Считаем bubble «отрендеренным»,
                // иначе повторный renderMessages создаст ВТОРОЙ список фото
                // (задвоение картинок внутри одного bubble, Олег 18:21).
                const hasRendered = attachList && (attachList.querySelector("img, video, audio, figure, .attach-error, .msg-attach-remote, .attach-decrypting"));
                if (existingBubble && !hasRendered) {
                    console.log("[murmur] rerendering attachments for sig", sig.slice(0, 12), "dir=", m.direction);
                    // Reuse existing bubble — переиспользуем DOM, только дорисуем attachments.
                    div = existingBubble;
                    _rerenderAttachments = true;
                } else {
                    continue;
                }
            } else {
                continue;
            }
        } else {
            const day = formatDayDivider(m.ts);
            if (day && day !== lastDay) {
                const divider = document.createElement("div");
                divider.className = "day-divider";
                divider.innerHTML = "<span>" + day + "</span>";
                messagesArea.appendChild(divider);
                lastDay = day;
            }
            div = document.createElement("div");
            const isOut = m.direction === "out";
            const isSystem = m.direction === "system";
            if (isSystem) {
                div.className = "bubble bubble-system";
            } else {
                div.className = "bubble " + m.direction;
            }
            div.setAttribute("data-sig", sig);
            let statusGlyph = "";
            if (isOut) {
                statusGlyph = m.status === "delivered" ? "✓✓" : (m.status === "sent" ? "✓" : "");
            }
            if (isSystem) {
                statusGlyph = "⏳";
            }
            const bodyText = m.body || "";
            let bodyHtml = escapeHtml(bodyText);
            div.innerHTML =
                "<div class='msg-body'>" + bodyHtml + "</div>" +
                "<span class='bubble-time'>" + formatTime(m.ts) + (statusGlyph ? " " + statusGlyph : "") + "</span>";
            messagesArea.appendChild(div);
            renderedSigs.add(sig);
        }
        // Phase 3: render attachments from outbox plaintext (own outgoing) or
        // decrypt via WASM (incoming) — both async, no inline data: URLs.
        const outboxAttachments = (m.direction === "out" && m._sig) ? null : null; // placeholder — populated below
        // For outgoing: m.attachments_meta from outbox cache (with plaintext_b64)
        // For outgoing with attachments_meta (own outbox or remote view):
        // render attachments inline. Then fall through to bubble append.
        // NOTE: do NOT use `return` here — we are inside `for (const m of msgs)`
        // and an early return would stop rendering all subsequent messages!
        // (Lesson #205, Олег 2026-08-26 11:45: на Mac после message с фото не
        // отображалась остальная переписка.)
        if (m.direction === "out" && m.attachments_meta && Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) {
            const placeholderEl = document.createElement("div");
            placeholderEl.className = "msg-attach-list";
            div.insertBefore(placeholderEl, div.firstChild);
            // Two cases:
            // 1. Local outbox row — has plaintext_b64, render directly.
            // 2. Server-fetched outgoing row (e.g. Alice views her own chat) —
            //    no plaintext_b64, just a wrapped_key for the recipient.
            //    Render a non-decrypting placeholder to avoid ECIES bad-tag error
            //    (Lesson #195).
            const hasPlaintext = m.attachments_meta.every(att => att.plaintext_b64);
            // Lesson #348: рендерим img для тех att, где plaintext ЕСТЬ, даже если
            // не у всех (PARTIAL). Chip'и (remote) — только для att без plaintext.
            // Раньше: every() → один att без plaintext топил ВСЕ фото в chip'и,
            // даже если у остальных plaintext был на месте.
            const anyPlaintext = m.attachments_meta.some(att => att.plaintext_b64);
            if (hasPlaintext || anyPlaintext) {
                for (const att of m.attachments_meta) {
                    try {
                        if (!att.plaintext_b64) {
                            const chip = document.createElement("div");
                            chip.className = "msg-attach-remote";
                            chip.textContent = "\ud83d\udcf7 " + (att.name || "file") + " (" + formatSize(att.size || 0) + ")";
                            placeholderEl.appendChild(chip);
                            continue;
                        }
                        const mime = att.mime || "application/octet-stream";
                        const blob = b64ToBlob(att.plaintext_b64, mime);
                        const url = URL.createObjectURL(blob);
                        // Lesson #225: track в WeakMap imgElement→blobUrl для авто-revoke
                        // (но сначала надо создать img element чтобы зарегистрировать)
                        const el = renderOutgoingAttachment({ mime, name: att.name, url, size: att.size });
                        if (el && el.tagName === "IMG" && window.__murmurBlobOwners) {
                            window.__murmurBlobOwners.set(el, url);
                        }
                        placeholderEl.appendChild(el);
                    } catch (e) {
                        console.error("[attach-out] render failed:", e);
                    }
                }
            } else {
                // Lesson #349: у исходящих с双重-wrapped ключом ({r,s}) plaintext из
                // outbox НЕ нужен — рендерим через remote-decrypt (fetch blob +
                // ECIES unwrap s НАШИМ privkey + AES). Работает на любом устройстве
                // с той же личностью и переживает чистый outbox. Legacy single-wrapped
                // (без .s) тоже попробуем decrypt'ом — с нашей подписью это НАШЕ
                // сообщение, но unwrap 'r' с нашим ключом упадёт → chip fallback.
                const remoteList = document.createElement("div");
                remoteList.className = "msg-attach-list";
                placeholderEl.appendChild(remoteList);
                // Те же гарантии, что у incoming (Lessons #210/#229/#245):
                // abort только при смене peer, задачи в __murmurAttachTasks.
                const renderAbort = new AbortController();
                if (typeof window.__murmurRenderAbort === "undefined") window.__murmurRenderAbort = null;
                if (typeof window.__murmurRenderAbortPeer === "undefined") window.__murmurRenderAbortPeer = null;
                if (window.__murmurRenderAbortPeer !== activePeer && window.__murmurRenderAbort) {
                    try { window.__murmurRenderAbort.abort("peer changed"); } catch (e) { /* ignore */ }
                }
                window.__murmurRenderAbort = renderAbort;
                window.__murmurRenderAbortPeer = activePeer;
                if (typeof window.__murmurAttachTasks === "undefined") window.__murmurAttachTasks = [];
                const thisRenderTasks = [];
                window.__murmurAttachTasks.push(thisRenderTasks);
                (async () => {
                    try {
                        if (!window.MurmurRenderAttachments) {
                            const mod = await import("./render-attachments.js");
                            window.MurmurRenderAttachments = mod;
                        }
                        for (const att of m.attachments_meta) {
                            const attEl = { ...att, _selfKey: true };
                            thisRenderTasks.push(
                                window.MurmurRenderAttachments.renderAttachment(attEl, remoteList, renderAbort.signal).catch(() => {})
                            );
                        }
                    } catch (e) {
                        console.error("[attach-out-remote] render setup failed:", e);
                    }
                })();
            }
            // fall through — bubble `div` is appended below
        }
        // For incoming ONLY: server returned attachments_meta only (no plaintext).
        // Outgoing messages with attachments_meta but without plaintext_b64 are
        // already rendered as remote-attach placeholders above (Lesson #195).
        if (m.direction === "in" && m.attachments_meta && Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) {
            // Render placeholder container, then async decrypt + replace.
            // Lesson #320: если _rerenderAttachments — переиспользуем существующий bubble,
            // но в любом случае создаём новый msg-attach-list (старого нет — мы это
            // проверили через existingBubble.querySelector(".msg-attach-list > *")).
            const placeholderEl = document.createElement("div");
            placeholderEl.className = "msg-attach-list";
            div.insertBefore(placeholderEl, div.firstChild);
            // Lesson #210 (Олег 2026-08-26 13:38): parallel renderAttachment with
            // ABORT CONTROLLER. Sequential await блокировал — 2-е фото ждало 1-е
            // fetch+decrypt (30+s) → iPhone PWA deadlock через renderMessages
            // повторные вызовы (от pollHist) — DOM reset терял предыдущие fetches
            // → blob URLs никогда не возвращались → loading spinner вечный.
            const renderAbort = new AbortController();
            // Lesson #245 (Олег 2026-08-26 23:09): только abort при изменении
            // activePeer. НЕ abort при append новых сообщений в этом же peer —
            // это вызывало исчезновение уже отображаемых фотографий при отправке
            // следующего сообщения. (Lesson #210 aborter всё, даже НЕ мою
            // очередь attachments — фото которое уже было показано, через 50ms
            // теряло свой img при следующем renderMessages call.)
            if (typeof window.__murmurRenderAbort === "undefined") window.__murmurRenderAbort = null;
            if (typeof window.__murmurRenderAbortPeer === "undefined") window.__murmurRenderAbortPeer = null;
            if (window.__murmurRenderAbortPeer !== activePeer && window.__murmurRenderAbort) {
                try { window.__murmurRenderAbort.abort("peer changed"); } catch (e) { /* ignore */ }
            }
            window.__murmurRenderAbort = renderAbort;
            window.__murmurRenderAbortPeer = activePeer;
            // Lesson #229 (Олег 2026-08-26 16:50): собираем Promise всех
            // attach renders в window.__murmurAttachTasks. renderMessages вызовет
            // await на них ПЕРЕД возвратом. Без этого IIFE fire-and-forget
            // теряется при следующем innerHTML="" — cache HIT на повторном render
            // срабатывает ПОСЛЕ того как placeholderEl уже уничтожен.
            if (typeof window.__murmurAttachTasks === "undefined") window.__murmurAttachTasks = [];
            const thisRenderTasks = [];
            window.__murmurAttachTasks.push(thisRenderTasks);
            (async () => {
                try {
                    if (!window.MurmurRenderAttachments) {
                        const mod = await import("./render-attachments.js");
                        window.MurmurRenderAttachments = mod.MurmurRenderAttachments || mod;
                    }
                    if (renderAbort.signal.aborted) return;
                    const renderer = window.MurmurRenderAttachments.renderAttachment ?
                                     window.MurmurRenderAttachments :
                                     window.MurmurRenderAttachments.MurmurRenderAttachments;
                    // PARALLEL: render all attachments simultaneously (NOT sequential!)
                    const allTasks = m.attachments_meta.map((att) => {
                        const t = (async () => {
                            if (renderAbort.signal.aborted) return null;
                            try {
                                return await renderer.renderAttachment(att, placeholderEl, renderAbort.signal);
                            } catch (e) {
                                console.error("[attach] render failed:", e);
                                return null;
                            }
                        })();
                        thisRenderTasks.push(t);
                        return t;
                    });
                    await Promise.allSettled(allTasks);
                } catch (e) {
                    console.error("[attach] init failed:", e);
                }
            })();
        }
    }
    // Lesson #225 (Олег 2026-08-26 16:05): ИЗЯЩНОЕ решение для blob URL lifecycle.
    //
    // Проблема: Lesson #213 setTimeout(30000) revokeObjectURL убивал blob URL
    // ДО того как img element был detached от DOM — img.src = blob:revoked_url
    // → broken image icon. На iPhone slow tunnel decrypt >30s → ещё хуже.
    //
    // Решение: WeakMap<imgElement, blobUrl>. MutationObserver отслеживает когда
    // img удаляется из DOM → revoke его URL. Никаких таймаутов — URLs живут
    // ровно столько, сколько нужен для отображения. Слабая ссылка WeakMap —
    // img element GC → URL entry тоже GC (без утечек).
    if (typeof window.__murmurBlobOwners === "undefined") {
        window.__murmurBlobOwners = new WeakMap();  // imgEl -> blobUrl
        if (!window.__murmurBlobObserver) {
            window.__murmurBlobObserver = new MutationObserver((mutations) => {
                for (const mut of mutations) {
                    for (const node of mut.removedNodes) {
                        if (node && node.tagName === "IMG" && node.src && node.src.startsWith("blob:")) {
                            const url = window.__murmurBlobOwners.get(node);
                            if (url) {
                                try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                                window.__murmurBlobOwners.delete(node);
                                console.log("[murmur] auto-revoke img blob URL on detach");
                            }
                        }
                    }
                }
            });
            window.__murmurBlobObserver.observe(document.body, { childList: true, subtree: true });
        }
    }
    // Lesson #225: previousUrls больше не нужен — URLs revoke'ятся автоматически
    // когда img detach'ится. Никакого setTimeout, никаких ручных вызовов.
    void previousUrls;  // silence unused warning
}

// Day divider label: "Сегодня", "Вчера", or "12 авг".
function formatDayDivider(ts) {
    if (!ts) return null;
    const d = new Date(ts * 1000);
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const today = startOf(now);
    const that = startOf(d);
    const diffDays = Math.round((today - that) / 86400000);
    if (diffDays === 0) return "Сегодня";
    if (diffDays === 1) return "Вчера";
    const months = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    return d.getDate() + " " + months[d.getMonth()];
}

function scrollToBottom() {
    requestAnimationFrame(() => { messagesArea.scrollTop = messagesArea.scrollHeight; });
}

// ── Infinite Scroll ──
if (messagesArea) {
    messagesArea.addEventListener("scroll", () => {
        if (messagesArea.scrollTop <= 1 && oldestTsForPeer[activePeer]) {
            loadHistory(activePeer, oldestTsForPeer[activePeer]);
        }
    });
}

// ── Send Message ──
// ============================================================================
// E2E encrypt/decrypt (Олег 2026-08-24 11:00 MSK, E2E вариант B)
// ============================================================================
//
// Все сообщения и файлы шифруются ECIES (X25519 ECDH + HKDF + AES-256-GCM)
// в WASM. Relay не видит plaintext. Push-провайдеры тоже.
//
// API:
//   encryptForRecipient(recipientNpub, {body, attachments}) -> base64-sealed
//   decryptEnvelope(base64-sealed) -> {body, attachments}
// ========================================================================

/// Resolve a peer key (alias or npub) to its full npub + agreement_pubkey_hex.
/// Returns null if not found.
async function resolvePeerKey(peer) {
    if (!peer) return null;
    if (peer.startsWith("npub1")) {
        // Это уже npub. Получаем agreement_pubkey через WASM.
        try {
            const mod = await loadWasmModule();
            const r = unwrap(mod.npub_to_pubkey_hex(peer));
            if (!r.ok) return null;
            // r.data = "signing_pubkey_hex (32 b) + agreement_pubkey_hex (32 b)" — 128 hex chars
            const hex = r.data;
            if (hex.length < 128) return null;
            return {
                npub: peer,
                signing_pubkey_hex: hex.slice(0, 64),
                agreement_pubkey_hex: hex.slice(64, 128),
            };
        } catch (e) { return null; }
    }
    // Иначе alias. Ищем в contacts.
    for (const k of Object.keys(contacts)) {
        const c = contacts[k];
        if (c.alias === peer || c.npub === peer || c.peer === peer) {
            // Если у contact есть npub — используем его.
            if (c.npub && c.npub.startsWith("npub1")) {
                return resolvePeerKey(c.npub);
            }
        }
    }
    // Последний шанс — может это уже npub похожий на alias. Не парсим.
    return null;
}

/// ECIES encrypt arbitrary plain object for a recipient.
/// Returns base64 sealed envelope (32 ephem + 12 nonce + ct + tag).
async function encryptForRecipient(recipientNpub, plainObj) {
    const mod = await loadWasmModule();
    // Кодируем plain в JSON → байты → base64 (для WASM границы).
    const json = JSON.stringify(plainObj);
    const bytes = new TextEncoder().encode(json);
    let binStr = "";
    for (let i = 0; i < bytes.length; i++) binStr += String.fromCharCode(bytes[i]);
    const plainB64 = btoa(binStr);
    const r = unwrap(mod.encrypt_for_recipient(recipientNpub, plainB64));
    if (!r.ok) throw new Error("encrypt_for_recipient: " + r.error);
    return r.data;
}

/// ECIES decrypt a base64 sealed envelope to original plain object.
async function decryptEnvelope(sealedB64) {
    const mod = await loadWasmModule();
    try {
        const r = unwrap(mod.decrypt_envelope(sealedB64));
        if (!r.ok) throw new Error("WASM error: " + r.error);
        // r.data = base64 plaintext bytes → decode → JSON.parse.
        const binStr = atob(r.data);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const json = new TextDecoder().decode(bytes);
        return JSON.parse(json);
    } catch (e) {
        console.error("[decrypt] fatal fail:", e);
        // Не показывать alert — Lesson #202 (Олег 2026-08-26): decrypt errors для
        // СВОИХ исходящих — норма (outbox не найден / другой key). Пользователю
        // показывается "📎 filename" placeholder через pollHist fallback.
        throw e;
    }
}

async function sendMessage() {
    // Lesson #152: try/finally ВОКРУГ всего тела — если WASM encrypt падает на
    // большом файле или FileReader не декодировал HEIC, btnSend оставалось
    // disabled навсегда. finally гарантирует разблокировку.
    if (!activePeer) return;
    const text = messageInput.value.trim();
    // Phase 2 (Variant Б): can send empty text if there are attachments.
    if (!text && pendingAttachments.length === 0) return;
    // Wait for any pending uploads to finish.
    const stillUploading = pendingAttachments.some((a) => a._uploading);
    if (stillUploading) {
        alert("Подождите, пока файлы загрузятся…");
        return;
    }
    await ensureWasm();
    messageInput.value = "";
    messageInput.style.height = "auto";
    btnSend.disabled = true;
    // Optimistic render — в safe state до encrypt, чтобы UI не зависал.
    let optimisticRendered = false;
    let renderedMsg = null;
    try {
        // E2E: resolve peer → npub, encrypt body via WASM ECIES.
        // Attachments: NO inline base64 (Lesson #165) — already uploaded as
        // encrypted blobs; envelope carries [{blob_id, wrapped_key, name, mime, size}].
        const peerKey = await resolvePeerKey(activePeer);
        if (!peerKey) {
            console.error("sendMessage: cannot resolve peer key for", activePeer);
            return;
        }
        // Clone meta before clearing, to avoid race with subsequent edits.
        // Privacy split (Олег 2026-08-31):
        //  - attachments_meta (SERVER-VISIBLE) → publicName (f-…bin), no real filename
        //  - sealed ct → attachments[].name = real filename (только peer увидит)
        const metaSnapshot = pendingAttachmentsMeta.map((a) => Object.assign({}, a));
        const sealedB64 = await encryptForRecipient(peerKey.npub, {
            body: text,
            attachments: metaSnapshot.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
        });
        // Server-visible meta: replace real names with neutral ones, drop plaintext_b64.
        const serverMeta = metaSnapshot.map((a) => ({
            blob_id: a.blob_id,
            sha256: a.sha256,
            wrapped_key: a.wrapped_key,
            iv: a.iv,
            mime: a.mime,
            size: a.size,
            name: a.publicName || "f-redacted.bin", // neutral — relay never sees filenames
        }));
        pendingAttachments = []; // clear after encrypt
        pendingAttachmentsMeta = []; // clear after encrypt
        renderAttachmentsPreview();

        const msg = {
            from: myNpub,
            to: activePeer,
            ct: sealedB64,         // ← E2E sealed envelope (base64)
            attachments_meta: serverMeta, // [{blob_id, sha256, wrapped_key, iv, mime, size, name=f-…bin}] — real names INSIDE ct
            ts: Math.floor(Date.now() / 1000),
        };
        // Privacy v155 (Олег 2026-08-31): from_name УДАЛЁН из wire-формата.
        // Имена контактов живут только локально (murmur.contact_names,
        // setContactName) и никогда не покидают устройство. Получатель сам
        // даёт имя контакту; поле from_name больше не читается в render-путях.
        const mod = await loadWasmModule();
        // Signature covers (from|to|ts|ct) via canonical envelope hash, same as
        // relay's `Envelope::verify`. sig input = SHA3(npub || payload).
        // (Олег 2026-08-24 11:00 MSK, E2E — гарантия что relay не подменил `ct`.)
        const signedPayload = msg.from + "|" + msg.to + "|" + msg.ts + "|" + msg.ct;
        const sigPayloadBytes = new TextEncoder().encode(signedPayload);
        const sig = unwrap(mod.sign_envelope(msg.from, sigPayloadBytes));
        if (!sig.ok) { console.error("sign error:", sig.error); return; }
        msg.sig = sig.data;
        // btoa может сломаться на 50MB — используем chunked encode.
        let binStr = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < sigPayloadBytes.length; i += CHUNK) {
            binStr += String.fromCharCode.apply(null, sigPayloadBytes.subarray(i, i + CHUNK));
        }
        msg.signed_payload = btoa(binStr);

        // Lesson #350b (security): plaintext_b64 (расшифрованные фото!) НЕ должен
        // уходить на релей. Релей валидирует sig по (from|to|ts|ct) — лишние поля
        // sig не ломают, но хранятся в SQLite (envelopes.body + /api/history).
        // Стрипаем перед POST; в outbox (saveToOutbox) plaintext остаётся.
        const wireMsg = Object.assign({}, msg, {
            attachments_meta: serverMeta, // уже с нейтральными именами f-…bin (real names внутри ct)
        });

        // Lesson #159: собираем plaintext cache для outbox + optimistic render
        // (чтобы не делать encrypt→send→receive→decrypt round-trip для своих,
        //  Lesson #155 — анти-паттерн).
        // attachmentsWithPlaintext — массив meta с plaintext_b64 для self-render.
        const attachmentsWithPlaintext = metaSnapshot
            .filter((a) => a.plaintext_b64)
            .map((a) => ({
                blob_id: a.blob_id,
                mime: a.mime,
                name: a.name,
                size: a.size,
                plaintext_b64: a.plaintext_b64,
            }));

        // Optimistic render
        if (!messages[activePeer]) messages[activePeer] = [];
        // Lesson #350 (Олег 2026-08-30 18:21 «фотки задваиваются»): гонка
        // sendMessage × pollHistoryForPeer — пока POST /envelope в полёте,
        // poll приносит серверный echo нашего исходящего. Дедуп по _hash
        // не работает (оптимистичная копия ещё _hash:null) → вторая копия
        // навсегда (до reload). Фикс: флаг _pendingServerAssign → pollHist
        // ДЕРЖИТ echo до прихода hash из POST-ответа (см. pollHistoryForPeer).
        renderedMsg = {
            from: myNpub, to: activePeer, body: text, ts: msg.ts,
            direction: "out", sig: sig.data, _sig: myNpub + msg.ts,
            status: "sent", isBinary: false, _hash: null,
            attachments_meta: attachmentsWithPlaintext, // [{blob_id, mime, name, size, plaintext_b64}]
            _pendingServerAssign: true,
        };
        messages[activePeer].push(renderedMsg);
        optimisticRendered = true;
        // Lesson #159: сохраняем в outbox localStorage, чтобы после reload можно было
        // отрисовать без decrypt (анти-паттерн шифровать/расшифровывать собственные).
        console.log("[send] attachmentsWithPlaintext count =", attachmentsWithPlaintext.length, "metaSnapshot =", metaSnapshot.length);
        // Lesson #350: _sig стабилен (локальный ts не меняем) — outbox сразу под финальным ключом.
        saveToOutbox(renderedMsg, text, attachmentsWithPlaintext);
        renderMessages();
        scrollToBottom();
        renderMessages();
        scrollToBottom();
        renderMessages();
        scrollToBottom();

        const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(activePeer), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(wireMsg), // Lesson #350b: без plaintext_b64
        });
        if (r.ok) {
            // Lesson #128: сохраняем envelope_hash из ответа для надёжного дедупа
            // (сервер может переписать ts, тогда дедуп по myNpub+ts сломается).
            try {
                const respJson = await r.json();
                if (respJson && respJson.hash) {
                    renderedMsg._hash = respJson.hash;
                    // Lesson #350: POST завершён — флаг снят, pollHist снова
                    // обрабатывает echo (дедуп по _hash теперь сработает:
                    // optimistic и echo имеют ОДИН hash = H(payload)).
                    renderedMsg._pendingServerAssign = false;
                    // Lesson #197/#347 (Олег 2026-08-26/30): обновить outbox с реальным
                    // _hash в ОБОИХ хранилищах (IDB appStore + LS fallback), иначе после
                    // reload plaintext теряется → outgoing photo становится failed-chip.
                    const outboxKey = renderedMsg._sig;
                    if (window.appStore) {
                        try {
                            const ob = (await window.appStore.kv.get(LS_OUTBOX)) || {};
                            if (ob[outboxKey]) {
                                ob[outboxKey]._hash = respJson.hash;
                                await window.appStore.kv.set(LS_OUTBOX, ob);
                                if (_outboxKVCache) _outboxKVCache = ob;
                            }
                        } catch (e) { console.warn("[send] outbox _hash IDB update failed:", e); }
                    }
                    try {
                        const outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
                        if (outbox[outboxKey]) {
                            outbox[outboxKey]._hash = respJson.hash;
                            localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox));
                        }
                    } catch (e) { /* LS quota — non-fatal */ }
                } else {
                    // Lesson #350: редкий ответ без hash — не держим echo в deferred
                    // вечно; через 15s отпускаем (худший случай — dup, но не пропуск).
                    setTimeout(() => {
                        if (renderedMsg._pendingServerAssign) {
                            renderedMsg._pendingServerAssign = false;
                            renderMessages();
                        }
                    }, 15000);
                }
            } catch (e) { /* /envelope может не вернуть JSON — fallback на ts */ }
            const last = messages[activePeer][messages[activePeer].length - 1];
            if (last && last._sig === renderedMsg._sig) last.status = "delivered";
            renderMessages();
            if (contacts[activePeer]) {
                contacts[activePeer].lastMessagePreview = text.slice(0, 80);
                contacts[activePeer].lastTs = msg.ts;
            }
            renderChatList();
        } else {
            const last = messages[activePeer][messages[activePeer].length - 1];
            if (last) {
                last.status = "failed";
                // Lesson #350: POST завершился ошибкой — не задерживаем echo.
                if (last._pendingServerAssign) last._pendingServerAssign = false;
                renderMessages();
            }
        }
    } catch (e) {
        // Lesson #152: ошибка (HEIC blob падает в WASM encrypt, network drop, итд)
        // — откатить optimistic render и показать failed.
        console.error("[murmur] sendMessage caught:", e.message);
        if (optimisticRendered && renderedMsg) {
            renderedMsg.status = "failed";
            // Lesson #350: POST упал — снимаем pending-флаг, чтобы pollHist больше
            // не задерживал серверный echo (hash-дедуп продолжит работать как раньше).
            renderedMsg._pendingServerAssign = false;
            renderMessages();
        }
    } finally {
        // 🔒 Lesson #152: всегда разблокируем кнопку, даже если WASM encrypt упал.
        btnSend.disabled = false;
        // 🧹 Lesson #196: всегда очищаем attachments-preview и input после send,
        // даже если encrypt/POST упал. Иначе preview висит, и следующее сообщение
        // "теряется" в чате.
        attachmentsPreview.innerHTML = "";
        pendingAttachments = [];
        pendingAttachmentsMeta = [];
        messageInput.value = "";
        messageInput.style.height = "auto";
        // 🔄 Lesson #196: перерендерить messages-area, чтобы новый bubble появился
        // даже если WASM упал в середине.
        if (typeof renderMessages === "function") renderMessages();
    }
}

// ── New Chat ──
// Input is always visible. Pressing + (or Enter in input) creates the chat.
// (поле «новый чат: alias или npub» + кнопка + удалены из index.html 2026-08-31
// по решению Олега: контакты создаются через invite-ссылку или входящее сообщение.
// createNewChatFromInput удалена заодно — alias там всё равно не работал, только npub1…)

// ── Input handling ──
messageInput?.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
});

messageInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

btnSend?.addEventListener("click", sendMessage);
window.sendMessage = sendMessage;

// Attach button + file input (Олег 2026-08-24 11:00 MSK)
const btnAttach = $("btn-attach");
const fileInput = $("file-input");
const attachmentsPreview = $("attachments-preview");
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB per file

if (btnAttach && fileInput) {
    btnAttach.addEventListener("click", () => fileInput.click());
    // Lesson #153: HEIC / HEIF не поддерживается в браузерах вне macOS Safari.
    // Если пользватель как-то протащил HEIC (drag/drop или Safari игнорирует accept),
    // показываем chip в UI вместо того чтобы принять файл и зависнуть на encrypt.
    const UNSUPPORTED_MIMES = new Set(["image/heic", "image/heif"]);
    const UNSUPPORTED_EXTS = /\.(heic|heif)$/i;
    function isUnsupported(file) {
        return UNSUPPORTED_MIMES.has(file.type) || UNSUPPORTED_EXTS.test(file.name || "");
    }
    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        // Phase 2 (Variant Б): encrypt each file client-side, upload via /api/upload,
        // collect {blob_id, wrapped_key, name, mime, size} into pendingAttachmentsMeta.
        // NO inline base64 (Lesson #165) — blob_id only goes into envelope.
        if (!activePeer) {
            pushRejectedChip({ name: "—", size: 0 }, "Выберите чат перед прикреплением файла.");
            fileInput.value = "";
            return;
        }
        // Lesson #349: WASM обязан быть готов ДО encrypt (Android: «ошибка
        // шифрования» = гонка eciesWrapKey с init WASM при restored identity).
        try { await ensureWasm(); } catch (wErr) {
            console.error("ensureWasm (attach) failed:", wErr);
            pushRejectedChip({ name: "—", size: 0 }, "Модуль шифрования не загрузился: " + (wErr.message || wErr));
            fileInput.value = "";
            return;
        }
        let peerKey;
        try {
            peerKey = await resolvePeerKey(activePeer);
        } catch (err) {
            console.error("resolvePeerKey failed:", err);
        }
        if (!peerKey) {
            pushRejectedChip({ name: "—", size: 0 }, "Не удалось разрешить ключ получателя.");
            fileInput.value = "";
            return;
        }
        // Ensure attachments module loaded (dynamic import, code-splitting #171).
        if (!window.MurmurAttachments) {
            try {
                await import("./attachments.js");
            } catch (err) {
                pushRejectedChip({ name: "—", size: 0 }, "Не удалось загрузить модуль шифрования.");
                console.error(err);
                fileInput.value = "";
                return;
            }
        }
        for (const file of files) {
            if (isUnsupported(file)) {
                pushRejectedChip(file, "HEIC/HEIF не поддерживается. Сконвертируйте в JPG/PNG.");
                continue;
            }
            if (file.size > MAX_ATTACHMENT_BYTES) {
                pushRejectedChip(file, `Превышает 50 МБ (${formatSize(file.size)}).`);
                continue;
            }
            // Local preview chip (with progress).
            const tempId = "tmp_" + Math.random().toString(36).slice(2, 8);
            const placeholder = {
                name: file.name,
                mime: file.type || "application/octet-stream",
                size: file.size,
                _tempId: tempId,
                _uploading: true,
            };
            pendingAttachments.push(placeholder);
            pendingAttachmentsMeta.push(placeholder);
            renderAttachmentsPreview();
            try {
                const result = await window.MurmurAttachments.attachEncryptAndUpload({
                    file,
                    peerNpub: peerKey.npub,
                    selfNpub: myNpub,
                    onProgress: (loaded, total) => {
                        const idx = pendingAttachments.findIndex((a) => a._tempId === tempId);
                        if (idx >= 0) {
                            pendingAttachments[idx]._progress = loaded / total;
                            renderAttachmentsPreview();
                        }
                    },
                });
                // Replace placeholder with real meta (blob_id, wrapped_key, iv).
                const idx = pendingAttachments.findIndex((a) => a._tempId === tempId);
                if (idx >= 0) {
                    Object.assign(pendingAttachments[idx], {
                        blob_id: result.blob_id,
                        sha256: result.sha256,
                        wrapped_key: result.wrapped_key,
                        iv: result.iv, // base64 12-byte IV for AES-GCM decrypt (Lesson #182)
                        plaintext_b64: result.plaintext_b64, // local outbox cache
                        mime: result.mime,
                        size: file.size,
                        name: file.name,
                        // Privacy: server-visible meta keeps the NEUTRAL upload name
                        // (f-XXXXXXXX.bin); real filename lives only in the sealed ct.
                        publicName: result.publicName,
                        _uploading: false,
                        _progress: 1,
                    });
                    pendingAttachmentsMeta[idx] = Object.assign({}, pendingAttachments[idx]);
                    delete pendingAttachmentsMeta[idx]._progress;
                    delete pendingAttachmentsMeta[idx]._uploading;
                    delete pendingAttachmentsMeta[idx]._tempId;
                    renderAttachmentsPreview();
                }
            } catch (err) {
                console.error("attachEncryptAndUpload failed:", err);
                const idx = pendingAttachments.findIndex((a) => a._tempId === tempId);
                if (idx >= 0) {
                    pendingAttachments.splice(idx, 1);
                    pendingAttachmentsMeta.splice(idx, 1);
                }
                pushRejectedChip(file, `Ошибка загрузки: ${err.message}`);
                renderAttachmentsPreview();
            }
        }
        fileInput.value = ""; // reset для повторного выбора того же файла
    });
}

function renderAttachmentsPreview() {
    if (!attachmentsPreview) return;
    attachmentsPreview.innerHTML = "";
    for (let i = 0; i < pendingAttachments.length; i++) {
        const a = pendingAttachments[i];
        const chip = document.createElement("span");
        chip.className = "attach-chip" + (a._uploading ? " uploading" : "");
        let label = `📎 ${escapeHtml(a.name)} (${formatSize(a.size)})`;
        if (a._uploading && typeof a._progress === "number") {
            label += ` ⏳ ${Math.floor(a._progress * 100)}%`;
        } else if (!a._uploading && a.blob_id) {
            label += ` ✓`;
        }
        label += ` <span class="x" data-idx="${i}">✕</span>`;
        chip.innerHTML = label;
        chip.querySelector(".x").addEventListener("click", () => {
            pendingAttachments.splice(i, 1);
            pendingAttachmentsMeta.splice(i, 1);
            renderAttachmentsPreview();
        });
        attachmentsPreview.appendChild(chip);
    }
    // Rejected files (HEIC, etc) — chip с warning.
    for (let i = 0; i < rejectedChips.length; i++) {
        const r = rejectedChips[i];
        const chip = document.createElement("span");
        chip.className = "attach-chip rejected";
        chip.title = r.reason;
        chip.innerHTML = `⚠️ ${escapeHtml(r.name)} (${formatSize(r.size)}) — ${escapeHtml(r.reason)} <span class="x" data-ridx="${i}">✕</span>`;
        chip.querySelector(".x").addEventListener("click", () => {
            rejectedChips.splice(i, 1);
            renderAttachmentsPreview();
        });
        attachmentsPreview.appendChild(chip);
    }
}

// Lesson #153: push rejected file chip (HEIC, etc.) в preview area.
let rejectedChips = [];
function pushRejectedChip(file, reason) {
    rejectedChips.push({ name: file.name, size: file.size, reason });
    renderAttachmentsPreview();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

btnBack?.addEventListener("click", () => {
    sidebar.classList.remove("hidden");
    chatPanel.classList.remove("active");
    const m = document.querySelector(".messenger");
    if (m) m.classList.remove("chat-open");
    activePeer = null;
    chatView.style.display = "none";
    chatView.hidden = true;
    noChat.style.display = "flex";
    if (btnDeleteChat) btnDeleteChat.hidden = true; // Lesson #129
    noChat.hidden = false;
    inputArea.classList.remove("visible");
    inputArea.hidden = true;
});

// Lesson #129: «удалить чат» — срываем chat из sidebar, чистим badge,
// очищаем память. На сервере ничего не трогаем (TTL 24ч).
btnDeleteChat?.addEventListener("click", () => {
    if (!activePeer) return;
    const peer = normalizePeer(activePeer);
    const nameMap = JSON.parse(localStorage.getItem(LS_CONTACT_NAMES) || "{}");
    const displayName = nameMap[peer] || "Без имени"; // v157: npub не светим
    const ok = confirm(
        "Удалить чат с «" + displayName + "»?\n\n" +
        "Чат исчезнет из списка. История хранится только в памяти этого " +
        "приложения; после удаления сервер не сможет её восстановить.\n\n" +
        "Если «" + displayName + "» пришлёт новое сообщение — чат " +
        "вернётся в список автоматически."
    );
    if (!ok) return;
    hidePeer(peer);
    if (messages[peer]) delete messages[peer];
    const conn = ws; // ничего не делаем, просто оставим коммент
    renderChatList();
    // Выходим в sidebar
    if (typeof btnBack !== "undefined" && btnBack) btnBack.click();
});

chatSearch?.addEventListener("input", () => renderChatList());

// ── WebSocket ──
function connectWS() {
    if (!myNpub) return;
    try {
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
        ws = new WebSocket(WS_URL);
    } catch { return; }

    ws.onopen = () => {
        wsConnected = true;
        wsReconnectDelay = WS_RECONNECT_BASE;
        console.log("WS connected");
        ws.send(JSON.stringify({ type: "subscribe", alias: myAlias, npub: myNpub }));
    };

    // Register alias→npub mapping via HTTP (works even if WS tunnel is down).
    // This is what allows /api/history and /api/inbox to find messages for us.
    if (myNpub && myAlias) {
        fetch(RELAY + "/api/register_alias", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alias: myAlias, npub: myNpub })
        }).then(r => r.json().then(j => console.log("register_alias:", j)))
          .catch(e => console.warn("register_alias failed:", e));
    }

    ws.onmessage = (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            // Relay wraps as {"type":"push","payload":{...}}
            const envelope = msg.payload || msg;
            if (msg.type === "subscribed" || msg.type === "pong" || msg.type === "error") return;
            if (envelope && envelope.ts) handleIncomingEnvelope(envelope);
        } catch (e) {
            console.warn("WS parse error:", e);
        }
    };

    ws.onclose = () => {
        wsConnected = false;
        console.log("WS closed, reconnecting in " + wsReconnectDelay + "ms");
        setTimeout(connectWS, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
    };

    ws.onerror = () => {
        if (ws) ws.close();
    };
}

function handleIncomingEnvelope(env) {
    if (!env || !env.ts) return;
    // Handle both formats: {from_npub, to} and {from, to}
    const fromNpub = env.from_npub || env.from;
    const toField = env.to || "";
    if (fromNpub !== myNpub && toField !== myNpub) return;

    const peer = normalizePeer(fromNpub === myNpub ? toField : fromNpub);
    if (!messages[peer]) messages[peer] = [];

    // Use canonical from Npub+ts as dedup key (sig is too long and would never
    // match the optimistic message key).
    const sigKey = fromNpub + env.ts;
    // Lesson #128: более надёжный дедуп — по envelope_hash, если WS push его
    // прислал. Сервер может перезаписать ts, тогда дедуп по ts ломается.
    const hash = env.envelope_hash_hex || (env.envelope && env.envelope.envelope_hash_hex) || null;
    let exists = false;
    if (hash) {
        exists = messages[peer].some(m => m._hash === hash);
    } else {
        exists = messages[peer].some(m => m._sig === sigKey);
    }
    if (exists) {
        // Already in memory (likely the optimistic copy). Update its status if it
        // was the locally-sent copy.
        const idx = hash
            ? messages[peer].findIndex(m => m._hash === hash)
            : messages[peer].findIndex(m => m._sig === sigKey);
        if (idx !== -1 && messages[peer][idx].status === "sent" && messages[peer][idx].direction === "out") {
            messages[peer][idx].status = "delivered";
            if (activePeer === peer) renderMessages();
        }
        return;
    }

    // Lesson #350: WS-echo НАШЕГО исходящего в полёте POST (self-chat echo,
    // second-device scenario): дедуп не сработает (optimistic._hash ещё null,
    // sig-ключи разные — сервер переписал ts) → вторая копия навсегда. Держим
    // echo до прихода hash из POST-ответа — тот же контракт, что в pollHist.
    if (fromNpub === myNpub && messages[peer].some(m => m._pendingServerAssign)) {
        console.log("[WS] outgoing echo deferred (POST in flight), hash=", (hash || "").slice(0, 12));
        return;
    }

    // E2E: если есть `ct` — расшифровываем async, иначе plaintext fallback.
    decryptEnvelopeForRender(env).then(({ text: bodyText, isBinary, attachments, attachmentsMeta }) => {
        // Privacy v155: from_name не читаем — имя контакта задаёт получатель локально.

        const msg = {
            from: fromNpub, to: toField, body: bodyText, ts: env.ts,
            direction: "in",
            sig: env.sig || "", _sig: sigKey, _hash: hash,
            isBinary: isBinary, status: null, attachments: attachments || [],
            // Privacy v154: attachmentsMeta теперь содержит real names (_plainName),
            // слитые из расшифрованного ct → чипы показывают настоящее имя файла.
            attachments_meta: attachmentsMeta || [],
        };
        messages[peer].push(msg);

        if (!contacts[peer]) {
            contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        }
        contacts[peer].lastMessagePreview = sanitizePreview(bodyText);
        contacts[peer].lastTs = env.ts;

        // Lesson #127: при reload WS присылает старые envelopes. Если ts <= maxTs,
        // сообщение уже было показано/прочитано — не bumpUnread.
        // Lesson #131 + #132.1: при ЛЮБОМ входящем envelope (в т.ч. self-sender
        // с другого устройства) — снимаем скрытие. Без этого чат навсегда
        // останется скрытым, если юзер использует один ключ на нескольких
        // устройствах и удалит чат.
        if (isHiddenPeer(peer)) {
            unhidePeer(peer);
        }
        const prevMax = getMaxTs(peer);
        if (activePeer !== peer && env.ts > prevMax) {
            bumpUnread(peer);
            contacts[peer].unreadCount = getUnread(peer);
        }
        updateMaxTs(peer, env.ts);

        renderChatList();
        if (activePeer === peer) {
            renderMessages();
            scrollToBottom();
        }
    });
}

// ── HTTP Polling (fallback) ──
async function pollInbox() {
    if (!myNpub) return;
    try {
        // Step 0: always refresh contacts list first, so newly-discovered peers
        // (someone who wrote us for the first time) become visible in sidebar
        // even if pollHistoryForPeer doesn't fire on them.
        await loadContacts();
        // Step 1: get all peers I've ever talked to.
        const cr = await fetch(RELAY + "/api/contacts?npub=" + encodeURIComponent(myNpub) + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
        if (!cr.ok) return;
        const cj = await cr.json();
        const peers = new Set();
        for (const c of (cj.contacts || [])) {
            if (c.peer) peers.add(c.peer);
        }
        // Also include any peers we already know about locally.
        for (const k of Object.keys(messages || {})) peers.add(k);
        for (const k of Object.keys(contacts || {})) peers.add(k);
        peers.delete(myNpub);
        // Lesson #132: также опрашиваем hidden peer'ов — иначе после
        // Lesson #129 (delete chat) связь с ними теряется полностью,
        // даже если peer прислал сообщение в первые 5 мин TTL.
        // Без этого fix'а: iPhone удалил чат → polling ничего не знает
        // про этого peer'а (его нет в /api/contacts, в messages нет,
        // а contacts хранит, но pollInbox его подхватывает — ОК если
        // первый контакт не был удалён, баг если contacts пуст).
        for (const k of loadHiddenPeers()) peers.add(k);
        if (peers.size === 0) return;

        // Step 2: for each peer, fetch full history.
        for (const peer of peers) {
            await pollHistoryForPeer(peer);
        }
    } catch (e) { console.warn("pollInbox failed:", e); }
}

async function pollHistoryForPeer(peer) {
    if (!myNpub || !peer) return;
    console.log("[pollHist] peer=", peer.slice(0,12), "myNpub=", myNpub.slice(0,12));
    try {
        const r = await fetch(RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) + "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
        if (!r.ok) return;
        const j = await r.json();
        const msgs = j.messages || [];
        if (msgs.length === 0) return;
        if (!messages[peer]) messages[peer] = [];
        let added = false;
        for (const msg of msgs) {
            const fromNpub = msg.from_npub || msg.from;
            const toField = msg.to || msg.to_alias || "";
            // Lesson #128: дедуп по envelope_hash если есть, иначе по ts.
            const hash = msg.envelope_hash || msg.envelope_hash_hex || null;
            const sigKey = fromNpub + msg.ts;
            let exists = false;
            if (hash) {
                exists = messages[peer].some(m => m._hash === hash);
            } else {
                exists = messages[peer].some(m => m._sig === sigKey);
            }
            if (exists) continue;

            // Lesson #350 (Олег 2026-08-30 18:21 «фотки задваиваются»): race
            // sendMessage × poll — оптимистичная копия ждёт ответ POST /envelope
            // (_hash: null, _pendingServerAssign: true). Серверный echo НАШЕГО
            // исходящего (hash = H(payload) — тот же, что вернёт POST) не матчится
            // по хэш-дедупу → вторая копия навсегда. Пока POST в полёте — скипаем
            // echo; hash/финальный sig поставит POST-обработчик.
            if (fromNpub === myNpub && messages[peer].some(m => m._pendingServerAssign)) {
                console.log("[pollHist] outgoing echo deferred (POST in flight), hash=", (hash || "").slice(0, 12));
                continue;
            }

            // Парсим body как JSON, чтобы обнаружить _kind.
            let parsedBody = null;
            try {
                if (typeof msg.body === "string") {
                    if (msg.body.startsWith("{") || msg.body.startsWith("[")) {
                        parsedBody = JSON.parse(msg.body);
                    }
                }
                if (typeof msg.body_base64 === "string" && msg.body_base64.length > 0) {
                    const inner = decodeBody(msg.body_base64);
                    if (inner && inner.text && (inner.text.startsWith("{") || inner.text.startsWith("["))) {
                        parsedBody = JSON.parse(inner.text);
                    }
                }
            } catch (_e) { parsedBody = null; }

            // Системное «undelivered» — отдаём отправителю, не считаем incoming,
            // рендерим особым bubble.
            if (parsedBody && parsedBody._kind === "undelivered") {
                messages[peer].push({
                    _sig: sigKey,
                    _hash: hash,
                    ts: msg.ts,
                    from: fromNpub,
                    to: toField,
                    body: parsedBody.message || "Адресат не получил сообщение.",
                    direction: "system",
                    isUndelivered: true,
                    originalHash: parsedBody.original_envelope_hash || "",
                    originalRecipient: parsedBody.original_recipient || "",
                    sig: "",
                });
                if (!contacts[peer]) contacts[peer] = { peer: peer, lastMessagePreview: "Не доставлено", lastTs: msg.ts, unreadCount: 0 };
                contacts[peer].lastMessagePreview = "Не доставлено";
                contacts[peer].lastTs = msg.ts;
                if (isHiddenPeer(peer)) {
                    // Lesson #132.5: tombstone — не восстанавливаем чат ради
                    // старого envelope, который polling пере-fetch'ит из
                    // /api/history. Восстанавливаем только при реально новом
                    // сообщении (ts > ts момента удаления).
                    if (msg.ts > getDeletedTs(peer)) unhidePeer(peer);
                }
                if (activePeer !== peer && msg.ts > getMaxTs(peer)) {
                    bumpUnread(peer);
                    contacts[peer].unreadCount = getUnread(peer);
                }
                updateMaxTs(peer, msg.ts);
                added = true;
                continue;
            }

            const { text: bodyText, isBinary } = extractMessageText(msg);
            // Lesson #199 (Олег 2026-08-26): для исходящих — идти в outbox вместо
            // "🔒 шифрованное сообщение", иначе UI покажет placeholder + decrypt errors.
            let resolvedBody = bodyText;
            let resolvedAttachments = msg.attachments || [];
            let resolvedAttachmentsMeta = msg.attachments || [];
            if (fromNpub === myNpub) {
                const outbox = loadOutboxForPeer(peer);
                let localOut = outbox.find(o => {
                    if (hash && o._hash === hash) return true;
                    if (o._sig === sigKey) return true;
                    return false;
                });
                if (!localOut && outbox.length > 0) {
                    let best = null, bestDelta = Infinity;
                    for (const o of outbox) {
                        const delta = Math.abs((o.ts || 0) - (msg.ts || 0));
                        if (delta < bestDelta && delta <= 60) { best = o; bestDelta = delta; }
                    }
                    if (best) localOut = best;
                }
                if (localOut && localOut.body) {
                    resolvedBody = localOut.body;
                    // Lesson #206 (Олег 2026-08-26 12:01): use outbox's attachments_meta
                    // ВСЕГДА, если оно заполнено — иначе UI дублирует chip
                    // (один с plaintext из outbox, второй без из server-fetched meta).
                    // Fallback к server-side только если outbox не сохранил ничего.
                    if (Array.isArray(localOut.attachments_meta) && localOut.attachments_meta.length > 0) {
                        resolvedAttachmentsMeta = localOut.attachments_meta;
                        resolvedAttachments = localOut.attachments || localOut.attachments_meta || [];
                    } else if (Array.isArray(localOut.attachments) && localOut.attachments.length > 0) {
                        // Outbox сохранил attachments но не attachments_meta (старая версия кода)
                        resolvedAttachmentsMeta = localOut.attachments.map(a => ({
                            ...a,
                            plaintext_b64: null,  // marker: рендерим remote chip без decrypt
                        }));
                    }
                    console.log("[pollHist] outgoing resolved via outbox", peer.slice(0, 12), "body=", resolvedBody.slice(0, 20), "att_count=", resolvedAttachmentsMeta.length, "_hash=", hash, "out_hash=", localOut._hash, "plaintext=", resolvedAttachmentsMeta.every(a => a.plaintext_b64));
                } else if (fromNpub === myNpub) {
                    // Lesson #201 + #214 (Олег 2026-08-26 14:33): outbox не нашёлся
                    // (например, после hard refresh iPhone PWA / outbox cleanup).
                    // Для исходящих НЕ показывать "🔒 шифрованное сообщение" — это
                    // триггерит async decrypt, который падает с bad tag.
                    // Lesson #214 fix: если attachments есть — НЕ синтезировать body.
                    // Раньше было `📎 filename (size)` body + remote chip = ДУБЛЬ.
                    // Теперь: body пустой → renderMessages показывает ТОЛЬКО chip.
                    const attMeta = msg.attachments || [];
                    if (attMeta.length > 0) {
                        resolvedBody = "";
                        resolvedAttachmentsMeta = attMeta.map(a => ({
                            ...a,
                            plaintext_b64: null,  // marker для renderMessages: нет decrypt
                            mime: a.mime,
                            name: a.name,
                            size: a.size,
                        }));
                    } else {
                        // Текстовое исходящее без outbox
                        resolvedBody = "[исходящее сообщение]";
                    }
                    console.warn("[pollHist] outgoing NOT resolved via outbox", peer.slice(0, 12), "msg_hash=", hash, "msg_ts=", msg.ts, "outbox_count=", outbox.length, "fallback_body=", resolvedBody.slice(0, 20));
                }
            }

            const envelope = {
                from: fromNpub, to: toField, body: resolvedBody, ts: msg.ts,
                direction: fromNpub === myNpub ? "out" : "in",
                sig: msg.sig || "", _sig: sigKey, _hash: hash,
                isBinary: isBinary,
                status: fromNpub === myNpub ? "sent" : null,
                // Phase 3: keep server fields for async decrypt (loadHistory decrypts
                // via raw `m` with body_base64; here we need it on envelope too).
                _server_msg: msg,
                attachments: resolvedAttachments,
                attachments_meta: resolvedAttachmentsMeta,
            };
            messages[peer].push(envelope);
            added = true;

            // Privacy v155: from_name не читаем — имя контакта задаёт получатель локально.

            if (!contacts[peer]) {
                contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
            }
            contacts[peer].lastMessagePreview = sanitizePreview(bodyText);
            contacts[peer].lastTs = msg.ts;
            // Lesson #131 + #132.1: при ЛЮБОМ новом сообщении для этого
            // peer (входящем ИЛИ self-sender с другого устройства)
            // проверяем hidden и снимаем скрытие. Без этого fix'а:
            // если Олег использует один ключ на MacBook и iPhone,
            // self-сообщение (from=myNpub) не снимает isHiddenPeer,
            // и удалённый чат навсегда остаётся скрытым.
            // Lesson #132.5: tombstone — повторное снятие скрытия работает
            // только при ts > tombstone[peer], чтобы polling re-fetch старых
            // envelope'ов из /api/history не восстанавливал удалённый чат.
            if (isHiddenPeer(peer)) {
                if (msg.ts > getDeletedTs(peer)) unhidePeer(peer);
            }
            // isIncoming используется ТОЛЬКО для unread bump — self-сообщения
            // с другого устройства не должны увеличивать badge (юзер их сам отправил).
            const isIncoming = fromNpub !== myNpub;
            if (isIncoming && activePeer !== peer && msg.ts > getMaxTs(peer)) {
                bumpUnread(peer);
                contacts[peer].unreadCount = getUnread(peer);
            }
            updateMaxTs(peer, msg.ts);
        }
        console.log("[pollHist] after loop: added=", added, "msgs in array=", msgs.length, "first _sig=", msgs[0] ? (msgs[0].from_npub || msgs[0].from) + msgs[0].ts : "none");
        if (added) {
            renderChatList();
            if (activePeer === peer) {
                renderMessages();
                scrollToBottom();
            }
            // Lesson #326: сохраняем обновлённый кэш после каждого poll.
            saveMessagesCacheForPeer(peer);
            // Phase 3: async decrypt new envelopes to replace placeholder
            // body "🔒 шифрованное сообщение" with real text (and attach meta).
            // Mirrors loadHistory pDecrypt pattern (Олег 2026-08-25 16:25 MSK).
            // Lesson #199 (Олег 2026-08-26): для исходящих (direction === "out")
            // НЕ пытаться расшифровать — у нас уже есть body/attachments_meta.
            // Lesson #341 (Олег 2026-08-30): broaden filter — body starting with
            // «🔒» (any variant) + incoming + has _server_msg (or raw body_base64).
            // Было строгое равенство body === "🔒 шифрованное сообщение" &&
            // `_server_msg` — кэш-сообщения (restore из IDB) имели body "🔒..." без
            // _server_msg и оставались зашифрованными навсегда.
            const allMsgs = messages[peer];
            const encMsgs = allMsgs.filter(m => m.direction === "in" &&
                m.body && m.body.includes("🔒") &&
                (m._server_msg || m.body_base64 || (m._hash && !m._decrypt_promise)));
            // Ensure _server_msg exists: rebuild from cache via body_base64 if missing.
            for (const m of encMsgs) {
                if (!m._server_msg && m.body_base64) {
                    try {
                        m._server_msg = { body_base64: m.body_base64, from: m.from, to: m.to, ts: m.ts };
                    } catch (e) { /* ignore */ }
                }
            }
            console.log("[pollHist] total in peer:", allMsgs.length, "encMsgs:", encMsgs.length, "first body:", allMsgs[0]?.body?.slice(0, 30), "first has server_msg:", !!allMsgs[0]?._server_msg);
            if (encMsgs.length > 0) {
                // Lesson #341: decryptWithTimeout memoizes per _server_msg object.
                // For cache-restored messages (no _server_msg), a fresh raw row is
                // needed — retry with server body_base64 to avoid stuck memoized
                // failures. Clear memoized failure so decrypt re-runs.
                Promise.all(encMsgs.map(m => {
                    if (m._server_msg) { m._server_msg._decrypt_promise = null; return decryptWithTimeout(m._server_msg).catch(() => null); }
                    return Promise.resolve(null);
                }))
                    .then(results => {
                        let changed = false;
                        for (let i = 0; i < encMsgs.length; i++) {
                            const r = results[i];
                            const m = encMsgs[i];
                            // Lesson #224 (Олег 2026-08-26 16:05): для outgoing с
                            // resolvedAttachmentsMeta (из outbox fallback или
                            // Lesson #214) НЕ заменять attachments_meta на
                            // _server_msg.attachments — это вызывает ДУБЛЬ чип
                            // (рендер из resolvedAttachmentsMeta + из новых
                            // attachments_meta). Только incoming может
                            // подставлять attachments_meta с сервера.
                            if (m.direction === "in" && m._server_msg && Array.isArray(m._server_msg.attachments)) {
                                m.attachments_meta = m._server_msg.attachments;
                            }
                            if (r && r.text && r.text !== "__DECRYPT_FAILED__") {
                                // Lesson #224: для outgoing НЕ перезаписывать body —
                                // он либо из outbox (correct), либо из Lesson #201
                                // fallback (correct). Только incoming — async decrypt.
                                if (m.direction === "in") {
                                    m.body = r.text;
                                    if (r.attachments) m.attachments = r.attachments;
                                    // Privacy v154: подтягиваем meta со слитыми real names
                                    // из расшифровки (иначе чипы навсегда f-…bin).
                                    if (r.attachmentsMeta && r.attachmentsMeta.length) {
                                        m.attachments_meta = r.attachmentsMeta;
                                        // Privacy v156 (Олег 16:41 «PDF приходят как *.bin»):
                                        // чип мог отрисоваться ДО расшифровки тела (гонка:
                                        // рендер чипа ∥ decrypt тела) и остался с нейтральным
                                        // f-…bin. Сбрасываем DOM attach-списка — следующий
                                        // renderMessages() ниже дорисует чип по пути
                                        // Lesson #320/#348 уже с настоящим именем.
                                        if (activePeer === peer) {
                                            try {
                                                const escFn2 = window.CSS && CSS.escape ? CSS.escape : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
                                                const sig2 = m._sig || ((m.from_npub || m.from) + m.ts);
                                                const bubbleEl2 = document.querySelector(`.bubble[data-sig="${escFn2(sig2)}"]`);
                                                const staleList = bubbleEl2 && bubbleEl2.querySelector(".msg-attach-list");
                                                // remove() а не innerHTML="": in-flight таск Lesson #229
                                                // дописал бы чип со СТАРЫМ именем в очищенный список
                                                // (дубль). В отсоединённый узел — невидимо.
                                                if (staleList) staleList.remove();
                                            } catch (e) { /* ignore */ }
                                        }
                                    }
                                }
                                changed = true;
                                // Lesson #238 v3 (Олег 2026-08-26 22:02 MSK):
                                // sidebar preview update ВНУТРИ цикла по m, не
                                // снаружи. v2 использовал m вне loop scope —
                                // ReferenceError, .catch() глотал, ничего не
                                // происходило. Lesson #232 inline update тоже
                                // внутри цикла — работает. Сейчас то же самое.
                                if (m.direction === "in" && m.body && contacts) {
                                    if (!contacts[peer]) contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
                                    const preview = String(m.body).slice(0, 80);
                                    if (contacts[peer].lastMessagePreview !== preview) {
                                        contacts[peer].lastMessagePreview = preview;
                                        contacts[peer].lastTs = m.ts || Date.now();
                                        renderChatList();
                                    }
                                }
                            } else if (r && r.text === "__DECRYPT_FAILED__") {
                                if (m.direction === "in") {
                                    m.body = "[не удалось расшифровать]";
                                    // Lesson #238 v3: failed decrypt тоже обновляет preview
                                    if (contacts && contacts[peer]) {
                                        contacts[peer].lastMessagePreview = "[не удалось расшифровать]";
                                        renderChatList();
                                    }
                                }
                                changed = true;
                            }
                        }
                        if (changed && activePeer === peer) {
                            // Lesson #232 (Олег 2026-08-26 17:08): точечно обновляем
                            // body в уже отрисованных bubbles вместо полного
                            // renderMessages — Lesson #230 (skip rendered sigs)
                            // оставляет bubble в DOM со СТАРЫМ body. Обновляем
                            // text node in-place.
                            for (let i = 0; i < encMsgs.length; i++) {
                                const m = encMsgs[i];
                                const sig = m._sig || (m.from_npub || m.from) + m.ts;
                                const sigMatch = sig;
                                if (window.__murmurRenderedSigs && window.__murmurRenderedSigs.has(sigMatch)) {
                                    // Lesson #236 (Олег 2026-08-26 21:07): selector
                                    // '.msg-bubble' был неправильный! Реальный class
                                    // = 'bubble'. Selector возвращал null → body
                                    // никогда не обновлялся. Mac не расшифровывал
                                    // текст, iPhone — случайно работал.
                                    // + CSS.escape fallback для старых Safari (без
                                    // native CSS.escape).
                                    const escFn = window.CSS && CSS.escape ? CSS.escape : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
                                    const bubbleEl = document.querySelector(`.bubble[data-sig="${escFn(sig)}"]`);
                                    if (bubbleEl) {
                                        const bodyEl = bubbleEl.querySelector('.msg-body');
                                        if (bodyEl && m.body) bodyEl.textContent = m.body;
                                    }
                                }
                            }
                            renderMessages();
                            scrollToBottom();
                            // Lesson #233 (Олег 2026-08-26 17:25): после in-place
                            // body update — scroll заново, так как body height мог
                            // измениться (🔒 шифрованное сообщение → расшифрованный
                            // текст), и input bar должен быть внизу.
                            requestAnimationFrame(() => {
                                try { messagesArea.scrollTop = messagesArea.scrollHeight; } catch (e) { /* ignore */ }
                            });
                        }
                        // Lesson #238 v3 (moved into loop above) — sidebar preview update
                        // теперь ВНУТРИ for-loop где m определён. v2 был снаружи
                        // → ReferenceError → .catch глотал → не работало.
                    })
                    .catch(e => console.warn("[pollHist] async decrypt chain failed:", e));
            }
        }
    } catch (e) {
        console.warn("pollHistoryForPeer failed:", e && e.message, e && e.stack);
        if (typeof window.__pollErrors !== 'undefined') window.__pollErrors.push({t: Date.now(), fn: 'pollHistoryForPeer', msg: String(e && e.message), stack: String(e && e.stack)});
    }
}

// Lesson #243 (Олег 2026-08-26 22:27): re-sync sidebar preview для всех
// peer'ов в messages. Нужен потому что Lesson #238 v3 срабатывает только
// когда сообщение ПОЛУЧЕНО впервые через pollHist. Но если сообщение
// пришло ДО деплоя v100, или async decrypt вернул пустоту/ошибку в первый
// раз, или Lesson #201 fallback оставил body='' — preview остаётся
// 'зашифрованное сообщение' навсегда.
//
// Проходим по всем messages в памяти и обновляем sidebar preview для
// КАЖДОГО incoming с расшифрованным plaintext body.
function resyncSidebarPreviews() {
    if (!contacts || !messages) return;
    let any = false;
    for (const peer of Object.keys(messages)) {
        const arr = messages[peer];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        // Самое новое сообщение (max ts)
        let newest = null;
        for (const m of arr) {
            if (!newest || (m.ts || 0) > (newest.ts || 0)) newest = m;
        }
        if (!newest) continue;
        // Lesson #243 v2: incoming ИЛИ outgoing (own outbox с attachments может
        // иметь пустой body, но текст мы достаем из resolvedBody / fallback).
        // Если body пустой — смотрим resolvedBody из Lesson #201/214 fallback.
        let body = newest.body;
        if (!body && newest.direction === "out") {
            body = newest.resolvedBody || newest.outbox_body || "";
        }
        if (!body) continue;
        const bodyStr = String(body);
        // Lesson #243 v2: пропускаем только если это raw ciphertext envelope.
        // '[не удалось расшифровать]' начинается с '[' — пропускать НЕ надо
        // (это валидное сообщение для UI).
        // 'Это самолет' и т.п. plaintext — тоже не начинается с '{'.
        if (bodyStr.startsWith("{")) continue;
        if (!contacts[peer]) contacts[peer] = { peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        const preview = bodyStr.slice(0, 80);
        if (contacts[peer].lastMessagePreview !== preview) {
            contacts[peer].lastMessagePreview = preview;
            contacts[peer].lastTs = newest.ts || Date.now();
            any = true;
        }
    }
    if (any) {
        console.log("[resyncSidebarPreviews] updated", Object.keys(messages).length, "peers");
        renderChatList();
    }
}
// Зовём после pollHist (новые сообщения могли прийти) и периодически.
setInterval(resyncSidebarPreviews, 5000);

// Lesson #132.4: рекурсивный setTimeout вместо setInterval.
// iOS PWA печально известен тем, что замораживает setInterval в фоне (или при
// длительном отсутствии input). setTimeout после await poll гарантирует, что
// каждый цикл реально отрабатывает — следующий tick ставится ТОЛЬКО после
// завершения предыдущего (включая всю async работу pollHistoryForPeer).
// visibilitychange делает poll сразу при возврате на экран — но не полагаемся
// только на это: таймаут 5s — это max, реальный интервал = время poll + 5s.
function startPolling() {
    if (window.__pollingStarted) return;
    window.__pollingStarted = true;
    window.__pollErrors = [];
    const POLL_GAP_MS = 5000;
    let lastForcedTick = 0;
    const forceTick = (reason) => {
        // Debounce: чаще одного раза в секунду не дёргаем.
        const now = Date.now();
        if (now - lastForcedTick < 1000) return;
        lastForcedTick = now;
        if (window.__pollTimer) clearTimeout(window.__pollTimer);
        tick(reason);
    };
    const tick = async (reason) => {
        if (reason) console.log("[poll] tick:", reason);
        try {
            await pollInbox();
        } catch (e) {
            console.warn("pollInbox failed in loop:", e && e.message);
        }
        window.__pollTimer = setTimeout(() => tick(), POLL_GAP_MS);
    };
    tick("initial");
    // Lesson #132.4: iOS PWA печально известен тем, что замораживает JS в фоне.
    // Поэтому форсируем tick на ЛЮБОЕ пользовательское действие: тап, скролл,
    // клавиатура, focus. Это гарантирует, что если setTimeout задержался,
    // любой пользовательский input даст мгновенный refresh.
    for (const evt of ["touchstart", "mousedown", "keydown", "scroll", "click", "focus"]) {
        document.addEventListener(evt, () => forceTick(evt), { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") forceTick("visibility");
    });
    window.addEventListener("pageshow", () => forceTick("pageshow"));
    window.addEventListener("focus", () => forceTick("focus"));
}

// ── Visibility handler (Lesson #132.4: основной visibility listener уже в startPolling выше) ──
// Старый visibility handler для WS удалён — visibilitychange теперь в startPolling
// вызывает tick() с полным рекурсивным циклом.

// ── Auto-restore last identity on load ──
async function tryAutoRestore() {
    const savedNpub = localStorage.getItem(LS_NPUB);
    const savedKey = localStorage.getItem(LS_KEY);
    if (!savedNpub || !savedKey) {
        console.log("auto-restore: nothing saved");
        return;
    }
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_restore(savedKey));
        if (res && res.ok && res.data && res.data.npub === savedNpub) {
            myNpub = res.data.npub;
            signKeyHex = res.data.signing_sk_hex;
            myAlias = localStorage.getItem(LS_NAME) || ("murmur-" + (res.data.npub || "").slice(4, 10));
            await invalidateCacheIfKeyChanged();
            enterMessenger();
        } else {
            console.warn("auto-restore: npub mismatch / restore failed", res);
            // Don't wipe LS — it might be a transient WASM load issue.
            // Keep LS for next reload to try again.
        }
    } catch (e) {
        console.warn("auto-restore error", e);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { warmOutboxCache(); tryAutoRestore(); });
} else {
    warmOutboxCache();
    tryAutoRestore();
}

// Повторный заход по ссылке в уже открытом приложении (PWA живёт в фоне).
window.addEventListener("hashchange", () => {
    if (messenger && messenger.classList.contains("active")) handleInviteHash();
});
