// murmur PWA client (polling-based, iOS-safe).
//   - murmur-id-wasm: identity ops
//   - relay HTTP /envelope: send signed Envelope (JSON)
//   - relay HTTP /api/inbox: poll for incoming envelopes every 5s
// No WebSocket — iOS Safari aggressively closes background WS, polling is rock-solid.

import init, { identity_new, ping, sign_message } from "./pkg/murmur_id_wasm.js";

const RELAY_HTTP = "https://collapse-authentic-soma-victorian.trycloudflare.com";

const $ = (id) => document.getElementById(id);

let myNpub = null;
let mySignKeyHex = null;
let myAgreeKeyHex = null;
let myAlias = "anon";        // под каким именем тебя слушает relay
let since = 0;               // cursor для /api/inbox
const inbox = [];
let pollTimer = null;

async function boot() {
    await init();
    $("rt-tau").textContent = "runtime: wasm";
    $("wasm-status").textContent = "wasm ready";
    $("btn-new-id").disabled = false;
    $("btn-ping").disabled = false;
    $("btn-uplink").disabled = false;
}

$("btn-new-id")?.addEventListener("click", async () => {
    const res = identity_new();
    if (!res.ok) { $("identity-status").textContent = "error: " + res.error; return; }
    myNpub = res.data.npub;
    mySignKeyHex = res.data.signing_pubkey_hex;
    myAgreeKeyHex = res.data.agreement_pubkey_hex;
    myAlias = myNpub; // default: subscribe under your own npub
    $("identity-status").textContent = "Identity ready.";
    $("npub-out").textContent = myNpub;
    $("pubkey-out").textContent =
        "sign:  " + mySignKeyHex +
        "\nagree: " + myAgreeKeyHex;
    $("npub-out").classList.remove("hidden");
    $("pubkey-out").classList.remove("hidden");
    $("my-alias").textContent = shortAlias(myNpub);
    $("alias-input").value = myAlias;
    $("btn-send").disabled = false;
    $("btn-uplink").disabled = false;
});

$("btn-ping")?.addEventListener("click", async () => {
    const msg = $("ping-input").value || "hello";
    const res = ping(msg);
    if (!res.ok) { $("ping-out").textContent = "err: " + res.error; return; }
    $("ping-out").textContent = "pong: " + res.data;
});

$("btn-uplink")?.addEventListener("click", () => {
    const newAlias = ($("alias-input").value || "").trim() || myNpub;
    myAlias = newAlias;
    $("my-alias").textContent = shortAlias(myAlias);
    $("uplink-status").textContent = "polling: " + shortAlias(myAlias);
    startPolling();
});

$("btn-downlink")?.addEventListener("click", () => {
    stopPolling();
    $("uplink-status").textContent = "disconnected";
});

$("btn-send")?.addEventListener("click", async () => {
    if (!myNpub) { $("send-out").textContent = "err: need identity first"; return; }
    const to = $("send-to").value.trim();
    const body = $("send-text").value;
    if (!to) { $("send-out").textContent = "err: recipient required"; return; }
    if (!body) { $("send-out").textContent = "err: body required"; return; }
    $("send-out").textContent = "signing…";

    const res = sign_message(body);
    if (!res.ok) { $("send-out").textContent = "sign err: " + res.error; return; }
    const sig = res.data;

    try {
        const r = await fetch(RELAY_HTTP + "/envelope?to=" + encodeURIComponent(to), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                from: myNpub,
                to: to,
                body: body,
                sig: sig,
                ts: Date.now(),
            }),
        });
        const j = await r.json().catch(() => ({}));
        $("send-out").textContent = JSON.stringify(j, null, 2);
        if (r.ok && j.ok) {
            $("send-text").value = "";
            // сразу подёргать inbox, чтобы увидеть своё же сообщение (если подписан на свой alias)
            pollInbox();
        }
    } catch (e) {
        $("send-out").textContent = "fetch err: " + e;
    }
});

function startPolling() {
    stopPolling();
    pollInbox();
    pollTimer = setInterval(pollInbox, 5000);
    // visibility change — пнуть сразу когда вернулись
    document.addEventListener("visibilitychange", onVisibility);
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    document.removeEventListener("visibilitychange", onVisibility);
}

function onVisibility() {
    if (document.visibilityState === "visible" && pollTimer) {
        pollInbox();
    }
}

async function pollInbox() {
    try {
        const url = RELAY_HTTP + "/api/inbox?alias=" + encodeURIComponent(myAlias) + "&since=" + since;
        const r = await fetch(url, { method: "GET", cache: "no-store" });
        if (!r.ok) {
            $("uplink-status").textContent = "poll err: " + r.status;
            return;
        }
        const j = await r.json();
        if (j.items && j.items.length) {
            for (const it of j.items) {
                inbox.unshift({
                    alias: myAlias,
                    hash: it.hash,
                    from: it.from_npub,
                    ts: it.ts,
                    body_len: it.body_len,
                });
            }
            since = j.next_since;
            renderInbox();
        }
        $("uplink-status").textContent = "polling: " + shortAlias(myAlias) +
            " (inbox=" + inbox.length + ", last_id=" + (inbox[0]?.hash?.slice(0, 8) || "-") + ")";
    } catch (e) {
        $("uplink-status").textContent = "poll fail: " + e;
    }
}

function shortAlias(a) {
    if (!a) return "anon";
    if (a.length <= 18) return a;
    return a.slice(0, 14) + "…" + a.slice(-4);
}

function renderInbox() {
    if (!inbox.length) { $("inbox-out").textContent = "no messages yet"; return; }
    $("inbox-out").textContent = JSON.stringify(inbox, null, 2);
}

boot().catch((e) => {
    $("wasm-status").textContent = "wasm init failed: " + e;
});
