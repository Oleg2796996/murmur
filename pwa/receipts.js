// murmur PWA — receipts ✓/✓✓ (вынесено из app.js v160z1, 2026-09-26)
// Блок 1180–1413 app.js: квитанции доставки, acks, anti-шторм очередь.
// Classic script, загружается ДО app.js (index.html) — глобалы общие.

const LS_ACKS = "murmur.acks.v1";           // { [envelope_hash]: ts } — ✓✓ от получателя
const LS_RECEIPTED = "murmur.receipted.v1"; // { ["peer|hash"]: ts } — уже отчитались (анти-шторм)

const RECEIPT_ACKS_CAP = 500;
const RECEIPT_STORE_CAP = 800;
const RECEIPT_BATCH_CAP = 80;               // hash'ей в одной квитанции
const RECEIPT_FLUSH_DELAY_MS = 2000;        // debounce ~2s (poll 5s → ✓✓ за ~7s)

// ═══ v158: квитанции доставки ✓/✓✓ (Олег 2026-08-31 19:16, «минимум рисков, без прочитано») ═══
// Дизайн: квитанция — обычный E2E-конверт Bob→Alice с публичным маркером
// _kind:"receipt" в wire JSON (sig покрывает from|to|ts|ct, маркер НЕ подписан —
// relay его видит, содержимое нет). Внутри ct: {v:1,_t:"receipt",msgs:[hash,...],pad}.
// Релей видит только «маленький конверт» — какие hash'и подтверждены, знает лишь пара.
function isReceiptRow(m) {
    if (!m || typeof m !== "object") return false;
    try {
        if (m._kind === "receipt") return true; // WS-путь или уже распарсено
        if (typeof m.body === "string" && m.body.indexOf("\"_kind\"") !== -1) {
            const p = JSON.parse(m.body);
            if (p && p._kind === "receipt") return true;
        }
        if (typeof m.body_base64 === "string" && m.body_base64.length > 0) {
            const inner = decodeBody(m.body_base64);
            if (inner && inner.text) {
                const p = JSON.parse(inner.text);
                if (p && (p._kind === "receipt" || p.rt === 1)) return true;
            }
        }
    } catch (e) { /* обычный конверт — не квитанция */ }
    return false;
}

function receiptLsRead(key, cap) {
    try {
        const raw = JSON.parse(localStorage.getItem(key) || "{}");
        const entries = Object.entries(raw);
        if (entries.length > cap) {
            entries.sort((a, b) => (a[1] || 0) - (b[1] || 0));
            const trimmed = {};
            for (const [k, v] of entries.slice(-cap)) trimmed[k] = v;
            try { localStorage.setItem(key, JSON.stringify(trimmed)); } catch (e) {}
            return trimmed;
        }
        return raw;
    } catch (e) { return {}; }
}

function receiptLsWrite(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
}

// Алиса: ✓✓-статусы. { hash: ts }
function loadAcks() { return receiptLsRead(LS_ACKS, RECEIPT_ACKS_CAP); }
function isAcked(hash) { return !!hash && !!receiptLsRead(LS_ACKS, RECEIPT_ACKS_CAP)[hash]; }
function markAcked(hash, ts) {
    if (!hash) return false;
    const acks = loadAcks();
    if (acks[hash]) return false;
    acks[hash] = ts || Math.floor(Date.now() / 1000);
    receiptLsWrite(LS_ACKS, acks);
    return true;
}

// Bob: «уже отчитался» (переживает reload — иначе каждый poll заново шлёт квитанции).
function receiptStoreRead() { return receiptLsRead(LS_RECEIPTED, RECEIPT_STORE_CAP); }
function isAlreadyReceipted(hash) { return !!receiptStoreRead()[hash]; }
function markReceipted(hashes) {
    if (!hashes || !hashes.length) return;
    const store = receiptStoreRead();
    let changed = false;
    for (const h of hashes) {
        if (h && !store[h]) { store[h] = Math.floor(Date.now() / 1000); changed = true; }
    }
    if (changed) receiptLsWrite(LS_RECEIPTED, store);
}

// Runtime-очередь на отправку: peer → Set(envelope_hash)
if (typeof window !== "undefined" && !window.__murmurReceiptState) {
    window.__murmurReceiptState = { queue: new Map(), inflight: new Set(), timers: new Map(), seen: new Set() };
}
function receiptQueueSize() {
    const st = window.__murmurReceiptState;
    let n = 0;
    for (const s of st.queue.values()) n += s.size;
    return n;
}

// Поставить hash'и входящих сообщений в очередь квитанции (debounce ~2s).
function queueReceiptsForPeer(peer, hashes) {
    if (!myNpub || !peer || peer === myNpub) return;
    if (!hashes || !hashes.length) return;
    const fresh = hashes.filter(h => h && !isAlreadyReceipted(h) && !window.__murmurReceiptState.seen.has(peer + "|" + h));
    if (!fresh.length) return;
    for (const h of fresh) window.__murmurReceiptState.seen.add(peer + "|" + h);
    if (!window.__murmurReceiptState.queue.has(peer)) window.__murmurReceiptState.queue.set(peer, new Set());
    const set = window.__murmurReceiptState.queue.get(peer);
    for (const h of fresh) {
        set.add(h);
        if (set.size > RECEIPT_BATCH_CAP) set.delete(set.values().next().value); // FIFO cap
    }
    scheduleReceiptFlush(peer);
}

function scheduleReceiptFlush(peer) {
    if (window.__murmurReceiptState.timers.has(peer)) return;
    const t = setTimeout(() => {
        window.__murmurReceiptState.timers.delete(peer);
        flushReceiptsForPeer(peer);
    }, RECEIPT_FLUSH_DELAY_MS);
    window.__murmurReceiptState.timers.set(peer, t);
}

// Отправка квитанции: обычный подписанный конверт Bob→Alice, POST /envelope?to=<peer>
// со служебным полем _kind:"receipt" в wire JSON (relay хранит тело как есть →
// /api/history отдаёт его в body_base64 → получатель фильтрует до decrypt).
async function flushReceiptsForPeer(peer) {
    const st = window.__murmurReceiptState;
    const pending = st.queue.get(peer);
    if (!pending || pending.size === 0 || st.inflight.has(peer)) return;
    const hashes = Array.from(pending).slice(0, RECEIPT_BATCH_CAP);
    st.inflight.add(peer);
    try {
        const peerKey = await resolvePeerKey(peer);
        if (!peerKey) { console.warn("[receipt] no peer key for", peer.slice(0, 12)); return; }
        const padLen = 96 + Math.floor(Math.random() * 384); // 96–480 hex символов против size-fingerprint
        const pad = new Array(padLen).fill(0).map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
        const plain = { v: 1, _t: "receipt", msgs: hashes, pad: pad };
        const sealedB64 = await encryptForRecipient(peerKey.npub, plain);
        const ts = Math.floor(Date.now() / 1000);
        const wireMsg = {
            from: myNpub, to: peer, ct: sealedB64, attachments_meta: [], ts,
            _kind: "receipt", // публичный маркер: релей не подсунет в чат, sig его не покрывает
        };
        const mod = await loadWasmModule();
        const signedPayload = wireMsg.from + "|" + wireMsg.to + "|" + wireMsg.ts + "|" + wireMsg.ct;
        const sigBytes = new TextEncoder().encode(signedPayload);
        const sig = unwrap(mod.sign_envelope(wireMsg.from, sigBytes));
        if (!sig.ok) { console.error("[receipt] sign error:", sig.error); return; }
        wireMsg.sig = sig.data;
        let binStr = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < sigBytes.length; i += CHUNK) {
            binStr += String.fromCharCode.apply(null, sigBytes.subarray(i, i + CHUNK));
        }
        wireMsg.signed_payload = btoa(binStr);
        const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(peer), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(wireMsg),
        });
        if (r.ok) {
            for (const h of hashes) pending.delete(h);
            markReceipted(hashes);
            console.log("[receipt] sent", hashes.length, "hash(es) →", peer.slice(0, 12));
        } else {
            console.warn("[receipt] POST failed, HTTP", r.status, "— re-queue (self-heal on next poll)");
            // pending не чистим — следующий flush повторит (hash'и остаются в seen, чтобы дубли не плодить в очереди)
        }
    } catch (e) {
        console.warn("[receipt] flush failed:", e.message);
    } finally {
        st.inflight.delete(peer);
        if (pending && pending.size > 0) scheduleReceiptFlush(peer); // остались недоставленные — retry цикл
    }
}

// Алиса: разобрать чужую квитанцию → ✓✓ на наших исходящих по _hash.
async function consumeReceiptRow(m, hash, fromPeer) {
    try {
        if (m._kind === "receipt" && m._plain) {
            applyReceipts(fromPeer, m._plain.msgs || []);
            return;
        }
        let ct = null;
        if (m._server_msg && typeof m._server_msg.ct === "string") ct = m._server_msg.ct;
        // v160y53: WS-путь — сервер кладёт полный envelope в ws_envelope_b64;
        // handleIncomingEnvelope распаковывает его в env.ct/body до вызова.
        if (!ct && typeof m.body === "string" && m.body.length > 0) {
            // v160y54: WS-путь — m.body = JSON wire-конверта с ct (isReceiptRow
            // уже распарсил m.body как JSON); повторный парс даёт inner.ct.
            try {
                const innerBody = JSON.parse(m.body);
                if (innerBody && typeof innerBody.ct === "string") ct = innerBody.ct;
            } catch (e) {
                // m.body не JSON (base64-тело, старый формат) — попробуем как base64-JSON ниже.
                try {
                    const innerB64 = JSON.parse(atob(m.body));
                    if (innerB64 && typeof innerB64.ct === "string") ct = innerB64.ct;
                } catch (e2) {}
            }
        }
        if (!ct && typeof m.body_base64 === "string" && m.body_base64.length > 0) {
            try {
                const inner = JSON.parse(atob(m.body_base64));
                if (inner && typeof inner.ct === "string") ct = inner.ct;
            } catch (e) {}
        }
        if (!ct) {
            // v160y53: больше НЕ молчим — логируем (иначе такие потерянные ✓✓
            // ловятся только вслепую, урок по квитанции 25.09).
            console.warn("[receipt] consume: no ct in receipt row, hash=", (hash || "").slice(0, 12),
                "_kind=", m._kind, "has_body=", typeof m.body === "string" && m.body.length > 0,
                "has_body64=", typeof m.body_base64 === "string" && m.body_base64.length > 0);
            return;
        }
        const plain = await decryptEnvelope(ct);
        applyReceipts(fromPeer, (plain && plain.msgs) || []);
    } catch (e) {
        // Чужой клиент старой версии / битая квитанция — молча игнор (Lesson #202 стиль).
    }
}

function applyReceipts(peer, hashes) {
    if (!hashes || !hashes.length) return;
    let changed = false;
    for (const h of hashes) {
        if (!h) continue;
        if (markAcked(h)) changed = true;
    }
    if (!changed) return;
    const acks = loadAcks(); // СВЕЖИЙ снапшот ПОСЛЕ markAcked (иначе stale → патч не сработает)
    console.log("[receipt] applied ✓✓ to", hashes.length, "msg(s) from", peer.slice(0, 12));
    // In-place tick patch (Lesson #230/#232): renderMessages скипает отрендеренные sig'и —
    // глиф запечён в bubble-time. Патчим DOM напрямую по data-sig.
    if (window.__murmurRenderedSigs && messages[peer]) {
        for (const msg of messages[peer]) {
            if (msg.direction !== "out" || !msg._hash || !acks[msg._hash]) continue;
            const sig = msg._sig || (msg.from_npub || msg.from) + msg.ts;
            if (!window.__murmurRenderedSigs.has(sig)) continue;
            try {
                const escR = window.CSS && CSS.escape ? CSS.escape : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
                const el = messagesArea.querySelector(`.bubble[data-sig="${escR(sig)}"] .bubble-time`);
                if (el && el.textContent.indexOf("✓✓") === -1) {
                    const base = el.textContent.replace(/\s*[✓⏳]+\s*$/, "").trimEnd();
                    el.innerHTML = base + " <span class='msg-read-check'>✓✓</span>";
                }
            } catch (e) {}
        }
    }
    if (activePeer === peer) renderMessages();
}
// ═══ конец v158 helpers ═══
