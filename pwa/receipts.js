// murmur PWA — receipts ✓/✓✓ (вынесено из app.js v160z1, 2026-09-26)
// Блок 1180–1413 app.js: квитанции доставки, acks, anti-шторм очередь.
// Classic script, загружается ДО app.js (index.html) — глобалы общие.

const LS_ACKS = "murmur.acks.v1";           // { [envelope_hash]: ts } — ✓✓ от получателя
const LS_RECEIPTED = "murmur.receipted.v1"; // { ["peer|hash"]: ts } — уже отчитались (анти-шторм)
// v160y61-receiptreq: self-heal — «перезвоните мне за галочкой». Квитанция живёт
// TTL ~5 мин после доставки (релей честно удаляет конверт). Если Алиса была
// офлайн в окно доставки квитанции — её ✓ навсегда одинокая (Олег 27.10:
// «галочки в одном чате странно проставились»: 14:32 «Котяяяррик» ✓, соседний
// «Чего кого?» ✓✓; 25 окт 18:48 ✓ против 21:49 ✓✓). Фикс: Алиса периодически
// просит Боба переподтвердить хэши; Боб отвечает квитанцией только по тем,
// которые РЕАЛЬНО получал (честность: не подтверждаем неполученное).
const LS_RECEIPT_REQ = "murmur.receiptreq.v1"; // { ["peer"]: ts } — backoff запросов
const RECEIPT_REQ_MIN_INTERVAL_MS = 10 * 60 * 1000;  // не чаще 1 запроса / 10 мин / peer
const RECEIPT_REQ_MAX_HASHES = 60;                   // кап на один запрос (batch cap receipts = 80)
const RECEIPT_REQ_MIN_AGE_MS = 90 * 1000;            // ждём 90с — обычный receipt-конвейер мог доехать

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

// ─── v160y61-receiptreq: self-heal ✓→✓✓ ───
function receiptReqLast(peer) {
    try { return (JSON.parse(localStorage.getItem(LS_RECEIPT_REQ) || "{}")[peer]) || 0; } catch (e) { return 0; }
}
function receiptReqMark(peer) {
    try {
        const raw = JSON.parse(localStorage.getItem(LS_RECEIPT_REQ) || "{}");
        raw[peer] = Date.now();
        localStorage.setItem(LS_RECEIPT_REQ, JSON.stringify(raw));
    } catch (e) {}
}

// Алиса: у исходящих с _hash нет ✓✓ → попросить Боба переподтвердить.
// Вызывается после loadHistory (источник правды по _hash/acks на текущий момент).
async function requestMissingReceipts(peer) {
    if (!myNpub || !peer || peer === myNpub) return;
    if (window.__murmurReceiptReqInflight && window.__murmurReceiptReqInflight.has(peer)) return;
    const msgs = messages[peer] || [];
    const now = Date.now();
    const missing = [];
    for (const m of msgs) {
        if (m.direction !== "out" || !m._hash || isAcked(m._hash)) continue;
        const age = now - ((m.ts || 0) * 1000);
        if (age < RECEIPT_REQ_MIN_AGE_MS) continue; // свежие — ждём обычный конвейер
        missing.push(m._hash);
        if (missing.length >= RECEIPT_REQ_MAX_HASHES) break;
    }
    if (!missing.length) return;
    if (now - receiptReqLast(peer) < RECEIPT_REQ_MIN_INTERVAL_MS) return;
    receiptReqMark(peer);
    if (!window.__murmurReceiptReqInflight) window.__murmurReceiptReqInflight = new Set();
    window.__murmurReceiptReqInflight.add(peer);
    try {
        await sendReceiptEnvelope(peer, { _t: "receipt_req", msgs: missing });
        console.log("[receipt] receipt_req sent:", missing.length, "hash(es) →", peer.slice(0, 12));
    } catch (e) {
        console.warn("[receipt] receipt_req failed:", e && e.message);
    } finally {
        window.__murmurReceiptReqInflight.delete(peer);
    }
}

function scheduleReceiptFlush(peer) {
    if (window.__murmurReceiptState.timers.has(peer)) return;
    const t = setTimeout(() => {
        window.__murmurReceiptState.timers.delete(peer);
        flushReceiptsForPeer(peer);
    }, RECEIPT_FLUSH_DELAY_MS);
    window.__murmurReceiptState.timers.set(peer, t);
}

// Общая отправка receipt-конверта: plain = {v:1,_t:"receipt"|"receipt_req",msgs:[...]}
// Обычный подписанный конверт Bob→Alice, POST /envelope?to=<peer> со служебным
// полем _kind:"receipt" в wire JSON (relay хранит тело как есть → /api/history
// отдаёт его в body_base64 → получатель фильтрует до decrypt).
async function sendReceiptEnvelope(peer, plain) {
    const peerKey = await resolvePeerKey(peer);
    if (!peerKey) throw new Error("no peer key for " + peer.slice(0, 12));
    const padLen = 96 + Math.floor(Math.random() * 384); // 96–480 hex символов против size-fingerprint
    const pad = new Array(padLen).fill(0).map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const padded = Object.assign({ pad: pad }, plain);
        const sealedB64 = await encryptForRecipient(peerKey.npub, padded);
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
            console.log("[receipt] sent", plain._t, (plain.msgs || []).length, "hash(es) →", peer.slice(0, 12));
            return true;
        }
        console.warn("[receipt] POST failed, HTTP", r.status);
        return false;
}

// Bob: слить очередь недоставленных hash'ей в одну квитанцию (debounce ~2s).
async function flushReceiptsForPeer(peer) {
    const st = window.__murmurReceiptState;
    const pending = st.queue.get(peer);
    if (!pending || pending.size === 0 || st.inflight.has(peer)) return;
    const hashes = Array.from(pending).slice(0, RECEIPT_BATCH_CAP);
    st.inflight.add(peer);
    try {
        const ok = await sendReceiptEnvelope(peer, { v: 1, _t: "receipt", msgs: hashes });
        if (ok) {
            for (const h of hashes) pending.delete(h);
            markReceipted(hashes);
        }
        // else: pending не чистим — следующий flush повторит
        // (hash'и остаются в seen, чтобы дубли не плодить в очереди)
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
            // v160y61-receiptreq: Боб получил наш запрос — отвечаем квитанцией
            // ТОЛЬКО по hash'ам, которые реально получали (receipted-store).
            if (m._plain._t === "receipt_req" && Array.isArray(m._plain.msgs)) {
                const known = m._plain.msgs.filter(h => h && isAlreadyReceipted(h));
                if (known.length) {
                    queueReceiptsForPeer(fromPeer, known);
                    console.log("[receipt] receipt_req answered:", known.length, "/", m._plain.msgs.length, "→", fromPeer.slice(0, 12));
                } else {
                    console.log("[receipt] receipt_req: none of", m._plain.msgs.length, "hash(es) known — no reply (честно)");
                }
                return;
            }
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
        // v160y61-receiptreq: branch как в _plain-пути выше (WS/history могут
        // доставить receipt_req без _plain — после расшифровки).
        if (plain && plain._t === "receipt_req" && Array.isArray(plain.msgs)) {
            const known = plain.msgs.filter(h => h && isAlreadyReceipted(h));
            if (known.length) {
                queueReceiptsForPeer(fromPeer, known);
                console.log("[receipt] receipt_req answered:", known.length, "/", plain.msgs.length, "→", fromPeer.slice(0, 12));
            } else {
                console.log("[receipt] receipt_req: none of", plain.msgs.length, "hash(es) known — no reply (честно)");
            }
            return;
        }
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
