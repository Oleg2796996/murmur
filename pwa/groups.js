// murmur PWA — groups store + E2E ops (вынесено из app.js v160z5, 2026-09-26)
// Блок 3121–3402 app.js: LS_GROUPS store CRUD (loadGroups/getGroup/upsertGroup,
// removeGroup/isAdminOf), group E2E (groupCreateKey/groupSeal/groupOpen,
// createGroup/sendGroupInvite/rotateGroupKey/sendGroupKeyRotation/sendGroupMessage),
// b64ToHex, decryptEnvelope (ECIES sealed → plain object).
// Classic script, загружается ДО app.js (index.html) — глобалы общие.
// Зависимости: encryptForRecipient/ensureWasm (app.js, runtime), chat-state (isHiddenPeer).

const LS_GROUPS = "murmur.groups"; // localStorage: [{id, name, members, key_b64, epoch, admins}]
const GROUP_MEMBER_CAP = 10;

// groups: localStorage store (id, name, members, key_b64, epoch, admins). После
// reload читаем заново. IDB-переезд позже (если группы вырастут).
function loadGroups() {
    try {
        const raw = localStorage.getItem(LS_GROUPS);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}
function saveGroups(groups) {
    try { localStorage.setItem(LS_GROUPS, JSON.stringify(groups)); } catch (e) {
        console.warn("[murmur] groups save failed:", e);
    }
}
function getGroup(groupId) {
    return loadGroups().find(g => g.id === groupId) || null;
}
function upsertGroup(g) {
    const groups = loadGroups();
    const i = groups.findIndex(x => x.id === g.id);
    if (i >= 0) groups[i] = Object.assign({}, groups[i], g);
    else groups.push(g);
    saveGroups(groups);
}
function removeGroup(groupId) {
    const groups = loadGroups().filter(g => g.id !== groupId);
    saveGroups(groups);
}
function isAdminOf(group, npub) {
    return Array.isArray(group.admins) && group.admins.includes(npub);
}

// group_new_key: WASM-примитив (32B master key, hex). Creator вызывает один раз.
async function groupCreateKey() {
    const mod = await loadWasmModule();
    const r = unwrap(mod.group_new_key());
    if (!r.ok) throw new Error("group_new_key: " + r.error);
    return r.data; // 64 hex chars
}

// group_encrypt wrap: base64 in/out (group key hex + epoch + group_id + sender).
// AAD привязан к group_id + sender + epoch — replay между группами/эпохами падает.
async function groupSeal(groupKeyHex, epoch, groupId, senderNpub, plaintextB64) {
    const mod = await loadWasmModule();
    // v160g5-fix: wasm-bindgen 0.2.127 u64 → BigInt — Number кидает «Cannot convert 1 to a BigInt».
    const r = unwrap(mod.group_encrypt(groupKeyHex, BigInt(epoch), groupId, senderNpub, plaintextB64));
    if (!r.ok) throw new Error("group_encrypt: " + r.error);
    return r.data; // base64 [nonce12][ct+tag]
}

// group_decrypt wrap: base64 sealed -> base64 plaintext.
async function groupOpen(groupKeyHex, epoch, groupId, senderNpub, sealedB64) {
    const mod = await loadWasmModule();
    const r = unwrap(mod.group_decrypt(groupKeyHex, BigInt(epoch), groupId, senderNpub, sealedB64));
    if (!r.ok) throw new Error("group_decrypt: " + r.error);
    return r.data; // base64 plaintext
}

window.groupSeal = groupSeal;
window.groupOpen = groupOpen;
window.loadGroups = loadGroups;
window.upsertGroup = upsertGroup;

// ============================================================================
// GROUP v160g4 (Олег 2026-09-21): отправка + инвайты + лента
// ============================================================================

// Group create: сгенерировать key + upsert локально + инвайты участникам.
// Инвайт — ECIES 1:1 envelope с _kind:"group_invite", payload внутри содержит
// group_id, name, members, admins, epoch, key_b64 (ключ раздаётся ТОЛЬКО через
// 1:1 E2E — релей его не видит). Только создатель (или админ с правами).
async function createGroup(name, memberNpubs) {
    await ensureWasm();
    if (!myNpub) throw new Error("not signed in");
    const members = [myNpub, ...memberNpubs.filter(m => m && m !== myNpub)].slice(0, GROUP_MEMBER_CAP);
    if (members.length < 2) throw new Error("нужно минимум 2 участника");
    const keyHex = await groupCreateKey();
    // group_id: bech32-подобный от SHA3(npub+ts) — детерминированный, уникальный.
    const mod = await loadWasmModule();
    const idBytes = new TextEncoder().encode("grp|" + myNpub + "|" + Date.now());
    const gid = unwrap(mod.sign_envelope("grp", idBytes));
    if (!gid.ok) throw new Error("group id: " + gid.error);
    const groupId = "grp1" + gid.data.slice(0, 40).toLowerCase().replace(/[^a-z0-9]/g, "");
    const g = {
        id: groupId,
        name: (name || "Группа").slice(0, 48),
        members,
        admins: [myNpub],
        key_b64: btoa(keyHex.match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join("")),
        epoch: 1,
        created_ts: Math.floor(Date.now() / 1000),
        inviter: null,
    };
    upsertGroup(g);
    // Инвайты всем кроме себя (each через 1:1 ECIES).
    for (const m of members) {
        if (m === myNpub) continue;
        try { await sendGroupInvite(g, m); } catch (e) {
            console.warn("[murmur] group invite failed for", m.slice(0, 12), e && e.message);
        }
    }
    renderChatList();
    return g;
}

// Отправка group_invite участнику m: ECIES(m.npub) { _kind:"group_invite", ... }.
async function sendGroupInvite(g, memberNpub) {
    const mod = await loadWasmModule();
    const peerKey = await resolvePeerKey(memberNpub);
    if (!peerKey) throw new Error("cannot resolve key for " + memberNpub.slice(0, 12));
    const payload = {
        group_id: g.id,
        name: g.name,
        members: g.members,
        admins: g.admins,
        epoch: g.epoch || 1,
        key_b64: g.key_b64,
        inviter: myNpub,
        created_ts: g.created_ts || Math.floor(Date.now() / 1000),
    };
    const plainB64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))));
    const sealedB64 = await encryptForRecipient(memberNpub, plainB64);
    const ts = Math.floor(Date.now() / 1000);
    const msg = { from: myNpub, to: memberNpub, ct: sealedB64, attachments_meta: [], ts, _kind: "group_invite" };
    const signedPayload = msg.from + "|" + msg.to + "|" + msg.ts + "|" + msg.ct;
    const sigPayloadBytes = new TextEncoder().encode(signedPayload);
    const sig = unwrap(mod.sign_envelope(msg.from, sigPayloadBytes));
    if (!sig.ok) throw new Error("sign: " + sig.error);
    msg.sig = sig.data;
    let binStr = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < sigPayloadBytes.length; i += CHUNK) {
        binStr += String.fromCharCode.apply(null, sigPayloadBytes.subarray(i, i + CHUNK));
    }
    msg.signed_payload = btoa(binStr);
    const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(memberNpub), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
    });
    if (!r.ok) throw new Error("relay POST " + r.status);
    return true;
}

// Ротация ключа (после выхода участника): epoch+1, новый key, group_key
// envelope каждому оставшемуся. Только админ.
async function rotateGroupKey(groupId) {
    const g = getGroup(groupId);
    if (!g || !isAdminOf(g, myNpub)) throw new Error("not admin");
    await ensureWasm();
    const newKeyHex = await groupCreateKey();
    g.epoch = (g.epoch || 1) + 1;
    g.key_b64 = btoa(newKeyHex.match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join(""));
    saveGroups(loadGroups());
    for (const m of g.members) {
        if (m === myNpub) continue;
        try { await sendGroupKeyRotation(g, m); } catch (e) {
            console.warn("[murmur] group key rotation failed for", m.slice(0, 12), e && e.message);
        }
    }
    return g;
}

async function sendGroupKeyRotation(g, memberNpub) {
    const mod = await loadWasmModule();
    const peerKey = await resolvePeerKey(memberNpub);
    if (!peerKey) throw new Error("cannot resolve key for " + memberNpub.slice(0, 12));
    const payload = { group_id: g.id, epoch: g.epoch, key_b64: g.key_b64, members: g.members };
    const plainB64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))));
    const sealedB64 = await encryptForRecipient(memberNpub, plainB64);
    const ts = Math.floor(Date.now() / 1000);
    const msg = { from: myNpub, to: memberNpub, ct: sealedB64, attachments_meta: [], ts, _kind: "group_key" };
    const signedPayload = msg.from + "|" + msg.to + "|" + msg.ts + "|" + msg.ct;
    const sigPayloadBytes = new TextEncoder().encode(signedPayload);
    const sig = unwrap(mod.sign_envelope(msg.from, sigPayloadBytes));
    if (!sig.ok) throw new Error("sign: " + sig.error);
    msg.sig = sig.data;
    let binStr = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < sigPayloadBytes.length; i += CHUNK) {
        binStr += String.fromCharCode.apply(null, sigPayloadBytes.subarray(i, i + CHUNK));
    }
    msg.signed_payload = btoa(binStr);
    const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(memberNpub), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
    });
    if (!r.ok) throw new Error("relay POST " + r.status);
    return true;
}

// Отправка группового сообщения (фанаут по members): групповой ключ шифрует
// payload c group_id+sender, envelope 1:1 каждому участнику. Сервер видит
// только точка-точку (как личные).
async function sendGroupMessage(groupId, text) {
    const g = getGroup(groupId);
    if (!g) throw new Error("group not found: " + groupId);
    if (!text || !text.trim()) return null;
    await ensureWasm();
    const keyHex = (g.key_b64 || "").length === 64 ? g.key_b64 : b64ToHex(g.key_b64);
    if (!keyHex) throw new Error("group key missing");
    // payload: group_id + sender внутри группового шифра (лейбл автора внутри E2E —
    // релей видит только ct). sender_npub в AAD — replay между группами падает.
    // v160g7b: UTF-8 байты → binary string → btoa (btoa кидает «The string contains
    // invalid characters» на кириллице — JSON.stringify НЕ эскейпит non-Latin1;
    // тот же паттерн что в encryptForRecipient).
    const plainB64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ group_id: g.id, sender: myNpub, body: text, ts: Math.floor(Date.now() / 1000) }))));
    const sealedB64 = await groupSeal(keyHex, g.epoch || 1, g.id, myNpub, plainB64);
    const ts = Math.floor(Date.now() / 1000);
    const results = [];
    for (const m of g.members) {
        // v160g8 (Олег 13:54 «не надо чтобы уведомления приходили отправителю»):
        // себe копия не нужна — optimistic render уже в ленте. Без self-эха нет
        // ни уведомлений, ни отдельного чата с самим собой.
        if (m === myNpub) continue;
        const mod = await loadWasmModule();
        const signedPayload = myNpub + "|" + m + "|" + ts + "|" + sealedB64;
        const sigPayloadBytes = new TextEncoder().encode(signedPayload);
        const sig = unwrap(mod.sign_envelope(myNpub, sigPayloadBytes));
        if (!sig.ok) { results.push({ member: m, ok: false, error: sig.error }); continue; }
        // v160g7b: signed_payload — ASCII-only (npub|npub|ts|b64), но chunked на всякий
        // случай: apply(null, bigArray) переполняет стек на длинных сообщениях.
        let sigBin = "";
        for (let i = 0; i < sigPayloadBytes.length; i += 0x8000) sigBin += String.fromCharCode.apply(null, sigPayloadBytes.subarray(i, i + 0x8000));
        const msg = { from: myNpub, to: m, ct: sealedB64, attachments_meta: [], ts, sig: sig.data, signed_payload: btoa(sigBin), _kind: "group_msg" };
        try {
            const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(m), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(msg),
            });
            results.push({ member: m, ok: r.ok, status: r.status });
        } catch (e) {
            results.push({ member: m, ok: false, error: e && e.message });
        }
    }
    return { group: g, ts, results, sealedB64, text };
}

function b64ToHex(b64) {
    try {
        const bin = atob(b64);
        if (bin.length !== 32) return null;
        let hex = "";
        for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
        return hex;
    } catch { return null; }
}

window.createGroup = createGroup;
window.rotateGroupKey = rotateGroupKey;

/// ECIES decrypt a base64 sealed envelope to original plain object.
async function decryptEnvelope(sealedB64) {
    // v160y (Олег 2026-09-03 «после перезапуска PWA видео перестало играть):
    // render-attachments.js зовёт window.decryptEnvelope(target) в eciesUnwrapKey
    // (L64). Экспорт ниже — после function declaration (module scope, L3064).
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

// v160y: export decryptEnvelope to window for render-attachments.js eciesUnwrapKey (module scope, runs on app.js load)
window.decryptEnvelope = decryptEnvelope;

