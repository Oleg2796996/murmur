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
let pollTimer = null;
let ws = null;
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_BASE;

function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
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
        // Some relays wrap message envelope as a separate field; the caller
        // may pass the full history row.
        if (input.envelope && typeof input.envelope === "object") {
            return extractBodyText(input.envelope);
        }
        return { text: JSON.stringify(input), isBinary: false };
    }
    if (typeof input !== "string") return { text: String(input), isBinary: false };

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
                return { text: JSON.stringify(parsed), isBinary: false };
            }
        } catch { /* fallthrough */ }
        // If it starts with { but failed to parse, return as plain text
        if (s.startsWith("{")) return { text: s, isBinary: false };
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
        const res = mod.identity_new();
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
        const res = mod.identity_restore(hex);
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
        const res = mod.identity_restore(hex);
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
    fetch(RELAY + "/api/register_alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: myNpub, npub: myNpub })
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

// ── Contacts ──
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
}
function bumpUnread(peer) {
    peer = normalizePeer(peer);
    const m = loadUnreadMap();
    m[peer] = (m[peer] || 0) + 1;
    saveUnreadMap(m);
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
                        lastMessagePreview: c.last_message_preview || "",
                        lastTs: c.last_ts || 0,
                        unreadCount: unreadMap[key] || 0,
                    };
                } else {
                    if (c.last_ts > contacts[key].lastTs) {
                        contacts[key].lastMessagePreview = c.last_message_preview || "";
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
            for (const m of j.messages) {
                const fromNpub = m.from_npub || m.from;
                const toField = m.to || m.to_alias || "";
                const sigKey = (fromNpub + m.ts);
                const hash = m.envelope_hash || m.envelope_hash_hex || null;
                if (hash && existingHashSet.has(hash)) continue;
                if (!hash && existingSigSet.has(sigKey)) continue;
                const { text: bodyText, isBinary } = extractMessageText(m);
                const fromName = m.from_name || (m.envelope && m.envelope.from_name);
                if (fromNpub && fromName && fromNpub !== myNpub) {
                    setContactName(fromNpub, fromName);
                }
                const msg = {
                    from: fromNpub, to: toField, body: bodyText, ts: m.ts,
                    direction: m.direction || (fromNpub === myNpub ? "out" : "in"),
                    sig: m.sig || "", _sig: sigKey, _hash: hash,
                    isBinary: isBinary,
                    status: m.direction === "out" ? "sent" : null,
                };
                newMsgs.push(msg);
                if (hash) existingHashSet.add(hash);
                existingSigSet.add(sigKey);
            }
            if (newMsgs.length > 0) messages[peer] = newMsgs.concat(messages[peer]);
            if (j.next_before_ts) oldestTsForPeer[peer] = j.next_before_ts;
            renderMessages();
        }
    } catch (e) { clearTimeout(timeoutId); loadingEl.remove(); console.warn("[murmur] loadHistory FAILED:", e.message); }
}

// ── Render Messages ──
function renderMessages() {
    if (!activePeer) return;
    const all = messages[activePeer] || [];
    const msgs = [...all].sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
        const { text: bodyText, isBinary } = extractBodyText(m.body);
        let bodyHtml;
        if (isBinary || m.isBinary) {
            bodyHtml = escapeHtml(bodyText);
        } else {
            bodyHtml = escapeHtml(bodyText);
        }
        div.innerHTML =
            bodyHtml +
            "<span class='bubble-time'>" + formatTime(m.ts) + (statusGlyph ? " " + statusGlyph : "") + "</span>";
        messagesArea.appendChild(div);
    }
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
async function sendMessage() {
    if (!activePeer) return;
    const text = messageInput.value.trim();
    if (!text) return;
    await ensureWasm();
    messageInput.value = "";
    messageInput.style.height = "auto";
    btnSend.disabled = true;
    const msg = {
        from: myNpub, to: activePeer, body: text,
        body_base64: bytesToBase64(new TextEncoder().encode(text)),
        ts: Math.floor(Date.now() / 1000),
    };
    const myName = (localStorage.getItem(LS_NAME) || "").trim();
    if (myName && myName !== myNpub) msg.from_name = myName;
    const mod = await loadWasmModule();
    const sig = mod.sign_message(text);
    if (!sig.ok) { btnSend.disabled = false; console.error("sign error:", sig.error); return; }
    msg.sig = sig.data;

    // Optimistic render
    if (!messages[activePeer]) messages[activePeer] = [];
    const renderedMsg = {
        from: myNpub, to: activePeer, body: text, ts: msg.ts,
        direction: "out", sig: sig.data, _sig: myNpub + msg.ts,
        status: "sent", isBinary: false, _hash: null,
    };
    messages[activePeer].push(renderedMsg);
    renderMessages();
    scrollToBottom();

    try {
        const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(activePeer), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg),
        });
        if (r.ok) {
            btnSend.disabled = false;
            // Lesson #128: сохраняем envelope_hash из ответа для надёжного дедупа
            // (сервер может переписать ts, тогда дедуп по myNpub+ts сломается).
            try {
                const respJson = await r.json();
                if (respJson && respJson.hash) {
                    renderedMsg._hash = respJson.hash;
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
            btnSend.disabled = false;
            const last = messages[activePeer][messages[activePeer].length - 1];
            if (last) { last.status = "failed"; renderMessages(); }
        }
    } catch (e) {
        btnSend.disabled = false;
        const last = messages[activePeer][messages[activePeer].length - 1];
        if (last) { last.status = "failed"; renderMessages(); }
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

    // Use canonical fromNpub+ts as dedup key (sig is too long and would never
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

    const { text: bodyText, isBinary } = extractBodyText(env);

    // Remember peer's display name if it came along with the envelope.
    const fromName = env.from_name || (env.envelope && env.envelope.from_name);
    if (fromNpub && fromName && fromNpub !== myNpub) {
        setContactName(fromNpub, fromName);
    }

    const msg = {
        from: fromNpub, to: toField, body: bodyText, ts: env.ts,
        direction: "in",
        sig: env.sig || "", _sig: sigKey, _hash: hash,
        isBinary: isBinary, status: null,
    };
    messages[peer].push(msg);

    if (!contacts[peer]) {
        contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
    }
    contacts[peer].lastMessagePreview = bodyText.slice(0, 80);
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
}

// ── HTTP Polling (fallback) ──
async function pollInbox() {
    if (!myNpub) return;
    try {
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

            const envelope = {
                from: fromNpub, to: toField, body: bodyText, ts: msg.ts,
                direction: fromNpub === myNpub ? "out" : "in",
                sig: msg.sig || "", _sig: sigKey, _hash: hash,
                isBinary: isBinary,
                status: fromNpub === myNpub ? "sent" : null,
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
            contacts[peer].lastMessagePreview = bodyText.slice(0, 80);
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
        if (added) {
            renderChatList();
            if (activePeer === peer) {
                renderMessages();
                scrollToBottom();
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
        const res = mod.identity_restore(savedKey);
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
