// murmur PWA - two-panel messenger
//   Identity: ed25519 npub via WASM (kept in localStorage).
//   Contacts: GET /api/contacts?npub=<me>
//   History:  GET /api/history?npub=<me>&peer=<peer>&limit=100&before_ts=...
//   Send:     POST /envelope?to=<npub> with signed JSON.
//   Realtime: WS broadcast + HTTP-polling fallback (5s).
//   Storage:  identity in localStorage, all chat state in JS memory.

// ── Error reporter (so JS errors show on screen, not just console) ──
(function () {
    const showErr = (msg, source, line, col) => {
        let div = document.getElementById("__js_error_overlay");
        if (!div) {
            div = document.createElement("div");
            div.id = "__js_error_overlay";
            div.style.cssText = "position:fixed;top:0;left:0;right:0;background:#ff3355;color:#fff;padding:12px;font-family:monospace;font-size:12px;z-index:99999;white-space:pre-wrap;max-height:50vh;overflow:auto;border-bottom:2px solid #fff;";
            document.body ? document.body.appendChild(div) : null;
        }
        const text = source ? `[${source}:${line}:${col}] ${msg}` : msg;
        div.textContent += "\n" + text;
    };
    window.addEventListener("error", (e) => showErr(e.message || String(e.error), e.filename, e.lineno, e.colno));
    window.addEventListener("unhandledrejection", (e) => showErr("Promise rejected: " + (e.reason && (e.reason.stack || e.reason.message || e.reason) || "?")));
})();

import init, { identity_new, identity_restore, sign_message } from "./pkg/murmur_id_wasm.js";

const RELAY = "https://explicit-treo-authorities-hash.trycloudflare.com";

// ── WASM boot (обязательно ДО identity_new / sign_message) ──
let wasmReady = null;
function ensureWasm() {
    if (!wasmReady) wasmReady = init();
    return wasmReady;
}

const LS_NPUB = "murmur.npub";
const LS_KEY = "murmur.sk";
const LS_NAME = "murmur.name";
const LS_DISPLAY_NAME = "murmur.display_name";
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
        if (input.body_base64) return decodeBody(input.body_base64);
        if (typeof input.body === "string") return { text: input.body, isBinary: false };
        return { text: JSON.stringify(input), isBinary: false };
    }
    if (typeof input !== "string") return { text: String(input), isBinary: false };

    const s = input;
    // Try direct JSON parse (envelope stored as JSON string)
    if (s.startsWith("{") || s.startsWith("[")) {
        try {
            const parsed = JSON.parse(s);
            if (parsed && typeof parsed === "object") {
                if (parsed.body_base64) return decodeBody(parsed.body_base64);
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
$("btn-create")?.addEventListener("click", async () => {
    try {
        await ensureWasm();
        const res = identity_new();
        if (!res.ok) { $("identity-error").textContent = "identity_new error: " + res.error; return; }
        myNpub = res.data.npub;
        signKeyHex = res.data.signing_sk_hex;
        myAlias = myNpub;
        localStorage.setItem(LS_NPUB, myNpub);
        localStorage.setItem(LS_KEY, signKeyHex);
        localStorage.setItem(LS_NAME, myAlias);
        enterMessenger();
    } catch (e) { $("identity-error").textContent = "Error: " + e.message; }
});

$("btn-restore")?.addEventListener("click", async () => {
    const hex = $("restore-hex").value.trim();
    if (!hex || hex.length < 60) { $("identity-error").textContent = "Enter 64-char hex key"; return; }
    try {
        await ensureWasm();
        const res = identity_restore(hex);
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
    messenger.classList.add("active");
    myNpubEl.textContent = truncateNpub(myNpub);
    const fullEl = $("my-npub-full");
    if (fullEl) fullEl.textContent = myNpub;
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
    const nameInput = $("my-name");
    if (nameInput) {
        nameInput.value = localStorage.getItem(LS_DISPLAY_NAME) || "";
        nameInput.addEventListener("change", () => {
            const v = nameInput.value.trim().slice(0, 24);
            if (v) localStorage.setItem(LS_DISPLAY_NAME, v);
            else localStorage.removeItem(LS_DISPLAY_NAME);
        });
    }
    if (chatView) chatView.style.display = "none";
    if (noChat) noChat.style.display = "flex";
    if (inputArea) inputArea.classList.remove("visible");
    if (sidebar) sidebar.classList.remove("hidden");
    if (chatPanel) chatPanel.classList.remove("active");
    renderChatList();
    loadContacts();
    connectWS();
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
    localStorage.removeItem(LS_DISPLAY_NAME);
    localStorage.removeItem("murmur.contact_names");
    messenger.classList.remove("active");
    identityScreen.style.display = "flex";
    $("identity-error").textContent = "";
    $("restore-hex").value = "";
});

// ── Contacts ──
async function loadContacts() {
    if (!myNpub) return;
    try {
        const r = await fetch(RELAY + "/api/contacts?npub=" + encodeURIComponent(myNpub));
        if (!r.ok) return;
        const j = await r.json();
        if (j.contacts) {
            for (const c of j.contacts) {
                const key = c.peer;
                if (!contacts[key]) {
                    contacts[key] = {
                        peer: c.peer,
                        lastMessagePreview: c.last_message_preview || "",
                        lastTs: c.last_ts || 0,
                        unreadCount: c.unread_count || 0,
                    };
                } else {
                    if (c.last_ts > contacts[key].lastTs) {
                        contacts[key].lastMessagePreview = c.last_message_preview || "";
                        contacts[key].lastTs = c.last_ts;
                    }
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
            ? (c.lastMessagePreview.length > 60 ? c.lastMessagePreview.slice(0, 60) + "..." : c.lastMessagePreview)
            : "No messages yet";
        const name = nameMap[c.peer];
        const peerDisplay = name ? escapeHtml(name) + "<span class='chat-item-peer-sub'>" + truncateNpub(c.peer) + "</span>" : truncateNpub(c.peer);
        const timeDisplay = formatChatTime(c.lastTs);
        const badge = c.unreadCount > 0 ? "<span class='chat-item-badge'>" + c.unreadCount + "</span>" : "";
        div.innerHTML =
            "<div class='chat-item-info'>" +
                "<div class='chat-item-peer'>" + peerDisplay + "</div>" +
                "<div class='chat-item-preview'>" + preview + "</div>" +
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
    activePeer = peer;
    if (window.innerWidth <= 768) {
        sidebar.classList.add("hidden");
        chatPanel.classList.add("active");
    }
    chatList.querySelectorAll(".chat-item").forEach(el => {
        const peerEl = el.querySelector(".chat-item-peer");
        el.classList.toggle("active", peerEl && peerEl.textContent === truncateNpub(peer));
    });
    if (contacts[peer]) contacts[peer].unreadCount = 0;
    chatView.style.display = "flex";
    noChat.style.display = "none";
    inputArea.classList.add("visible");
    const nameMap = loadContactNames();
    const savedName = nameMap[peer];
    chatPeerName.innerHTML = (savedName ? escapeHtml(savedName) + "<span class='peer-name-sub'>" + truncateNpub(peer) + "</span>" : truncateNpub(peer));
    chatPeerName.title = peer + "\nНажмите, чтобы задать имя";
    chatPeerName.onclick = () => {
        const current = loadContactNames()[peer] || "";
        const v = prompt("Display name for " + truncateNpub(peer) + ":", current);
        if (v === null) return;
        const trimmed = v.trim().slice(0, 24);
        saveContactName(peer, trimmed);
        openChat(peer);
    };
    if (!messages[peer]) {
        messages[peer] = [];
        loadHistory(peer);
    } else {
        renderMessages();
        scrollToBottom();
    }
}

// ── Load History ──
async function loadHistory(peer, beforeTs) {
    if (!myNpub) return;
    let url = RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) +
              "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT;
    if (beforeTs) url += "&before_ts=" + beforeTs;
    const area = messagesArea;
    const loadingEl = document.createElement("div");
    loadingEl.className = "loading-spinner";
    loadingEl.textContent = "Loading...";
    area.prepend(loadingEl);
    try {
        const r = await fetch(url);
        if (!r.ok) { loadingEl.remove(); return; }
        const j = await r.json();
        loadingEl.remove();
        if (j.messages && j.messages.length > 0) {
            if (!messages[peer]) messages[peer] = [];
            const existingSet = new Set(messages[peer].map(m => m._sig));
            const newMsgs = [];
            for (const m of j.messages) {
                const sigKey = m.sig || (m.from + m.ts + (m.body_base64 || ""));
                if (existingSet.has(sigKey)) continue;
                let bodyText = "";
                let isBinary = false;
                if (m.body_base64) {
                    const decoded = decodeBody(m.body_base64);
                    bodyText = decoded.text;
                    isBinary = decoded.isBinary;
                } else if (m.body) {
                    bodyText = m.body;
                }
                const msg = {
                    from: m.from, to: m.to, body: bodyText, ts: m.ts,
                    direction: m.direction || (m.from === myNpub ? "out" : "in"),
                    sig: m.sig || "", _sig: sigKey,
                    isBinary: isBinary,
                    status: m.direction === "out" ? "sent" : null,
                };
                newMsgs.push(msg);
                existingSet.add(sigKey);
            }
            if (newMsgs.length > 0) messages[peer] = newMsgs.concat(messages[peer]);
            if (j.next_before_ts) oldestTsForPeer[peer] = j.next_before_ts;
            renderMessages();
        }
    } catch (e) { loadingEl.remove(); console.warn("loadHistory failed:", e); }
}

// ── Render Messages ──
function renderMessages() {
    if (!activePeer) return;
    const msgs = messages[activePeer] || [];
    messagesArea.innerHTML = "";
    for (const m of msgs) {
        const div = document.createElement("div");
        const isOut = m.direction === "out";
        div.className = "message " + m.direction;
        let statusHtml = "";
        if (isOut && m.status) {
            statusHtml = "<span class='message-status " + m.status + "'>" + m.status + "</span>";
        }
        // Always run through extractBodyText — handles old messages stored
        // as JSON envelopes before the parser was added.
        const { text: bodyText, isBinary } = extractBodyText(m.body);
        let bodyHtml;
        if (isBinary || m.isBinary) {
            bodyHtml = "<div class='message-binary'>" + escapeHtml(bodyText) + "</div>";
        } else {
            bodyHtml = "<pre>" + escapeHtml(bodyText) + "</pre>";
        }
        div.innerHTML =
            "<div class='message-body'>" + bodyHtml + "</div>" +
            "<div class='message-meta'>" +
                "<span class='message-time'>" + formatTime(m.ts) + "</span>" +
                statusHtml +
            "</div>";
        messagesArea.appendChild(div);
    }
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
    const sig = sign_message(text);
    if (!sig.ok) { btnSend.disabled = false; console.error("sign error:", sig.error); return; }
    msg.sig = sig.data;

    // Optimistic render
    if (!messages[activePeer]) messages[activePeer] = [];
    const renderedMsg = {
        from: myNpub, to: activePeer, body: text, ts: msg.ts,
        direction: "out", sig: sig.data, _sig: sig.data,
        status: "sent", isBinary: false,
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
            const last = messages[activePeer][messages[activePeer].length - 1];
            if (last) last.status = "delivered";
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
    activePeer = null;
    chatView.style.display = "none";
    noChat.style.display = "flex";
    inputArea.classList.remove("visible");
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

    const peer = fromNpub === myNpub ? toField : fromNpub;
    if (!messages[peer]) messages[peer] = [];

    const sigKey = env.sig || (fromNpub + env.ts + (env.body_base64 || ""));
    const exists = messages[peer].some(m => m._sig === sigKey);
    if (exists) return;

    const { text: bodyText, isBinary } = extractBodyText(env.body || env);

    const msg = {
        from: fromNpub, to: toField, body: bodyText, ts: env.ts,
        direction: "in",
        sig: env.sig || "", _sig: sigKey,
        isBinary: isBinary, status: null,
    };
    messages[peer].push(msg);

    if (!contacts[peer]) {
        contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
    }
    contacts[peer].lastMessagePreview = bodyText.slice(0, 80);
    contacts[peer].lastTs = env.ts;
    if (activePeer !== peer) {
        contacts[peer].unreadCount = (contacts[peer].unreadCount || 0) + 1;
    }

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
        const cr = await fetch(RELAY + "/api/contacts?npub=" + encodeURIComponent(myNpub));
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
        const r = await fetch(RELAY + "/api/history?npub=" + encodeURIComponent(myNpub)
            + "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT);
        if (!r.ok) return;
        const j = await r.json();
        const msgs = j.messages || [];
        if (msgs.length === 0) return;
        if (!messages[peer]) messages[peer] = [];
        let added = false;
        for (const msg of msgs) {
            const fromNpub = msg.from_npub || msg.from;
            const toField = msg.to || msg.to_alias || "";
            const sigKey = msg.envelope_hash_hex || msg.sig || (fromNpub + msg.ts);
            const exists = messages[peer].some(m => m._sig === sigKey);
            if (exists) continue;

            const { text: bodyText, isBinary } = extractBodyText(msg.body);

            const envelope = {
                from: fromNpub, to: toField, body: bodyText, ts: msg.ts,
                direction: fromNpub === myNpub ? "out" : "in",
                sig: msg.sig || "", _sig: sigKey,
                isBinary: isBinary,
                status: fromNpub === myNpub ? "sent" : null,
            };
            messages[peer].push(envelope);
            added = true;

            if (!contacts[peer]) {
                contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
            }
            contacts[peer].lastMessagePreview = bodyText.slice(0, 80);
            contacts[peer].lastTs = msg.ts;
            if (activePeer !== peer) {
                contacts[peer].unreadCount = (contacts[peer].unreadCount || 0) + 1;
            }
        }
        if (added) {
            renderChatList();
            if (activePeer === peer) {
                renderMessages();
                scrollToBottom();
            }
        }
    } catch (e) { console.warn("pollHistoryForPeer failed:", e); }
}

function startPolling() {
    pollInbox();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollInbox, POLL_INTERVAL);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") pollInbox();
    });
}

// ── Visibility handler for WS ──
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        if (!wsConnected) connectWS();
        pollInbox();
    }
});

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
        const res = identity_restore(savedKey);
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
