// murmur PWA — minimal, polling-only.
//   Identity: ed25519 npub generated on first load (kept in localStorage).
//   Online list: GET /api/online every 5s.
//   Inbox: GET /api/inbox?alias=<name>&since=N every 3s.
//   Send: POST /envelope?to=<name> with signed JSON.
// No buttons to press except "Send" and "New name".

import init, { identity_new, identity_restore, sign_message } from "./pkg/murmur_id_wasm.js";

const RELAY = "https://collapse-authentic-soma-victorian.trycloudflare.com";
const LS_NPUB = "murmur.npub";
const LS_KEY = "murmur.sk";        // signing key hex (private — только для PWA)
const LS_NAME = "murmur.name";      // short alias chosen by user

const $ = (id) => document.getElementById(id);

let myNpub = null;
let myName = "anon";
let signKeyHex = null;
let since = 0;
let pollTimer = null;
const inbox = [];

async function boot() {
    await init();
    $("status").textContent = "wasm ready";

    // Restore or generate identity
    const savedSk = localStorage.getItem(LS_KEY);
    const savedNpub = localStorage.getItem(LS_NPUB);
    if (savedSk && savedNpub) {
        const r = identity_restore(savedSk);
        if (r.ok) {
            myNpub = r.data.npub;
            signKeyHex = savedSk;
            $("status").textContent = "identity restored";
        } else {
            await generateIdentity();
        }
    } else {
        await generateIdentity();
    }
    myName = localStorage.getItem(LS_NAME) || shortNpub(myNpub);
    renderMe();
    startPolling();
}

async function generateIdentity() {
    const res = identity_new();
    if (!res.ok) { $("status").textContent = "identity err: " + res.error; return; }
    myNpub = res.data.npub;
    signKeyHex = res.data.signing_sk_hex;   // secret key for re-signing
    localStorage.setItem(LS_NPUB, myNpub);
    localStorage.setItem(LS_KEY, signKeyHex);
    $("status").textContent = "new identity created";
}

function renderMe() {
    $("my-name").textContent = myName;
    $("my-npub").textContent = myNpub.slice(0, 18) + "…" + myNpub.slice(-6);
}

$("btn-new-name")?.addEventListener("click", async () => {
    // Спрашиваем короткое имя у пользователя. Оно используется как alias для inbox.
    const newName = prompt("Твоё имя (напр. ozerov, ivan, alice):", myName);
    if (!newName) return;
    myName = newName.trim().slice(0, 32) || shortNpub(myNpub);
    localStorage.setItem(LS_NAME, myName);
    renderMe();
    since = 0;
    inbox.length = 0;
    renderInbox();
    pollInbox();
});

$("btn-send")?.addEventListener("click", async () => {
    const to = $("send-to").value.trim();
    const body = $("send-text").value.trim();
    if (!to) { $("send-out").textContent = "кому?"; return; }
    if (!body) { $("send-out").textContent = "что?"; return; }
    $("send-out").textContent = "отправляю…";

    const sig = sign_message(body);
    if (!sig.ok) { $("send-out").textContent = "sign err"; return; }

    try {
        const r = await fetch(RELAY + "/envelope?to=" + encodeURIComponent(to), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                from: myNpub,
                to: to,
                body: body,
                sig: sig.data,
                ts: Date.now(),
            }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok) {
            $("send-text").value = "";
            $("send-out").textContent = "ok ✓";
            // если подписаны на свой alias — увидим в inbox
            pollInbox();
        } else {
            $("send-out").textContent = "err: " + JSON.stringify(j);
        }
    } catch (e) {
        $("send-out").textContent = "network err: " + e;
    }
});

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollInbox();
    pollTimer = setInterval(pollInbox, 3000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") pollInbox();
    });
}

async function pollInbox() {
    // online count
    try {
        const r = await fetch(RELAY + "/api/online", { cache: "no-store" });
        if (r.ok) {
            const j = await r.json();
            $("online-count").textContent = j.count || 0;
        }
    } catch {}

    // inbox
    try {
        const r = await fetch(RELAY + "/api/inbox?alias=" + encodeURIComponent(myName) + "&since=" + since, { cache: "no-store" });
        if (!r.ok) { $("status").textContent = "poll " + r.status; return; }
        const j = await r.json();
        if (j.items && j.items.length) {
            for (const it of j.items) {
                inbox.unshift({
                    from: shortNpub(it.from_npub) || it.from_npub,
                    hash: it.hash.slice(0, 8),
                    ts: it.ts,
                });
            }
            since = j.next_since;
        }
        $("inbox-count").textContent = inbox.length;
        $("status").textContent = "online (" + j.count + ") · inbox " + inbox.length;
        renderInbox();
    } catch (e) {
        $("status").textContent = "poll fail: " + e;
    }
}

function renderInbox() {
    const ul = $("inbox-list");
    ul.innerHTML = "";
    for (const m of inbox.slice(0, 20)) {
        const li = document.createElement("li");
        const t = new Date(m.ts * 1000).toLocaleTimeString().slice(0, 5);
        li.textContent = `[${t}] ${m.from}: …`;
        ul.appendChild(li);
    }
}

function shortNpub(s) {
    if (!s) return "";
    return s.slice(0, 6) + "…" + s.slice(-4);
}

boot().catch((e) => {
    $("status").textContent = "init err: " + e;
});