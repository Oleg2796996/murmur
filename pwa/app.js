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

// ── Push debug panel (v160y22pushdebug1) ──
// Visible overlay for push subscription/register/delivery diagnostics.
(function () {
    const MAX_LINES = 80;
    const logs = [];
    let panel = null;
    let logEl = null;
    let visible = true;

    function ts() {
        const d = new Date();
        return d.toLocaleTimeString("ru-RU", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
    }

    function ensurePanel() {
        if (panel) return;
        panel = document.createElement("div");
        panel.id = "__push_debug_panel";
        panel.style.cssText = "position:fixed;bottom:0;left:0;right:0;max-height:38vh;background:rgba(0,20,40,0.92);color:#7fd4ff;font-family:monospace;font-size:10px;z-index:99998;border-top:2px solid #229ED9;display:flex;flex-direction:column;";
        const hdr = document.createElement("div");
        hdr.style.cssText = "display:flex;gap:6px;padding:4px 8px;background:rgba(34,158,217,0.25);align-items:center;flex-shrink:0;";
        const title = document.createElement("span");
        title.textContent = "🔔 PUSH DEBUG";
        title.style.fontWeight = "bold";
        hdr.appendChild(title);
        const mkBtn = (label, fn) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.style.cssText = "padding:2px 6px;font-size:10px;border:1px solid #229ED9;background:#17212b;color:#fff;cursor:pointer;border-radius:3px;";
            b.onclick = fn;
            return b;
        };
        hdr.appendChild(mkBtn("Скрыть", () => { visible = false; panel.style.display = "none"; }));
        hdr.appendChild(mkBtn("Показать", () => { visible = true; panel.style.display = "flex"; }));
        hdr.appendChild(mkBtn("Очистить", () => { logs.length = 0; if (logEl) logEl.textContent = ""; }));
        hdr.appendChild(mkBtn("Копировать", () => {
            const text = logs.map(l => l.t + " " + l.msg).join("\n");
            navigator.clipboard.writeText(text).catch(() => {});
        }));
        hdr.appendChild(mkBtn("🔔 retry", () => {
            if (typeof _schedulePushRetry === "function") _schedulePushRetry(true);
            else if (typeof setupPushSubscription === "function") setupPushSubscription(true);
        }));
        logEl = document.createElement("pre");
        logEl.style.cssText = "margin:0;padding:6px 8px;overflow:auto;white-space:pre-wrap;word-break:break-all;flex:1;";
        panel.appendChild(hdr);
        panel.appendChild(logEl);
        (document.body || document.documentElement).appendChild(panel);
    }

    function render() {
        if (!logEl) return;
        logEl.textContent = logs.map(l => l.t + " " + l.msg).join("\n");
        logEl.scrollTop = logEl.scrollHeight;
    }

    window.pushDebugLog = function (msg, level) {
        const line = { t: ts(), msg: (level ? "[" + level + "] " : "") + String(msg) };
        logs.push(line);
        if (logs.length > MAX_LINES) logs.shift();
        console.log("[push-debug]", line.msg);
        // v160p6b: panel hidden by default (запрос Олега) — only console.
        // Panel opens on demand via window.__PUSH_DEBUG__.show() in console.
    };

    window.__PUSH_DEBUG__ = {
        logs: () => logs.slice(),
        show: () => { visible = true; ensurePanel(); panel.style.display = "flex"; },
        hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    };

    // SW → page push events
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (ev) => {
            const d = ev.data;
            if (!d || d.type !== "push-debug") return;
            window.pushDebugLog("[SW] " + (d.event || "?") + ": " + (d.detail || ""), "sw");
        });
    }

    window.pushDebugLog("panel init v160p6b (hidden; console-only, show via __PUSH_DEBUG__.show())");
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
        // v160g6-fix: cache-bust на pkg JS И wasm — Safari держит старый бинарник
        // без групповых экспортов (wasm.group_new_key is not a function).
        // Явный URL с query: import.meta.url resolution сьедает ?v= на relative path.
        const bust = "v=160h8";
        const mod = await import("./pkg/murmur_id_wasm.js?" + bust);
        if (!_wasmReady) {
            const wasmUrl = new URL("pkg/murmur_id_wasm_bg.wasm?" + bust, location.href);
            await mod.default(wasmUrl.href);   // <-- явный путь с bust, не import.meta.url
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

const RELAY = "https://murmurchat.org";
const LS_NPUB = "murmur.npub";
const LS_KEY = "murmur.sk";
const LS_NAME = "murmur.name";
// Lesson #159 (Олег 2026-08-25 08:18 MSK): после reload локальный кэш messages[peer]
// обнуляется. Без постоянного кэша исходящие на устройстве отправителя превращаются
// в «исходящее, шифрование нарушено». Решение: outbox — localStorage кэш (sig → {body,
// att, ts, from, to}) восстанавливается на init.
const WS_URL = RELAY.replace("https://", "wss://").replace("http://", "ws://") + "/ws";
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
const btnCall = $("btn-call");
const btnVideoCall = $("btn-video-call");

let myNpub = null;
let myAlias = "anon";
let signKeyHex = null;
let contacts = {};
let messages = {};
let currentGroup = null; // v160g3: открытая группа (group_id) — null = обычный 1:1 чат

// v160g4: модалка создания группы (имя + выбор участников из контактов).
// Только подписанный юзер. Инвайты уходят через 1:1 ECIES (sendGroupInvite).
function openCreateGroupModal() {
    if (!myNpub) { alert("Сначала войдите (подпишите identity)."); return; }
    const peers = Object.values(contacts)
        .filter(c => !isHiddenPeer(c.peer))
        .sort((a, b) => (loadContactNames()[a.peer] || a.peer).localeCompare(loadContactNames()[b.peer] || b.peer));
    if (!peers.length) { alert("Нет контактов для приглашения. Сначала создайте 1:1 чат."); return; }
    const overlay = document.createElement("div");
    overlay.id = "group-modal-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;";
    const nameMap = loadContactNames();
    overlay.innerHTML =
        '<div style="background:var(--panel,#17212b);border-radius:14px;max-width:420px;width:100%;max-height:80vh;overflow:auto;padding:18px;color:#e9eaeb;">' +
        '<h3 style="margin:0 0 14px;font-size:17px;">Новая группа</h3>' +
        '<input id="group-name-input" type="text" placeholder="Название группы" maxlength="48" style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;border:1px solid var(--border,#2f3b47);background:var(--bg,#0e1621);color:#e9eaeb;font-size:14px;margin-bottom:12px;">' +
        '<div style="font-size:11px;opacity:.55;margin-bottom:6px;">Участники (до ' + GROUP_MEMBER_CAP + ', вкл. вас):</div>' +
        '<div id="group-members-list" style="max-height:240px;overflow:auto;margin-bottom:14px;">' +
        peers.map((c, i) =>
            '<label style="display:flex;align-items:center;gap:10px;padding:8px 6px;border-radius:8px;cursor:pointer;"><input type="checkbox" class="group-member-cb" data-npub="' + c.peer + '" style="accent-color:#5eb0ff;"><span style="font-size:14px;">' + escapeHtml(nameMap[c.peer] || shortNpub(c.peer)) + '</span><span style="font-size:11px;opacity:.45;margin-left:auto;">' + shortNpub(c.peer) + '</span></label>'
        ).join("") +
        '</div>' +
        '<div style="display:flex;gap:10px;">' +
        '<button id="group-create-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--border,#2f3b47);background:transparent;color:#e9eaeb;cursor:pointer;">Отмена</button>' +
        '<button id="group-create-ok" style="flex:1;padding:10px;border-radius:8px;border:none;background:#2b5278;color:#fff;font-weight:600;cursor:pointer;">Создать</button>' +
        '</div>' +
        '<div id="group-create-status" style="margin-top:10px;font-size:12px;opacity:.7;min-height:16px;"></div>' +
        '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector("#group-create-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#group-create-ok").addEventListener("click", async () => {
        const name = overlay.querySelector("#group-name-input").value.trim();
        const members = [...overlay.querySelectorAll(".group-member-cb:checked")].map(cb => cb.dataset.npub);
        if (!name) { overlay.querySelector("#group-create-status").textContent = "Введите название"; return; }
        if (!members.length) { overlay.querySelector("#group-create-status").textContent = "Выберите хотя бы одного участника"; return; }
        const st = overlay.querySelector("#group-create-status");
        st.textContent = "Создаю группу и отправляю инвайты…";
        try {
            const g = await createGroup(name, members);
            st.textContent = "Готово: " + g.name + " (" + g.members.length + " участн.)";
            setTimeout(() => { overlay.remove(); openGroupChat(g.id); }, 600);
        } catch (e) {
            st.textContent = "Ошибка: " + (e && e.message || e);
        }
    });
}
window.openCreateGroupModal = openCreateGroupModal;
let activePeer = null;
let oldestTsForPeer = {};
// Expose for E2E test diagnostics (Олег 2026-08-26)
window.__murmurState = () => ({ messages, activePeer, contacts });

// Local call history events. These are intentionally not sent through the
// relay: call metadata stays on each participant's device.
window.recordCallEvent = function (peer, event) {
    if (!peer || !event || !event.status) return;
    const ts = event.ts || Math.floor(Date.now() / 1000);
    const item = {
        direction: "system", callEvent: true, callStatus: event.status,
        callDirection: event.direction || "in", callDuration: Math.max(0, Number(event.duration) || 0),
        body: "", ts, _sig: "call:" + peer + ":" + ts + ":" + Math.random().toString(36).slice(2),
    };
    (messages[peer] = messages[peer] || []).push(item);
    // Call events are appended in real time without rebuilding the message
    // list. A full render + forced scroll here races iOS keyboard/viewport
    // settling and was the source of visible chat jumps.
    if (activePeer === peer && messagesArea) {
        const label = item.callDirection === "out"
            ? (item.callStatus === "declined" ? "Исходящий отклонен" : "Исходящий")
            : (item.callStatus === "cancelled" ? "Входящий отменен" : "Входящий");
        const duration = item.callDuration > 0 ? " - " + formatDurationForCall(item.callDuration) : "";
        const node = document.createElement("div");
        node.className = "call-event-text";
        node.dataset.sig = item._sig;
        node.textContent = label + " " + formatTime(item.ts) + duration;
        messagesArea.appendChild(node);
        try { window.__murmurRenderedSigs?.add(item._sig); } catch (_) {}
    }
    try { saveMessagesCacheForPeer(peer); } catch (_) {}
    try { window.appStore?.saveMessages(peer, messages[peer]); } catch (_) {}
};

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
// v160r (Олег 2026-09-17): reply-to — тап на bubble → бар «ответ на: …»,
// отправка несёт reply_to {sig, preview} внутри E2E payload (релей не видит).
let pendingReply = null;           // {sig, preview, ts} | null
let ws = null;
let wsConnected = false;
window.MurmurRuntime = window.MurmurRuntime || {};
window.addEventListener("message", (event) => {
    const d = event.data || {};
    if (d.type === "incoming_call" && window.MurmurCall && d.from_npub) {
        window.MurmurCall.notifyIncoming(d.from_npub, d.call_mode);
    }
});
Object.defineProperties(window.MurmurRuntime, {
    activePeer: { get: () => activePeer },
    myNpub: { get: () => myNpub },
    ws: { get: () => ws }
});
let wsReconnectDelay = WS_RECONNECT_BASE;

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
window.b64ToBlob = b64ToBlob; // v160p: глобальный alias — blob-cache paste в sendMessage

// Convert base64 string to ArrayBuffer (v160y37: OPFS plaintext-put при отправке).
function b64ToAb(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
}
window.b64ToAb = b64ToAb;

// Render an outgoing attachment from local plaintext (no decrypt round-trip).
function renderOutgoingAttachment({ mime, name, url, size, poster, att }) {
    const figure = document.createElement("figure");
    figure.className = "attach-figure";
    if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = name || "image";
        img.loading = "lazy";
        img.className = "attach-image";
        img.onclick = (ev) => {
            // v160y27: same fix — тап по фото = только fullscreen, reply долгим нажатием.
            ev.stopPropagation();
            ev.preventDefault();
            openFullscreen(url, mime);
        };
        // v160p9 FIX (Олег 20:40 «на маке опять мелки превью»): same fix —
        // явная width из natural-размера после load (bubble не схлопывается).
        img.addEventListener("load", () => {
            console.log("[attach-img-out] loaded", att && att.blob_id ? att.blob_id.slice(0, 8) : "?",
                "natural=", img.naturalWidth + "x" + img.naturalHeight,
                "rendered=", img.clientWidth + "x" + img.clientHeight,
                "blobSize=", size);
            const nw = img.naturalWidth, nh = img.naturalHeight;
            if (nw && nh) {
                let w = nw;
                if (nh > 280) w = Math.round(nw * 280 / nh);
                img.style.width = w + "px";
            }
        });
        // Lesson #225: register для auto-revoke на detach
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(img, url);
        figure.appendChild(img);
    } else if (mime.startsWith("video/")) {
        // v160c: превью-кадр + play-кнопка; сетап общий с render-attachments.js
        // (window.murmurSetupVideoPreview). Регресс v160b (absolute-слои →
        // wrap 0 высоты) убран: video в потоке, iOS = muted-автоплей.
        const wrap = document.createElement("div");
        wrap.className = "video-preview";
        const thumb = document.createElement("video");
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = "metadata";
        thumb.className = "video-thumb";
        thumb.src = url + "#t=0.1";
        if (poster) thumb.poster = poster; // v160d: кадр от отправителя (iOS)
        // v160y34 (Олег 2026-09-24 «вместо превью черный кадр»): если за 3.5с
        // ни постера, ни декодированного кадра — CSS-чип «🎥 Видео» на тёмном
        // (вместо пустого чёрного квадрата). video-frame-ready от rVFC
        // (murmurSetupVideoPreview) снимает чип, когда кадр реально показан.
        setTimeout(() => {
            if (!wrap.classList.contains("video-frame-ready") && !thumb.poster) {
                wrap.classList.add("video-fallback-chip");
            }
        }, 3500);
        const playBtn = document.createElement("div");
        playBtn.className = "video-play-btn";
        playBtn.textContent = "▶";
        wrap.appendChild(thumb);
        wrap.appendChild(playBtn);
        // v160p: полный плеер теперь window.openVideoFullscreen (self-healing,
        // re-resolve из blob-кэша при dead URL) — дубль убран.
        // v160y30 (Олег 22:44 «Вариант B и для исходящих»): у входящих (render-attachments)
        // stopPropagation есть, здесь НЕ было — клик всплывал до messages-area
        // → wireBubbleTrap открывал reply-бар ПОВЕРХ fullscreen. Тап = только fullscreen.
        wrap.onclick = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            openVideoFullscreen(url, mime, att.name || att._plainName || name, att);
        };
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(thumb, url);
        figure.appendChild(wrap);
        if (window.murmurSetupVideoPreview) window.murmurSetupVideoPreview(wrap, thumb, url);
    } else if (mime.startsWith("audio/")) {
        const a = document.createElement("audio");
        a.src = url;
        a.controls = true;
        a.preload = "metadata";
        a.className = "attach-audio";
        // v160y30: клик по контролам не всплывает в reply-бар (контролы работают).
        a.onclick = (ev) => ev.stopPropagation();
        if (window.__murmurBlobOwners) window.__murmurBlobOwners.set(a, url);
        figure.appendChild(a);
    } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = name || "file";
        link.className = "attach-file";
        link.textContent = `📎 ${name || "file"} (${formatSize(size)})`;
        // v160y30: клик по ссылке не всплывает в reply-бар; download работает
        // (preventDefault НЕ ставим — ссылка должна качать).
        link.addEventListener("click", (ev) => ev.stopPropagation());
        figure.appendChild(link);
    }
    return figure;
}

function formatTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDurationForCall(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
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

// v158c (Олег 22:49): превью чата с учётом файлов — файл без текста → «📎 имя»,
// текст+файлы → «📎 имя · текст». Нерасшифровано → «🔒 зашифрованное сообщение».
function previewForMsg(m) {
    try {
        if (!m) return "";
        const am = (Array.isArray(m.attachments_meta) && m.attachments_meta.length) ? m.attachments_meta : (Array.isArray(m.attachments) ? m.attachments : []);
        // v160t (Олег): типовое превью вместо имени — «фото/видео/файл». Имя файла
        // не нужно: mime есть и у сервера → локальное и серверное превью СОВПАДАЮТ,
        // перетирание в loadContacts (f-…bin) становится безвредным. Root cause
        // класса багов v160q–s устранён упрощением, а не новым merge-правилом.
        const kindOf = (a) => {
            const mime = (a && a.mime) || "";
            if (mime.startsWith("image/")) return "фото";
            if (mime.startsWith("video/")) return "видео";
            if (mime.startsWith("audio/")) return "аудио";
            return "файл";
        };
        const attLabel = am.length ? "📎 " + kindOf(am[0]) + (am.length > 1 ? " +" + (am.length - 1) : "") : "";
        let t = String(m.body || m.resolvedBody || m.outbox_body || "").trim();
        if (t.startsWith("{")) t = ""; // сырой envelope — считаем нерасшифрованным
        if (t && m.isBinary) t = "";  // "[binary, N bytes]" — чип файла, не текст
        if (t && attLabel) {
            t = t.split("\n").filter(line => !line.trim().startsWith("📎")).join(" ").trim();
            t = t.replace(/\s+/g, " ");
        }
        if (t) return (attLabel ? attLabel + " · " : "") + t.slice(0, 80 - (attLabel ? attLabel.length + 3 : 0));
        if (attLabel) return attLabel;
        return "🔒 зашифрованное сообщение";
    } catch (e) { return ""; }
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

// ═══ v160r (Олег 2026-09-17): reply-to ═══
// Тап на bubble → бар «Ответ» над input-row. Отправка несёт reply_to
// {sig, preview} внутри E2E payload — relay его не видит, приватность та же.
// Цитата рендерится в bubble адресата над текстом; тап по цитате — scrollTo
// оригинала (по data-sig в DOM).
function previewForReplyTarget(m) {
    try {
        if (!m) return "";
        const am = (Array.isArray(m.attachments_meta) && m.attachments_meta.length) ? m.attachments_meta : (Array.isArray(m.attachments) ? m.attachments : []);
        if (am.length) {
            const kindOf = (a) => { const mm = (a && a.mime) || ""; if (mm.startsWith("image/")) return "фото"; if (mm.startsWith("video/")) return "видео"; if (mm.startsWith("audio/")) return "аудио"; return "файл"; };
            return "📎 " + kindOf(am[0]) + (am.length > 1 ? " +" + (am.length - 1) : "");
        }
        let t = String(m.body || "").trim();
        if (t.startsWith("{")) return "🔒 зашифрованное";
        if (t === "__DECRYPT_FAILED__") return "🔒 зашифрованное";
        return t.split("\n").filter(line => !line.trim().startsWith("📎")).join(" ").trim().slice(0, 80);
    } catch (e) { return ""; }
}

function showReplyBar(msg) {
    const bar = document.getElementById("reply-bar");
    const prev = document.getElementById("reply-bar-preview");
    if (!bar || !prev) return;
    pendingReply = {
        sig: msg._sig || (msg.from + ":" + msg.ts),
        hash: msg._hash || null,
        ts: msg.ts,
        preview: previewForReplyTarget(msg),
    };
    prev.textContent = pendingReply.preview || "сообщение";
    bar.hidden = false;
    if (window.innerWidth >= 480) messageInput?.focus();
}

function hideReplyBar() {
    pendingReply = null;
    const bar = document.getElementById("reply-bar");
    if (bar) bar.hidden = true;
}

function wireReplyBarControls() {
    const bar = document.getElementById("reply-bar");
    const cancel = document.getElementById("btn-reply-cancel");
    if (!bar || !cancel) return;
    cancel.addEventListener("click", hideReplyBar);
}

// Тап на bubble → showReplyBar (кроме system/цитат — тап по цитате = скролл к оригиналу).
function wireBubbleTap() {
    const area = document.getElementById("messages-area");
    if (!area) return;
    if (area.__murmurReplyWired) return; // защита от повторного wiring
    area.__murmurReplyWired = true;
    area.addEventListener("click", (ev) => {
        // 1) тап по цитате → скролл к оригиналу (data-qsig на quoted)
        const q = ev.target.closest(".quoted[data-qsig]");
        if (q) {
            const target = area.querySelector(`[data-sig="${CSS.escape(q.dataset.qsig)}"]`);
            if (target) {
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                target.style.transition = "filter 0.4s";
                target.style.filter = "brightness(1.35)";
                setTimeout(() => { target.style.filter = ""; }, 600);
            }
            return; // не открываем reply-бар
        }
        // 2) тап по bubble → reply
        const b = ev.target.closest(".bubble");
        if (!b || b.classList.contains("bubble-system")) return;
        const sig = b.getAttribute("data-sig");
        if (!sig) return;
        const peer = activePeer;
        if (!peer || !messages[peer]) return;
        const m = messages[peer].find((x) => (x._sig === sig) || ((x.from || x.from_npub || "") + x.ts === sig));
        if (m) showReplyBar(m);
    });
}

// v160y27 (Олег 19:31 «сохранить обе функции, улучшить UX»): long-press → reply
// (Telegram-стиль). Тап по фото/видео = fullscreen (stopPropagation в
// render-attachments), долгое нажатие на ЛЮБОЕ сообщение (текст или вложение) =
// reply-бар. Отмена при скролле (>10px сдвиг) — иначе случайный reply при
// прокрутке ленты. contextmenu preventDefault — иначе системное меню iOS
// («Сохранить фото») конфликтует с нашим reply-баром.
// Хинт: первый long-press показывает toast «Долгое нажатие — ответить» (1 раз).
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 10;
let __longPressFired = false; // хинт показан?

function showLongPressHint() {
    if (__longPressFired) return;
    __longPressFired = true;
    try { localStorage.setItem("murmur.longpress-hint", "1"); } catch (e) {}
    const t = document.createElement("div");
    t.textContent = "Долгое нажатие — ответить";
    t.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:1001;pointer-events:none;transition:opacity .4s;";
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 500); }, 1800);
}

function wireLongPressReply() {
    const area = document.getElementById("messages-area");
    if (!area) return;
    if (area.__murmurLongPressWired) return;
    area.__murmurLongPressWired = true;
    try { __longPressFired = !!localStorage.getItem("murmur.longpress-hint"); } catch (e) {}

    let pressTimer = null;
    let startX = 0, startY = 0;

    const clearTimer = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };

    const findMsg = (target) => {
        const b = target.closest && target.closest(".bubble");
        if (!b || b.classList.contains("bubble-system")) return null;
        const sig = b.getAttribute("data-sig");
        if (!sig) return null;
        const peer = activePeer;
        if (!peer || !messages[peer]) return null;
        return messages[peer].find((x) => (x._sig === sig) || ((x.from || x.from_npub || "") + x.ts === sig)) || null;
    };

    const fireReply = (ev, m) => {
        clearTimer();
        if (!m) return;
        if (ev.cancelable) ev.preventDefault();
        showReplyBar(m);
        showLongPressHint();
        // тактильный отклик (iOS/Android, где доступен)
        try { navigator.vibrate && navigator.vibrate(15); } catch (e) {}
    };

    // Touch (iOS/Android primary path)
    area.addEventListener("touchstart", (ev) => {
        if (ev.touches.length !== 1) { clearTimer(); return; }
        const t = ev.touches[0];
        startX = t.clientX; startY = t.clientY;
        const m = findMsg(t.target);
        if (!m) return; // вне bubble — не заводим таймер (scroll свободно)
        clearTimer();
        pressTimer = setTimeout(() => fireReply(ev, m), LONG_PRESS_MS);
    }, { passive: true });

    area.addEventListener("touchmove", (ev) => {
        if (!pressTimer) return;
        const t = ev.touches[0];
        if (!t) { clearTimer(); return; }
        const dx = t.clientX - startX, dy = t.clientY - startY;
        if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) clearTimer(); // скролл — отмена
    }, { passive: true });

    area.addEventListener("touchend", clearTimer, { passive: true });
    area.addEventListener("touchcancel", clearTimer, { passive: true });

    // Desktop: правый клик / длинный mousedown (mouse long-press —
    // convenience для мака). contextmenu = reply (Telegram-стиль desktop).
    area.addEventListener("contextmenu", (ev) => {
        const m = findMsg(ev.target);
        if (!m) return; // вне bubble — системное меню свободно
        ev.preventDefault();
        fireReply(ev, m);
    });

    // Системное меню «Сохранить фото» на iOS: долгий тап по img триггерит
    // contextmenu — гасим его только когда наш long-press уже сработал
    // (иначе iOS покажет системное меню поверх reply-бара). img.long-press
    // стреляет раньше — preventDefault здесь держит системное меню закрытым.
    area.addEventListener("touchend", (ev) => {
        // no-op: системное меню iOS показывается ТОЛЬКО если таймер не стрелял;
        // fireReply уже предотвратил contextmenu через ev.cancelable path.
    }, { passive: true });
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
// v160f: восстановление по готовому hex-ключу (код переноса / deep-link) —
// без инпута, общий путь с _handleRestore.
window._handleRestoreFromKey = async function(hex) {
    await ensureWasm();
    const mod = await loadWasmModule();
    const res = unwrap(mod.identity_restore(hex));
    if (!res.ok) throw new Error("restore failed: " + res.error);
    myNpub = res.data.npub;
    signKeyHex = hex;
    myAlias = res.data.npub;
    localStorage.setItem(LS_NPUB, myNpub);
    localStorage.setItem(LS_KEY, signKeyHex);
    localStorage.setItem(LS_NAME, myAlias);
    await invalidateCacheIfKeyChanged();
    enterMessenger();
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
    // v160n: прогрев ленивых модулей вложений. attachments.js/render-attachments.js
    // грузятся динамическим import() ТОЛЬКО в момент прикрепления файла. На
    // iOS PWA без кэша (no-store) плохая сеть (метро/LTE-тоннель) даёт
    // «TypeError: Load failed» → чип «Не удалось загрузить модуль шифрования»,
    // и WebKit запоминает неудачу до перезагрузки страницы. Греем оба модуля
    // сразу после входа — к моменту attach они уже в памяти.
    // v160y28: ?v= в import — иначе браузер отдаёт старую копию из кэша при
    // деплое новой версии (повтор повтор #420 — версии подресурсов не синхронны).
    import("./attachments.js?v=160y56")
        .then(() => { window.MurmurAttachments = window.MurmurAttachments || null; console.log("[warmup] attachments.js ready"); })
        .catch((e) => console.warn("[warmup] attachments.js failed (will retry on attach):", e));
    import("./render-attachments.js?v=160y56&i18n=1")
        .then(() => console.log("[warmup] render-attachments.js ready"))
        .catch((e) => console.warn("[warmup] render-attachments.js failed (will retry on render):", e));
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
    updateNoChatVisibility(); // v160x3: вместо безусловного показа
    if (inputArea) inputArea.classList.remove("visible");
    if (inputArea) inputArea.hidden = true;
    const m = document.querySelector(".messenger");
    if (m) m.classList.remove("chat-open");
    renderChatList();
    loadContacts();
    // v160t (Олег 18.09): «печатает…» требует WS-соединения. Reconnect storm
    // фиксен backoff'ом (WS_RECONNECT_BASE 1s → MAX 60s, экспоненциальный +
    // reconnect только при close), CF-туннель теперь роутит /ws → 8443.
    connectWS();
    startPolling();
    // Granted permission + stale Safari sub = 403 forever until force resubscribe.
    // v160y22push2: use retry wrapper — myNpub may not be ready if enterMessenger
    // races with async identity restore.
    if (Notification.permission === "granted") {
        _schedulePushRetry(true);
    }
    updateBadge();
    setupInviteUI();
    // Deep-link invite: .../#invite=<npub> → открыть чат с этим контактом.
    // Выполняется после enterMessenger: identity создана/восстановлена, DOM готов.
    handleInviteHash();
    // v160o: холодный старт установленной PWA — если в Safari открыли новую
    // invite-ссылку, cookie-мост добавит чат (handleInviteHash уже мог съесть
    // cookie через peer===ck — тогда bridge тихо выйдет).
    checkInviteCookieBridge(false);
    // Cold-start handoff from the service worker notification click.
    handleIncomingCallLink();
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

    if (perm === "granted" && (myNpub || myAlias)) {
        try {
            // v160y22pushdebug2: npub is the canonical relay key (PushPayload.alias = to_npub).
            // Human alias ("Oleg") is NOT stored on server — check npub first.
            const tried = [];
            for (const [param, candidate] of [
                ["npub", myNpub],
                ["alias", myAlias],
            ].filter(([, v]) => v)) {
                const r = await fetch(RELAY + "/push/status?" + param + "=" + encodeURIComponent(candidate), { cache: "no-store" });
                const j = await r.json();
                tried.push(param + "=" + candidate.slice(0, 12));
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
            // v160q: ветка по ФАКТИЧЕСКОМУ наличию подписки, не по permission.
            // Раньше granted + нет подписки (тёмный bell, title "нажми чтобы
            // переподключить") попадал в toggle-off и СТИРАЛ записи —
            // клики по тёмному колокольчику молча убивали пуши.
            let hasSub = false;
            try {
                const reg = await navigator.serviceWorker.ready;
                hasSub = !!(await reg.pushManager.getSubscription());
            } catch (e) { /* нет SW — считаем подписки нет */ }
            if (Notification && Notification.permission === "granted" && hasSub) {
                // Включено → выключить: снять browser-подписку + серверные записи.
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
                // Выключено ИЛИ granted-без-подписки → включить/переподключить.
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

// ─── Push notifications + badge ───
// v160s: bytes → base64url (для сравнения applicationServerKey подписки с
// серверным VAPID-ключом; ключ приходит из sub.options.applicationServerKey).
function _u8ToBase64url(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) out[i] = rawData.charCodeAt(i);
    return out;
}

// v160y22push2: retry push register when myNpub/SW not ready yet (Lesson #407).
let _pushSetupPromise = null;
let _pushSetupPendingForce = false;

function _schedulePushRetry(force) {
    if (force) _pushSetupPendingForce = true;
    if (typeof pushDebugLog === "function") pushDebugLog("_schedulePushRetry force=" + force + " myNpub=" + (myNpub ? myNpub.slice(0, 16) : "null"), "retry");
    if (_pushSetupPromise) {
        if (typeof pushDebugLog === "function") pushDebugLog("retry already running — queued force=" + force, "retry");
        return;
    }
    const wantForce = () => _pushSetupPendingForce;
    _pushSetupPromise = (async () => {
        for (let i = 0; i < 12; i++) {
            if (typeof pushDebugLog === "function") pushDebugLog("retry attempt " + (i + 1) + "/12 force=" + wantForce(), "retry");
            const ok = await setupPushSubscription(wantForce());
            if (ok) {
                if (typeof pushDebugLog === "function") pushDebugLog("retry SUCCESS on attempt " + (i + 1), "ok");
                _pushSetupPendingForce = false;
                return;
            }
            await new Promise(r => setTimeout(r, 500 + i * 250));
        }
        console.warn("[push] retry exhausted — tap 🔔 to register manually");
        if (typeof pushDebugLog === "function") pushDebugLog("retry EXHAUSTED — tap 🔔", "err");
        _pushSetupPendingForce = false;
    })().finally(() => { _pushSetupPromise = null; });
}

async function setupPushSubscription(forceResubscribe) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        console.log("[push] PushManager not supported");
        if (typeof pushDebugLog === "function") pushDebugLog("PushManager not supported", "err");
        return false;
    }
    if (typeof pushDebugLog === "function") pushDebugLog("setupPushSubscription force=" + forceResubscribe + " perm=" + Notification.permission, "setup");
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (typeof pushDebugLog === "function") pushDebugLog("browser sub=" + (sub ? sub.endpoint.slice(0, 55) + "…" : "null"), "setup");
        // v160s: server VAPID key may have been regenerated (relay reinstall).
        // A browser subscription created with an OLD key gets 403 from Apple on
        // every delivery (VAPID signature mismatch) — and looks perfectly alive
        // client-side. Detect key mismatch and recreate the subscription.
        const vapidKey = (await fetch(RELAY + "/vapid_public_key").then(r => r.text())).trim();
        if (typeof pushDebugLog === "function") pushDebugLog("vapid key=" + (vapidKey ? vapidKey.slice(0, 20) + "…" : "EMPTY"), "setup");
        if (!vapidKey || vapidKey.length < 20) {
            console.warn("[push] vapid key invalid:", vapidKey);
            if (typeof pushDebugLog === "function") pushDebugLog("vapid key INVALID len=" + (vapidKey ? vapidKey.length : 0), "err");
            return false;
        }
        if (forceResubscribe && sub) {
            console.warn("[push] force resubscribe requested — dropping browser subscription");
            if (typeof pushDebugLog === "function") pushDebugLog("force: unsubscribe old browser sub", "setup");
            try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
            sub = null;
        }
        if (sub && sub.options && sub.options.applicationServerKey) {
            try {
                const subKeyB64 = _u8ToBase64url(new Uint8Array(sub.options.applicationServerKey));
                if (subKeyB64 !== vapidKey) {
                    console.warn("[push] subscription VAPID key mismatch (server rotated) — resubscribing");
                    if (typeof pushDebugLog === "function") pushDebugLog("VAPID MISMATCH subKey≠server — resubscribing", "warn");
                    await sub.unsubscribe();
                    sub = null;
                } else if (typeof pushDebugLog === "function") {
                    pushDebugLog("VAPID key match OK", "setup");
                }
            } catch (e) {
                console.warn("[push] key compare failed:", e && e.message);
            }
        } else if (sub && !forceResubscribe) {
            // Safari/iOS often hides applicationServerKey — can't verify VAPID match.
            // After relay reinstall stale subs get 403 from Apple forever (Lesson #404).
            // Drop and recreate once per session so 🔔 isn't the only recovery path.
            const LS_PUSH_RESUB = "murmur.push_resub_done";
            if (!sessionStorage.getItem(LS_PUSH_RESUB)) {
                console.warn("[push] Safari: VAPID key not inspectable — force resubscribe once this session");
                if (typeof pushDebugLog === "function") pushDebugLog("Safari: key not inspectable — force resub once/session", "warn");
                sessionStorage.setItem(LS_PUSH_RESUB, "1");
                try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
                sub = null;
            } else {
                console.log("[push] existing subscription (VAPID key not inspectable) — re-registering on server");
                if (typeof pushDebugLog === "function") pushDebugLog("Safari: key not inspectable — re-register on server only", "setup");
            }
        } else if (sub && forceResubscribe) {
            // forceResubscribe=true (granted permission on load / 🔔 tap): always
            // drop stale browser sub — sessionStorage gate must NOT block recovery.
            console.warn("[push] force resubscribe — dropping browser subscription (Safari path)");
            try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
            sub = null;
        }
        if (!sub) {
            const perm = Notification.permission;
            if (perm === "denied") {
                console.warn("[push] notifications denied by user");
                if (typeof pushDebugLog === "function") pushDebugLog("permission denied — cannot subscribe", "err");
                return false;
            }
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey),
            });
            console.log("[push] created new browser subscription");
            if (typeof pushDebugLog === "function") pushDebugLog("NEW browser sub endpoint=" + sub.endpoint.slice(0, 55) + "…", "ok");
        } else {
            console.log("[push] re-using existing browser subscription, endpoint=", sub.endpoint.slice(0, 60));
        }
        const subJson = sub.toJSON();
        // v149/v160y22: relay matches push by recipient npub (PushPayload.alias = to_npub).
        // Human alias ("Oleg") must NOT be used here — envelope routing is npub-only.
        // CRITICAL (Lesson #131.10): always re-register on the server, even when reusing
        // the existing browser subscription.
        if (!myNpub) {
            console.warn("[push] myNpub not ready yet — will retry");
            if (typeof pushDebugLog === "function") pushDebugLog("myNpub NOT READY — scheduling retry", "warn");
            _schedulePushRetry(forceResubscribe);
            return false;
        }
        if (typeof pushDebugLog === "function") pushDebugLog("POST register_subscribe npub=" + myNpub.slice(0, 16) + "…", "setup");
        // v160p Phase 2: proof-of-key — sign "push-register" challenge with our
        // identity key (same canonical signature_input as envelope sig). Relay
        // verifies → foreign endpoint cannot register for our npub.
        let challengeSig = null;
        try {
            const wmod = await loadWasmModule();
            const signRes = unwrap(wmod.sign_envelope(myNpub, new TextEncoder().encode("push-register")));
            if (signRes.ok) challengeSig = signRes.data;
        } catch (e) {
            console.warn("[push] challenge sign failed", e);
        }
        if (!challengeSig) {
            if (typeof pushDebugLog === "function") pushDebugLog("challenge sign FAIL — cannot register", "err");
            _schedulePushRetry(forceResubscribe);
            return false;
        }
        const r = await fetch(RELAY + "/push/register_subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ npub: myNpub, subscription: subJson, challenge_sig: challengeSig }),
        });
        if (!r.ok) {
            const errText = await r.text();
            console.warn("[push] register_subscribe HTTP", r.status, errText);
            if (typeof pushDebugLog === "function") pushDebugLog("register_subscribe FAIL HTTP " + r.status + " " + errText.slice(0, 80), "err");
            return false;
        }
        console.log("[push] registered on server as npub=", myNpub.slice(0, 16));
        if (typeof pushDebugLog === "function") pushDebugLog("register_subscribe OK npub=" + myNpub.slice(0, 16) + "… endpoint=" + (subJson.endpoint || "").slice(0, 55) + "…", "ok");
        // v160y22pushdebug2: verify server actually persisted the subscription.
        try {
            const vr = await fetch(RELAY + "/push/status?npub=" + encodeURIComponent(myNpub), { cache: "no-store" });
            const vj = await vr.json();
            const sc = (vj && vj.count) || 0;
            const subd = !!(vj && vj.subscribed);
            if (typeof pushDebugLog === "function") pushDebugLog("verify serverCount=" + sc + " subscribed=" + subd, subd ? "ok" : "err");
            if (!subd || sc < 1) {
                console.warn("[push] register OK but server verify failed: count=", sc);
                if (typeof pushDebugLog === "function") pushDebugLog("VERIFY FAIL: HTTP 200 but serverCount=0 — will retry", "err");
                return false;
            }
        } catch (ve) {
            console.warn("[push] verify failed:", ve && ve.message);
            if (typeof pushDebugLog === "function") pushDebugLog("verify fetch failed: " + (ve && ve.message || ve), "err");
            return false;
        }
        if (typeof updateNotifBtnState === "function") updateNotifBtnState();
        return true;
    } catch (e) {
        console.warn("[push] setup failed:", e && e.message);
        if (typeof pushDebugLog === "function") pushDebugLog("setup FAILED: " + (e && e.message || e), "err");
        return false;
    }
}

async function requestPushPermission() {
    if (!("Notification" in window)) {
        alert("Браузер не поддерживает уведомления");
        return;
    }
    if (typeof pushDebugLog === "function") pushDebugLog("🔔 tap perm=" + Notification.permission, "btn");
    if (Notification.permission === "granted") {
        await setupPushSubscription(true);
        return;
    }
    if (Notification.permission === "denied") {
        if (typeof pushDebugLog === "function") pushDebugLog("permission DENIED by user", "err");
        alert("Уведомления заблокированы. Включите в Safari → Настройки сайтов → Уведомления.");
        return;
    }
    const result = await Notification.requestPermission();
    console.log("[push] permission:", result);
    if (typeof pushDebugLog === "function") pushDebugLog("requestPermission result=" + result, "btn");
    if (result === "granted") {
        await setupPushSubscription(true);
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

// v160v: флаг «контакты/кэш загружены» — renderChatList рисует «Нет сообщений»
// только когда данные реально загружены (иначе пусто, без ступенчатого перебора).
let contactsLoaded = false;
// Пустая лента = приветственная строка в панели (не заглушка без ввода).
function openGroupChat(groupId) {
    const g = getGroup(groupId);
    if (!g) { console.warn("[murmur] group not found:", groupId); return; }
    currentGroup = groupId;
    const membersN = Array.isArray(g.members) ? g.members.length : 0;
    const isAdmin = isAdminOf(g, myNpub);
    // Layout КАК в openChat: messenger.chat-open, подсветка активной группы,
    // chat-view flex, inputArea visible, noChat скрыт.
    const m = document.querySelector(".messenger");
    if (m) m.classList.add("chat-open");
    chatList.querySelectorAll(".chat-item").forEach(el => {
        el.classList.toggle("active", el.dataset && el.dataset.groupId === groupId);
    });
    if (contacts[groupId]) contacts[groupId].unreadCount = 0;
    clearUnread(groupId);
    if (btnDeleteChat) btnDeleteChat.hidden = true; // удаление группы — G5, не 1:1-кнопка
    chatView.style.display = "flex";
    chatView.hidden = false;
    noChat.style.display = "none";
    noChat.hidden = true;
    inputArea.hidden = false;
    inputArea.classList.add("visible");
    // Шапка: имя группы (без onclick-имени — название задаётся при создании, G5: редактирование)
    chatPeerName.innerHTML = "<span class='peer-name-main'>" + escapeHtml(g.name || "Группа") + "</span>";
    chatPeerName.title = "";
    chatPeerName.onclick = null;
    // Панель: если есть сообщения — лента; иначе приветственная строка.
    const panel = document.getElementById("chat-panel");
    if (panel) {
        if ((messages[groupId] || []).length > 0) {
            renderGroupMessages();
        } else {
            panel.innerHTML = '<div style="padding:20px 16px;font-size:13px;opacity:.65;">Группа «' + escapeHtml(g.name || "Группа") + '» · ' + membersN + ' участников' + (isAdmin ? ' · вы админ' : '') + '. Напишите первое сообщение — оно уйдёт каждому участнику в E2E-конверте.</div>';
        }
        panel.hidden = false;
    }
    // Backlog: подтянуть историю группы.
    try { pollHistoryForGroup(groupId); } catch (e) { console.warn("[murmur] pollHistoryForGroup:", e); }
    // scrollCure (v160x19 family): stale-вьюпорт лечится реальным скроллом.
    try { if (typeof window.scrollCure === "function") {
        [100, 400, 900].forEach(t => setTimeout(window.scrollCure, t));
    } } catch (e) {}
}

// ── UI Helpers (Invite & Logout) ───
// v160x3: #no-chat виден ТОЛЬКО когда нет видимых чатов (см. комментарий
// в renderChatList). style.display обязателен: author-CSS перебивает
// UA-стиль [hidden] (правило 659692d2). Вызывается из renderChatList,
// btnBack и showMessenger-путей.
function updateNoChatVisibility() {
    const visibleChats = Object.values(contacts).filter(c => !isHiddenPeer(c.peer)).length;
    const empty = visibleChats === 0;
    if (noChat) {
        noChat.hidden = !empty;
        noChat.style.display = empty ? "flex" : "none";
    }
    // call32: на стартовой странице (нет чатов) поле списка чатов не показываем:
    // сайдбар схлопывается в компактную колонку кнопок, no-chat занимает весь остаток.
    const msgr = document.querySelector(".messenger");
    if (msgr) msgr.classList.toggle("no-chats", empty);
}

function handleIncomingCallLink() {
    const params = new URLSearchParams(location.search);
    const from = params.get("incoming_call");
    if (!from || !/^npub1[a-z0-9]+$/i.test(from)) return;
    const callMode = params.get("call") === "video" ? "video" : (params.get("call") === "audio" ? "audio" : null);
    // Consume the one-shot handoff before showing the UI, so a reload cannot
    // reopen a stale incoming-call dialog.
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    if (window.MurmurCall && typeof window.MurmurCall.notifyIncoming === "function") {
        // Let the deferred call-audio module finish attaching its API and let
        // the messenger DOM settle after a cold start.
        setTimeout(() => window.MurmurCall.notifyIncoming(from, callMode), 0);
    }
}

function handleInviteHash() {
    // Deep-link invite, 3 формата (выполняем только в мессенджере, identity есть):
    //   …/#invite=<npub>        — старые share-ссылки
    //   /invite/<npub>           — v160h: path-формат для PWA start_url
    //                              (iOS выбрасывает query и hash из start_url,
    //                               path сохраняет — Lesson #358)
    //   /?invite=<npub>          — legacy
    const m = document.querySelector(".messenger");
    if (!m) return;
    let peer = null;
    const pm = (location.pathname || "").match(/\/invite\/(npub1[a-z0-9]+)/i);
    const mt = (location.hash || "").match(/^#invite=(npub1[a-z0-9]+)/i);
    const q = new URLSearchParams(location.search).get("invite");
    // v160i: cookie-мост — если URL пуст (iOS выкинул query/path из start_url),
    // достаём npub из cookie, поставленной в Safari при открытии ссылки.
    const ck = readInviteCookie();
    // v160o: приоритет источника пира. Cookie (свежий invite из Safari) бьёт
    // start_url, ЕСЛИ они расходятся: iOS хранит start_url вечно (старый чат
    // будет «прилетать» при каждом холодном старте), а cookie ставится только
    // когда юзер реально открыл новую ссылку. Равные значения → это наш
    // собственный start_url, приоритет не важен.
    if (pm) {
        peer = pm[1];
        try { history.replaceState(null, "", "/"); } catch (e) {}
    } else if (mt) {
        peer = mt[1];
        try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    } else if (q && /^npub1[a-z0-9]+$/i.test(q)) {
        peer = q;
        try { history.replaceState(null, "", location.pathname); } catch (e) {}
    } else if (ck) {
        // Cookie-мост: URL пуст, но в Safari недавно открывали invite-ссылку.
        peer = ck;
    }
    if (!peer) return;
    // v160o: cookie съедаем ТОЛЬКО когда реально её использовали (peer из cookie,
    // не из URL) И мы в standalone-PWA. В Safari чистить нельзя — иначе Safari
    // съест мост до того, как PWA успеет его прочитать (куки общие).
    // Баг v160i `ck && !pm` ел cookie в Safari сразу после установки моста.
    if (ck && peer === ck && isStandalonePWA()) clearInviteCookie();
    // Если чат уже существует — просто открыть; иначе создать контакт и открыть.
    // Нюанс v160h: path-формат приходит из start_url ПРИ КАЖДОМ запуске PWA —
    // поэтому для него авто-открытие только если контакта ещё нет (не насилуем
    // юзера переходом в чат пригласившего при каждом старте). Hash-ссылки
    // (живой переход по ссылке) — открываем всегда. Cookie-мост — как hash:
    // это явный свежий invite, открываем всегда.
    if (typeof openChat !== "function") return;
    const fromStartUrl = !!pm; // cookie-мост НЕ start_url — авто-открытие разрешено
    if (!contacts[peer]) {
        contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        renderChatList();
        openChat(peer);
    } else if (!fromStartUrl) {
        openChat(peer);
    }
    setTimeout(() => { try { history.replaceState(null, "", "/"); } catch (e) {} }, 50);
}

// v160o: cookie-мост для УСТАНОВЛЕННОЙ PWA. Сценарий: PWA стоит (стартует с
// «/» — invite в URL отсутствует), юзер открыл новую invite-ссылку в Safari →
// index.html положил cookie. При следующем запуске/резюме PWA добавляем чат
// (и открываем его). Веб-ссылка не может программно открыть установленную iOS
// PWA (нет universal links для web-app) — этот мост практический эквивалент.
function checkInviteCookieBridge(autoOpen) {
    // Только в установленной PWA: в Safari cookie — мост ДЛЯ PWA, есть URL-пути.
    if (!isStandalonePWA()) return;
    const m = document.querySelector(".messenger");
    if (!m) return; // мессенджер не активен — нечего открывать
    const ck = readInviteCookie();
    if (!ck || !/^npub1[a-z0-9]+$/i.test(ck)) return;
    if (ck === activePeer && contacts[ck]) { clearInviteCookie(); return; }
    if (!contacts[ck]) {
        contacts[ck] = { peer: ck, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        renderChatList();
    }
    clearInviteCookie(); // съели — чат добавлен, повторное авто-открытие не нужно
    if (autoOpen) openChat(ck);
}
function setupInviteUI() {
    // Guard: enterMessenger может вызываться повторно (boot/restore/poll-reconnect).
    // Без guard'а на кнопки вешаются дубли обработчиков → двойные confirm/alert (Lesson #356).
    if (setupInviteUI._bound) return;
    setupInviteUI._bound = true;
    const btnInvite = $("btn-invite");
    const btnLogout = $("btn-logout");
    const btnShowKey = $("btn-show-key");

    // v160o: cookie-мост на резюме PWA (юзер открыл ссылку в Safari, вернулся
    // в PWA — чат подхватится без перезапуска). _visBound — от повторных биндов.
    if (!setupInviteUI._visBound) {
        setupInviteUI._visBound = true;
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && isStandalonePWA()) {
                checkInviteCookieBridge(true);
            }
        });
    }

    // v160o: гарантированный путь добавить чат — вставить ссылку/npub вручную.
    // iOS ≥17 не даёт веб-странице программно открыть установленную PWA, а
    // cookie-мост требует, чтобы юзер хоть раз вернулся в PWA. Paste-add —
    // работает всегда, из любого места (Комната, заметки, Telegram).
    const btnAddByLink = $("btn-add-by-link");
    if (btnAddByLink) {
        btnAddByLink.addEventListener("click", () => {
            const raw = prompt("Вставь invite-ссылку или npub собеседника:");
            if (!raw) return;
            const m = raw.match(/invite[=\\/](npub1[a-z0-9]+)/i)
                || raw.match(/\b(npub1[a-z0-9]{20,})\b/i);
            if (!m) { alert("Не нашла npub1… в вставленном тексте"); return; }
            const peer = m[1];
            if (!contacts[peer]) {
                contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
                renderChatList();
            }
            openChat(peer);
        });
    }

    // v160e: показать ключ личности (перенос Safari↔PWA↔устройства).
    if (btnShowKey) {
        btnShowKey.addEventListener("click", () => {
            const key = localStorage.getItem(LS_KEY) || "";
            if (!key) { alert("Ключ не найден (нет аккаунта?)"); return; }
            let ov = document.getElementById("key-reveal");
            if (ov) ov.remove();
            ov = document.createElement("div");
            ov.id = "key-reveal";
            ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;";
            const box = document.createElement("div");
            box.style.cssText = "background:#17212b;border-radius:12px;padding:18px;max-width:340px;width:100%;color:#e8edf2;font:14px -apple-system,sans-serif;box-sizing:border-box;";
            const title = document.createElement("div");
            title.textContent = "Твой ключ (секрет!)";
            title.style.cssText = "margin-bottom:10px;font-weight:600;font-size:15px;";
            const hint = document.createElement("div");
            hint.textContent = "Вставь его на другом устройстве / в PWA через «У меня есть ключ». Никому не показывай.";
            hint.style.cssText = "margin-bottom:12px;color:#8a97a5;font-size:13px;line-height:1.4;";
            const inp = document.createElement("input");
            inp.readOnly = true;
            inp.value = key;
            inp.style.cssText = "width:100%;box-sizing:border-box;background:#0e1621;color:#e8edf2;border:1px solid #2a3b4d;border-radius:8px;padding:10px;font-size:13px;word-break:break-all;";
            const btnCopy = document.createElement("button");
            btnCopy.textContent = "Скопировать";
            btnCopy.style.cssText = "margin-top:12px;width:100%;background:#2b5278;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;";
            btnCopy.addEventListener("click", () => {
                inp.select();
                if (legacyCopy(inp.value)) { btnCopy.textContent = "Скопировано ✓"; setTimeout(() => ov.remove(), 800); }
            });
            const btnClose = document.createElement("button");
            btnClose.textContent = "Закрыть";
            btnClose.style.cssText = "margin-top:8px;width:100%;background:#22303e;color:#8a97a5;border:0;border-radius:8px;padding:10px;font-size:14px;";
            btnClose.addEventListener("click", () => ov.remove());
            ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
            box.appendChild(title); box.appendChild(hint); box.appendChild(inp); box.appendChild(btnCopy); box.appendChild(btnClose);
            ov.appendChild(box); document.body.appendChild(ov);
        });
    }

    if (btnInvite) {
        btnInvite.addEventListener("click", async () => {
            const inviteLink = `${window.location.origin}${window.location.pathname}#invite=${myNpub}`;
            // Copy synchronously inside the gesture, then show QR/share overlay.
            const copied = legacyCopy(inviteLink);
            showInviteQr(inviteLink, copied);
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

function showInviteQr(inviteLink, alreadyCopied) {
    let ov = document.getElementById("invite-qr");
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.id = "invite-qr";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;";
    const box = document.createElement("div");
    box.style.cssText = "background:#17212b;border-radius:12px;padding:18px;max-width:340px;width:100%;color:#e8edf2;font:14px -apple-system,sans-serif;box-sizing:border-box;text-align:center;";
    const title = document.createElement("div");
    title.textContent = window.MurmurI18N ? window.MurmurI18N.t("Пригласить друга") : "Пригласить друга";
    title.style.cssText = "margin-bottom:6px;font-weight:600;font-size:15px;";
    const hint = document.createElement("div");
    hint.textContent = window.MurmurI18N ? window.MurmurI18N.t("Пусть друг наведёт камеру телефона на QR-код") : "Пусть друг наведёт камеру телефона на QR-код";
    hint.style.cssText = "margin-bottom:12px;color:#8a97a5;font-size:13px;line-height:1.4;";
    const qrHolder = document.createElement("div");
    qrHolder.id = "invite-qr-holder";
    qrHolder.style.cssText = "display:inline-block;background:#fff;border-radius:8px;padding:12px;margin-bottom:4px;";
    const err = document.createElement("div");
    err.style.cssText = "display:none;color:#e8a;font-size:13px;margin:10px 0;";
    // Кнопки — в том же стиле, что key-reveal / manual-copy оверлеи.
    const btnShare = document.createElement("button");
    btnShare.textContent = window.MurmurI18N ? window.MurmurI18N.t("Поделиться") : "Поделиться";
    btnShare.style.cssText = "margin-top:12px;width:100%;background:#2b5278;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;";
    btnShare.addEventListener("click", async () => {
        if (navigator.share) {
            try {
                // v158c: ссылку зашиваем В текст — macOS share sheet discard'ит url.
                await navigator.share({
                    title: "murmur",
                    text: (window.MurmurI18N ? window.MurmurI18N.t("Присоединяйся в приватном мессенджере murmur!") : "Присоединяйся в приватном мессенджере murmur!") + " " + inviteLink,
                });
            } catch (e) {
                if (e.name !== "AbortError") console.warn("share failed:", e);
            }
        } else {
            // Нет share API (десктоп) → копируем в буфер.
            if (legacyCopy(inviteLink)) { btnShare.textContent = "Скопировано ✓"; setTimeout(() => ov.remove(), 800); }
        }
    });
    const btnCopy = document.createElement("button");
    btnCopy.textContent = window.MurmurI18N ? window.MurmurI18N.t("Скопировать ссылку") : "Скопировать ссылку";
    btnCopy.style.cssText = "margin-top:8px;width:100%;background:#22303e;color:#e8edf2;border:0;border-radius:8px;padding:10px;font-size:14px;";
    btnCopy.addEventListener("click", () => {
        if (legacyCopy(inviteLink)) { btnCopy.textContent = "Скопировано ✓"; setTimeout(() => ov.remove(), 800); }
    });
    const btnClose = document.createElement("button");
    btnClose.textContent = window.MurmurI18N ? window.MurmurI18N.t("Закрыть") : "Закрыть";
    btnClose.style.cssText = "margin-top:8px;width:100%;background:#22303e;color:#8a97a5;border:0;border-radius:8px;padding:10px;font-size:14px;";
    btnClose.addEventListener("click", () => ov.remove());
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
    box.appendChild(title); box.appendChild(hint); box.appendChild(qrHolder); box.appendChild(err);
    box.appendChild(btnShare); box.appendChild(btnCopy); box.appendChild(btnClose);
    ov.appendChild(box); document.body.appendChild(ov);
    // Генерация QR — после вставки оверлея, обёрнута в try (битая библиотека
    // не должна ломать весь invite-флоу: ссылка уже скопирована в жесте).
    try {
        const q = typeof QRCode !== "undefined" ? QRCode : (typeof qrcode !== "undefined" ? qrcode : null);
        if (!q) throw new Error("qrcode lib not loaded");
        const qr = q(0, "M");
        qr.addData(inviteLink);
        qr.make();
        const img = document.createElement("img");
        img.alt = "QR инвайта";
        // createDataURL даёт GIF — легче SVG, и pixelated-рендер чётче с камеры.
        img.src = qr.createDataURL(6, 0);
        img.style.cssText = "width:220px;height:220px;image-rendering:pixelated;display:block;";
        qrHolder.appendChild(img);
    } catch (e) {
        console.warn("QR render failed:", e);
        err.textContent = "QR не отрисовался — используй «Поделиться» или «Скопировать»";
        err.style.display = "block";
    }
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

// ── Local chat-name editor (не зависит от нативного Safari prompt) ──
function showChatNameEditor(peer) {
    const old = document.getElementById("chat-name-editor");
    if (old) old.remove();
    const current = contactNameFor(peer);
    const ov = document.createElement("div");
    ov.id = "chat-name-editor";
    ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:20px;";
    const box = document.createElement("div");
    box.style.cssText = "width:min(360px,100%);background:var(--panel,#fff);color:var(--text,#111);border:1px solid var(--border,#ccc);border-radius:16px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.28);";
    const title = document.createElement("div");
    title.textContent = "Название чата";
    title.style.cssText = "font-weight:700;font-size:17px;margin-bottom:12px;";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.value = current;
    input.autocomplete = "off";
    input.style.cssText = "box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#aaa);border-radius:10px;padding:10px 12px;outline:none;";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Отмена";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Сохранить";
    save.style.cssText = "font-weight:600;";
    const close = () => ov.remove();
    cancel.onclick = close;
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    const commit = () => {
        const name = input.value.trim().slice(0, 24);
        try {
            saveContactName(peer, name);
            // Verify the write before closing. This also catches Safari storage errors.
            const saved = contactNameFor(peer);
            if (name && saved !== name) throw new Error("имя не записалось в localStorage");
            if (!name && saved) throw new Error("имя не удалилось из localStorage");
        } catch (e) {
            console.error("[murmur] chat name save failed:", e);
            alert("Не удалось сохранить название чата. Попробуйте ещё раз.");
            return;
        }
        close();
        // Do not reopen the chat: that could reload a stale contact object and
        // immediately overwrite the freshly saved local name on iOS.
        const label = chatPeerName && chatPeerName.querySelector(".peer-name-main");
        if (label) {
            label.textContent = name || "Без имени";
            label.classList.toggle("peer-name-unnamed", !name);
        }
        if (chatPeerName) chatPeerName.title = "Нажмите, чтобы задать имя";
        renderChatList();
    };
    save.onclick = commit;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    actions.append(cancel, save);
    box.append(title, input, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);
    requestAnimationFrame(() => { input.focus(); input.select(); });
}

// ── Open Chat ──
function openChat(peer, opts) {
    peer = normalizePeer(peer);
    activePeer = peer;
    if (btnCall) btnCall.hidden = !peer;
    if (btnVideoCall) btnVideoCall.hidden = !peer;
    // v160h4: сброс currentGroup ТОЛЬКО при явном юзер-клике (opts.fromUser).
    // v160h3 сбрасывал безусловно — программные openChat (входящие/полл/инвайт)
    // выкидывали группу во время набора («полоска отскакивает на чат», Олег
    // 21.09 21:15; сим: currentGroup=null сразу после openGroupChat).
    if (opts && opts.fromUser && currentGroup) currentGroup = null;
    hideReplyBar(); // v160r: reply сброс при смене чата (не тащим чужой reply)
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
    // v160z10 (Олег 27.09 10:32 «опять первый заход некрасивый, а второй
    // идеально плавно»): фейд 0.35 (v160z9) сборку НЕ спрятал — просвечивает.
    // Холодный заход (кэша нет, decrypt-конвейер, bubbles всплывают по мере
    // готовности) = пошаговая сборка. Тёплый (всё из IDB/памяти) = мгновенно.
    // Решение: на холодном — СПЛОШНАЯ заглушка (splash, bg) поверх панели до
    // первого полного рендера; на тёплом — не ставится вовсе.
    // Холодный = messages[peer] пуст при openChat (кэш ещё не загружен).
    const coldOpen = !(messages[peer] && messages[peer].length);
    // v160g4-kbd7 (Олег 12:05: «отжал и сразу собранная страница»): splash
    // теперь на ЛЮБОЕ открытие. Тёплый заход без заглушки показывал сборку
    // по частям (видео 11:58: шапка -> лента -> композер -> догон-серия).
    // Тёплый скрывается раньше (350ms стабилизации), холодный держит 800ms
    // (кэш+сервер+decrypt-батч) - логика v160z11 сохранена.
    const splash = document.getElementById("chat-splash");
    if (splash) {
        splash.hidden = false;
        splash.style.opacity = "1";
    }
    noChat.style.display = "none"; // v160x3: чат открыт — панель не нужна
    noChat.hidden = true;
    inputArea.hidden = false;
    inputArea.classList.add("visible");
    const nameMap = loadContactNames();
    const savedName = contactNameFor(peer, nameMap);
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
    chatPeerName.onclick = () => showChatNameEditor(peer);
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
    // v160x19 (Олег 11:00): stale-вьюпорт лечится scrollCure. v160y34 (Олег
    // 2026-09-24 «проваливаешься в чат — сначала все мигает»): 3 вызова
    // scrollCure (100/400/900) на документе = 3 вспышки layout (body +80px →
    // restore). Фикс: ОДИН вызов на 250ms, и только если gapDetector
    // (elementFromPoint проба paint, Lesson #v160x14) подтверждает дыру —
    // на маке/здоровом вьюпорте scrollCure не запускается вовсе = нет мигания.
    try { if (typeof window.scrollCure === "function") {
        // Automatic scrollCure disabled after physical-iPhone diagnostics:
        // it creates visible 0→80→0 jumps. Keep manual export only.
        // v160y58 (Олег 25.09 18:00: «при открытии чата дыра под композером;
        // тап в поле ввода лечит»): дыра проявляется ПОСЛЕ 250ms — рендер батча
        // (attachments/decrypt) дёргает layout позже чека. Один gapDetector-чек
        // её пропускает. Лечим серией догонов (600-3200ms) тем же, чем лечит
        // тап в поле: scrollCure + nudge слоя композера. Дёшево: elementFromPoint
        // проба, cure ТОЛЬКО если дыра реальна (на маке/здоровом вьюпорте — no-op).
        // v160y61 (diag-скрин Олега 21:08): ВСЕ метрики ЧЕСТНЫЕ (844 везде,
        // iaBot=844, --vvh=844) при ВИДИМОЙ дыре на том же скрине → PAINT устар,
        // layout НЕ врёт. gapDetector (elementFromPoint = LAYOUT) при композере
        // В ПОТОКЕ (v160x17, fixed убран) находит композер ВСЕГДА даже при дыре
        // → гейт НИКОГДА не открывался → все openChat-догоны y58/y59/y60 были
        // МЁРТВЫЙ КОД. Тап в поле ЛЕЧИТ потому что focusout-цепочка зовёт
        // лекарство БЕЗ гейта (unconditional). Теперь openChat зовёт ТОТ ЖЕ
        // набор БЕЗ гейта: forceReflow (реальный reflow = репейнт сталой зоны),
        // settle (scroll-защёлк layout), nudge слоя композера, setVvh.
        // v160z8 (Олег 27.09 09:02 «стало лучше, но появилась пустая область под
        // строкой ввода»): 8px НЕ лечит дыру (скролл должен пройти через ВСЮ
        // сталую зону ~60-80px — амплитуда 80 возвращена). Дёрганье лечим ЧИСЛОМ
        // вызовов: первый — immediate (0ms, экран переходный, прыжок незаметен),
        // догон-серия сокращена 4→2 (700/2400).
        setTimeout(() => {
            try {
                // v160y62: scrollCure ПЕРВЫЙ (реальный скролл — ЕДИНСТВЕННОЕ,
                // что репейнтит сталую зону), потом forceReflow/nudge/settle/setVvh
                // как страховка.
                // scrollCure disabled: artificial 0→80→0 jump is visible on iPhone.
                if (typeof window.__murmurForceReflow === "function") window.__murmurForceReflow();
                if (typeof window.__murmurSettle === "function") window.__murmurSettle();
                if (typeof window.__murmurNudgeComposer === "function") window.__murmurNudgeComposer();
                if (typeof window.__murmurSetVvh === "function") window.__murmurSetVvh();
            } catch (e) {}
        }, 0);
        [700, 2400].forEach(t => setTimeout(() => {
            try {
                // v160y62 (diag-скрин Олега 21:14: msBot=845/iaBot=845 — layout
                // ДОХОДИТ до низа, PAINT устар): в v160y61 openChat-догон звал
                // forceReflow ПЕРВЫМ (else scrollCure — МЁРТВАЯ ветка, forceReflow
                // всегда существует) → scrollCure НИКОГДА не выполнялся. А тап в
                // поле ЛЕЧИТ именно scrollCure (v160x18: реальный скролл —
                // ЕДИНСТВЕННОЕ, что репейнтит сталую зону; forceReflow недостаточен
                // — v160x15, nudge был для FIXED-композера — теперь в потоке).
                // Порядок как в focusout-цепочке: scrollCure ПЕРВЫЙ, потом
                // forceReflow/nudge/settle/setVvh как страховка.
                // scrollCure disabled: artificial 0→80→0 jump is visible on iPhone.
                if (typeof window.__murmurForceReflow === "function") window.__murmurForceReflow();
                if (typeof window.__murmurSettle === "function") window.__murmurSettle();
                if (typeof window.__murmurNudgeComposer === "function") window.__murmurNudgeComposer();
                if (typeof window.__murmurSetVvh === "function") window.__murmurSetVvh();
            } catch (e) {}
        }, t));
    } } catch (e) {}
    // v160g4-kbd6 (порт w6m2/m5): открытие = гарантированный низ + pin-окно 3с.
    window.__murmurWasAtBottom = true;
    window.__murmurPinUntil = Date.now() + 3000;
    window.__murmurLastDist = 0;
    loadHistory(peer).then(() => {
        if (contacts[peer]) contacts[peer].unreadCount = 0;
        renderChatList();
        renderMessages();
        scrollToBottom();
        // v160g4-kbd6 (порт w6m2/m3/m5): догон-серия с гейтом - decrypt/attachments
        // растят ленту после первого скролла. dist>140 -> smooth, иначе мгновенно.
        [100, 300, 600, 1000, 1500, 2500].forEach(t => setTimeout(() => {
            try {
                if (window.__murmurWasAtBottom && activePeer === peer) {
                    const ma = messagesArea;
                    const dist = ma.scrollHeight - ma.scrollTop - ma.clientHeight;
                    if (dist <= 0) { window.__murmurLastDist = 0; return; }
                    const prev = window.__murmurLastDist;
                    window.__murmurLastDist = dist;
                    if (prev > dist + 10) return; // smooth уже едет - не стомпить
                    // v160g4-kbd8: пока splash виден - мгновенно (движение под
                    // заглушкой юзер не видит; smooth после = «по частям»).
                    const sp = document.getElementById("chat-splash");
                    const splashUp = sp && !sp.hidden;
                    if (dist > 140 && !splashUp) ma.scrollTo({ top: ma.scrollHeight, behavior: "smooth" });
                    else ma.scrollTop = ma.scrollHeight;
                }
            } catch (e) {}
        }, t));
        // v160z11 (Олег 27.09 11:46 видео первого/второго захода «не сработало»):
        // видео показало — splash скрылся СЛИШКОМ РАНО (после кэш-рендера), а
        // сервер-рендер loadHistory + прыжок scrollToBottom идут ПОСЛЕ → сборка
        // видна (устаревший срез → прыжок вниз). Держим splash до стабилизации:
        // 800ms после первого рендера (кэш+сервер+decrypt-батч ≈ 0.5с, AES
        // 35MB ≈ 100-300ms) + фейд 250ms. Спиннер в splash — тап сразу даёт
        // видимую реакцию (кадр 1-3 видео: 0.5с без отклика = «не работает»).
        const splash = document.getElementById("chat-splash");
        if (splash && !splash.hidden) {
            // v160g4-kbd8 (лог Олега 12:14: «лента двигается по частям»):
            // держим заглушку пока лента НЕ стабилизируется у низа
            // (2 подряд замера dist<=2), потом один фейд. Тёплый min 250ms,
            // холодный min 800ms (decrypt-батч), кап 1500ms.
            const minHold = coldOpen ? 800 : 250;
            const t0 = Date.now();
            let okStreak = 0;
            const splashPoll = setInterval(() => {
                try {
                    const ma = document.querySelector(".messages-area");
                    const dist = ma ? (ma.scrollHeight - ma.scrollTop - ma.clientHeight) : 999;
                    okStreak = dist <= 2 ? okStreak + 1 : 0;
                    const elapsed = Date.now() - t0;
                    if ((okStreak >= 2 && elapsed >= minHold) || elapsed > 1500) {
                        clearInterval(splashPoll);
                        splash.style.transition = "opacity 250ms ease-out";
                        splash.style.opacity = "0";
                        setTimeout(() => { splash.hidden = true; }, 260);
                    }
                } catch (e) { clearInterval(splashPoll); }
            }, 100);
        }
    }).catch((e) => {
        console.warn("[murmur] openChat loadHistory failed:", e);
        // v160z10: даже при ошибке — не оставлять splash навсегда (стакан
        // «застрявший splash» хуже некрасивого первого рендера).
        const splash = document.getElementById("chat-splash");
        if (splash) splash.hidden = true;
    });
}

// ── Load History ──
async function loadHistory(peer, beforeTs) {
    if (!myNpub) return;
    // v160k9c: ждём завершения loadMessagesCacheForPeer для того же peer, чтобы
    // не перетереть кэш устаревшим результатом сервера.
    const pendingCache = __murmurCacheLoading.get(peer);
    if (pendingCache) {
        try { await pendingCache; } catch (e) { /* ignore */ }
    }
    // Cache-bust every /api/* request: bypass HTTP cache, Service Worker cache,
    // and Cloudflare edge cache. Without this, browsers serve stale responses
    // from earlier deploys (when /api/history returned empty) and the chat
    // appears empty even though the DB has messages.
    let url = RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) +
              "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT +
              // v160y24 (Олег 2026-09-23): visible=1 только при видимом документе —
              // фоновые poll'и (Power Nap, закрытая крышка) не сокращают TTL
              // на сервере. Сообщения живут полные 24ч до реального открытия.
              "&visible=" + (document.visibilityState === "visible" ? 1 : 0) +
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
        errEl.innerHTML = "⏳ Не удалось загрузить историю. Плохой инет — <button class='link-btn' onclick='openChat(\"" + peer + "\", {fromUser: true})'>повторить</button>";
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
                // v158 (Олег 19:16 «минимум рисков, без прочитано»): квитанции ✓✓ —
                // служебные конверты Bob→Alice с marker'ом _kind:"receipt".
                // В чат их НЕ рендерим: чужие — помечают наши сообщения доставленными,
                // свои (echo) — молча скипаем ДО outbox-resolution и дедупа.
                if (isReceiptRow(m)) {
                    if (fromNpub !== myNpub) consumeReceiptRow(m, hash, fromNpub);
                    continue;
                }
                // v158: входящие hash'и → в очередь квитанций (backlog при первом
                // открытии чата тоже квитуется; дубли фильтрует receipted-store).
                if (fromNpub !== myNpub && hash) queueReceiptsForPeer(peer, [hash]);
                // v160h5 (сим 21.09 22:00): group-роутер как в poll-пути — групповые
                // конверты (свои эхо-фанауты с _kind:"group_msg"/"group_invite" И
                // чужие) маршрутизируем ДО outbox-пути. Без этого loadHistory матчит
                // эхо группового конверта через outbox-ts-fallback в фантомную
                // out-копию 1:1 чата с участником («исходящие во всех чатах»).
                {
                    let gwire = null;
                    try {
                        if (typeof m.body === "string" && (m.body.startsWith("{") || m.body.startsWith("["))) gwire = JSON.parse(m.body);
                        else if (typeof m.body_base64 === "string" && m.body_base64.length > 0) {
                            const inner = decodeBody(m.body_base64);
                            if (inner && inner.text && (inner.text.startsWith("{") || inner.text.startsWith("["))) gwire = JSON.parse(inner.text);
                        }
                    } catch (_e) { gwire = null; }
                    const gkind = gwire && typeof gwire._kind === "string" ? gwire._kind : (m._kind || null);
                    if (gkind === "group_msg" || gkind === "group_invite" || gkind === "group_key") {
                        if (gkind === "group_msg") await handleIncomingGroupMsg(m, fromNpub, hash);
                        else if (fromNpub !== myNpub) await consumeGroupEnvelope(m);
                        continue;
                    }
                }
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
                            pDecrypt.push(decryptWithTimeout(m).then(({ text: newBody, attachments: newAttArr, reply_to: newReplyTo }) => {
                                // v160y2: пустой text + вложения = успех (фото без подписи).
                                if (decryptResultHasContent({ text: newBody, attachments: newAttArr })) {
                                    cachedMsg.body = newBody || "";
                                    // v160r: reply_to тоже в кэш (цитата после reload).
                                    if (newReplyTo) cachedMsg.reply_to = newReplyTo;
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
                        // v160y52 (Олег 25.09: «цитата пропадает после перезахода»):
                        // `local` из messages[peer] (старая кэш-копия, reply_to=null)
                        // ЗАТИРАЕТ outbox-запись, у которой reply_to ЕСТЬ (v160y50).
                        // Когда local.reply_to нет — фолбэк в outbox по _hash/_sig/±60s
                        // и берём reply_to оттуда.
                        let replyToResolved = local.reply_to || null;
                        if (!replyToResolved) {
                            try {
                                const ob = loadOutboxForPeer(peer);
                                let obEntry = ob.find(o => (hash && o._hash === hash) || o._sig === sigKey);
                                if (!obEntry && ob.length > 0) {
                                    let best = null, bestDelta = Infinity;
                                    for (const o of ob) {
                                        const delta = Math.abs((o.ts || 0) - (m.ts || 0));
                                        if (delta < bestDelta && delta <= 60) { best = o; bestDelta = delta; }
                                    }
                                    if (best) obEntry = best;
                                }
                                if (obEntry && obEntry.reply_to) replyToResolved = obEntry.reply_to;
                            } catch (e) { /* outbox недоступен — цитата null */ }
                        }
                        const msg = {
                            from: fromNpub, to: toField, body: local.body, ts: m.ts,
                            direction: "out",
                            sig: m.sig || "", _sig: sigKey, _hash: hash,
                            isBinary: false,
                            status: "sent",
                            attachments: local.attachments || [],
                            // v160y50: reply_to из outbox/local — цитата выживает
                            // reload/poll (Олег 23:44: «остается только отправленное
                            // сообщение без привязи»). Отсутствие поля = цитата теряется.
                            // v160y52: фолбэк в outbox, когда кэш-копия без цитаты.
                            reply_to: replyToResolved,
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
                pDecrypt.push(decryptWithTimeout(m).then(async ({ text: bodyText, attachments: attArr, attachmentsMeta: mergedMeta, reply_to: mergedReplyTo }) => {
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
                            // v160t: типовое превью (mime → фото/видео/аудио/файл), не f-…bin
                            const kindOfA = (a) => { const mm = (a && a.mime) || ""; if (mm.startsWith("image/")) return "фото"; if (mm.startsWith("video/")) return "видео"; if (mm.startsWith("audio/")) return "аудио"; return "файл"; };
                            finalBody = "📎 " + meta.map(kindOfA).join(", ");
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
                        // v160r: reply_to из mergedMeta (decrypt paths) или inner (без E2E)
                        reply_to: mergedReplyTo || (m._server_msg && m._server_msg.reply_to) || m.reply_to || null,
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
                // v160y8 (Олег 2026-09-10): сервер после TTL отдаёт только свежие
                // строки. Если IDB-кэш не успел/не смог загрузиться — in-memory
                // пуст → UI показывает только «Сегодня». Прямой re-read IDB.
                if ((!messages[peer] || messages[peer].length === 0) && window.appStore) {
                    try {
                        const cached = await window.appStore.chats.getMessages(peer);
                        if (Array.isArray(cached) && cached.length > 0) {
                            messages[peer] = cached;
                            console.log("[murmur] loadHistory: IDB backfill", peer.slice(0, 12), "count=" + cached.length);
                        }
                    } catch (e) {
                        console.warn("[murmur] loadHistory: IDB backfill failed:", e && e.message);
                    }
                }
                // v160m: fix for "missing <10 messages".
                // If server returns new messages, we MUST NOT overwrite the memory
                // state with just newMsgs.concat(messages[peer]) if that array
                // might have been stripped or partially loaded.
                // We ensure messages[peer] is the source of truth and newMsgs are merged.
                const combined = newMsgs.concat(messages[peer]);
                // Keep newest 500 strictly by TS to avoid order-based dropping.
                const finalSet = keepNewestByTs(combined, MESSAGES_CACHE_MAX_PER_PEER);
                messages[peer] = finalSet;

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
                    // Lesson #241: НЕ обновлять preview здесь, если body
                    // ещё-зашифрованный JSON envelope (async decrypt обновит).
                    // v160w: писать только через setChatPreview (ts-порядок).
                    const bodyStr = String(newest.body);
                    if (!bodyStr.startsWith("{")) {
                        setChatPreview(peer, newest.ts, bodyStr.slice(0, 80));
                    }
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
    // v160y55c (Олег 25.09 13:51: «когда открываешь чат, всё плавно появлялось,
    // а то сейчас загружается рывками»): счётчик НОВЫХ баблов за этот render.
    // После append: если >0 — batch-анимация fadeInUp на всех новых (один
    // класс .msg-enter на render, каскад через animation-delay по индексу;
    // CSS в index.html). Только при first-batch-after-peer-change — не анимируем
    // каждый инкрементальный полл (иначе новое сообщение «выплывает» тоже —
    // это норм и приятно, но рывки лечит именно батч).
    let __newBubbles = 0;
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
            // v160r2 (Олег 18.09 «входящее отображается без привязи, после
            // обновления — как надо»): bubble уже отрисован БЕЗ цитаты, а
            // reply_to пришёл ПОЗЖЕ (Phase-3 decrypt петля в pollHist: первый
            // render идёт с reply_to=null, decrypt асинхронный). Skip-путь
            // оставлял bubble без .quoted навсегда (до reload, где loadHistory
            // расшифровывает ДО render). Фикс: вставляем .quoted in-place
            // перед .msg-body, если цитата есть, а в bubble её ещё нет.
            // Гард от дубля: только если .quoted отсутствует.
            if (m.reply_to && m.reply_to.sig) {
                try {
                    const qBubble = messagesArea.querySelector(`[data-sig="${CSS.escape(sig)}"]`);
                    if (qBubble && !qBubble.querySelector(".quoted")) {
                        const q = document.createElement("div");
                        q.className = "quoted";
                        q.setAttribute("data-qsig", m.reply_to.sig);
                        q.textContent = String(m.reply_to.preview || "сообщение").slice(0, 120);
                        const qBody = qBubble.querySelector(".msg-body");
                        qBubble.insertBefore(q, qBody || qBubble.firstChild);
                    }
                } catch (e) { /* ignore */ }
            }
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
                    // v160w6n: если bubble отрендерился до того, как attachments_meta
                    // доехал (repair-путь), класс мог не выставиться — дожимаем тут.
                    if (!String(m.body || "").trim()) {
                        div.classList.add("bubble-media");
                        div.classList.remove("bubble-media-cap");
                    } else if (Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) {
                        div.classList.add("bubble-media-cap");
                        div.classList.remove("bubble-media");
                    }
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
                // v160w6n (Олег 07.10 «безрамочный формат для фото и видео»):
                // медиа--only сообщение (есть attachments, текста нет) → бабл без
                // фона/паддинга/тени — медиа встаёт вплотную, время поверх
                // плашкой (Telegram-style). Сообщения с текстом остаются в рамке.
                const mediaOnly = Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0 &&
                    !String(m.body || "").trim();
                if (mediaOnly) div.classList.add("bubble-media");
                // v160w6p (Олег 07.10 21:26 «рамки бабла с видео/фото тонкими по бокам»):
                // медиа + подпись → паддинг убираем, медиа вплотную к краям бабла,
                // текст с боковым паддингом снизу. :has() ненадёжен на iOS — класс.
                else if (Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) div.classList.add("bubble-media-cap");
            }
            div.setAttribute("data-sig", sig);
            let statusGlyph = "";
            if (isOut) {
                // v158: ✓✓ только по реальной квитанции получателя (acks);
                // POST 200 больше не «доставлено» — это просто «отправлено» ✓.
                const acked = m._hash && isAcked(m._hash);
                statusGlyph = acked ? "✓✓" : ((m.status === "delivered" || m.status === "sent") ? "✓" : "");
            }
            if (isSystem) {
                statusGlyph = "⏳";
            }
            if (m.callEvent) {
                        const label = m.callDirection === "out"
                    ? (m.callStatus === "declined" ? "Исходящий отклонен" : "Исходящий")
                    : (m.callStatus === "cancelled" ? "Входящий отменен" : "Входящий");
                const dur = m.callDuration > 0 ? " - " + formatDurationForCall(m.callDuration) : "";
                const text = label + " " + formatTime(m.ts) + dur;
                div.className = "call-event-text";
                div.textContent = text;
                messagesArea.appendChild(div);
                renderedSigs.add(sig);
                continue;
            }
            let bodyText = m.body || "";
            // v160y7: 🔒-заглушка в body + уже есть чипы attachments_meta
            // → не показываем текстовую «🔒 шифрованное сообщение» строку.
            // ТОЛЬКО render-слой (НЕ pollHist bodyText="" — регресс y6).
            if (m.direction === "in" && /\u{1F512}\s*шифрованное сообщение/u.test(bodyText) &&
                Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0) {
                bodyText = "";
            }
            // Олег 2026-09-05 20:40: linkify — после escape. В iOS PWA
            // target=_blank открывает SFSafariViewController, в обычном
            // браузере — новый таб. Не заменяем внутреннюю навигацию.
            let bodyHtml = linkifyHtml(escapeHtml(bodyText));
            // v160k8 (Олег 19:23 «галочки красятся когда прочитано): ✓✓ —
            // цветная галочка (читано), ✓ — muted (отправлено, не читано).
            let statusHtml = "";
            if (statusGlyph === "\u2713\u2713") {
                statusHtml = " <span class='msg-read-check'>\u2713\u2713</span>";
            } else if (statusGlyph === "\u2713") {
                statusHtml = " <span class='msg-sent-check'>\u2713</span>";
            } else if (statusGlyph) {
                statusHtml = " " + statusGlyph;
            }
            // v160r: цитата (reply_to из расшифрованного ct) над текстом.
            // m.reply_to пишется в msg-объектах (decrypt paths + optimistic).
            // data-qsig = sig оригинала — тап по цитате скроллит к нему.
            // Privacy v155: имя отправителя не светим (nameMap только локально,
            // в quoted уходит превью текста — достаточно для привязки).
            let quotedHtml = "";
            if (m.reply_to && m.reply_to.sig) {
                quotedHtml =
                    "<div class='quoted' data-qsig='" + escapeHtml(m.reply_to.sig) + "'>" +
                        escapeHtml(String(m.reply_to.preview || "сообщение").slice(0, 120)) +
                    "</div>";
            }
            div.innerHTML =
                quotedHtml +
                "<div class='msg-body'>" + bodyHtml + "</div>" +
                "<span class='bubble-time'>" + formatTime(m.ts) + statusHtml + "</span>";
            messagesArea.appendChild(div);
            renderedSigs.add(sig);
            // v160y55c: плавное появление — каждый новый бабл получает класс
            // .msg-enter (fadeInUp) + каскадную задержку по индексу (CSS
            // animation-delay var(--enter-delay)). После цикла сбрасываем
            // --enter-delay, чтобы инкрементальные поллы рендерились без задержки.
            try {
                div.classList.add("msg-enter");
                div.style.setProperty("--enter-delay", Math.min(__newBubbles * 40, 400) + "ms");
                __newBubbles++;
            } catch (e) {}
            // v160k9a (Олег 2026-09-05 23:48): Link Unfurl. Если в body был URL,
            // ниже первой ссылки подтянем og:image/title/description через
            // microlink.io и вставим превью-карточку. Не передаём URL через
            // relay — privacy: всё на клиенте. Кэш в IDB murmur.unfurl_cache,
            // TTL 24ч.
            if (window.attachUnfurlPreview) {
                try { window.attachUnfurlPreview(div, bodyText, sig); } catch (e) { /* ignore */ }
            }
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
            // v160o: сплит по plaintext. Всё, у чего plaintext ЕСТЬ (картинки,
            // мелкие файлы) — прежний inline-рендер из outbox. Всё без plaintext
            // (видео после v160o-санитайза, серверные echo) — через remote-decrypt
            // (fetch blob + ECIES unwrap НАШИМ privkey, Lesson #349), с постером
            // из локальных meta, пока fetch идёт. Chip остаётся fallback'ом при
            // полном провале (нет ни plaintext, ни blob на relay — >24h).
            // v160o: сплит по plaintext (см. выше).
            const localAtts = m.attachments_meta.filter(att => att.plaintext_b64);
            const remoteAtts = m.attachments_meta.filter(att => !att.plaintext_b64);
            // Lesson #349: у исходящих с двойн-wrapped ключом ({r,s}) plaintext из
            // outbox НЕ нужен — рендерим через remote-decrypt (fetch blob +
            // ECIES unwrap s НАШИМ privkey + AES). Работает на любом устройстве
            // с той же личностью и переживает чистый outbox. Legacy single-wrapped
            // (без .s) тоже попробуем decrypt'ом — с нашей подписью это НАШЕ
            // сообщение, но unwrap 'r' с нашим ключом упадёт → chip fallback.
            if (localAtts.length > 0) {
                for (const att of localAtts) {
                    try {
                        const mime = att.mime || "application/octet-stream";
                        const blob = b64ToBlob(att.plaintext_b64, mime);
                        const url = URL.createObjectURL(blob);
                        // Lesson #225: track в WeakMap imgElement→blobUrl для авто-revoke
                        // (но сначала надо создать img element чтобы зарегистрировать)
                        const el = renderOutgoingAttachment({ mime, name: att.name, url, size: att.size, poster: att.poster_data_url || att._plainPoster || posterFromCache(att.blob_id) || null, att });
                        if (el && el.tagName === "IMG" && window.__murmurBlobOwners) {
                            window.__murmurBlobOwners.set(el, url);
                        }
                        placeholderEl.appendChild(el);
                    } catch (e) {
                        console.error("[attach-out] render failed:", e);
                    }
                }
            }
            if (remoteAtts.length > 0) {
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
                        // v160o: только att БЕЗ plaintext (локальные уже отрендерены
                        // выше). _plainPoster — постер из локальных meta, чтобы
                        // превью видео было видно сразу, до завершения fetch+decrypt.
                        for (const att of remoteAtts) {
                            const attEl = { ...att, _selfKey: true, _plainPoster: att._plainPoster || att.poster_data_url || null };
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
    // v160y55c: __newBubbles объявлен let внутри renderMessages — на следующем
    // render счётчик с нуля, инкрементальные баблы получают delay=0ms
    // (каскад — только для батча при открытии чата). Сброс не нужен.
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
    // v160i18n: даты через словарь (Сегодня/Вчера) + Intl для месяцев
    if (diffDays === 0) return window.MurmurI18N.t("Сегодня");
    if (diffDays === 1) return window.MurmurI18N.t("Вчера");
    if (window.MurmurI18N.isEn) {
        return d.getDate() + " " + d.toLocaleString("en", { month: "short" });
    }
    const months = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    return d.getDate() + " " + months[d.getMonth()];
}

function scrollToBottom() {
    requestAnimationFrame(() => { messagesArea.scrollTop = messagesArea.scrollHeight; });
}

// v160y51 (Олег 06:41: «заходишь в чат сразу после другого — оказываешься на
// последнем видео, а не внизу; при повторном заходе в тот же чат всё ок»):
// гонка высот — scrollToBottom отрабатывает при дефолтных 16/9-высотах превью,
// потом loadedmetadata/img.load ставит реальные пропорции (вертикальное видео
// = +150-280px) и лента растёт УЖЕ ПОСЛЕ скролла → юзер висит на последнем
// видео, сообщения после него уходят под низ. Повторный вход ок (рендер
// мгновенный, высоты честные до скролла). Фикс: pin-bottom — скролл-листенер
// непрерывно помнит «были ли на низе», а __murmurPinBottom (зовётся из
// render-attachments при loadedmetadata/img.load) доводит низ, если до роста
// были на нём. Ручной скролл вверх > 60px от низа снимает флаг — не хайджекаем.
window.__murmurWasAtBottom = true;
if (messagesArea) {
    // v160z14: первое ручное касание отменяет openChat pin-window.
    // Раньше первый iOS-скролл в течение 3 секунд считался служебным
    // scrollToBottom и следующая догонка возвращала ленту вниз. После окна
    // всё работало, поэтому баг проявлялся только на первом скролле.
    const cancelBottomPinOnUserScroll = () => {
        window.__murmurPinUntil = 0;
        window.__murmurWasAtBottom = false;
    };
    messagesArea.addEventListener("touchstart", cancelBottomPinOnUserScroll, { passive: true });
    messagesArea.addEventListener("pointerdown", cancelBottomPinOnUserScroll, { passive: true });
    messagesArea.addEventListener("wheel", cancelBottomPinOnUserScroll, { passive: true });
    messagesArea.addEventListener("scroll", () => {
        // v160g4-kbd6 (порт w6m5): в pin-окне флаг не снимаем - smooth-доскролл
        // проходит промежуточные позиции (dist>60) и обрывал догон-серию.
        if (Date.now() < (window.__murmurPinUntil || 0)) {
            window.__murmurWasAtBottom = true;
        } else {
            window.__murmurWasAtBottom =
                (messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight) < 60;
        }
    }, { passive: true });
}
window.__murmurPinBottom = () => {
    try {
        if (!messagesArea || !window.__murmurWasAtBottom) return;
        messagesArea.scrollTop = messagesArea.scrollHeight;
    } catch (e) { /* ignore */ }
};

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

// ============================================================================
// GROUP client (v160g1, Олег 2026-09-21, вариант 3 — sender-keys + epoch)
// ============================================================================
// Клиент-сайд фанаут: сервер НЕ знает о группах. Групповое сообщение =
// обычный 1:1 envelope на каждого участника (?to=<member_npub>), внутри
// зашифрованного payload — group_id + sender. Ключ группы раздаётся через
// 1:1 ECIES. Групповая лента собирается клиентом по group_id.



async function sendMessage() {
    // Lesson #152: try/finally ВОКРУГ всего тела — если WASM encrypt падает на
    // большом файле или FileReader не декодировал HEIC, btnSend оставалось
    // disabled навсегда. finally гарантирует разблокировку.
    // v160g7: ветвление на группу — currentGroup приоритетнее activePeer
    // (открытая группа ≠ 1:1 чат; sendGroupMessage сам раскладывает по участникам).
    if (!activePeer && !currentGroup) return;
    if (currentGroup) {
        const gText = messageInput.value.trim();
        if (!gText) return;
        if (pendingAttachments.length > 0) { alert("Вложения в группах — следующий шаг (G5). Пока отправляйте текст."); return; }
        messageInput.value = "";
        messageInput.style.height = "auto";
        btnSend.disabled = true;
        try {
            const res = await sendGroupMessage(currentGroup, gText);
            if (res) {
                // Optimistic: своё сообщение в ленту группы (direction out).
                // v160g8: _sig как у handleIncomingGroupMsg — poll-echo (payload.ts = res.ts)
                // дедупится против optimistic, иначе дубль в ленте группы.
                (messages[currentGroup] = messages[currentGroup] || []).push({
                    direction: "out", from: myNpub, body: gText, ts: res.ts, isGroup: true,
                    _sig: "grp" + currentGroup + "|" + myNpub + "|" + res.ts,
                });
                if (typeof renderGroupMessages === "function") renderGroupMessages();
                scrollToBottom();
                setChatPreview(currentGroup, res.ts, "Вы: " + gText);
            }
        } catch (e) {
            alert("Ошибка отправки в группу: " + (e && e.message));
        } finally {
            btnSend.disabled = false;
        }
        return;
    }
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
        // v160r: reply-to snapshot ДО очистки (pendingReply сбрасывается после encrypt).
        // reply_to живёт ВНУТРИ E2E payload — relay его не видит (приватность та же).
        const replySnapshot = pendingReply ? Object.assign({}, pendingReply) : null;
        // Clone meta before clearing, to avoid race with subsequent edits.
        // Privacy split (Олег 2026-08-31):
        //  - attachments_meta (SERVER-VISIBLE) → publicName (f-…bin), no real filename
        //  - sealed ct → attachments[].name = real filename (только peer увидит)
        const metaSnapshot = pendingAttachmentsMeta.map((a) => Object.assign({}, a));
        const sealedB64 = await encryptForRecipient(peerKey.npub, {
            body: text,
            // v160r: reply_to внутри E2E — {sig, preview, ts} целиком зашифровано.
            reply_to: replySnapshot ? { sig: replySnapshot.sig, preview: replySnapshot.preview, ts: replySnapshot.ts } : null,
            attachments: metaSnapshot.map((a) => ({ name: a.name, mime: a.mime, size: a.size,
                // v160d: постер-кадр (data:image/jpeg) — только получателю, внутри E2E.
                poster_data_url: a.poster_data_url || null,
            })),
        });
        // v160r: reply сбрасываем после encrypt (снимок уже снят).
        hideReplyBar();
        // Server-visible meta: replace real names with neutral ones, drop plaintext_b64.
        const serverMeta = metaSnapshot.map((a) => ({
            blob_id: a.blob_id,
            sha256: a.sha256,
            // v160p Phase 2: bearer token in server meta — relay already stores
            // its hash (no extra leak); recipient reads it to download blob.
            blob_token: a.blob_token || null,
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
                sha256: a.sha256,
                blob_token: a.blob_token || null, // v160p Phase 2 (self-download after reload)
                // v160o: wrapped_key ({r,s}) + iv нужны для self-decrypt после
                // reload (когда plaintext из storage выброшен санитайзером —
                // Lesson #349). Без них превью после перезахода становится чипом.
                wrapped_key: a.wrapped_key,
                iv: a.iv,
                mime: a.mime,
                name: a.name,
                size: a.size,
                plaintext_b64: a.plaintext_b64,
                poster_data_url: a.poster_data_url || null, // v160d
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
            // v160r: reply в optimistic render (цитата видна сразу после отправки)
            reply_to: replySnapshot ? { sig: replySnapshot.sig, preview: replySnapshot.preview, ts: replySnapshot.ts } : null,
            _pendingServerAssign: true,
        };
        messages[activePeer].push(renderedMsg);
        optimisticRendered = true;
        // Lesson #159: сохраняем в outbox localStorage, чтобы после reload можно было
        // отрисовать без decrypt (анти-паттерн шифровать/расшифровывать собственные).
        console.log("[send] attachmentsWithPlaintext count =", attachmentsWithPlaintext.length, "metaSnapshot =", metaSnapshot.length);
        // v160p: plaintext каждого вложения (видео и большие файлы тоже!) кладём
        // в blob-cache (IDB хранит Blob нативно — квота base64-строк не ревает,
        // Lesson #360). После reload рендер мгновенный из кэша, без расшифки
        // (Олег 2026-09-02: «висит расшифка, потом видео — должно из кэша»).
        for (const a of metaSnapshot) {
            if (a.plaintext_b64 && window.MurmurBlobCache && window.MurmurBlobCache.isAvailable()) {
                try {
                    window.MurmurBlobCache.put(a.blob_id, b64ToBlob(a.plaintext_b64, a.mime), a.mime).catch(() => {});
                } catch (e) { /* cache paste — fail OK */ }
            }
            // v160y37 (Олег: «после перезахода в pwa ни превью, ни проигрывания»
            // для .MOV с мака): IDB cache evicted при 50MB → рендер после reload
            // идёт в fetch → серверная копия может быть TTL-удалена → навсегда
            // chip. OPFS plaintext-копия при отправке — восстановление без сети.
            if (a.plaintext_b64 && window.MurmurBlobOPFS && typeof window.MurmurBlobOPFS.isAvailable === "function" && window.MurmurBlobOPFS.isAvailable()) {
                try {
                    window.MurmurBlobOPFS.put("attp-" + a.blob_id, b64ToAb(a.plaintext_b64), a.mime).catch(() => {});
                } catch (e) { /* OPFS fail OK */ }
            }
        }
        // v160p: постер каждого вложения в постоянный кэш по blob_id
        // превью survives reload'ы и слияние кэша с серверной строкой.
        for (const a of metaSnapshot) savePosterToCache(a.blob_id, a.poster_data_url);
        // Lesson #350: _sig стабилен (локальный ts не меняем) — outbox сразу под финальным ключом.
        // Важно: дождаться записи локального plaintext до POST/poll.
        // Иначе echo с релея может попасть в history раньше outbox и
        // перезаписать фото метаданными без локальной копии.
        await saveToOutbox(renderedMsg, text, attachmentsWithPlaintext);
        await saveMessagesCacheForPeer(activePeer);
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
            // v158: POST 200 = «отправлено», не «доставлено». ✓✓ ставит только
 // квитанция получателя (applyReceipts → acks).
            if (last && last._sig === renderedMsg._sig) last.status = "sent";
            renderMessages();
            setChatPreview(activePeer, msg.ts, text.slice(0, 80));
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
        // v160r: reply тоже сбрасываем в finally — иначе при ошибке encrypt
        // бар висит и следующий send унесёт чужой reply_to.
        hideReplyBar();
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
// ═══ v160t (Олег 18.09): «печатает…» индикатор ═══
// Приватность: relay видит только ФАКТ набора (без текста), ничего не пишет
// в DB, событие эфемерное (не persist). Отправка: WS {type:"typing", npub}
// throttle 2.5с. Приём: WS push {type:"typing", from_npub, ts} —
// показываем «печатает…» под именем в header чата 4с (auto-hide).
let typingSendLast = 0;          // ms timestamp последней отправки typing
const TYPING_SEND_GAP = 2500;    // throttle отправки
const TYPING_SHOW_MS = 4000;     // сколько показываем индикатор
let typingTimers = new Map();    // peer → setTimeout id
let typingPeers = new Set();     // peer → сейчас печатает (для превью в списке)

function sendTypingPing() {
    const now = Date.now();
    if (now - typingSendLast < TYPING_SEND_GAP) return;
    typingSendLast = now;
    try {
        if (ws && ws.readyState === WebSocket.OPEN && myNpub && activePeer) {
            ws.send(JSON.stringify({ type: "typing", npub: myNpub, to: activePeer }));
        }
    } catch (e) { /* ignore */ }
}

function showTyping(peer) {
    if (typeof peer !== "string") return;
    // v160u: превью в списке чатов тоже «печатает…» (как в Telegram).
    // Эфемерно: contacts-объект в памяти, в setChatPreview не пишем (там
    // ts-монотонность + persist) — свой typing-таймер восстанавливает
    // финальный preview через hideTyping.
    typingPeers.add(peer);
    const nameEl = document.getElementById("chat-peer-name");
    if (!nameEl) return;
    if (activePeer === peer) nameEl.textContent = window.MurmurI18N.t("печатает…");
    const old = typingTimers.get(peer);
    if (old) clearTimeout(old);
    typingTimers.set(peer, setTimeout(() => hideTyping(peer), TYPING_SHOW_MS));
}

function hideTyping(peer) {
    typingPeers.delete(peer);
    const nameEl = document.getElementById("chat-peer-name");
    if (nameEl && activePeer === peer) {
        const nm = loadContactNames();
        nameEl.textContent = nm[peer] || shortNpub(peer);
    }
    const t = typingTimers.get(peer);
    if (t) { clearTimeout(t); typingTimers.delete(peer); }
    // v160u: убрали «печатает…» из превью — перерисовываем список.
    renderChatList();
}

function handleTypingEvent(env) {
    if (!env || env.type !== "typing") return false;
    const from = env.from_npub || env.from;
    if (!from || from === myNpub) return true; // своё — скип
    const peer = normalizePeer(from);
    // v160u: showTyping ВСЕГДА (typingPeers.add → превью в списке для любого
    // peer). Header обновится только если peer — активный чат (условие внутри
    // showTyping). Раньше showTyping был под if (activePeer === peer) —
    // превью не рендерилось, пока чат закрыт.
    showTyping(peer);
    renderChatList();
    return true;
}

messageInput?.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
    // v160t: typing ping на любой ввод (throttle внутри).
    sendTypingPing();
});

messageInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// v160w5e3 (Олег 29.09 07:09, скрин+уточнение «галочка — норм, стрелка — дергается»
// при w5e2): w5e2 (touchend preventDefault) НЕ сработал — на iOS blur инпута
// происходит на TOUCHSTART по другому элементу (клавиатура уезжает ещё до
// touchend), к моменту touchend фокус уже потерян, guard не срабатывает.
// Рабочая точка перехвата — TOUCHSTART СТРЕЛКИ (capture, passive:false):
// preventDefault на touchstart отменяет дефолтный blur-на-touchstart И
// синтетический click. Путь = Enter-пути: клавиатура остаётся ОТКРЫТОЙ.
// Отправку делаем на touchend (не touchstart — палец может соскользнуть).
btnSend?.addEventListener("touchstart", (e) => {
    try {
        if (messageInput && document.activeElement === messageInput) {
            e.preventDefault();
            btnSend.__kbSendPending = true;
        }
    } catch (err) { /* fallthrough к обычному обработчику */ }
}, { capture: true, passive: false });
btnSend?.addEventListener("touchend", (e) => {
    try {
        if (btnSend.__kbSendPending) {
            btnSend.__kbSendPending = false;
            e.preventDefault();
            sendMessage();
        }
    } catch (err) { /* fallthrough к обычному обработчику */ }
}, { capture: true, passive: false });
btnSend?.addEventListener("touchcancel", () => {
    try { btnSend.__kbSendPending = false; } catch (err) {}
}, { capture: true });
btnSend?.addEventListener("click", (e) => {
    try {
        if (messageInput && document.activeElement === messageInput) {
            e.preventDefault();
            sendMessage();
        }
    } catch (err) { /* fallthrough к обычному обработчику */ }
}, true);
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
        // v160n: ретраи с паузой — в метро/LTE-тоннеле первый fetch может упасть
        // («Load failed»). 3 попытки: сразу, +1.5s, +3s; после неудачи — чип.
        // Прогрев из enterMessenger обычно уже загрузил модуль, это fallback.
        if (!window.MurmurAttachments) {
            let loaded = false, lastErr = null;
            for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
                if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
                try {
                    // v160y28: ?v= в fallback-import — синхронно с warmup.
                    await import("./attachments.js?v=160y56");
                    loaded = true;
                } catch (err) {
                    lastErr = err;
                    console.error("attachments.js import attempt", attempt + 1, "failed:", err);
                }
            }
            if (!loaded) {
                pushRejectedChip({ name: "—", size: 0 }, "Не удалось загрузить модуль шифрования (сеть? проверьте соединение и откройте приложение заново).");
                console.error(lastErr);
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
                    // v160y45: stage-индикация на чипе — «конвертация…» /
                    // «кадр превью…» / «шифрование…» / % загрузки (40MB видео
                    // конвертируется real-time — минуты; без индикации выглядело
                    // как зависание).
                    onStage: (stage) => {
                        const idx = pendingAttachments.findIndex((a) => a._tempId === tempId);
                        if (idx >= 0) {
                            pendingAttachments[idx]._stage = stage;
                            renderAttachmentsPreview();
                        }
                    },
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
                        poster_data_url: result.poster_data_url || null, // v160d: кадр для превью
                        mime: result.mime,
                        size: result.size,
                        name: result.name,
                        // Privacy: server-visible meta keeps the NEUTRAL upload name
                        // (f-XXXXXXXX.bin); real filename lives only in the sealed ct.
                        publicName: result.publicName,
                        // v160p2: bearer token from upload response — must be in
                        // pendingAttachments or serverMeta ships blob_token:null → 401.
                        blob_token: result.blob_token || null,
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
        } else if (a._uploading && a._stage) {
            label += ` ⚙️ ${escapeHtml(a._stage)}…`; // v160y45: транскод/шифрование
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

// Олег 2026-09-05 20:40: linkify поверх escapeHtml. Ищем URL на уже
// экранированной строке — не ломаем HTML. Регекс берёт http/https/www
// + опциональный путь/query/fragment. target=_blank + rel=noopener
// noreferrer — в iOS PWA Safari открывает новый таб SFSafariViewController,
// в обычном браузере — новый таб. Никакой internal-роутер не нужен.
function linkifyHtml(escaped) {
    if (!escaped) return "";
    // (?:https?:\/\/|www\.)[^\s<]+  — после escape все < > и пробелы уже
    // безопасны; \s достаточно для разрыва URL.
    const re = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
    return escaped.replace(re, (m) => {
        let href = m;
        if (/^www\./i.test(href)) href = "https://" + href;
        // Trailing punctuation (типа "." или "," в конце предложения) — частая
        // грабля. URL.ы кончаются на ?!&,;:'.) — оставляем как есть (компромисс,
        // но для мессенджера хватает; пользователь увидит «https://x.com.» и
        // тапнет в зону «https://x.com»).
        return "<a href=\"" + href + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + m + "</a>";
    });
}

// v160k9a (Олег 2026-09-05 23:48): Link Unfurl — превью ссылок в чате.
// Находим ПЕРВЫЙ URL в тексте сообщения, тянем OG-метаданные (og:image,
// og:title, og:description) через microlink.io, вставляем карточку под
// .msg-body. Кэш в IDB murmur.unfurl_cache (24ч TTL). Не передаём URL через
// relay — privacy: всё на клиенте.
window.attachUnfurlPreview = async function (bubbleDiv, bodyText, sig) {
    if (!bubbleDiv || !bodyText) return;
    // уже был превью для этого sig?
    if (bubbleDiv.querySelector(".unfurl-card")) return;
    const m = bodyText.match(/https?:\/\/[^\s<]+/i);
    if (!m) return;
    const url = m[0].replace(/[.,!?)]+$/, ""); // strip trailing punct
    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|youtu\.be|m\.youtube\.com)\//i.test(url)
        && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) return;
    // URL валидный — продолжаем.
    const cacheKey = "murmur.unfurl_cache";
    const cache = (window.appStore && await window.appStore.kv.get(cacheKey).catch(() => null)) || {};
    const now = Date.now();
    let meta = cache[url];
    if (meta && now - meta._at > 24 * 3600 * 1000) meta = null; // TTL
    if (!meta) {
        try {
            // microlink.io: бесплатный OG endpoint. Без API key 50 req/day,
            // с ключом (в URL) — больше. Нам для beta хватит.
            const r = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url)
                + "&meta=true&screenshot=false&embed=screenshot.url");
            if (!r.ok) return;
            const j = await r.json();
            if (!j || j.status !== "success" || !j.data) return;
            meta = {
                title: j.data.title || url,
                description: j.data.description || "",
                image: (j.data.image && j.data.image.url) || "",
                siteName: j.data.publisher || j.data.title || "",
            };
            cache[url] = { ...meta, _at: now };
            // Пишем обратно в кэш (kv store). Не критично если упало.
            if (window.appStore) window.appStore.kv.set(cacheKey, cache).catch(() => {});
        } catch (e) {
            // CORS, offline, rate-limit — молча возвращаемся.
            return;
        }
    }
    if (!meta || (!meta.title && !meta.image)) return;
    const card = document.createElement("a");
    card.className = "unfurl-card";
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML =
        (meta.image ? "<div class='unfurl-img'><img src=\"" + escapeHtml(meta.image) + "\" alt=\"\"></div>" : "") +
        "<div class='unfurl-meta'>" +
            (meta.siteName ? "<div class='unfurl-site'>" + escapeHtml(meta.siteName) + "</div>" : "") +
            "<div class='unfurl-title'>" + escapeHtml(meta.title || "") + "</div>" +
            (meta.description ? "<div class='unfurl-desc'>" + escapeHtml(meta.description) + "</div>" : "") +
        "</div>";
    bubbleDiv.appendChild(card);
};

btnBack?.addEventListener("click", () => {
    sidebar.classList.remove("hidden");
    chatPanel.classList.remove("active");
    const m = document.querySelector(".messenger");
    if (m) m.classList.remove("chat-open");
    activePeer = null;
    if (btnCall) btnCall.hidden = true;
    if (window.MurmurCall) window.MurmurCall.close();
    // v160z10: при выходе из чата splash тоже прячем (если юзер вышел до конца
    // холодной загрузки — иначе splash остаётся на панель до loadHistory).
    const splash = document.getElementById("chat-splash");
    if (splash) splash.hidden = true;
    chatView.style.display = "none";
    chatView.hidden = true;
    updateNoChatVisibility(); // v160x3: панель только если чатов нет (было: всегда flex → 50/50 сплит)
    if (btnDeleteChat) btnDeleteChat.hidden = true; // Lesson #129
    inputArea.classList.remove("visible");
    inputArea.hidden = true;
});

// Lesson #129: «удалить чат» — срываем chat из sidebar, чистим badge,
// очищаем память. На сервере ничего не трогаем (TTL 24ч).
btnDeleteChat?.addEventListener("click", () => {
    if (!activePeer) return;
    const peer = normalizePeer(activePeer);
    const nameMap = loadContactNames(); // v160z6: LS_CONTACT_NAMES переехал в contacts.js — loadContactNames() то же
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
            // v160t: typing events приходят голым {type:"typing", from_npub, ts}
            // (не в push-payload — эфемерные, не хранятся).
            if (handleTypingEvent(msg) || handleTypingEvent(msg.payload || {})) return;
            if (msg.type === "call_signal" && window.MurmurCall) { window.MurmurCall.onSignal(msg).catch(e => console.warn("[call] signal error", e)); return; }
            const envelope = msg.payload || msg;
            if (msg.type === "subscribed" || msg.type === "pong" || msg.type === "error") return;
            if (envelope && envelope.ts) handleIncomingEnvelope(envelope).catch((e) => { console.warn("[murmur] envelope error:", e && e.message); });
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

async function handleIncomingEnvelope(env) {
    if (!env || !env.ts) return;
    // Handle both formats: {from_npub, to} and {from, to}
    const fromNpub = env.from_npub || env.from;
    const toField = env.to || env.alias || "";
    if (fromNpub !== myNpub && toField !== myNpub) return;

    const peer = normalizePeer(fromNpub === myNpub ? toField : fromNpub);
    if (!messages[peer]) messages[peer] = [];

    // Use canonical from Npub+ts as dedup key (sig is too long and would never
    // match the optimistic message key).
    const sigKey = fromNpub + env.ts;
    // Lesson #128: более надёжный дедуп — по envelope_hash, если WS push его
    // прислал. Сервер может перезаписать ts, тогда дедуп по ts ломается.
    const hash = env.envelope_hash_hex || (env.envelope && env.envelope.envelope_hash_hex) || null;
    // v160y53: сервер кладёт ПОЛНОЕ тело квитанции в ws_envelope_b64 (base64
    // envelope bytes) — распаковываем ДО receipt-ветки, иначе isReceiptRow
    // не опознает WS-пуш (без _kind/body_base64) и квитанция провалит в
    // contentless-ветку → deferred poll находит строку уже TTL-удалённой →
    // ack терялся навсегда (Олег 25.09: «✓ не превращается в ✓✓»).
    if (!env._kind && typeof env.ws_envelope_b64 === "string" && env.ws_envelope_b64.length > 0) {
        try {
            const innerEnv = JSON.parse(atob(env.ws_envelope_b64));
            if (innerEnv && typeof innerEnv === "object") {
                // v160y54b: wire-конверт ЗАВЁРНУТ {"_kind":"json_envelope",
                // "payload":{...}} (subscribers.rs → ws_server json!) — _kind
                // квитанции внутри payload. Топ-левел _kind = "json_envelope",
                // старая проверка env._kind === "receipt" ВСЕГДА false →
                // ack терялся на WS-пути (Олег 25.09: «на 1 сработало,
                // на следующих 3-х нет» — единственный ✓✓ был через /api/history).
                const wsPayload = (innerEnv._kind === "json_envelope" && innerEnv.payload && typeof innerEnv.payload === "object") ? innerEnv.payload : innerEnv;
                env._kind = wsPayload._kind || innerEnv._kind || null;
                env.ct = wsPayload.ct || env.ct;
                env.body = JSON.stringify(wsPayload); // consumeReceiptRow парсит JSON
                env.body_base64 = env.ws_envelope_b64; // fallback-путь
            }
        } catch (e) { console.warn("[WS] ws_envelope_b64 parse failed:", e && e.message); }
    }
    // v158: служебные конверты не рендерим (WS в prod мёртв, но защита на
    // будущее). Чужая квитанция — тоже ✓✓; своя — молча скип.
    if (env._kind === "receipt" || isReceiptRow(env)) {
        if (fromNpub !== myNpub) consumeReceiptRow(env, hash, peer);
        return;
    }
    // v160y29: системные broadcast'ы (from_npub=system:relay) — НЕ сообщения.
    // Receipt-broadcast с fallback-телом «New message — open the app…» и пустым
    // hash проходил contentless-фильтр → ФАНТОМНЫЙ чат «Без имени» (Олег 22:00).
    if (fromNpub === "system:relay") {
        console.log("[WS] system broadcast ignored, ts=", env.ts);
        return;
    }
    // v160g3: групповые служебные (invite/rotation) — обновляют groups store,
    // НЕ рендерятся как сообщения. Групповое ОБЫЧНОЕ сообщение (с group_id
    // внутри payload) рендерится ниже по обычному пути (peer = member_npub,
    // клиент собирает ленту по group_id из payload).
    if (env._kind === "group_invite" || env._kind === "group_key") {
        if (fromNpub !== myNpub) { await consumeGroupEnvelope(env); }
        return;
    }
    // v160g4: групповое ОБЫЧНОЕ сообщение — payload содержит group_id +
    // sender + body (внутри группового шифра). Рендерим в ГРУППОВУЮ ленту
    // (peer = group_id), не в 1:1 чат отправителя.
    // v160g8 (Олег 13:54 «сообщения отображаются в отдельных чатах»): WS-доставка
    // заворачивает wire-msg в {"_kind":"json_envelope","payload":<wire>} —
    // env._kind === "json_envelope", а group_msg внутри payload. Старая проверка
    // env._kind === "group_msg" ВСЕГДА false на WS → провал в 1:1 путь →
    // messages[member_npub] = отдельные чаты.
    const gm = (env._kind === "json_envelope" && env.payload && typeof env.payload === "object") ? env.payload : env;
    if (gm._kind === "group_msg" && typeof gm.ct === "string") {
        await handleIncomingGroupMsg(gm, fromNpub, hash);
        return;
    }
    // v160h2: WS-пуш не несёт контента (body = серверный текст «New message —
    // open the app to read it», ct/body_base64 нет). Если рендерить — в чат
    // попадает серверный текст, а реального сообщения нет (Олег 21:05 «адресату
    // приходит только пуш, а сообщение не отображается»). Не рендерим — дёргаем
    // poll: реальный конверт придёт из /api/history (body_base64 → _kind →
    // group_msg/1:1 путь) и расшифруется там. Групповые копии хранятся per-member
    // (to=myNpub), так что pollHistoryForPeer(fromNpub) их находит.
    const isContentlessPush = hash && !env.ct && !env.body_base64 &&
        (!env.body || env.body.indexOf("open the app") !== -1);
    if (isContentlessPush) {
        console.log("[WS] contentless push deferred to poll, hash=", (hash || "").slice(0, 12), "peer=", peer.slice(0, 12));
        setTimeout(() => {
            pollHistoryForPeer(peer).catch(() => {});
            const gids = Object.keys(loadGroups() || {});
            for (const gid of gids) { try { pollHistoryForGroup(gid); } catch (e) {} }
        }, 400);
        return;
    }
    if (fromNpub !== myNpub && hash) queueReceiptsForPeer(peer, [hash]);
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
            // v158: WS-echo своего исходящего = доставка до relay, недо получателя.
            messages[peer][idx].status = "sent";
            if (activePeer === peer) renderMessages();
        }
        return;
    }

    // Lesson #350: WS-echo НАШЕГО исходящего в полёте POST (self-chat echo,
    // second-device scenario): дедуп не сработает (optimistic._hash ещё null,
    // sig-ключи разные — сервер переписал ts) → вторая копия навсегда. Держим
    // echo до прихода hash из POST-ответа — тот же контракт, что в pollHist.
    // v160g9: держим echo пока у любой исходящей копии не присвоен _hash
    // (та же защита что в pollHist v160g9) — гонка exists-проверка × POST-ответ.
    if (fromNpub === myNpub &&
        (messages[peer].some(m => m._pendingServerAssign) ||
         messages[peer].some(m => m.direction === "out" && !m._hash && !m.isUndelivered &&
             Math.abs((m.ts || 0) - (env.ts || 0)) <= 120))) {
        console.log("[WS] outgoing echo deferred (hash unresolved), hash=", (hash || "").slice(0, 12));
        return;
    }

    // E2E: если есть `ct` — расшифровываем async, иначе plaintext fallback.
    decryptEnvelopeForRender(env).then(({ text: bodyText, isBinary, attachments, attachmentsMeta, reply_to: decryptedReplyTo }) => {
        // Privacy v155: from_name не читаем — имя контакта задаёт получатель локально.

        const msg = {
            from: fromNpub, to: toField, body: bodyText, ts: env.ts,
            direction: "in",
            sig: env.sig || "", _sig: sigKey, _hash: hash,
            isBinary: isBinary, status: null, attachments: attachments || [],
            // Privacy v154: attachmentsMeta теперь содержит real names (_plainName),
            // слитые из расшифрованного ct → чипы показывают настоящее имя файла.
            attachments_meta: attachmentsMeta || [],
            // v160r: reply_to из расшифрованного ct (внутри E2E, не на envelope)
            reply_to: decryptedReplyTo || null,
        };
        messages[peer].push(msg);

        setChatPreview(peer, env.ts, previewForMsg(msg));

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
    // v160y55c (Олег 25.09 13:51: «опять в переписке задублировалось сообщение»):
    // гонка параллельных poll'ов — WS contentless defer (400ms) и forceTick
    // (visibilitychange/focus) дёргают pollHistoryForPeer НАПРЯМУЮ, вне
    // сериализованного poll-лупа (setTimeout-after-await). Два параллельных
    // fetch /api/history: оба приходят до exists-дедупа (ни один ещё не успел
    // push) → оба push → ДУБЛЬ. Фикс: per-peer in-flight guard — второй вызов
    // ждёт первый (promise reuse), а не дублирует fetch.
    window.__murmurPollHistInFlight = window.__murmurPollHistInFlight || new Map();
    const inFlight = window.__murmurPollHistInFlight.get(peer);
    if (inFlight) {
        try { await inFlight; } catch (e) { /* ignore */ }
        return;
    }
    const run = (async () => {
    // v160p: как в loadHistory (v160k9c) — ждём загрузку кэша, иначе добавление
    // серверных строк в пустой messages[peer] + saveMessagesCacheForPeer
    // затирало IDB-историю серверным окном (root cause «пропала история 15:30–20:25»).
    const pendingCache = __murmurCacheLoading.get(peer);
    if (pendingCache) {
        try { await pendingCache; } catch (e) { /* ignore */ }
    }
    console.log("[pollHist] peer=", peer.slice(0,12), "myNpub=", myNpub.slice(0,12));
    try {
        const r = await fetch(RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) + "&peer=" + encodeURIComponent(peer) + "&limit=" + HISTORY_LIMIT + "&visible=" + (document.visibilityState === "visible" ? 1 : 0) + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
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
            // v160h5 (сим 21.09 21:50): групповые конверты (свои эхо-фанауты с
            // _kind:"group_msg"/"group_invite" в body_base64 И чужие) маршрутизируем
            // ДО exists/echo/orphan — иначе v160w orphan-merge матчит эхо группового
            // конверта в фантомную out-копию в 1:1 чат с участником («исходящие
            // сообщения отображаются помимо группы во всех чатах», Олег 21.09 20:18).
            {
                let gwire = null;
                try {
                    if (typeof msg.body === "string" && (msg.body.startsWith("{") || msg.body.startsWith("["))) gwire = JSON.parse(msg.body);
                    else if (typeof msg.body_base64 === "string" && msg.body_base64.length > 0) {
                        const inner = decodeBody(msg.body_base64);
                        if (inner && inner.text && (inner.text.startsWith("{") || inner.text.startsWith("["))) gwire = JSON.parse(inner.text);
                    }
                } catch (_e) { gwire = null; }
                const gkind = gwire && typeof gwire._kind === "string" ? gwire._kind : (msg._kind || null);
                if (gkind === "group_msg" || gkind === "group_invite" || gkind === "group_key") {
                    if (gkind === "group_msg") await handleIncomingGroupMsg(msg, fromNpub, hash);
                    else if (fromNpub !== myNpub) await consumeGroupEnvelope(gwire || msg);
                    continue;
                }
            }
            // v158: квитанции НЕ попадают в чат. Чужую — разобрать (✓✓), свою —
            // молча скипнуть ДО hash-дедупа (иначе своя квитанция после reload
            // прошла бы по outbox-resolution как «исходящее») и ДО Lesson #350
            // echo-держателя (свой echo квитанции не должен зависать на _pendingServerAssign).
            if (isReceiptRow(msg)) {
                if (fromNpub !== myNpub) consumeReceiptRow(msg, hash, peer);
                continue;
            }
            // v158: реальное входящее — ставим envelope_hash в очередь квитанции
            // ДО exists-дедупа: первый poll приносит ВСЮ историю, надо отчитаться
            // и по backlog'у. Дубли отфильтровывают seen/receipted-хранилища.
            if (fromNpub !== myNpub && hash) queueReceiptsForPeer(peer, [hash]);
            let exists = false;
            if (hash) {
                exists = messages[peer].some(m => m._hash === hash);
            } else {
                exists = messages[peer].some(m => m._sig === sigKey);
            }
            if (exists) {
                // v160k: cached 🔒 incoming — decrypt even when exists.
                if (fromNpub !== myNpub && (hash || msg.body_base64)) {
                    const cachedMsg = messages[peer].find(m => (hash ? m._hash === hash : m._sig === sigKey));
                    const staleBody = cachedMsg && cachedMsg.body &&
                        (cachedMsg.body.includes("🔒") || cachedMsg.body.includes("шифрованное"));
                    if (cachedMsg && staleBody && !cachedMsg._decrypt_promise) {
                        cachedMsg._decrypt_promise = decryptWithTimeout(msg)
                            .then(({ text: newBody, attachments: newAttArr, attachmentsMeta: newMeta, reply_to: newReplyTo }) => {
                                // v160y2: пустой text + вложения = успех (фото без подписи).
                                if (decryptResultHasContent({ text: newBody, attachments: newAttArr })) cachedMsg.body = newBody || "";
                                if (newMeta && newMeta.length) cachedMsg.attachments_meta = newMeta;
                                // v160r: reply_to тоже — цитата после decrypt.
                                if (newReplyTo && !cachedMsg.reply_to) cachedMsg.reply_to = newReplyTo;
                                if (activePeer === peer) renderMessages();
                            });
                    }
                }
                continue;
            }

            // Lesson #350 (Олег 2026-08-30 18:21 «фотки задваиваются»): race
            // sendMessage × poll — оптимистичная копия ждёт ответ POST /envelope
            // (_hash: null, _pendingServerAssign: true). Серверный echo НАШЕГО
            // исходящего (hash = H(payload) — тот же, что вернёт POST) не матчится
            // по хэш-дедупу → вторая копия навсегда. Пока POST в полёте — скипаем
            // echo; hash/финальный sig поставит POST-обработчик.
            // v160g9 (Олег 21.09 16:26 «после перезахода дубль пропал» → дубль жил
            // только в памяти): держим echo пока у ЛЮБОЙ исходящей копии в этом чате
            // не присвоен _hash (POST в полёте ИЛИ ответ ещё не дошёл) и ts эха
            // совпадает с ней ±120s. Закрывает гонку «exists-проверка прошла до
            // POST-ответа» → echo не сматчился ни по hash, ни по orphan → дубль.
            // После присвоения hash exists-дедуп срабатывает; если POST не вернул
            // hash — 15s-таймер отпускает, дальше ловит v160w orphan-merge.
            if (fromNpub === myNpub &&
                (messages[peer].some(m => m._pendingServerAssign) ||
                 messages[peer].some(m => m.direction === "out" && !m._hash && !m.isUndelivered &&
                     Math.abs((m.ts || 0) - (msg.ts || 0)) <= 120))) {
                console.log("[pollHist] outgoing echo deferred (hash unresolved), hash=", (hash || "").slice(0, 12));
                continue;
            }

            // v160w: fallback-дедуп «потерянный POST-ответ». Если исходящее
            // ушло (релей сохранил), но ответ POST потерян (сеть/сворачивание
            // PWA) — optimistic остаётся с _hash=null, echo не матчится по
            // hash → дубль. Матчим echo к ближайшей безhash-копии по ts
            // (±120с; echo-тело зашифровано — по body не сравнить), бэкфиллим
            // hash (в копию и outbox) и склеиваем.
            if (fromNpub === myNpub && hash) {
                let orphan = null, orphanDelta = Infinity;
                for (const m of messages[peer]) {
                    if (m.direction !== "out" || m._hash || m.isUndelivered) continue;
                    const delta = Math.abs((m.ts || 0) - (msg.ts || 0));
                    if (delta <= 120 && delta < orphanDelta) { orphan = m; orphanDelta = delta; }
                }
                if (orphan) {
                    console.log("[pollHist] v160w orphan outgoing merged (POST answer lost), hash=", hash.slice(0, 12), "delta=", orphanDelta);
                    orphan._hash = hash;
                    orphan._server_msg = msg;
                    if (orphan.status === "failed") orphan.status = "sent";
                    // Бэкфилл hash в outbox — после reload plaintext резолвится по hash.
                    try {
                        const obKey = orphan._sig;
                        const upd = (ob) => { if (ob && ob[obKey] && !ob[obKey]._hash) { ob[obKey]._hash = hash; return true; } return false; };
                        const obIdb = (window.appStore ? await window.appStore.kv.get(LS_OUTBOX) : null);
                        if (obIdb && upd(obIdb)) { await window.appStore.kv.set(LS_OUTBOX, obIdb); if (_outboxKVCache) _outboxKVCache = obIdb; }
                        const obLs = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
                        if (upd(obLs)) localStorage.setItem(LS_OUTBOX, JSON.stringify(obLs));
                    } catch (e) { console.warn("[pollHist] v160w outbox hash backfill failed:", e); }
                    continue;
                }
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

            // v160g4: групповое сообщение в poll-пути — _kind:"group_msg" в wire
            // JSON (исходящие тоже: сервер хранит _kind в body). Рендер в групповую
            // ленту (peer=group_id), не в 1:1 чат отправителя.
            if (parsedBody && parsedBody._kind === "group_msg") {
                await handleIncomingGroupMsg(msg, fromNpub, hash);
                continue;
            }

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
                setChatPreview(peer, msg.ts, "Не доставлено");
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
                let resolvedReplyTo = null; // v160y52: reply_to из outbox (цитата)
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
                // v160y29: было `localOut && localOut.body` — photo/video-only исходящие
                // (body === "") проваливались в fallback → «[исходящее сообщение]»
                // вместо chip. Тот же баг что Lesson #328 (loadHistory-путь), тут
                // pollHist-путь не был синхронизирован. Fix: если outbox ЕСТЬ (по _hash/_sig),
                // это наше исходящее — доверяем localOut.attachments_meta.
                if (localOut) {
                    resolvedBody = localOut.body;
                    // v160y52 (Олег 25.09: «цитата пропадает после перезахода»):
                    // pollHist outbox-путь строил envelope с reply_to=null ВСЕГДА,
                    // даже когда localOut.reply_to есть (v160y50 сохранил его в
                    // outbox, но этот путь не читал). Phase-3 decrypt-петля ниже
                    // фильтрует только direction="in" → исходящие с reply_to=null
                    // никогда не ремонтировались → копия без цитаты падала в кэш.
                    if (localOut.reply_to && !resolvedReplyTo) resolvedReplyTo = localOut.reply_to;
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
                // v160y52: reply_to из outbox/localOut (цитата после перезахода).
                // decrypt-петля ниже фильтрует только "in" — для out это единственный
                // источник цитаты.
                reply_to: resolvedReplyTo || null,
            };
            messages[peer].push(envelope);
            added = true;

            // Privacy v155: from_name не читаем — имя контакта задаёт получатель локально.

            setChatPreview(peer, msg.ts, previewForMsg(envelope));
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
        }
        // v160q: Phase-3 (decrypt/merge meta) выполняется при КАЖДОМ тике, не только
        // при added. Кэш-строки после reload приходят с расшифрованным body, но
        // НЕОТМЕРЖЕННОЙ meta (f-…bin без _plainName) — раньше они навсегда
        // выпадали из обработки, и превью файла оставалось .bin (сим-репро 22:49).
        // Фильтр encMsgs сам оставляет только нуждающихся (🔒 или needsMetaMerge),
        // после успешного merge _plainName снимает msg с фильтра → ретраев нет.
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
            // v160q (Олег 22:49 «превью перебирается и остаётся bin»): в фильтр
            // добавлены входящие, у которых meta ещё НЕ ОТМЕРЖЕНА (name=f-…bin,
            // _plainName нет) — кэш-строки после reload: body уже расшифрован,
            // поэтому фильтр по «🔒» их пропускал, и real names из ct никогда
            // не попадали в attachments_meta → превью навсегда .bin.
            const needsMetaMerge = (m) => Array.isArray(m.attachments_meta) && m.attachments_meta.length > 0 &&
                m.attachments_meta.some(a => a && !a._plainName && a.name && /^f-/.test(a.name));
            const encMsgs = allMsgs.filter(m => m.direction === "in" && m._server_msg && (
                (m.body && m.body.includes("🔒")) || needsMetaMerge(m)
            ));
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
                            // v160y2: пустой text + вложения = успех (фото без подписи).
                            if (decryptResultHasContent(r)) {
                                // Lesson #224: для outgoing НЕ перезаписывать body —
                                // он либо из outbox (correct), либо из Lesson #201
                                // fallback (correct). Только incoming — async decrypt.
                                if (m.direction === "in") {
                                    m.body = r.text || "";
                                    if (r.attachments) m.attachments = r.attachments;
                                    // v160r: reply_to из расшифрованного ct — цитата в bubble.
                                    if (r.reply_to && !m.reply_to) m.reply_to = r.reply_to;
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
                                if (m.direction === "in" && contacts) {
                                    const preview = previewForMsg(m); // v158c: файлы → 📎 имя
                                    if (preview && setChatPreview(peer, m.ts || Date.now(), preview)) {
                                        renderChatList();
                                    }
                                }
                            } else if (r && r.text === "__DECRYPT_FAILED__") {
                                if (m.direction === "in") {
                                    m.body = "[не удалось расшифровать]";
                                    // Lesson #238 v3: failed decrypt тоже обновляет preview
                                    if (contacts && contacts[peer]) {
                                        setChatPreview(peer, m.ts || Date.now(), "[не удалось расшифровать]");
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
                    .catch(e => console.warn("[pollHist] async decrypt chain failed:", e))
                    .finally(() => {
                        // v160q: merge meta меняет данные и при added=false (кэш-строки) —
                        // сохраняем кэш после КАЖДОГО завершения Phase-3 цепочки,
                        // иначе IDB остаётся с f-…bin без _plainName навсегда.
                        // v160y8: не глотаем ошибки save — unhandled rejection → txn abort.
                        saveMessagesCacheForPeer(peer).catch((e) => {
                            console.warn("[pollHist] saveMessagesCacheForPeer failed:", e && e.message);
                            try {
                                localStorage.setItem("murmur.last_save_error", JSON.stringify({
                                    t: Date.now(), peer: peer.slice(0, 12), fn: "pollHist.save",
                                    err: String(e && e.message || e),
                                }));
                            } catch (_) { /* ignore */ }
                        });
                    });
            }
    } catch (e) {
        console.warn("pollHistoryForPeer failed:", e && e.message, e && e.stack);
        if (typeof window.__pollErrors !== 'undefined') window.__pollErrors.push({t: Date.now(), fn: 'pollHistoryForPeer', msg: String(e && e.message), stack: String(e && e.stack)});
    }
    })(); // v160y55c: конец run() — in-flight promise
    try { await run; } finally { window.__murmurPollHistInFlight.delete(peer); }
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
        // v158c: без body не выходим — у attachment-only сообщений превью
        // строится из attachments_meta («📎 имя»), раньше они выпадали тут.
        const hasBody = !!(body && String(body).trim());
        if (!hasBody && !(newest.attachments_meta && newest.attachments_meta.length)) continue;
        const preview = previewForMsg(newest);
        // Lesson #243 v2: пропускаем только если это raw ciphertext envelope.
        // '[не удалось расшифровать]' начинается с '[' — пропускать НЕ надо
        // (это валидное сообщение для UI).
        // 'Это самолет' и т.п. plaintext — тоже не начинается с '{'.
        // v158c: превью через previewForMsg (файлы → 📎 имя; 🔒 для нерасшифрованных).
        // НО: resync видит только последний msg; если у него нет ни текста, ни
        // attachments_meta (старый кэш), а в contacts уже стоит 📎 или текст из
        // более раннего рендера — НЕ откатывать на 🔒-плейсхолдер (мерцание).
        const fallbackish = (preview === "🔒 зашифрованное сообщение");
        const cur = contacts[peer] ? contacts[peer].lastMessagePreview : "";
        if (fallbackish && cur && cur !== "🔒 зашифрованное сообщение") continue;
        if (!contacts[peer]) contacts[peer] = { peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
        if (preview && setChatPreview(peer, newest.ts || Date.now(), preview)) {
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

// ── v160f: invite → PWA-манифест + лендинг + код переноса ────────────────

const TRANSFER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // без похожих (0/O, 1/I/L)

function isStandalonePWA() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
        || window.navigator.standalone === true;
}

// Invite в URL? Поддерживаем 3 формата:
//   #invite=npub1…            — старые ссылки + share-ссылки из UI
//   /invite/npub1…            — v160h: path-формат, iOS сохраняет path в start_url
//                               (query из start_url iOS выбрасывает — Lesson #358)
//   ?invite=npub1…            — legacy (iOS его тоже выбрасывает из start_url)
function extractInviteNpub() {
    const pm = (location.pathname || "").match(/\/invite\/(npub1[a-z0-9]+)/i);
    if (pm) return pm[1];
    const h = (location.hash || "").match(/[#&]invite=(npub1[a-z0-9]+)/i);
    if (h) return h[1];
    const q = new URLSearchParams(location.search).get("invite");
    return (q && /^npub1[a-z0-9]+$/i.test(q)) ? q : null;
}

// v160i: cookie-мост Safari→PWA. index.html (inline head) ставит murmur_invite
// при открытии invite-ссылки; если манифест-механизм не сработал (iOS кэш/нормализация),
// PWA при старте достаёт npub отсюда. На iOS 17+ хранилища изолированы — cookie
// сработает не везде, но на iOS 15/16 и Android/десктопе это спасает.
function readInviteCookie() {
    const m = document.cookie.match(/(?:^|;\s*)murmur_invite=(npub1[a-z0-9]+)/i);
    return m ? m[1] : null;
}
function clearInviteCookie() {
    try { document.cookie = "murmur_invite=; max-age=0; path=/; SameSite=Lax"; } catch (e) {}
}

// A. Invite → PWA-манифест: iOS запоминает start_url из манифеста в момент
// «На экран Домой». Свапаем <link rel=manifest> на /manifest.json?invite=<npub>,
// релей отдаёт копию с start_url="/?invite=<npub>" → PWA стартует сразу с чатом.
(function swapManifestForInvite() {
    const invite = extractInviteNpub();
    if (!invite) return;
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    // v160i: path-формат манифеста (уникальный URL бьёт кэш iOS, без query).
    link.href = "/manifest/" + invite + ".json";
    console.log("[invite] manifest swapped for PWA start_url:", link.href);
})();

// B. Safari (не-PWA) + invite + нет личности → лендинг-инструкция вместо
// «Создать аккаунт». Иначе юзер создаст аккаунт в Safari-контейнере, а PWA
// получит пустое хранилище и сгенерит второго юзера (баг-репорт Олега 01.09).
// Browser install instruction (per-browser detection, v160p6 variant B).
function installInstructions() {
    const ua = navigator.userAgent || "";
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|SamsungBrowser|Firefox/.test(ua);
    const isSamsung = /SamsungBrowser/.test(ua);
    const isFirefox = /Firefox/.test(ua);
    const isEdge = /Edg\//.test(ua);
    const isChrome = /Chrome|CriOS/.test(ua) && !isSamsung && !isEdge;
    const isDesktop = !/Mobi|Android|iPhone|iPad/.test(ua);

    if (iOS && isSafari) {
        return [
            "1. Внизу Safari жми ⟨Поделиться⟩ (квадрат со стрелкой)",
            "2. Выбери ⟨На экран „Домой“⟩ → ⟨Добавить⟩",
            "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    if (iOS && isChrome) { // Chrome iOS: тоже шаринг, но без PWA-установки → Safari-совместимая инструкция
        return [
            "1. Внизу Chrome жми ⟨Поделиться⟩ (квадрат со стрелкой)",
            "2. Выбери ⟨Открыть в Safari⟩",
            "3. Дальше как в Safari: ⟨Поделиться⟩ → ⟨На экран „Домой“⟩ → ⟨Добавить⟩",
        ];
    }
    if (/Android/.test(ua) && isChrome) {
        return [
            "1. В Chrome жми ⟨⋮⟩ (три точки справа сверху)",
            "2. Выбери ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩",
            "3. Подтверди ⟨Установить⟩ — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    if (isSamsung) {
        return [
            "1. В Samsung Internet жми ⟨≡⟩ (три полоски снизу справа)",
            "2. Выбери ⟨Добавить страницу в⟩ → ⟨Экран „Домой“⟩",
            "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    if (isFirefox && !isDesktop) {
        return [
            "1. В Firefox жми ⟨⋮⟩ (три точки)",
            "2. Выбери ⟨Установить⟩ / ⟨Добавить на главный экран⟩",
            "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    // Desktop
    if (isEdge) {
        return [
            "1. В Edge жми ⟨⋯⟩ в адресной строке (иконка установки) или ⟨⋯ меню⟩ → ⟨Приложения⟩ → ⟨Установить этот сайт как приложение⟩",
            "2. Подтверди ⟨Установить⟩",
            "3. murmur откроется в отдельном окне — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    if (isChrome) {
        return [
            "1. В Chrome жми иконку установки в правой части адресной строки (монитор со стрелкой)",
            "2. Или ⟨⋮ меню⟩ → ⟨Транслировать, сохранить и поделиться⟩ → ⟨Установить страницу как приложение…⟩",
            "3. Подтверди ⟨Установить⟩ — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    if (isSafari) {
        return [
            "1. В Safari жми ⟨Файл⟩ (в строке меню Mac)",
            "2. Выбери ⟨Добавить в Dock…⟩",
            "3. Подтверди ⟨Добавить⟩ — аккаунт создастся сам, и чат уже будет ждать",
        ];
    }
    // Fallback: generic
    return [
        "1. Найди в меню браузера пункт ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩",
        "2. Подтверди установку",
        "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать",
    ];
}

// A. Invite → PWA-манифест: iOS запоминает start_url из манифеста в момент
// «На экран Домой». Свапаем <link rel=manifest> на /manifest.json?invite=<npub>,
// релей отдаёт копию с start_url="/?invite=<npub>" → PWA стартует сразу с чат.
(function swapManifestForInvite() {
    const invite = extractInviteNpub();
    if (!invite) return;
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    // v160i: path-формат манифеста (уникальный URL бьёт кэш iOS, без query).
    link.href = "/manifest/" + invite + ".json";
    console.log("[invite] manifest swapped for PWA start_url:", link.href);
})();

// B. Safari (не-PWA) + invite + нет личности → лендинг-инструкция вместо
// «Создать аккаунт». Иначе юзер создаст аккаунт в Safari-контейнере, а PWA
// получит пустое хранилище и сгенерит второго юзера (баг-репорт Олега 01.09).
// v160p6 variant B: детекция браузера (Safari/Chrome/Samsung/Firefox/Edge,
// iOS/Android/десктоп) → одна правильная инструкция на экране; кнопка
// «Продолжить в браузере» осталась с честным предупреждением о двух аккаунтах.
function showInviteLanding(inviteNpub) {
    if (!identityScreen) return;
    const card = identityScreen.querySelector(".identity-card");
    if (!card || document.getElementById("invite-landing")) return;
    const ov = document.createElement("div");
    ov.id = "invite-landing";
    ov.style.cssText = "padding:4px;";
    const standalone = isStandalonePWA();
    // v160p6c: без кнопок (запрос Олега) — описание + инструкция + ссылка.
    // В standalone лендинг не нужен — чат откроется сам (start_url с invite).
    // v160z14: без invite — секцию «принять приглашение» не показываем
    // (нет ссылки), лендинг = буллеты + инструкция установки PWA + видео.
    const hasInvite = !!inviteNpub;
    const inviteUrl = location.origin + "/?invite=" + inviteNpub;
    // v160p8 (Олег 18:59 «ставь на тест»): структура лендинга v3 (одобрена) —
    // буллеты приватности с иконками + сокращённый текст + выровненная
    // инструкция. Тап-копия ссылки сохранена (invite-url-box + hint).
    ov.innerHTML =
        '<div style="text-align:center;margin-bottom:16px;">' +
        '<img src="/i192-2026b.png" alt="" style="width:72px;height:72px;border-radius:16px;box-shadow:0 8px 24px rgba(34,158,217,0.3);" onerror="this.style.display=\'none\'">' +
        '<div style="font-size:26px;font-weight:800;letter-spacing:-.5px;margin-top:10px;background:linear-gradient(90deg,#229ED9,#5eead4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;display:inline-block;">MurMur</div>' +
        '<div style="font-size:14px;color:#9fb0c3;margin-top:2px;">приватный мессенджер</div>' +
        '</div>' +
        '<div style="text-align:center;font-size:14.5px;font-weight:600;color:var(--text);margin-bottom:10px;">Почему это приватно</div>' +
        '<div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:14px;">' +
        '<div style="display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.55;color:var(--text-muted);margin-bottom:10px;"><span style="flex-shrink:0;">🔐</span><div><b style="color:var(--text);">Всё хранится на вашем устройстве</b> — сервер видит только зашифрованные сообщения</div></div>' +
        '<div style="display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.55;color:var(--text-muted);margin-bottom:10px;"><span style="flex-shrink:0;">🧹</span><div><b style="color:var(--text);">Переписка удаляется с сервера</b> после доставки</div></div>' +
        '<div style="display:flex;gap:10px;align-items:flex-start;font-size:13.5px;line-height:1.55;color:var(--text-muted);margin-bottom:10px;"><span style="flex-shrink:0;">🕶️</span><div><b style="color:var(--text);">Нам не нужно знать</b> ваши имена, телефоны и почту</div></div>' +
        '</div>' +
        '<div style="font-size:14.5px;font-weight:600;color:var(--text);margin-bottom:8px;">' + (hasInvite ? 'Чтобы принять приглашение' : 'Как установить MurMur') + '</div>' +
        (hasInvite ?
        '<div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px;color:var(--text-muted);font-size:13.5px;line-height:1.8;">' +
        '<div><b style="color:var(--text);">1)</b> MurMur уже установлен? <b style="color:var(--text);">Нажмите на ссылку</b> — она скопируется, вставьте её в приложение:</div>' +
        '<div id="invite-url-box" role="button" style="display:block;background:#0b1420;border:1px solid rgba(34,158,217,.4);background:rgba(34,158,217,.08);border-radius:8px;padding:9px 10px;margin:8px 0;font-family:monospace;font-size:11.5px;color:#7fd4f0;word-break:break-all;cursor:pointer;text-align:center;" title="Нажмите, чтобы скопировать">' + inviteUrl + '</div>' +
        '<div id="invite-copied-hint" style="display:none;color:#3fd07a;font-size:12.5px;text-align:center;margin-bottom:6px;">✓ Скопировано — вставьте в MurMur</div>' +
        '<div><b style="color:var(--text);">2)</b> Ещё не установлен? Пара шагов:</div>' +
        '<div style="margin-top:4px;"><b style="color:#5eead4;">Safari</b> (iPhone/iPad): Поделиться → На экран «Домой»</div>' +
        '<div><b style="color:#5eead4;">Chrome</b> (Android/ПК): ⋮ → Добавить на главный экран</div>' +
        '<div style="margin-top:6px;color:var(--text);">Откройте MurMur с новой иконки — аккаунт создастся сам, и чат уже будет ждать</div>' +
        '</div>'
        :
        '<div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px;color:var(--text-muted);font-size:13.5px;line-height:1.8;">' +
        '<div><b style="color:var(--text);">Safari</b> (iPhone/iPad): Поделиться → На экран «Домой»</div>' +
        '<div><b style="color:var(--text);">Chrome</b> (Android/ПК): ⋮ → Добавить на главный экран</div>' +
        '<div style="margin-top:6px;color:var(--text);">Откройте MurMur с новой иконки — аккаунт создастся сам, ничего больше не нужно</div>' +
        '</div>') +
        // v160q: видео-инструкции (Олег 16.09) — 2 карточки под секцией шагов.
        '<div style="font-size:14.5px;font-weight:600;color:var(--text);margin:14px 0 8px;">Видео-инструкция</div>' +
        '<div style="display:flex;gap:10px;">' +
        '<div role="button" class="vid-card" data-vid="safari" style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px;text-align:center;cursor:pointer;">' +
        '<div style="font-size:20px;">🍎</div><div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px;">Safari</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">iPhone / iPad</div>' +
        '</div>' +
        '<div role="button" class="vid-card" data-vid="chrome" style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px;text-align:center;cursor:pointer;">' +
        '<div style="font-size:20px;">🤖</div><div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px;">Chrome</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Android</div>' +
        '</div>' +
        '</div>' +
        // v160z15-fix2 (Олег 28.09 17:28): ссылка на Privacy Policy — на лендинге
        // её не было (скрин Олега). Открывается в той же вкладке (window.location),
        // т.к. лендинг — единственное, что видит посетитель до установки.
        '<div style="text-align:center;margin-top:14px;">' +
        '<a href="/privacy" style="font-size:12.5px;color:#5a6b80;text-decoration:none;">Privacy Policy</a>' +
        '</div>' +
        '</div>';

    // v160p6e: tap on link box → copy to clipboard (нажми → скопировалось)
    setTimeout(() => {
        const box = document.getElementById("invite-url-box");
        const hint = document.getElementById("invite-copied-hint");
        if (!box || !hint) return;
        box.addEventListener("click", async () => {
            const url = inviteUrl;
            try {
                await navigator.clipboard.writeText(url);
            } catch (e) {
                // Safari 17+/fallback: execCommand
                const ta = document.createElement("textarea");
                ta.value = url;
                ta.style.cssText = "position:fixed;opacity:0;";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); } catch (e2) {}
                ta.remove();
            }
            hint.style.display = "";
            setTimeout(() => { hint.style.display = "none"; }, 3000);
        });
    }, 0);

    // v160p6c: кнопок нет — лендинг информационный. Нажимать ничего не нужно:
    // юзер копирует ссылку → вставляет в установленное приложение (или ставит
    // PWA по инструкции). card больше не показываем — иначе форма создания
    // в браузере создаст второй аккаунт (баг-репорт Олега).
    card.style.display = "none";
    card.parentNode.insertBefore(ov, card);

    // v160q: тап на видео-карточку → модалка с <video controls> (не autoplay —
    // iOS требует жеста; controls + playsinline достаточно).
    ov.querySelectorAll(".vid-card").forEach(vc => {
        vc.addEventListener("click", () => {
            const vid = vc.getAttribute("data-vid");
            if (vid === "safari") showVideoModal("/media/instruction-safari.mp4", "/media/instruction-safari-poster.jpg");
            else if (vid === "chrome") showVideoModal("/media/instruction-chrome-android.mp4", "/media/instruction-chrome-android-poster.jpg");
        });
    });
}

// v160q: модалка видео-инструкции (одна на экран, тап по фону закрывает).
function showVideoModal(src, poster) {
    if (document.getElementById("vid-modal")) return;
    const m = document.createElement("div");
    m.id = "vid-modal";
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;";
    m.innerHTML =
        '<div style="width:100%;max-width:360px;">' +
        '<div style="display:flex;justify-content:center;margin-bottom:10px;"><button id="vid-close" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px 36px;font-size:16px;font-weight:600;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4);">← Назад</button></div>' +
        '<video src="' + src + '" poster="' + poster + '" controls playsinline style="width:100%;border-radius:12px;background:#000;"></video>' +
        '</div>';
    document.body.appendChild(m);
    const close = () => { const v = m.querySelector("video"); if (v) v.pause(); m.remove(); };
    m.querySelector("#vid-close").addEventListener("click", close);
    m.addEventListener("click", e => { if (e.target === m) close(); });
}

// v160f: модалка «код переноса» — генерация (отправитель, в мессенджере).
// ── Auto-restore last identity on load ──
async function tryAutoRestore() {
    const savedNpub = localStorage.getItem(LS_NPUB);
    const savedKey = localStorage.getItem(LS_KEY);
    if (!savedNpub || !savedKey) {
        console.log("auto-restore: nothing saved");
        // v160f: invite в Safari (не-PWA) без личности → лендинг-инструкция,
        // чтобы аккаунт не создался в Safari-контейнере впустую.
        // v160i: invite ищем и в URL, и в cookie-мосте (Safari→PWA).
        const inv = extractInviteNpub() || readInviteCookie();
        // v160z14 (Олег 23:35): лендинг-инструкция показываем и без invite —
        // новый пользователь на murmur.senswifi.ru тоже должен видеть инструкцию
        // установки PWA (иначе аккаунт создастся в Safari-контейнере впустую).
        if (!isStandalonePWA()) showInviteLanding(inv);
        // v160w5e1 (Олег 28.09 21:49): секция «Создать» скрыта в HTML по
        // умолчанию (hidden) — показываем ТОЛЬКО когда аккаунта нет (сюда).
        // Пока PWA грузится с существующим аккаунтом — кнопки «Создать» не видно.
        const createSection = document.getElementById("identity-create-section");
        if (createSection) createSection.hidden = false;
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

// v160y22push2: enterMessenger handles push via _schedulePushRetry after
// identity restore. No duplicate auto-subscribe here — it raced before myNpub.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", async () => {
        await requestNotificationPermission();
        requestPersistentStorage(); // v160w6m: не ждем — параллельно
        warmOutboxCache();
        wireReplyBarControls(); // v160r: reply-bar controls wiring
        wireBubbleTap();        // v160r: тап на bubble → reply (текст)
        wireLongPressReply();   // v160y27: долгое нажатие → reply (фото/видео/текст)
        try { const bg = document.getElementById("btn-new-group"); if (bg) bg.addEventListener("click", openCreateGroupModal); } catch (e) {}
        tryAutoRestore();
    });
} else {
    requestNotificationPermission();
    requestPersistentStorage(); // v160w6m: не ждем — параллельно
    warmOutboxCache();
    wireReplyBarControls(); // v160r
    wireBubbleTap();        // v160r
    wireLongPressReply();   // v160y27: long-press → reply
    try { const bg = document.getElementById("btn-new-group"); if (bg) bg.addEventListener("click", openCreateGroupModal); } catch (e) {}
    tryAutoRestore();
}

// v160w6m (Олег 07.10.2026): requestPersistentStorage — просим у браузера
// persistent-storage сразу после входа в мессенджер. Без persist() данные
// (IDB: переписка, outbox-plaintext'ы исходящих) живут в «best-effort» режиме
// и МОГУТ быть эвицированы браузером под давлением квоты — особенно агрессивен
// iOS Safari/WebKit. Симптомы, которые это чинит: пропавшие сообщения после
// reload («кэш эвицирован, сервер уже отдал 5-min TTL») и
// «[исходящее сообщение»]-placeholder (outbox-запись вылетела).
// persist() НЕ меняет приватность: данные остаются только на устройстве,
// меняется лишь политика eviction. Логируем estimate() для диагностики.
async function requestPersistentStorage() {
    try {
        if (!navigator.storage) return;
        if (navigator.storage.persist) {
            const already = await navigator.storage.persisted();
            if (!already) {
                const ok = await navigator.storage.persist();
                console.log("[murmur] storage.persist() →", ok, already ? "(was already persisted)" : "");
            } else {
                console.log("[murmur] storage: already persisted");
            }
        }
        if (navigator.storage.estimate) {
            const est = await navigator.storage.estimate();
            console.log("[murmur] storage estimate: usage=", est.usage, "quota=", est.quota);
        }
    } catch (e) {
        console.warn("[murmur] requestPersistentStorage failed:", e);
    }
}

async function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    try {
        if (Notification.permission === "default") {
            console.log("[murmur] requesting notification permission");
            await Notification.requestPermission();
        }
    } catch (e) { console.warn("[murmur] permission request failed", e); }
}

// v160x6: viewport-diag overlay — 7 тапов по имени чата в шапке (или ?diag=1).
// Слепые итерации x2–x5 закончились: смотрим РЕАЛЬНЫЕ высоты на устройстве.
(function () {
    const build = () => {
        const box = document.createElement("div");
        box.id = "vp-diag";
        box.style.cssText = "position:fixed;left:4px;top:96px;z-index:99999;background:rgba(0,0,0,.8);color:#4f4;font:10px/1.4 monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;max-width:82vw;";
        document.body.appendChild(box);
        const f = (v) => (v == null || isNaN(v) ? "-" : Math.round(v));
        const tick = () => {
            try {
                const vv = window.visualViewport;
                const r = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect() : null; };
                const rms = r(".messenger"), ria = r("#input-area"), rcv = r("#chat-view"), rb = document.body.getBoundingClientRect(), rd = document.documentElement.getBoundingClientRect();
                const cs = getComputedStyle(document.documentElement);
                box.textContent =
                    "APP=v160g4-kbd13\n" +
                    "kbClass=" + document.body.classList.contains("keyboard-visible") + "\n" +
                    "kb=" + (document.documentElement.style.getPropertyValue("--kb-inset") || "-").trim() + " composerH=" + (document.documentElement.style.getPropertyValue("--composer-h") || "-").trim() + "\n" +
                    "innerH=" + f(innerHeight) + " cliH=" + f(document.documentElement.clientHeight) + "\n" +
                    "vvH=" + (vv ? f(vv.height) : "none") + " vvTop=" + (vv ? f(vv.offsetTop) : "-") + " sc=" + (vv ? vv.scale.toFixed(2) : "-") + "\n" +
                    "bodyH=" + f(rb.height) + " bodyTop=" + f(rb.top) + " docH=" + f(rd.height) + " docTop=" + f(rd.top) + "\n" +
                    "--vvh=" + (cs.getPropertyValue("--vvh") || "").trim() + " safeB=" + (cs.getPropertyValue("--safe-bottom") || "").trim() + "\n" +
                    "msBot=" + f(rms && rms.bottom) + " msH=" + f(rms && rms.height) + " cvBot=" + f(rcv && rcv.bottom) + "\n" +
                    "iaBot=" + f(ria && ria.bottom) + " iaPadB=" + (document.querySelector("#input-area") ? getComputedStyle(document.querySelector("#input-area")).paddingBottom : "-") + "\n" +
                    "scrollY=" + f(scrollY);
            } catch (e) { /* ignore */ }
        };
        setInterval(tick, 500);
        window.addEventListener("resize", tick);
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", tick);
            window.visualViewport.addEventListener("scroll", tick);
        }
        tick();
    };
    try {
        if (location.search.indexOf("diag=1") >= 0 || location.hash.indexOf("diag") >= 0) {
            try { localStorage.setItem("murmur_diag", "1"); } catch (e) {}
        }
        // v160x7b: триггер = долгое нажатие 1.2с на ЛЮБОМ месте шапки чата
        // (центр — это имя flex:1, другого пустого места нет). Клик
        // (переименование) подавляется, если long-press сработал.
        // Повторное удержание выключает. contextmenu глушим (iOS long-press).
        window.__buildVpDiag = build;
        // v160z15-fix1 (Олег 28.09 17:28): diag-HUD торчал на лендинге в обычном
        // браузере — localStorage murmur_diag=1 остался с отладок и строил overlay
        // на ЛЮБОЙ странице, включая invite-landing (скрин Олега: лог над буллетами).
        // Фикс: HUD — только в standalone-PWA (там и дебажим), в браузере не строим.
        if (localStorage.getItem("murmur_diag") === "1") build(); // call33: и в браузере (Android Chrome diag)
        let lpTimer = null, lpFired = false, sx = 0, sy = 0;
        document.addEventListener("contextmenu", (e) => {
            const h = document.querySelector("#chat-view .chat-header");
            if (h && h.contains(e.target)) e.preventDefault();
        }, true);
        document.addEventListener("pointerdown", (e) => {
            const h = document.querySelector("#chat-view .chat-header");
            if (!h || !h.contains(e.target) || e.target.closest("button")) return;
            lpFired = false; sx = e.clientX; sy = e.clientY;
            lpTimer = setTimeout(() => {
                lpTimer = null; lpFired = true;
                const on = (localStorage.getItem("murmur_diag") !== "1");
                try { localStorage.setItem("murmur_diag", on ? "1" : "0"); } catch (err) {}
                const ex = document.getElementById("vp-diag");
                if (ex) ex.remove();
                if (on) build();
            }, 1200);
        }, true);
        const cancel = (e) => {
            if (lpTimer && e && e.type === "pointermove" && Math.abs(e.clientX - sx) < 10 && Math.abs(e.clientY - sy) < 10) return;
            if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
        };
        ["pointerup", "pointercancel", "pointermove"].forEach(t => document.addEventListener(t, cancel, true));
        document.addEventListener("click", (e) => {
            if (!lpFired) return;
            const h = document.querySelector("#chat-view .chat-header");
            if (h && h.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
            lpFired = false;
        }, true);
    } catch (e) { /* ignore */ }
})();

// v160w6j: prevent vertical gestures that begin in the composer from
// scrolling the chat or iOS page. Delegated because #input-area is rebuilt.
(function installComposerScrollGuard() {
    let composerTouch = null;
    document.addEventListener("touchstart", (e) => {
        const el = e.target && e.target.closest ? e.target.closest("#input-area") : null;
        const t = e.touches && e.touches[0];
        composerTouch = el && t ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true, capture: true });
    document.addEventListener("touchmove", (e) => {
        if (!composerTouch) return;
        const t = e.touches && e.touches[0];
        if (!t) return;
        const dy = t.clientY - composerTouch.y;
        const dx = t.clientX - composerTouch.x;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 2 && e.cancelable) e.preventDefault();
    }, { passive: false, capture: true });
    ["touchend", "touchcancel"].forEach(type =>
        document.addEventListener(type, () => { composerTouch = null; }, { passive: true, capture: true }));
})();

// Повторный заход по ссылке в уже открытом приложении (PWA живёт в фоне).
window.addEventListener("hashchange", () => {
    if (messenger && messenger.classList.contains("active")) handleInviteHash();
});

// v160x2 (Олег 2026-09-20): iOS standalone — после закрытия клавиатуры
// visual viewport может остаться поднятым/сдвинутым → «пустота снизу»,
// которая переживает перезапуск (WebKeviceKit не возвращает fixed-body сам).
// Страховка: пока не печатаем — держим окно в (0,0) при каждом resize/scroll
// visual viewport. Пока фокус в инпуте — НЕ трогаем (иначе уроним input над
// клавиатурой).
(function () {
    const vv = window.visualViewport;
    if (!vv) return;
    let typing = false;
    const isInput = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    // call33f: Android (resizes-content) — клавиатура УЖИМАЕТ layout, класс keyboard-visible
    // (прятание шапки) на Android не нужен и вреден: vv.height==clientHeight ломает эвристику,
    // слепые add при typing залипают после закрытия (лог 20:39: kbC=true при закрытой КВ).
    const IS_ANDROID = /Android/.test(navigator.userAgent);
    try { if (IS_ANDROID) document.documentElement.classList.add("android"); } catch (e) {}
    const reset = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); };
    // v160x4: --vvh = реальная видимая высота (вкл. safe-зону). На iOS standalone
    // 100dvh ИСКЛЮЧАЕТ нижний safe-inset → .messenger не доходит до физического
    // низа (светлая полоса body под input-area). Бонус: при клавиатуре vv.height
    // сжимается → мессенджер сжимается → инпут всегда над клавиатурой.
    // v160x5: НЕ typing → высота ICB = document.body.getBoundingClientRect().height
    // (fixed body = ровно layout viewport; в standalone он ВКЛЮЧАЕТ зону под
    // home-indicator, в отличие от 100dvh и visualViewport.height, которые на
    // iOS standalone её исключают — потому v160x4 не сдвинул пиллюлю).
    // typing → vv.height (клавиатура сжала visual viewport) → инпут над ней.
    // v160x9 (Олег 22:35, скрин «всё ещё дыра»): в gap-состоянии iOS после
    // цикла клавиатуры держит layout viewport СЖАТЫМ (body≈744), но visual
    // viewport честен (vv.height+offset=844). Брать только body (v160x5) —
    // залипало 744 → тёмная полоса фона под input. Решение: НЕ-typing высота
    // = MAX(vv.height+vv.offsetTop, body, innerHeight) — врёт один источник,
    // другие вытягивают. typing → vv.height (клавиатура) как было.
    // v160w5j (Олег 29.09 09:04, видео IMG_5100 покадрово 20fps): w5i
    // (transition: height на .messenger) НЕ сработал на iOS — WebKit НЕ
    // анимирует height, когда значение приходит через custom property (--vvh),
    // transition от переменной физически не запускается.
    // v160w5m (Олег 29.09 10:21 «Делай» — упрощение по Telegram Web A,
    // windowSize.ts): w5j-анимация rAF УБРАНА. Причины: (1) ретаргет на
    // мусорных промежуточных значениях при коллапсе давал тряску/мигание
    // (Олег 10:05); (2) Telegram НЕ анимирует --vh вообще — мгновенная
    // установка, троттлинг 250мс. Плавность даёт троттлинг: iOS шлёт resize
    // серией, каждое значение честное, между ними 250мс пауза = без ретаргетов.
    const setVvhProperty = (targetPx) => {
        try {
            document.documentElement.style.setProperty("--vvh", Math.round(targetPx) + "px");
        } catch (e) {}
    };
    // v160g4-kbd11 (лог Олега 12:34): сворачивание = анимация 250мс ease-out,
    // СИНХРОННО со слайдом клавиатуры iOS (~250мс). Мгновенное расширение
    // (kbd10) обгоняло клавиатуру: композер уходил за ещё видимую клавиатуру.
    // 250мс ease-out = композер едет с верхним краем клавиатуры (монолит).
    // Открытие (typing) мгновенное с kbd9 - не тронуто. Повторный вызов с той
    // же целью не перезапускает анимацию (без заиканий от серии resize).
    const animateVvh = (targetPx) => {
        try {
            const to = Math.round(targetPx);
            if (collapseAnim) {
                if (collapseAnim.to === to) return; // уже едем туда
                cancelAnimationFrame(collapseAnim.raf); collapseAnim = null;
            }
            const el = document.documentElement;
            const cur = parseFloat(getComputedStyle(el).getPropertyValue("--vvh")) || to;
            const from = cur, dist = Math.abs(to - from);
            if (dist < 2) { setVvhProperty(to); return; }
            const t0 = performance.now(), dur = 250;
            const tick = (now) => {
                if (!collapseAnim) return;
                const k = Math.min(1, (now - t0) / dur);
                const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
                setVvhProperty(Math.round(from + (to - from) * e));
                // v160g4-kbd12: лента едет С композером - прижата к низу на
                // каждом кадре (scrollTop=новый максимум). Без этого iOS
                // держит scrollTop и между лентой и композером возникает
                // видимый сдвиг («скачок под строку ввода»). Гейт: юзер был
                // у низа; читающего историю не дёргаем.
                try {
                    if (window.__murmurWasAtBottom) {
                        var ma = document.querySelector(".messages-area");
                        if (ma) ma.scrollTop = ma.scrollHeight;
                    }
                } catch (pinErr) {}
                try { if (window.__murmurKbSnap) window.__murmurKbSnap("coll" + Math.round(k * 100)); } catch (lgErr) {}
                if (k < 1) collapseAnim.raf = requestAnimationFrame(tick);
                else {
                    collapseAnim = null; setVvhProperty(to);
                    // v160g4-kbd13: Paint-Cure im Finale - Layout stimmt framegenau,
                    // aber der Compositor liefert den Feed einen Frame versetzt
                    // (PAINT-Defekt, Log 12:47). Reflow+Layer-Nudge erzwingt den
                    // sauberen Final-Frame, Pin sichert die Endposition.
                    try {
                        if (window.__murmurWasAtBottom) {
                            var ma2 = document.querySelector(".messages-area");
                            if (ma2) ma2.scrollTop = ma2.scrollHeight;
                        }
                    } catch (pinErr2) {}
                    try {
                        if (window.__murmurNudgeComposer) window.__murmurNudgeComposer();
                        if (window.__murmurForceReflow) window.__murmurForceReflow();
                    } catch (cureErr) {}
                }
            };
            collapseAnim = { raf: requestAnimationFrame(tick), from, to };
        } catch (e) { try { setVvhProperty(targetPx); } catch (e2) {} }
    };
    // v160w5k (Олег 29.09 10:05, «после очередного нажатия галочки клавиатура
    // уходит и вместе с ней уходит и строка ввода + тряска и мигание»):
    // при коллапсе vv/pageTop возвращают ПРОМЕЖУТОЧНЫЕ/мусорные значения,
    // vvFull может стать БОЛЬШЕ экрана → .messenger выше физического низа →
    // композер уходит за экран вместе с клавиатурой. Сразу после focusout
    // (500мс) целиком доверяем ТОЛЬКО window.innerHeight (урок v160y59:
    // он не врёт в gap-состоянии) — vvFull/bodyH игнорируем.
    let collapseLockUntil = 0;
    // v160g4-kbd6: интерполяция collapse (порт w6m6/m7, классика-совместима).
    // focusout: vv врёт 844 при ещё видимой клавиатуре; мгновенный прыжок --vvh
    // = лента уходит под KB и выпрыгивает после. rAF ease-in-out 360мс.
    let collapseAnim = null;
    const setVvh = () => {
        try {
            if (vv.scale && Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoom — не трогаем
            // v160x17 (research: Telegram windowSize.ts): на iOS vv.height НЕ включает
            // pageTop — высота на mobile должна быть vv.height + vv.pageTop.
            // v160w6c: vvFull больше не участвует в высоте страницы (см. ниже,
            // формула Олега) — остался для диагностики/логов.
            const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
            const vvFull = isIOS
                ? (vv.height || 0) + (vv.pageTop || 0)
                : (vv.height || 0) + (vv.offsetTop || 0);
            let h;
            if (typing) {
                h = vv.height;
            } else if (Date.now() < collapseLockUntil) {
                // v160w5k: во время коллапса (500мс после focusout) vv.height+pageTop
                // врут (промежуточные высоты, stale pageTop) — только честный
                // innerHeight. animateVvh делает это скольжением, а не скачком.
                if (!collapseAnim) h = Math.max(window.innerHeight || 0, 0);
                else h = collapseAnim.to; // kbd6: не ретаргетить в окне коллапса
            } else {
                // v160w6c (Олег 30.09 09:33, формула Олега): высота страницы =
                // высота видимой области + высота клавиатуры. Клавиатура ушла →
                // visible=innerHeight, kb=0 → страница = innerHeight РОВНО.
                // iOS НЕ сжимает layout (клавиатура ПЕРЕКРЫВАЕТ) — innerHeight
                // честен всегда. Прежний MAX(innerHeight, vvFull, bodyH) брал
                // раздутый лечением bodyH (932 вместо 852) → страница длиннее
                // экрана → область внизу, о которую спотыкаемся (симуляция
                // real-ios-cycle-sim: 2/6 циклов, --vvh=933 залип, scrollY=80).
                // Больше НЕ вычисляем «максимум из того, что видит».
                h = Math.max(window.innerHeight || 0, 0);
            }
            // v160w5l (Олег 29.09 10:19, «на ~5-й раз сворачивания строка
            // уезжает под экран»): stale pageTop при коллапсе даёт vvFull
            // БОЛЬШЕ физической высоты (панувший viewport) → .messenger выше
            // экрана → композер (в потоке) уходит за низ вместе с клавиатурой.
            // Клэмп: при scrollY=0 (fixed-body не скроллит) --vvh физически
            // НЕ может быть больше window.innerHeight.
            const phys = window.innerHeight || 0;
            if (phys && !window.scrollY && h > phys) h = phys;
            // call30e: после fs-звонка iOS держит innerHeight РАЗДУТЫМ до
            // screenH (912) при честной видимой высоте docClientH (844).
            // Лог call30d: --vvh=912, композер bottom=912 при 844 видимых —
            // строка ввода уезжает на 68px (safe-top) под экран. Клэмп:
            // при scrollY=0 физический потолок = clientHeight документа.
            try {
                const docH = document.documentElement.clientHeight || 0;
                if (docH && !window.scrollY && h > docH) h = docH;
            } catch (dErr) {}
            if (h && h > 100) {
                // v160g4-kbd9: асимметрия открытие/сворачивание (лог Олега 12:18).
                // ОТКРЫТИЕ (typing): мгновенно - низ закрыт клавиатурой, скачок
                // невидим, композер сразу в финальной позиции (без всплытия).
                // СВОРАЧИВАНИЕ: интерполяция 360мс (vv врёт, лечит провал ленты).
                if (typing) setVvhProperty(Math.round(h));
                else animateVvh(Math.round(h));
            }
            // v160x11: keyboard inset для fixed-композера. .input-area якорится
            // к физическому низу: bottom: var(--kb-inset). Клавиатура ↑ →
            // inset = innerHeight - vv.height → инпут над клавиатурой.
            // Клавиатура ↓ → inset = 0 → инпут в самом краю (НЕ зависит
            // от залипшего --vvh / layout viewport desync — iOS надёжно
            // позиционирует fixed bottom:0 композитором).
            // v160g4-kbd13: iOS staucht innerHeight EINEN Frame auf Tastaturhoehe
            // -> kb=0 statt 347, kb-inset bleibt bei 0 haengen (Composer unterm
            // Feld). Letzte ehrliche Hoehe (>=300px) statt des gestoerten Frames.
            try {
                const inh = window.innerHeight || 0;
                if (inh >= 300) window.__murmurLastGoodInH = inh;
            } catch (lgiErr) {}
            const kb = typing
                ? Math.max(0, (window.__murmurLastGoodInH || window.innerHeight || 0) - (vv.height || 0))
                : 0;
            document.documentElement.style.setProperty("--kb-inset", Math.round(kb) + "px");
        } catch (e) { /* ignore */ }
    };
    // v160x8 (Олег 21:00, diag-скрин): vvH=497/msBot=497 — сжатие верное, но
    // iOS ПАНУЕТ layout viewport вверх на высоту клавиатуры (fixed-body
    // уезжает, scrollY≈347) → инпут у верха экрана. Наше сжатие делает пан
    // не нужным → сбрасываем scroll ВСЕГДА, вкл. печать: по scroll-событию
    // (моментальный контр-пан) + серия догонов после focusin (анимация
    // клавиатуры ~300мс). + pin списка сообщений к низу при сжатии.
    // v160x11: с fixed-композером messenger обязан резервировать место под
    // ним, иначе список уезжает под инпут. Высота композера динамическая
    // (attachments-preview, reply-bar) — меряем РЕАЛЬНЫЙ rect и ставим
    // CSS-переменную --composer-h.
    const syncComposerSpace = () => {
        const ia = document.getElementById("input-area");
        if (!ia || ia.hidden) return;
        const hgt = ia.getBoundingClientRect().height + (parseFloat(getComputedStyle(ia).bottom) || 0);
        if (hgt > 40) document.documentElement.style.setProperty("--composer-h", Math.round(hgt) + "px");
    };
    const ro = new MutationObserver(syncComposerSpace);
    try { ro.observe(document.getElementById("input-area"), { attributes: true, childList: true, subtree: true }); } catch (e) {}
    window.addEventListener("resize", syncComposerSpace);
    if (vv) vv.addEventListener("resize", syncComposerSpace);
    setInterval(syncComposerSpace, 1000); // дешёвый догон — композер маленький
    const pinBottom = () => {
        const ma = document.querySelector(".messages-area");
        if (!ma) return;
        if (ma.scrollHeight - ma.scrollTop - ma.clientHeight < 80) ma.scrollTop = ma.scrollHeight;
    };
    // kb-oob(f): reset заглушён на collapse (window.__murmurQuiet) — нативный
    // контр-пан/scroll-restore iOS проходит без нашего вмешательства. Это
    // УБИРАЕТ контр-скролл против restore = главный источник дёрганья на
    // реальном устройстве (в сим no-op — сим этот механизм НЕ видит).
    const onVv = () => {
        setVvh();
        // Keep the keyboard class authoritative during the opening animation;
        // deriving it from an intermediate vv.height is one frame too late and
        // is what lets the composer lag behind the keyboard.
        if (typing && !IS_ANDROID) document.body.classList.add("keyboard-visible"); // call33f
        if (!window.__murmurQuiet) reset();
        requestAnimationFrame(pinBottom);
        // v160g4-kbd8: при открытой клавиатуре лента прижата к низу МГНОВЕННО
        // (монолит). Лог 12:14: iOS сам двигает страницу (scY 347<->0) и
        // msB прыгает 447<->794 - мгновенный пин на каждое vv-событие убирает
        // видимую борьбу. Гейт wasAtBottom: чтение истории не хайджекаем.
        if (typing) requestAnimationFrame(() => {
            try {
                if (!window.__murmurWasAtBottom) return;
                const ma = document.querySelector(".messages-area");
                const d = ma.scrollHeight - ma.scrollTop - ma.clientHeight;
                if (d > 80) ma.scrollTop = ma.scrollHeight;
            } catch (e) {}
        });
    };
    // v160w5m (Telegram Web A windowSize.ts: WINDOW_RESIZE_THROTTLE_MS = 250):
    // vv resize с троттлингом — iOS шлёт resize серией во время анимации
    // клавиатуры, без троттлинга каждый вызов = потенциальный ретаргет/рывок.
    // v160w6c3 (Олег 30.09 11:05: «пару раз получилось почти без задержки»):
    // троттлинг 250мс = до 250мс лишней задержки на пересчёт --vvh после
    // коллапса. Снижен 250 → 80мс: iOS-анимация ~250-300мс оседает ступенями
    // (симуляция: 6 ступеней по 50мс), при 80мс пересчёт ловит каждую ступень
    // — «почти без задержки» становится нормой. Первое событие прогоняем
    // сразу (leading edge), остальные раз в 80мс.
    let vvResizeLast = 0;
    const onVvThrottled = () => {
        // v160w6c5 (Олег 30.09 11:24: «а если убрать пересчёт высоты?»):
        // при закрытии (typing=false) пересчёт даёт РОВНО innerHeight (формула
        // w6c) — значение ОДИНАКОВОЕ на каждом событии, троттлинг там только
        // лишняя задержка (до 80мс). Прогоняем КАЖДОЕ vv-событие СРАЗУ (0мс).
        // Полностью убирать пересчёт НЕЛЬЗЯ: при открытии (typing=true) он
        // поднимает инпут над клавиатурой (сжатие = vv.height) — там ретаргет
        // возможен, троттлинг 80мс остаётся только для typing.
        if (!typing) { onVv(); return; }
        const now = Date.now();
        if (now - vvResizeLast >= 80) { vvResizeLast = now; onVv(); }
        else { vvResizeLast = Math.max(vvResizeLast, now - 80 + 1); setTimeout(onVv, 80 - (now - vvResizeLast)); }
    };
    // v160x11: scroll-to-settle (research-подтверждённый Fix B). При закрытии
    // клавиатуры iOS может залипнуть layout viewport — renders 781 при
    // честных 844. Крошечный scroll (0,1)→(0,0) заставляет композитор
    // синхронно перерисовать и защёлкнуть layout на место.
    const settle = () => {
        if (window.scrollY || window.scrollX) return; // уже скроллим — не мешаем
        try { window.scrollTo(0, 1); setTimeout(() => { try { window.scrollTo(0, 0); } catch (e) {} }, 10); } catch (e) {}
    };
    // v160x18 (WebKit bug 254861, «scroll somewhere slightly fixes it»):
    // scroll ЛЕЧИТ stale-вьюпорт, но ТОЛЬКО если документ реально скроллится.
    // settle() скроллил 1px на нескроллируемом документе = no-op. Теперь:
    // удлиняем body на 80px → документ скроллится → РЕАЛЬНЫЙ scroll вниз/наверх
    // (WebKit обновляет visualViewport на scroll) → возвращаемся → restore.
    // v160z8 (Олег 27.09 09:02 «стало лучше, но появилась пустая область под
    // строкой ввода»): 8px НЕ лечит дыру (две точки данных: 80px — лечит+дёргает,
    // 8px — не дёргает+дыра вернулась). Скролл должен пройти через ВСЮ сталую
    // зону (~60-80px) — амплитуда 80 возвращена. Дёрганье лечим ЧИСЛОМ вызовов:
    // первый — immediate (0ms, экран переходный, прыжок незаметен), догон-серия
    // сокращена 4→2 в openChat (v160z8).
    const scrollCure = () => {
        try {
            if (window.scrollY || window.scrollX) return;
            const b = document.body;
            if (!b) return;
            const prev = b.style.height;
            b.style.height = (b.offsetHeight + 80) + "px";
            void b.offsetHeight;
            window.scrollTo(0, 80);
            requestAnimationFrame(() => {
                window.scrollTo(0, 0);
                requestAnimationFrame(() => { b.style.height = prev; });
            });
        } catch (e) {}
    };
    // v160x18 (ik, репортер бага 254861): vv resize listener НЕ стреляет больше
    // одного раза — перерегистрируем на каждый focus инпута.
    const refreshVvListener = () => {
        try {
            if (!vv || !vv.removeEventListener || !vv.addEventListener) return;
            vv.removeEventListener("resize", onVvThrottled);
            vv.addEventListener("resize", onVvThrottled);
        } catch (e) {}
    };
    // v160x13 (Олег 10:04, скрин с diag: kb=0px, iaBot=844, но композер
    // ПИКсЕЛЬНО на 783): поллинг не помог — inset честный 0, а композитор
    // iOS КЛЕМПИТ fixed-элементы к visual-низу 783 и НЕ перерисовывает
    // зону 783..844 (сталая клавиатурная зона). Работающий обход (по опыту
    // iOS-тредов): принудительный reflow всего документа — кратко меняем
    // высоту body (844 → +1px → 844), это инвалидирует композиторный слой
    // и заставляет iOS перерисовать ВСЁ, вкл. сталую зону.
    const forceReflow = () => {
        try {
            const b = document.body;
            if (!b) return;
            const prev = b.style.height;
            b.style.height = "calc(100% + 1px)";
            void b.offsetHeight; // force style+layout
            requestAnimationFrame(() => { b.style.height = prev; });
        } catch (e) {}
    };
    // v160x14 (Олег 10:10, «на iPhone — дыра, на маке — отлично»): ректы ВСЕ
    // врут (gBCR=844), но композитор красит страницу в 783px-поверхность.
    // ДЕТЕКТОР через elementFromPoint: проба в физическом низу экрана.
    // Если там bg/html вместо композера → баг активен → forceReflow.
    // Это единственный сигнал, которому JS может верить: PAINT, не layout.
    const gapDetector = () => {
        try {
            const ia = document.getElementById("input-area");
            if (!ia || ia.hidden) return false;
            const y = Math.round((window.innerHeight || 844) - 5);
            const el = document.elementFromPoint(Math.round((window.innerWidth || 390) / 2), y);
            if (!el) return false;
            // композер или его ребёнок в самом низу = ОК
            if (el === ia || ia.contains(el)) return false;
            // bg/html/другое = дыра активна
            return true;
        } catch (e) { return false; }
    };
    window.__murmurGapDetector = gapDetector; // v160y34: экспорт для openChat
    let gapFixTimer = null;
    // watchdog: если дыра активна, дёргает И reflow, И слой композера.
    const gapWatchdog = () => {
        // v160w5r (Олег 29.09 13:18 «Делай» после отката w5p/w5q, доки проекта:
        // v160x18/x19 scrollCure-лекарство подтверждено, но оно перезапускает
        // композер, НЕ растит .messenger — при срезанном --vvh композер остаётся
        // в дыре; урок w5q: rAF-анимация + lastFullViewportH = «ещё больше
        // дёрганий»). ОДНА правка: после оседания iOS (таймеры 450+мс) если
        // --vvh срезан ниже реального экрана — МГНОВЕННАЯ установка
        // --vvh = window.innerHeight (честный после оседания, урок v160y59)
        // + scrollCure. Без анимации (дёргания w5q), само-повтор 300мс макс 5.
        // v160w5t (Олег 29.09 14:50 diag-скрин в дыре на v160w5s: ВСЕ метрики
        // ЧЕСТНЫЕ — innerH=844, vvH=844, --vvh=844, iaBot=844, msBot=844 при
        // ВИДИМОЙ дыре = точь-в-точь урок v160y61: layout НЕ врёт, PAINT устар.
        // Поэтому w5r/w5s молчали: --vvh и так честный. Лекарство = БЕЗ гейта
        // (урок v160y61: gapDetector = LAYOUT-проба, при композере в потоке
        // находит композер ВСЕГДА даже при дыре → гейт мёртвый код → watchdog
        // не звал лекарство никогда). Височностный чек w5r/s убран, вместо
        // гейта — безусловный набор как у тапа в поле: forceReflow (реальный
        // reflow = репейнт сталой зоны), nudge слоя композера, scrollCure.
        // Само-повтор 300мс макс 5 (счётчик gapFixTimer) — прежний.
        // v160w5u (Олег 29.09 15:00, diag-скрин w5t в дыре: --vvh=912=innerH,
        // iaBot=912 — дыра ЗАКРЫВАЕТСЯ, но рывками: «поле рывками опускается
        // вниз экрана»). Cure-набор стреляет 5 раз (само-повтор 300мс×5), каждый
        // scrollCure (реальный скролл 0→80→0) дёргает композер на шаг = видимые
        // рывки. Фикс: scrollCure ТОЛЬКО на ПЕРВОМ вызове watchdog (один скролл
        // = один репейнт), повторы — только forceReflow+nudge (безвизуальные).
        forceReflow();
        nudgeComposerLayer();
        // Диагностика 02.10: scrollCure давал видимые скачки scrollY 0→80→0
        // на каждом закрытии клавиатуры. Оставляем безусловный reflow+nudge,
        // но не запускаем искусственный scroll в автоматическом watchdog.
        // scrollCure остаётся экспортированным для ручной диагностики.
        // v160w5v (Олег 29.09 15:22 «делай», видео IMG_5108: 2-й цикл клавиатуры —
        // дыра y=1125 стоит до конца видео, scrollCure 1-го захода НЕ лечит:
        // layout уже в стабильном stale-состоянии, скролл физически не проходит.
        // В проверенном v160x18 лечение было СЕРИЕЙ 80/300/600 — возвращаем
        // 2-й заход через 150мс: первый скролл расширяет body, второй проходит
        // через всю stale-зону. Прыжок незаметен (оба после оседания клавиатуры).
        // Второй автоматический scrollCure также отключён: он был вторым
        // скачком 0→80→0 в присланном KB-логе.
        // повтор через 300мс — если iOS снова срезал, дёргаем ещё раз (макс 5 попыток)
        const n = (parseInt(gapFixTimer || "0", 10) || 0) + 1;
        gapFixTimer = null;
        if (n < 5) { setTimeout(gapWatchdog, 300); gapFixTimer = String(n); }
    };
    // v160x16 (Олег 10:20, скрин v160x15: пиксели ТЕ ЖЕ — композер красится на
    // промежуточной фазе закрытия клавиатуры, vv.height≈783, и НЕ перерисовывается.
    // forceReflow body не помог — слой композера не трогался). Фикс: дёргаем
    // КОМПОЗИЦИОННЫЙ СЛОЙ самого композера: transform translateZ(0) toggle —
    // promote/demote заставляет iOS пересчитать позицию fixed-элемента.
    const nudgeComposerLayer = () => {
        try {
            const ia = document.getElementById("input-area");
            if (!ia || ia.hidden) return;
            ia.style.transform = "translateZ(0)";
            void ia.offsetHeight;
            requestAnimationFrame(() => { ia.style.transform = ""; });
        } catch (e) {}
    };
    document.addEventListener("focusout", (e) => {
        if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) {
            // v160w5k: блокируем vv-источники на время коллапса (500мс) —
            // иначе vvFull с stale pageTop уводит .messenger за экран.
            typing = false;
            collapseLockUntil = Date.now() + 500;
            // kb-oob(f): 600мс тишины для reset() — покрывает анимацию закрытия
            // (~250-300мс) + запас. Нативный scroll-restore iOS проходит без
            // контр-скролла. gapWatchdog [450,900,1500] остаётся страховкой.
            window.__murmurQuiet = true;
            setTimeout(() => { window.__murmurQuiet = false; }, 600);
            animateVvh(Math.round(window.innerHeight || 0));
            // v160x12: Поллинг оставлен (дотягивает --kb-inset/--vvh при оседании,
            // идемпотентен, без визуального эффекта).
            [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000].forEach(t => setTimeout(() => { setVvh(); syncComposerSpace(); }, t));
            // v160w6c6 (avito-deep-dive2 12:20, Олег 12:28 «Делай»): МЕХАНИЗМ AVITO =
            // ОТСУТСТВИЕ МЕХАНИЗМА — живой m.avito.ru: input position:absolute,
            // transform:none, transition:0s; reference-симуляция (3 цикла, реальная
            // iOS-модель): layout не мутирует НИ РАЗУ, композер 806/844 на всех
            // ступенях, закрытие = нативный scroll-restore iOS. Рывки w6c5 = ~30
            // таймеров в 1-м кадре (~10 реальных скроллов/мутаций; scrollCure 0/150
            // ВНУТРИ анимации закрытия) + двойной focusout. Фикс: 1-й кадр ОЧИЩЕН —
            // остаются ТОЛЬКО формула высоты (animateVvh, без визуального эффекта)
            // и scrollBottom (якорь ленты, как у Telegram). scrollCure/forceReflow/
            // nudge/settle из первого кадра УБРАНЫ — лечение в ЕДИНСТВЕННОМ
            // gapWatchdog после оседания (no-op на здоровом вьюпорте).
            [450, 900, 1500].forEach(t => setTimeout(gapWatchdog, t));
            // v160w5n (Олег 29.09 11:02: «с 3-го сворачивания над строкой НЕ конец
            // ленты, а немного предыдущее сообщение, приходится руками мотать»):
            // при закрытии клавиатуры высота ленты РАСТЁТ (клавиатура уходит),
            // а scrollTop остаётся — юзер видит предпоследние. Догоняем к низу
            // с поллингом после оседания (аналог focusin-поллинга scrollBottomKb).
            const scrollBottomUnfocus = () => {
                try {
                    const ma = document.querySelector(".messages-area");
                    if (!ma) return;
                    ma.scrollTop = ma.scrollHeight;
                } catch (err) {}
            };
            // v160w5o (Олег 29.09 11:26, видео IMG_5102: «подтягивание не должно
            // быть видно пользователю»): покадровый разбор показал — при коллапсе
            // лента вырастает на ~300px, порог pinBottom (<80px) не проходит →
            // подтяжка уезжает в поллинг на 600мс+ = видимый скролл. Фикс: СРАЗУ
            // при фокусе-ауте (пока лента ещё сжата, юзер был у низа) скроллим
            // к низу мгновенно; при росте высоты контента iOS держит нижний край
            // видимого окна на конце ленты автоматически (scroll anchoring),
            // поллинг остаётся как страховка. Порог НЕ трогаем (нужен для
            // обычных скроллов вверх — иначе лента прилипнет намертво).
            // v160w6c6: unmarkKb перенесён сюда (слит с window-focusout — двойной
            // слушатель = двойное лечение в случайных фазах, диагноз avito-deep-dive2).
            if (IS_ANDROID) {
                document.body.classList.remove("keyboard-visible"); // call33f: Android — шапка всегда видима
            } else {
            const unmarkKb = () => {
                try {
                    const active = (vv.height || 0) < (document.documentElement.clientHeight || 0) - 2;
                    document.body.classList.toggle("keyboard-visible", active);
                } catch (err) {}
            };
            [100, 250, 500, 750, 1000, 1500, 2000].forEach(t => setTimeout(unmarkKb, t));
            } // call33f
            // kb-oob(f)+(b): мгновенный scrollBottomUnfocus УБРАН из клиники
            // закрытия — реальный ma.scrollTop в кадре, когда layout в полёте,
            // рвёт нативный scroll anchoring/restore. Поллинг 600+ остаётся
            // (страховка «предпоследнего сообщения» после оседания, v160w5n).
            [600, 800, 1200, 2000].forEach(t => setTimeout(scrollBottomUnfocus, t));
        }
    }, true);
    document.addEventListener("focusin", (e) => {
        if (!isInput(e.target)) return;
        typing = true;
        // v160g4-kbd6: refocus во время collapse-анимации - отменить её.
        try { if (collapseAnim) { cancelAnimationFrame(collapseAnim.raf); collapseAnim = null; } } catch (err) {}
        // v160w6h: enter the keyboard layout immediately on focus, before the
        // first visualViewport.resize arrives. Waiting for vv.height < clientHeight
        // leaves the flex composer at the old layout-viewport bottom for one iOS
        // frame while the keyboard is already moving, which is the visible gap
        // in IMG_5154. The class is removed only on focusout after collapse.
        if (e.target.id === "message-input") {
            if (!IS_ANDROID) document.body.classList.add("keyboard-visible"); // call33f: Android — класс не ставим
            setVvh();
            syncComposerSpace();
        }
        // v160x20 (Олег 11:11: «когда тапаешь в печать — выше появляется не последнее
        // сообщение, а предыдущие»): при открытии клавиатуры клавиатура сжимает
        // messages-area и iOS держит scrollTop — юзер видит предпоследние. Скроллим
        // к низу сразу + с поллингом (клавиатура едет ~350мс, высота меняется).
        const isChatInput = e.target.id === "message-input";
        const scrollBottomKb = () => {
            try {
                if (!isChatInput) return;
                const ma = document.querySelector(".messages-area");
                if (!ma) return;
                ma.scrollTop = ma.scrollHeight;
            } catch (err) {}
        };
        scrollBottomKb();
        [50, 150, 300, 500, 800].forEach(t => setTimeout(scrollBottomKb, t));
        // v160x18: перерегистрация vv-листенера (bug 254861 ik-workaround).
        refreshVvListener();
        // v160x17 (research: Telegram Web A): при открытой клавиатуре — клacc
        // keyboard-visible на body: шапка чата скрыта, композер (flex-child)
        // прижимается к низу колонки без дыры. Ставим сразу + с поллингом:
        // изометрия = vv.height < documentElement.clientHeight.
        if (!IS_ANDROID) { // call33f: Android — класс не управляется поллингами
        const markKb = () => {
            try {
                const active = (vv.height || 0) < (document.documentElement.clientHeight || 0) - 2;
                document.body.classList.toggle("keyboard-visible", active);
            } catch (err) {}
        };
        markKb();
        [50, 150, 300, 500, 800].forEach(t => setTimeout(markKb, t));
        } // call33f
        [50, 150, 300, 500, 800].forEach(t => setTimeout(reset, t));
    }, true);
    // kb-oob(f): reset заглушён на collapse (окно тишины из focusout).
    window.addEventListener("scroll", (e) => { if (!window.__murmurQuiet) reset(); }, { passive: true });
    vv.addEventListener("resize", onVvThrottled);
    // v160x10b (Олег 2026-09-21, скрин «дыра 63px»): vv scroll = изменение
    // offsetTop БЕЗ изменения height. В gap-состоянии после цикла клавиатуры
    // iOS оседает: vv.height+vvTop = полная высота, но последнийvv resize
    // прилетел ПРОМЕЖУТОЧНЫМ (vvFull≈790) → --vvh залип на 790, снизу дыра
    // 54px. reset() тут НЕ пересчитывает высоту. Добавляем setVvh: каждый
    // vv scroll дотягивает --vvh до честного MAX(...). Дешёво (setVvh
    // идемпотентен, guard от pinch-zoom внутри).
    vv.addEventListener("scroll", () => { setVvh(); if (!window.__murmurQuiet) reset(); });
    setVvh();
    reset();
    // v160x19: экспорт scrollCure на window (module scope — lesson #363/#364),
    // чтобы openChat (top-level function) мог запускать лекарство при открытии чата.
    try { window.scrollCure = scrollCure; } catch (e) {}
    // v160y58: экспорт nudgeComposerLayer для openChat-догонов (дыра под
    // композером при открытии чата — лечит тап в поле, значит слой композера).
    try { window.__murmurNudgeComposer = nudgeComposerLayer; } catch (e) {}
    // v160y60: экспорт forceReflow/settle/gapWatchdog — openChat-догоны зовут
    // ТОТ ЖЕ набор лекарства, что и focusout-цепочка после тапа в поле
    // (разница forceReflow/settle/gapWatchdog была причиной «тап лечит,
    // открытие чата — нет»).
    try { window.__murmurForceReflow = forceReflow; } catch (e) {}
    try { window.__murmurSettle = settle; } catch (e) {}
    try { window.__murmurGapWatchdog = gapWatchdog; } catch (e) {}
    // v160y61: экспорт setVvh — openChat-догоны зовут его БЕЗ гейта (диаг-скрин:
    // метрики честные при видимой дыре — PAINT устар, layout не врёт).
    try { window.__murmurSetVvh = setVvh; } catch (e) {}
})();

// v160g4-kbd1 (05.10.2026, diag-first по правилу Олега 30.09): KB ring-buffer
// + кнопка копирования. Строится только при murmur_diag=1 в standalone-PWA.
// События: focusin/focusout (capture), vv resize/scroll (троттлинг 40мс),
// win-scroll + снапшот метрик на каждое событие. Кнопка KB копирует лог.
(function () {
    try {
        var ok = false;
        try { ok = (localStorage.getItem("murmur_diag") === "1"); } catch (e) {}
        if (!ok) return;
        // call33: гейт standalone снят — диагностика нужна в браузере (Android Chrome)
        // (var standalone = ...; if (!standalone) return;)
        var LOG = [];
        var f = function (v) { return (v == null || isNaN(v)) ? "-" : Math.round(v); };
        var snap = function (ev) {
            var vv = window.visualViewport;
            var cs = getComputedStyle(document.documentElement);
            var ia = document.querySelector("#input-area");
            var ma = document.querySelector(".messages-area");
            var ria = ia ? ia.getBoundingClientRect() : null;
            var rma = ma ? ma.getBoundingClientRect() : null;
            return "t=" + Date.now() +
                " ev=" + ev +
                " vvH=" + (vv ? f(vv.height) : "none") +
                " vvT=" + (vv ? f(vv.offsetTop) : "-") +
                " pgT=" + (vv ? f(vv.pageTop) : "-") +
                " inH=" + f(window.innerHeight) +
                " cliH=" + f(document.documentElement.clientHeight) +
                " scY=" + f(window.scrollY) +
                " vvh=" + (cs.getPropertyValue("--vvh") || "-").trim() +
                " kb=" + (cs.getPropertyValue("--kb-inset") || "-").trim() +
                " cH=" + (cs.getPropertyValue("--composer-h") || "-").trim() +
                " kbC=" + document.body.classList.contains("keyboard-visible") +
                " iaB=" + (ria ? f(ria.bottom) : "-") +
                " msB=" + (rma ? f(rma.bottom) : "-");
        };
        var log = function (ev) {
            try {
                LOG.push(snap(String(ev)));
                if (LOG.length > 120) LOG.shift();
            } catch (e) {}
        };
        // v160g4-kbd12: экспорт снапшота - animateVvh пишет кадры collapse
        // в KB-лог (diag-first: факты по каждому кадру, не догадки).
        try { window.__murmurKbSnap = log; } catch (e) {}
        var lastVV = 0;
        var vvLog = function () {
            var n = Date.now();
            if (n - lastVV < 40) return;
            lastVV = n;
            log("vv-resize");
        };
        window.addEventListener("focusin", function (e) {
            var tg = (e.target && e.target.tagName) ? e.target.tagName : "?";
            log("focusin:" + tg);
        }, true);
        window.addEventListener("focusout", function (e) {
            var tg = (e.target && e.target.tagName) ? e.target.tagName : "?";
            log("focusout:" + tg);
        }, true);
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", vvLog);
            window.visualViewport.addEventListener("scroll", function () { log("vv-scroll"); });
        }
        window.addEventListener("scroll", function () { log("win-scroll"); }, { passive: true });
        window.__murmurKbDump = function () { return LOG.join("\\n") || "(empty)"; };
        var btn = document.createElement("button");
        btn.textContent = "KB";
        btn.setAttribute("aria-label", "copy keyboard log");
        btn.style.cssText = "position:fixed;right:6px;bottom:120px;z-index:99999;background:rgba(0,0,0,.85);color:#4f4;border:1px solid #4f4;border-radius:6px;font:bold 12px monospace;padding:8px 10px;";
        btn.addEventListener("click", function () {
            var txt = "KB-LOG " + new Date().toISOString() + "\\n" + window.__murmurKbDump();
            var done = function () {
                btn.textContent = "OK";
                setTimeout(function () { btn.textContent = "KB"; }, 1200);
            };
            var fallback = function () {
                var ta = document.createElement("textarea");
                ta.value = txt;
                ta.style.cssText = "position:fixed;left:-9999px;top:0;";
                document.body.appendChild(ta);
                ta.focus(); ta.select();
                try { document.execCommand("copy"); done(); } catch (e2) {}
                document.body.removeChild(ta);
            };
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt).then(done, fallback);
                } else { fallback(); }
            } catch (e) { fallback(); }
        });
        var mount = function () {
            if (document.body) document.body.appendChild(btn);
            else setTimeout(mount, 300);
        };
        mount();
        log("init");
    } catch (e) {}
})();

