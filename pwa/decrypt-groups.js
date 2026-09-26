// murmur PWA — body-decode + decrypt + groups (вынесено из app.js v160z4, 2026-09-26)
// Блок 286–810 app.js: base64/unwrap/decodeBody, extractBodyText*, decrypt-хелперы
// (decryptResultHasContent, decryptEnvelopeForRender), groups E2E (consumeGroupEnvelope,
// handleIncomingGroupMsg, renderGroupMessages, pollHistoryForGroup), decryptWithTimeout
// (+DECRYPT_TIMEOUT_MS, memoize per _server_msg).
// Classic script, загружается ДО app.js (index.html) — глобалы общие.
// Зависимости: ensureWasm/WASM (app.js), chat-state (normalizePeer/isHiddenPeer — грузится раньше).

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
// v160y2: decrypt успешен, если есть текст ИЛИ вложения. Фото/файл без подписи:
// text="" — ВАЛИДНЫЙ результат (чип рендерится из attachments_meta). Старые
// guard'ы «if (newBody && ...)» считали пустой text неудачей → 🔒-заглушка
// не перезаписывалась (регрессия v160y: раньше текст всегда был из 📎-append).
function decryptResultHasContent(d) {
    if (!d || d.text === "__DECRYPT_FAILED__") return false;
    if (typeof d.text === "string" && d.text.includes("🔒")) return false;
    return (d.text && d.text.length > 0) || (Array.isArray(d.attachments) && d.attachments.length > 0);
}

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
                        // v160d: постер-кадр видео (data:image/jpeg;base64) —
                        // извлечён отправителем, релей его не видел (внутри ct).
                        _plainPoster: pa.poster_data_url || null,
                    });
                    // v160p: постер входящего в постоянный кэш по blob_id.
                    if (attachmentsMeta[i].blob_id) savePosterToCache(attachmentsMeta[i].blob_id, pa.poster_data_url);
                }
            }
        }
        // Render attachments inline в body — ТОЛЬКО если чипов нет.
        // v160y: attachmentsMeta рисуется отдельным чипом (msg-attach-list,
        // render-attachments.js «📎 name (size)») — дубль текстом был только
        // у входящих. Старый формат без attachments_meta: 📎-строка в body
        // остаётся единственным указанием на файл — не теряем.
        if (plain.attachments && plain.attachments.length && !attachmentsMeta.length) {
            for (const a of plain.attachments) {
                body += "\n📎 " + a.name + " (" + formatSize(a.size) + ")";
            }
        }
        // v160r: reply_to из расшифрованного ct — несём в render (цитата в bubble).
        return { text: body, isBinary: false, attachments: plain.attachments || [], attachmentsMeta, reply_to: plain.reply_to || null };
    } catch (e) {
        console.warn("decrypt failed:", e);
        // (Олег 2026-08-25 07:55 MSK): caller в loadHistory различает исходящие
        // и входящие — для исходящих показываем attachments_meta вместо «🔒».
        return { text: "__DECRYPT_FAILED__", isBinary: false };
    }
}

// v160g3 (Олег 2026-09-21, вариант 3): групповые служебные envelope'ы.
// group_invite: инвайт нового участника (group_id, name, members, epoch,
// key_b64, inviter) — ECIES 1:1, key внутри. group_key: ротация ключа после
// выхода участника (group_id, epoch, key_b64). Оба НЕ рендерятся в чат —
// обновляют локальный groups store (как receipts, но для групп).
async function consumeGroupEnvelope(m) {
    try {
        if (!m || typeof m !== "object") return false;
        // (1) WS-путь или уже распарсено: payload напрямую.
        let kind = m._kind || null;
        let payload = null;
        if (kind === "group_invite" || kind === "group_key") {
            payload = m._plain ? (typeof m._plain === "string" ? JSON.parse(m._plain) : m._plain)
                               : (m.payload || null);
        }
        // (2) Message row from /api/history: body_base64 -> inner JSON.
        if (!payload && typeof m.body_base64 === "string") {
            try {
                const inner = JSON.parse(atob(m.body_base64));
                if (inner && (inner._kind === "group_invite" || inner._kind === "group_key")) {
                    kind = inner._kind;
                    // inner.ct — ECIES 1:1 (расшифровывается моим приватным ключом).
                    if (typeof inner.ct === "string") {
                        const plain = await decryptEnvelope(inner.ct);
                        // v160h7 (сим 21.09 22:35): decryptEnvelope может вернуть
                        // СТРОКУ (base64 от payload-JSON — двойное кодирование на
                        // отправке, сим: plain = "eyJncm91cF9pZCI6...", plain.body
                        // undefined → JSON.parse(undefined) throw → payload=null →
                        // инвайт отброшен молча). Нормализуем: строку → atob-декод →
                        // JSON.parse; объект с body → как раньше.
                        let plainBody = null;
                        if (plain && typeof plain === "string") {
                            try { plainBody = plain; } catch {}
                        } else if (plain && typeof plain === "object" && plain.body) {
                            plainBody = plain.body;
                        }
                        if (plainBody) {
                            try { payload = JSON.parse(plainBody); } catch {
                                try { payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(plainBody), c => c.charCodeAt(0)))); } catch { payload = null; }
                            }
                        }
                    }
                }
            } catch {}
        }
        if (!payload) return false;
        // Валидация payload.
        if (!payload.group_id || typeof payload.group_id !== "string") return false;
        if (kind === "group_invite") {
            if (!payload.key_b64 || !Array.isArray(payload.members) || !payload.members.length) return false;
            // Инвайт: создаём/обновляем группу локально (key внутри ECIES —
            // релей его не видел).
            upsertGroup({
                id: payload.group_id,
                name: (payload.name || "Группа").slice(0, 48),
                members: payload.members.slice(0, GROUP_MEMBER_CAP),
                admins: Array.isArray(payload.admins) ? payload.admins.slice(0, GROUP_MEMBER_CAP) : (payload.inviter ? [payload.inviter] : []),
                key_b64: payload.key_b64,
                epoch: payload.epoch || 1,
                inviter: payload.inviter || null,
                created_ts: payload.created_ts || Date.now(),
            });
            try { console.warn("[murmur] group invite applied:", payload.group_id, payload.name); } catch {}
            return true;
        }
        if (kind === "group_key") {
            // Ротация ключа: применяем ТОЛЬКО если epoch новее текущего.
            const g = getGroup(payload.group_id);
            if (!g) return false;
            const newEpoch = payload.epoch || 0;
            if (newEpoch <= (g.epoch || 1)) return true; // старая ротация — молча скип
            g.key_b64 = payload.key_b64 || g.key_b64;
            g.epoch = newEpoch;
            if (Array.isArray(payload.members)) g.members = payload.members.slice(0, GROUP_MEMBER_CAP);
            saveGroups(loadGroups());
            try { console.warn("[murmur] group key rotated:", payload.group_id, "epoch", newEpoch); } catch {}
            return true;
        }
        return false;
    } catch (e) {
        try { console.warn("[murmur] group envelope error:", e && e.message); } catch {}
        return false;
    }
}
window.consumeGroupEnvelope = consumeGroupEnvelope;

// v160g4: входящее групповое сообщение — расшифровка групповым ключом (epoch
// из группы), рендер в групповую ленту (messages[group_id]), автор из payload
// (внутри E2E). Рelay видит только ct. Ошибки (нет группы/ключа/не та эпоха)
// — молча скип (включая 🔒-замок в будущих версиях).
async function handleIncomingGroupMsg(env, fromNpub, hash) {
    try {
        // (1) WS-путь / уже распарсено; (2) history-путь body_base64.
        let innerEnvelope = null;
        if (typeof env.ct === "string") innerEnvelope = env;
        else if (typeof env.body_base64 === "string") {
            try { innerEnvelope = JSON.parse(atob(env.body_base64)); } catch { return; }
        }
        if (!innerEnvelope || typeof innerEnvelope.ct !== "string") return;
        const ct = innerEnvelope.ct;
        // group_id из payload: ct = групповой шифр (НЕ ECIES). Ищем группу по
        // AAD-bind: перебираем локальные группы (cap 10) — decrypt падает по
        // тегу для чужих (быстро на 10 группах).
        const groups = loadGroups();
        if (!groups.length) return;
        let matched = null, plainB64 = null;
        for (const g of groups) {
            const keyHex = b64ToHex(g.key_b64);
            if (!keyHex) continue;
            try {
                const pt = await groupOpen(keyHex, g.epoch || 1, g.id, fromNpub, ct);
                matched = g; plainB64 = pt; break;
            } catch (e) { /* not this group/epoch — next */ }
        }
        if (!matched) { try { console.warn("[murmur] group msg: no key/epoch for", (hash || "").slice(0,12)); } catch {} return; }
        // v160g7b: atob возвращает UTF-8 байты как binary string — декодируем
        // TextDecoder'ом (JSON.parse на binary string кидает на кириллице).
        const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(plainB64), c => c.charCodeAt(0))));
        if (!payload || payload.group_id !== matched.id || !payload.body) return;
        const sender = payload.sender || fromNpub;
        const gid = matched.id;
        const sigKey = "grp" + gid + "|" + sender + "|" + (payload.ts || env.ts || 0);
        if (!messages[gid]) messages[gid] = [];
        // Дедуп: по hash (envelope) ИЛИ по групповому sigKey (та же группа,
        // тот же sender, тот же ts — фанаут N копий имеют РАЗНЫЕ envelope-hash,
        // но ОДИН payload.ts).
        const exists = messages[gid].some(m =>
            (hash && m._hash === hash) || m._sig === sigKey);
        if (exists) return;
        messages[gid].push({
            _sig: sigKey, _hash: hash,
            ts: payload.ts || env.ts || Math.floor(Date.now() / 1000),
            from: sender, to: gid,
            body: payload.body, direction: sender === myNpub ? "out" : "in",
            isGroup: true, groupId: gid,
            status: sender === myNpub ? "sent" : null,
            sig: "", isBinary: false,
            attachments: [], attachments_meta: [], reply_to: null,
        });
        updateMaxTs(gid, payload.ts || env.ts || 0);
        // Receipts: ✓✓ в группу — как личные, per-envelope (мой фанаут-копии
        // имеют разные hash; отчечаем полученную копию).
        if (sender !== myNpub && hash) queueReceiptsForPeer(fromNpub, [hash]);
        setChatPreview(gid, payload.ts || env.ts || 0, (sender === myNpub ? "Вы: " : "") + payload.body.slice(0, 40));
        if (currentGroup === gid) { renderGroupMessages(); scrollToBottom(); }
        else if (sender !== myNpub) { bumpUnread(gid); contacts[gid] = contacts[gid] || { peer: gid, unreadCount: 0 }; contacts[gid].unreadCount = getUnread(gid); }
        renderChatList();
    } catch (e) {
        try { console.warn("[murmur] group msg error:", e && e.message); } catch {}
    }
}

// v160g4: полноценная лента группового чата (messages[group_id]). Автор над
// пузырем (цвет по npub hash). Отправка через sendGroupMessage (фанаут).
function renderGroupMessages() {
    const gid = currentGroup;
    if (!gid) return;
    const g = getGroup(gid);
    if (!g) return;
    const panel = document.getElementById("chat-panel");
    if (!panel) return;
    const msgs = (messages[gid] || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const nameColor = (npub) => {
        let h = 0;
        for (let i = 0; i < npub.length; i++) h = (h * 31 + npub.charCodeAt(i)) & 0xffff;
        const hue = h % 360;
        return `hsl(${hue}, 55%, 65%)`;
    };
    const shortName = (npub) => {
        const nm = loadContactNames()[npub] || "";
        if (nm) return nm;
        return npub.slice(5, 11) + "…";
    };
    panel.innerHTML = msgs.map(m => {
        const mine = m.direction === "out";
        const authorLine = mine ? "" :
            `<div style="font-size:11px;color:${nameColor(m.from)};margin:0 0 2px 12px;font-weight:600;">${escapeHtml(shortName(m.from))}</div>`;
        const bubble = `<div style="display:inline-block;max-width:78%;padding:7px 11px;border-radius:12px;${mine ?
            "background:#2b5278;color:#fff;float:right;" : "background:#182533;color:#e9eaeb;"}white-space:pre-wrap;word-break:break-word;">${escapeHtml(m.body)}</div>` +
            `<div style="font-size:10px;opacity:.45;text-align:${mine ? "right" : "left"};margin:2px 4px 8px;">${new Date(m.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${mine ? " ✓" : ""}</div>`;
        return `<div style="margin:0 8px;clear:both;">${authorLine}${bubble}</div>`;
    }).join("") + '<div style="height:8px;"></div>';
}
window.renderGroupMessages = renderGroupMessages;

// v160g4: poll истории группы — GET /api/history по каждому member (групповые
// копии приходят в 1:1 каналах member_npub), handleIncomingGroupMsg рендерит
// в messages[group_id] с дедупом по payload.ts. Backlog: первый poll приносит
// всю историю.
async function pollHistoryForGroup(gid) {
    if (!myNpub || !gid) return;
    const g = getGroup(gid);
    if (!g) return;
    const seenHashes = new Set();
    for (const m of (g.members || [])) {
        // v160g8: свои копии не пуллим — optimistic уже в ленте (и self-фанаут
        // убран, своих копий на сервере больше нет).
        if (m === myNpub) continue;
        try {
            const r = await fetch(RELAY + "/api/history?npub=" + encodeURIComponent(myNpub) + "&peer=" + encodeURIComponent(m) + "&limit=" + HISTORY_LIMIT + "&visible=" + (document.visibilityState === "visible" ? 1 : 0) + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
            if (!r.ok) continue;
            const j = await r.json();
            for (const msg of (j.messages || [])) {
                const hash = msg.envelope_hash || msg.envelope_hash_hex || null;
                if (hash && seenHashes.has(hash)) continue;
                if (hash) seenHashes.add(hash);
                // Фильтр по wire _kind: только group_msg (инвайты/ротации/личные
                // в групповую ленту НЕ попадают).
                let parsed = null;
                try {
                    if (typeof msg.body === "string" && msg.body.startsWith("{")) parsed = JSON.parse(msg.body);
                    else if (typeof msg.body_base64 === "string") {
                        const inner = JSON.parse(atob(msg.body_base64));
                        if (inner && typeof inner._kind === "string") parsed = inner;
                    }
                } catch {}
                if (!parsed || parsed._kind !== "group_msg") continue;
                await handleIncomingGroupMsg(msg, msg.from_npub || msg.from, hash);
            }
        } catch (e) { console.warn("[murmur] group poll", m.slice(0,12), e && e.message); }
    }
}
window.pollHistoryForGroup = pollHistoryForGroup;

// Lesson #158 (Олег 2026-08-25 08:13 MSK): WASM decrypt может зависнуть
// без exception на iPhone PWA. Per-decrypt таймаут через Promise.race.
// Вынесен в module scope — loadHistory и pollHistoryForPeer используют.
const DECRYPT_TIMEOUT_MS = 8000;


async function decryptWithTimeout(m) {
    // Lesson #228 (Олег 2026-08-26 16:42): MEMOIZE per server message.
    // Без этого каждый renderMessages() call → новый decryptWithTimeout → новый
    // fetch+decrypt → 2-4 MISS подряд на cache → photo A bubble рендерится
    // только как chip (plaintext не успел), фото исчезает при следующем render.
    // Диагностика v89: 4 renderMessages() calls для 1 message, 2 attach-cache MISS подряд.
    // Memoization: первый вызов создаёт Promise, все последующие возвращают тот же.
    if (m && m._decrypt_promise) return m._decrypt_promise;
    // v160k2 (Олег 2026-09-03 17:12 « шифровки нестабильные, иногда после
    // следующих обновлений появляется нормальный текст"): WASM init после
    // reload занимает 20-25s на Safari/iPhone (Lesson #308), а per-decrypt
    // race timeout = 8000ms. Race fires BEFORE wasm init → decrypt timeout →
    // 🔒 остаётся в кэш. Следующий reload: wasm уже init (быстрый) → decrypt
    // успевает → нормальный текст. Инстабилити = race × WASM init.
    // Fix: await ensureWasm() OUT of the race — 8000ms отсчитывается только
    // после готовности WASM (реальный decrypt ~0-2s).
    await ensureWasm();
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
