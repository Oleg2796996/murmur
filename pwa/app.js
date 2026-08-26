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
    window.addEventListener("unhandledrejection", (e) => showErr("Promise rejected: " + (e.reason && (e.reason.stack || e.reason.message || e.reason) || "?")));
})();

// WASM boot via dynamic import() so this file can run as a CLASSIC script
// (no <script type="module">). iOS PWA standalone has flaky module support,
// and classic scripts with inline event handlers are 100% reliable.
let _wasmModulePromise = null;
let wasmReady = null;
function loadWasmModule() {
    if (!_wasmModulePromise) {
        _wasmModulePromise = import("./pkg/murmur_id_wasm.js").then((mod) => {
            window.__murmurModuleLoaded = true;
            console.log('[murmur] WASM module loaded');
            return mod;
        });
    }
    return _wasmModulePromise;
}

async function ensureWasm() {
    const mod = await loadWasmModule();
    if (!wasmReady) wasmReady = mod.default();
    return wasmReady;
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

async function saveToOutbox(msg, plaintext, attachmentsPlaintext) {
    try {
        const outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        const key = msg._sig || (msg.from + ":" + msg.ts);
        // attachmentsPlaintext = [{ blob_id, plaintext_b64, mime, name, size }]
        // — used for outgoing render without decrypt round-trip (Lesson #155).
        outbox[key] = {
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
        // Trim outbox to last 200 entries to keep localStorage manageable.
        const keys = Object.keys(outbox);
        if (keys.length > 200) {
            keys.sort((a, b) => (outbox[a].ts || 0) - (outbox[b].ts || 0));
            const toDelete = keys.slice(0, keys.length - 200);
            toDelete.forEach(k => delete outbox[k]);
        }
        localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox));
    } catch (e) {
        console.warn("[murmur] saveToOutbox failed:", e);
    }
}

function loadOutboxForPeer(peerNpub) {
    try {
        const outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        const result = [];
        for (const [key, m] of Object.entries(outbox)) {
            if (m.from === peerNpub || m.to === peerNpub) {
                result.push({
                    ...m,
                    _sig: key,
                    direction: m.from === peerNpub ? "out" : "in",
                });
            }
        }
        return result;
    } catch (e) {
        console.warn("[murmur] loadOutboxForPeer failed:", e);
        return [];
    }
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
const newChatInput = $("new-chat-input");
const btnNewChat = $("btn-new-chat");
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
    return Promise.race([
        decryptEnvelopeForRender(m),
        new Promise((_, rej) => setTimeout(() => rej(new Error("decrypt timeout " + DECRYPT_TIMEOUT_MS + "ms")), DECRYPT_TIMEOUT_MS)),
    ]).catch((e) => {
        console.warn("[murmur] decrypt failed/timed out:", e.message);
        return { text: "__DECRYPT_FAILED__", isBinary: false, attachments: [] };
    });
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
        figure.appendChild(img);
    } else if (mime.startsWith("video/")) {
        const v = document.createElement("video");
        v.src = url;
        v.controls = true;
        v.preload = "metadata";
        v.className = "attach-video";
        figure.appendChild(v);
    } else if (mime.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = url;
        a.controls = true;
        a.preload = "metadata";
        a.className = "attach-audio";
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
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
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
    return loadContactNames()[peer] || truncateNpub(peer);
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunk = bytes.subarray(0, Math.min(bytes.length, 0x8000));
    binary += String.fromCharCode.apply(null, chunk);
    return btoa(binary);
}

// ── Identity Screen ──
async function _handleCreate() {
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_new());
        // WASM returns JSON-encoded string (avoids externref shim pitfalls).
        if (!res.ok) { $("identity-error").textContent = "identity_new error: " + res.error; return; }
        myNpub = res.data.npub;
        signKeyHex = res.data.signing_sk_hex;
        myAlias = myNpub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        localStorage.setItem(LS_NAME, myAlias);
        enterMessenger();
    } catch (e) {
        console.error("[murmur] _handleCreate error:", e);
        const errEl = $("identity-error");
        errEl.textContent = "Error: " + (e.message || String(e));
        errEl.hidden = false;
    }
}
window.__murmurCreate = _handleCreate;
// Expose handlers on window so the inline handlers in index.html can call them
// after the WASM/module has finished loading.
window._handleCreate = _handleCreate;
window._handleRestore = async function() {
    const hex = $("restore-hex").value.trim();
    if (!hex || hex.length < 60) { $("identity-error").textContent = "Enter 64-char hex key"; return; }
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_restore(hex));
        if (!res.ok) { $("identity-error").textContent = "restore error: " + res.error; return; }
        myNpub = res.data.npub;
        signKeyHex = hex;
        myAlias = res.data.npub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        localStorage.setItem(LS_NAME, myAlias);
        enterMessenger();
    } catch (e) { $("identity-error").textContent = "Error: " + e.message; }
};
$("btn-create")?.addEventListener("click", _handleCreate);

$("btn-restore")?.addEventListener("click", async () => {
    const hex = $("restore-hex").value.trim();
    if (!hex || hex.length < 60) { $("identity-error").textContent = "Enter 64-char hex key"; return; }
    try {
        await ensureWasm();
        const mod = await loadWasmModule();
        const res = unwrap(mod.identity_restore(hex));
        if (!res.ok) { $("identity-error").textContent = "restore error: " + res.error; return; }
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
    myNpubEl.textContent = truncateNpub(myNpub);
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
}

$("btn-logout")?.addEventListener("click", () => {
    if (!confirm("Are you sure? Identity will be deleted.")) return;
    localStorage.removeItem(LS_NPUB);
    localStorage.removeItem(LS_KEY);
    if (pollTimer) clearInterval(pollTimer);
    if (ws) { ws.close(); ws = null; }
    contacts = {}; messages = {}; activePeer = null;
    oldestTsForPeer = {};
    localStorage.removeItem("murmur.contact_names");
    messenger.classList.remove("active");
    messenger.hidden = true;
    identityScreen.style.display = "flex";
    identityScreen.hidden = false;
    $("identity-error").textContent = "";
    $("restore-hex").value = "";
});

// Click handler: visible state shows whether browser+server agree there's
// an active push subscription. If browser says yes but server has nothing
// (e.g. after subscriptions.json reset), the button stays visually off so
// user knows to re-tap.
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
                (filter ? "No chats match «" + escapeHtml(filter) + "»" : "No chats yet") +
            "</div>" +
            "<div class='chat-empty-hint'>" +
                "Tap <b>+</b> to start a new conversation.<br>" +
                "Enter the recipient's <code>npub1...</code> address." +
            "</div>";
        chatList.appendChild(empty);
        return;
    }

    for (const c of sorted) {
        const div = document.createElement("div");
        div.className = "chat-item" + (activePeer === c.peer ? " active" : "");
        const preview = c.lastMessagePreview
            ? (c.lastMessagePreview.length > 60 ? c.lastMessagePreview.slice(0, 60) + "…" : c.lastMessagePreview)
            : "No messages yet";
        const name = nameMap[c.peer];
        const displayName = name || truncateNpub(c.peer);
        const avatarInitial = (name || c.peer).slice(0, 1).toUpperCase();
        const avatarColor = avatarColorFor(c.peer);
        const peerDisplay = name
            ? escapeHtml(name) + "<span class='chat-item-peer-sub'>" + escapeHtml(truncateNpub(c.peer)) + "</span>"
            : escapeHtml(truncateNpub(c.peer));
        const timeDisplay = formatChatTime(c.lastTs);
        const badge = c.unreadCount > 0 ? "<span class='chat-item-badge'>" + c.unreadCount + "</span>" : "";
        const previewEsc = escapeHtml(preview);
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

// ── Open Chat ──
function openChat(peer) {
    peer = normalizePeer(peer);
    activePeer = peer;
    const m = document.querySelector(".messenger");
    if (m) m.classList.add("chat-open");
    chatList.querySelectorAll(".chat-item").forEach(el => {
        const peerEl = el.querySelector(".chat-item-peer");
        el.classList.toggle("active", peerEl && peerEl.textContent === truncateNpub(peer));
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
    if (savedName) {
        chatPeerName.innerHTML =
            "<span class='peer-name-main'>" + escapeHtml(savedName) + "</span>" +
            "<span class='peer-name-sub'>" + truncateNpub(peer) + "</span>";
    } else {
        chatPeerName.innerHTML = "<span class='peer-name-main'>" + truncateNpub(peer) + "</span>";
    }
    chatPeerName.title = peer + "\nНажмите, чтобы задать имя";
    chatPeerName.onclick = () => {
        const current = loadContactNames()[peer] || "";
        const v = prompt("Display name for " + truncateNpub(peer) + ":", current);
        if (v === null) return;
        const trimmed = v.trim().slice(0, 24);
        saveContactName(peer, trimmed);
        openChat(peer);
    };
    // Always load history when opening a chat — /api/history is the source
    // of truth, even if we've already received 0 messages via WS. The previous
    // `!messages[peer]` check missed the case where an empty `[]` had been
    // created by an earlier incoming-message handler.
    messages[peer] = [];
    // Локальный badge: сбрасываем счётчик сразу и подтягиваем историю.
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
    loadingEl.textContent = "Loading...";
    // Lesson #158: чистим ВСЕ предыдущие spinners, чтобы они не копились
    // при повторных openChat.
    area.querySelectorAll(".loading-spinner").forEach(el => el.remove());
    area.prepend(loadingEl);
    // 25s timeout: Cloudflare tunnel cold-start can take 10-20s on first request after deploy.
    const fetchCtrl = new AbortController();
    const timeoutId = setTimeout(() => {
        fetchCtrl.abort();
        console.warn("[murmur] loadHistory: timeout 25s");
        loadingEl.remove();
        const errEl = document.createElement("div");
        errEl.className = "error-msg";
        errEl.innerHTML = "Не удалось загрузить историю (25s). <button class='link-btn' onclick='openChat(\"" + peer + "\")'>Повторить</button>";
        area.appendChild(errEl);
    }, 25000);
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
                if (hash && existingHashSet.has(hash)) continue;
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
                    if (local && local.body) {
                        // Нашли локальный plaintext — используем его, не расшифровываем.
                        const msg = {
                            from: fromNpub, to: toField, body: local.body, ts: m.ts,
                            direction: "out",
                            sig: m.sig || "", _sig: sigKey, _hash: hash,
                            isBinary: false,
                            status: "sent",
                            attachments: local.attachments || [],
                        };
                        newMsgs.push(msg);
                        if (hash) existingHashSet.add(hash);
                        existingSigSet.add(sigKey);
                        return; // skip decrypt
                    }
                    // Нет локального — это сообщение отправлено с ДРУГОГО устройства
                    // или до установки PWA. Расшифровываем.
                }
                pDecrypt.push(decryptWithTimeout(m).then(({ text: bodyText, attachments: attArr }) => {
                    const fromName = m.from_name || (m.envelope && m.envelope.from_name);
                    if (fromNpub && fromName && fromNpub !== myNpub) {
                        setContactName(fromNpub, fromName);
                    }
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
                    const msg = {
                        from: fromNpub, to: toField, body: finalBody, ts: m.ts,
                        direction: m.direction || (fromNpub === myNpub ? "out" : "in"),
                        sig: m.sig || "", _sig: sigKey, _hash: hash,
                        isBinary: false,
                        status: m.direction === "out" ? "sent" : null,
                        attachments: attArr || [],
                        // Phase 3: relay's attachment_refs (blob_id, wrapped_key, iv, mime, name, size).
                        // Used by renderMessages to async decrypt + render incoming attachments.
                        attachments_meta: m.attachments || [],
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
                // Обновляем preview sidebar: берём самое свежее сообщение.
                // (Олег 2026-08-25 08:18 MSK — preview не должен быть raw JSON.)
                const newest = messages[peer][0];
                if (newest && newest.body) {
                    if (!contacts[peer]) contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
                    contacts[peer].lastMessagePreview = sanitizePreview(newest.body);
                    contacts[peer].lastTs = newest.ts;
                }
            }
            if (j.next_before_ts) oldestTsForPeer[peer] = j.next_before_ts;
            renderMessages();
            renderChatList();
        }
    } catch (e) { clearTimeout(timeoutId); loadingEl.remove(); console.warn("[murmur] loadHistory FAILED:", e.message); }
}

// ── Render Messages ──
function renderMessages() {
    if (!activePeer) return;
    const all = messages[activePeer] || [];
    const msgs = [...all].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    // Lesson #207 (Олег 2026-08-26 12:01): clean up revoked blob URLs from previous
    // render to prevent memory leak. Each outgoing attachment creates a URL.createObjectURL
    // (Lesson #155), and they accumulate forever without revoke → iPhone PWA hang.
    if (typeof window.__murmurUrlsToRevoke === "undefined") window.__murmurUrlsToRevoke = [];
    const previousUrls = window.__murmurUrlsToRevoke;
    window.__murmurUrlsToRevoke = [];
    messagesArea.innerHTML = "";

    let lastDay = null;
    for (const m of msgs) {
        const day = formatDayDivider(m.ts);
        if (day && day !== lastDay) {
            const divider = document.createElement("div");
            divider.className = "day-divider";
            divider.innerHTML = "<span>" + day + "</span>";
            messagesArea.appendChild(divider);
            lastDay = day;
        }
        const div = document.createElement("div");
        const isOut = m.direction === "out";
        const isSystem = m.direction === "system";
        if (isSystem) {
            div.className = "bubble bubble-system";
        } else {
            div.className = "bubble " + m.direction;
        }
        let statusGlyph = "";
        if (isOut) {
            statusGlyph = m.status === "delivered" ? "✓✓" : (m.status === "sent" ? "✓" : "");
        }
        if (isSystem) {
            statusGlyph = "⏳";
        }
        // E2E: расшифрованное сообщение в m.body (если содержит attachments — они уже в массиве)
        const bodyText = m.body || "";
        let bodyHtml = escapeHtml(bodyText);

        // Входящие вложения рендерятся асинхронно через render-attachments.js
        // Исходящие рендерятся из локального кэша outbox.
        // Больше не используем data:URL в bodyHtml (Lesson #170).
        div.innerHTML =
            bodyHtml +
            "<span class='bubble-time'>" + formatTime(m.ts) + (statusGlyph ? " " + statusGlyph : "") + "</span>";
        messagesArea.appendChild(div);
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
            if (hasPlaintext) {
                for (const att of m.attachments_meta) {
                    try {
                        const mime = att.mime || "application/octet-stream";
                        const blob = b64ToBlob(att.plaintext_b64, mime);
                        const url = URL.createObjectURL(blob);
                        // Lesson #207: track URL for revoke on next render
                        window.__murmurUrlsToRevoke.push(url);
                        const el = renderOutgoingAttachment({ mime, name: att.name, url, size: att.size });
                        placeholderEl.appendChild(el);
                    } catch (e) {
                        console.error("[attach-out] render failed:", e);
                    }
                }
            } else {
                // Remote-outgoing: show static chips without trying to decrypt.
                for (const att of m.attachments_meta) {
                    const chip = document.createElement("div");
                    chip.className = "msg-attach-remote";
                    chip.textContent = "\ud83d\udcf7 " + (att.name || "file") + " (" + formatSize(att.size || 0) + ")";
                    placeholderEl.appendChild(chip);
                }
            }
            // fall through — bubble `div` is appended below
        }
        // For incoming ONLY: server returned attachments_meta only (no plaintext).
        // Outgoing messages with attachments_meta but without plaintext_b64 are
        // already rendered as remote-attach placeholders above (Lesson #195).
        if (m.direction === "in" && m.attachments_meta && Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) {
            // Render placeholder container, then async decrypt + replace.
            const placeholderEl = document.createElement("div");
            placeholderEl.className = "msg-attach-list";
            div.insertBefore(placeholderEl, div.firstChild);
            // Lesson #210 (Олег 2026-08-26 13:38): parallel renderAttachment with
            // ABORT CONTROLLER. Sequential await блокировал — 2-е фото ждало 1-е
            // fetch+decrypt (30+s) → iPhone PWA deadlock через renderMessages
            // повторные вызовы (от pollHist) — DOM reset терял предыдущие fetches
            // → blob URLs никогда не возвращались → loading spinner вечный.
            const renderAbort = new AbortController();
            // Register this controller for this render call — previous render's
            // controllers are aborted when renderMessages fires again.
            if (typeof window.__murmurRenderAbort === "undefined") window.__murmurRenderAbort = null;
            if (window.__murmurRenderAbort) {
                try { window.__murmurRenderAbort.abort("newer render starting"); } catch (e) { /* ignore */ }
            }
            window.__murmurRenderAbort = renderAbort;
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
                    await Promise.allSettled(m.attachments_meta.map(async (att) => {
                        if (renderAbort.signal.aborted) return null;
                        try {
                            return await renderer.renderAttachment(att, placeholderEl, renderAbort.signal);
                        } catch (e) {
                            console.error("[attach] render failed:", e);
                            return null;
                        }
                    }));
                } catch (e) {
                    console.error("[attach] init failed:", e);
                }
            })();
        }
    }
    // Lesson #207: revoke previous render's blob URLs to prevent memory leak
    // (otherwise URLs accumulate forever, iPhone PWA hangs after few messages).
    setTimeout(() => {
        for (const u of previousUrls) {
            try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
        }
        if (previousUrls.length > 0) {
            console.log("[murmur] revoked", previousUrls.length, "blob URLs from previous render");
        }
    }, 5000);  // 5s delay — attachments need time to load
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
        const metaSnapshot = pendingAttachmentsMeta.map((a) => Object.assign({}, a));
        const sealedB64 = await encryptForRecipient(peerKey.npub, {
            body: text,
            attachments: metaSnapshot.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
        });
        pendingAttachments = []; // clear after encrypt
        pendingAttachmentsMeta = []; // clear after encrypt
        renderAttachmentsPreview();

        const msg = {
            from: myNpub,
            to: activePeer,
            ct: sealedB64,         // ← E2E sealed envelope (base64)
            attachments_meta: metaSnapshot, // [{blob_id, sha256, wrapped_key, name, mime, size}]
            ts: Math.floor(Date.now() / 1000),
        };
        const myName = (localStorage.getItem(LS_NAME) || "").trim();
        if (myName && myName !== myNpub) msg.from_name = myName;
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
        renderedMsg = {
            from: myNpub, to: activePeer, body: text, ts: msg.ts,
            direction: "out", sig: sig.data, _sig: myNpub + msg.ts,
            status: "sent", isBinary: false, _hash: null,
            attachments_meta: attachmentsWithPlaintext, // [{blob_id, mime, name, size, plaintext_b64}]
        };
        messages[activePeer].push(renderedMsg);
        optimisticRendered = true;
        // Lesson #159: сохраняем в outbox localStorage, чтобы после reload можно было
        // отрисовать без decrypt (анти-паттерн шифровать/расшифровывать собственные).
        console.log("[send] attachmentsWithPlaintext count =", attachmentsWithPlaintext.length, "metaSnapshot =", metaSnapshot.length);
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
            body: JSON.stringify(msg),
        });
        if (r.ok) {
            // Lesson #128: сохраняем envelope_hash из ответа для надёжного дедупа
            // (сервер может переписать ts, тогда дедуп по myNpub+ts сломается).
            try {
                const respJson = await r.json();
                if (respJson && respJson.hash) {
                    renderedMsg._hash = respJson.hash;
                    // Lesson #197 (Олег 2026-08-26): обновить outbox с реальным _hash,
                    // иначе после reload loadHistory не найдёт локальный plaintext
                    // и попытается расшифровать зашифрованное-для-Bob (failed).
                    const outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
                    const outboxKey = renderedMsg._sig;
                    if (outbox[outboxKey]) {
                        outbox[outboxKey]._hash = respJson.hash;
                        localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox));
                    }
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
            if (last) { last.status = "failed"; renderMessages(); }
        }
    } catch (e) {
        // Lesson #152: ошибка (HEIC blob падает в WASM encrypt, network drop, итд)
        // — откатить optimistic render и показать failed.
        console.error("[murmur] sendMessage caught:", e.message);
        if (optimisticRendered && renderedMsg) {
            renderedMsg.status = "failed";
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
function createNewChatFromInput() {
    const npub = newChatInput.value.trim();
    if (!npub) {
        newChatInput.focus();
        return;
    }
    if (!npub.startsWith("npub1")) {
        newChatInput.style.borderColor = "var(--danger)";
        setTimeout(() => { newChatInput.style.borderColor = ""; }, 1200);
        return;
    }
    if (contacts[npub]) {
        openChat(npub);
    } else {
        contacts[npub] = { peer: npub, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        renderChatList();
        openChat(npub);
    }
    newChatInput.value = "";
}

$("btn-new-chat")?.addEventListener("click", createNewChatFromInput);

newChatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        createNewChatFromInput();
    }
});

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
    const displayName = nameMap[peer] || truncateNpub(peer);
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

    // E2E: если есть `ct` — расшифровываем async, иначе plaintext fallback.
    decryptEnvelopeForRender(env).then(({ text: bodyText, isBinary, attachments }) => {
        // Remember peer's display name if it came along with the envelope.
        const fromName = env.from_name || (env.envelope && env.envelope.from_name);
        if (fromNpub && fromName && fromNpub !== myNpub) {
            setContactName(fromNpub, fromName);
        }

        const msg = {
            from: fromNpub, to: toField, body: bodyText, ts: env.ts,
            direction: "in",
            sig: env.sig || "", _sig: sigKey, _hash: hash,
            isBinary: isBinary, status: null, attachments: attachments || [],
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
                    // Lesson #201 (Олег 2026-08-26): outbox не нашёлся (например,
                    // после hard refresh iPhone PWA / outbox cleanup). Для исходящих
                    // НЕ показывать "🔒 шифрованное сообщение" — это триггерит
                    // async decrypt, который падает с bad tag. Вместо этого:
                    // синтетический placeholder из server attachment meta (filename+size).
                    const attMeta = msg.attachments || [];
                    if (attMeta.length > 0) {
                        const att = attMeta[0];
                        const name = att.name || "attachment";
                        const sizeKb = att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : "";
                        const emoji = att.mime && att.mime.startsWith("image/") ? "🖼" :
                                      att.mime && att.mime.startsWith("video/") ? "🎬" :
                                      att.mime && att.mime.startsWith("audio/") ? "🎵" : "📎";
                        resolvedBody = `${emoji} ${name}${sizeKb}`;
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

            // Remember peer's display name if present (envelope or top-level).
            const fromName = msg.from_name || (msg.envelope && msg.envelope.from_name);
            if (fromNpub && fromName && fromNpub !== myNpub) {
                setContactName(fromNpub, fromName);
            }

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
            // Phase 3: async decrypt new envelopes to replace placeholder
            // body "🔒 шифрованное сообщение" with real text (and attach meta).
            // Mirrors loadHistory pDecrypt pattern (Олег 2026-08-25 16:25 MSK).
            // Lesson #199 (Олег 2026-08-26): для исходящих (direction === "out")
            // НЕ пытаться расшифровать — у нас уже есть body/attachments_meta.
            const allMsgs = messages[peer];
            const encMsgs = allMsgs.filter(m => m.body === "🔒 шифрованное сообщение" && m._server_msg && m.direction === "in");
            console.log("[pollHist] total in peer:", allMsgs.length, "encMsgs:", encMsgs.length, "first body:", allMsgs[0]?.body?.slice(0, 30), "first has server_msg:", !!allMsgs[0]?._server_msg);
            if (encMsgs.length > 0) {
                Promise.all(encMsgs.map(m => decryptWithTimeout(m._server_msg).catch(() => null)))
                    .then(results => {
                        let changed = false;
                        for (let i = 0; i < encMsgs.length; i++) {
                            const r = results[i];
                            const m = encMsgs[i];
                            // Phase 3: server's attachment_refs (blob_id, wrapped_key, iv, mime)
                            // come from _server_msg.attachments, NOT from decrypted plaintext.
                            if (m._server_msg && Array.isArray(m._server_msg.attachments)) {
                                m.attachments_meta = m._server_msg.attachments;
                            }
                            if (r && r.text && r.text !== "__DECRYPT_FAILED__") {
                                m.body = r.text;
                                if (r.attachments) m.attachments = r.attachments;
                                changed = true;
                            } else if (r && r.text === "__DECRYPT_FAILED__") {
                                m.body = "[не удалось расшифровать]";
                                changed = true;
                            }
                        }
                        if (changed && activePeer === peer) {
                            renderMessages();
                            scrollToBottom();
                        }
                    })
                    .catch(e => console.warn("[pollHist] async decrypt chain failed:", e));
            }
        }
    } catch (e) {
        console.warn("pollHistoryForPeer failed:", e && e.message, e && e.stack);
        if (typeof window.__pollErrors !== 'undefined') window.__pollErrors.push({t: Date.now(), fn: 'pollHistoryForPeer', msg: String(e && e.message), stack: String(e && e.stack)});
    }
}

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
    document.addEventListener("DOMContentLoaded", tryAutoRestore);
} else {
    tryAutoRestore();
}
