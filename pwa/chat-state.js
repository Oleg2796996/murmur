// murmur PWA — chat-state (вынесено из app.js v160z2, 2026-09-26)
// Блок 2072–2262 app.js: normalizePeer, unread-карта (+IDB зеркало для SW),
// maxTs-карта (IDB source of truth), hidden-peers + tombstone, deleted-ts.
// Classic script, загружается ДО app.js (index.html) — глобалы общие.

const LS_MESSAGES_MAX_TS = "murmur.messages_max_ts";
const LS_UNREAD = "murmur_unread_v1";
const LS_MAXTS = "murmur_maxts_v1";
const LS_HIDDEN_PEERS = "murmur_hidden_peers_v1";
const LS_DELETED_TS = "murmur_deleted_ts_v1";

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

// Lesson #127: при reload WS переотправляет «свежие» envelopes — они
// могут быть уже прочитанными (мы открыли чат и сбросили unread), но
// bumpUnread увеличивает обратно. Решение: хранить maxTs по каждому
// peer'у (самый поздний уже показанный envelope). На reload любой
// envelope с ts <= maxTs игнорируется для bumpUnread.
// Lesson #129: chat delete — скрытие чата на клиенте. Peer орёт-в localStorage,
// в sidebar не показывается. На сервере ничего не удаляется (TTL 24ч удалит само).
// Lesson #132.5: tombstone при удалении чата. Карта peer -> ts удаления.
// При polling новый unhidePeer сработает ТОЛЬКО если msg.ts > tombstone[peer].
// Без этого fix'а: polling приходит с msg.ts <= tombstone и снимает скрытие,
// потому что lesson #132.1 (любое новое сообщение для peer'а) сталкивается
// с re-fetch старых envelopes в /api/history. tombstone отсекает старые.
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
    // v160b (Олег 2026-09-17): зеркало unread в IDB kv — SW (закрытое приложение)
    // читает его в push-хендлере и ставит ТОЧНЫЙ badge. localStorage в SW-контексте
    // недоступен, IDB — единственное разделяемое состояние страница↔SW.
    try {
        if (window.appStore && window.appStore.kv.set) {
            window.appStore.kv.set("murmur.badge_unread", m).catch(() => {});
        }
    } catch (e) { /* ignore */ }
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
    // v160l: IDB kv is the source of truth for max_ts; localStorage is a legacy fallback.
    // saveMessagesCacheForPeer writes to appStore.kv(LS_MESSAGES_MAX_TS), so read it first.
    if (window.appStore) {
        try {
            const idb = window.appStore.kv.get(LS_MESSAGES_MAX_TS);
            if (idb && idb[peer]) return idb[peer];
        } catch (e) { /* fallthrough */ }
    }
    return loadMaxTsMap()[peer] || 0;
}
async function updateMaxTs(peer, ts) {
    peer = normalizePeer(peer);
    if (!ts) return;
    // v160l: keep both IDB kv and localStorage in sync so incremental fetch
    // always sees the latest max_ts regardless of which path wrote it.
    let idbMax = {};
    if (window.appStore) {
        try {
            idbMax = (await window.appStore.kv.get(LS_MESSAGES_MAX_TS)) || {};
        } catch (e) { /* fallthrough */ }
    }
    let dirty = false;
    if (ts > (idbMax[peer] || 0)) {
        idbMax[peer] = ts;
        dirty = true;
    }
    const lsMax = loadMaxTsMap();
    if (ts > (lsMax[peer] || 0)) {
        lsMax[peer] = ts;
        saveMaxTsMap(lsMax);
    }
    if (dirty && window.appStore) {
        try { await window.appStore.kv.set(LS_MESSAGES_MAX_TS, idbMax); } catch (e) {}
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
