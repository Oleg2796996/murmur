// murmur PWA client. Talks to:
//   - murmur-id-wasm: identity ops (npub generation, signing)
//   - relay WSS: subscribe + receive PushPayload frames
//   - relay HTTP /envelope: send signed Envelope (postcard bytes)
//
// Protocol notes:
//   - WS frames are TEXT/JSON.
//   - HTTP POST body is raw postcard bytes (Content-Type: application/octet-stream).

import init, { identity_new, ping, sign_message } from "./pkg/murmur_id_wasm.js";

const RELAY_WSS = "wss://ventures-joel-determined-joining.trycloudflare.com";
const RELAY_HTTP = "https://residents-metro-portable-debut.trycloudflare.com";

const $ = (id) => document.getElementById(id);

let myNpub = null;       // bech32 string
let mySignKeyHex = null; // hex of ed25519 signing pubkey
let myAgreeKeyHex = null; // hex of X25519 agreement pubkey
let ws = null;
const inbox = [];        // PushPayload[]

async function boot() {
    await init();
    $("rt-tau").textContent = "runtime: wasm";
    $("wasm-status").textContent = "wasm ready";
    $("btn-new-id").disabled = false;
    $("btn-ping").disabled = false;
    $("btn-uplink").disabled = false;
}

$("btn-new-id")?.addEventListener("click", async () => {
    const res = identity_new();  // CmdResult<{ npub, signing_pubkey_hex, agreement_pubkey_hex }>
    if (!res.ok) { $("identity-status").textContent = "error: " + res.error; return; }
    myNpub = res.data.npub;
    mySignKeyHex = res.data.signing_pubkey_hex;
    myAgreeKeyHex = res.data.agreement_pubkey_hex;
    $("identity-status").textContent = "Identity ready.";
    $("npub-out").textContent = myNpub;
    $("pubkey-out").textContent =
        "sign:  " + mySignKeyHex +
        "\nagree: " + myAgreeKeyHex;
    $("npub-out").classList.remove("hidden");
    $("pubkey-out").classList.remove("hidden");
    $("my-alias").textContent = myNpub.slice(0, 14) + "…";
    $("btn-send").disabled = false;
});

$("btn-ping")?.addEventListener("click", async () => {
    const msg = $("ping-input").value || "hello";
    const res = ping(msg);
    if (!res.ok) { $("ping-out").textContent = "err: " + res.error; return; }
    $("ping-out").textContent = "pong: " + res.data;
});

$("btn-uplink")?.addEventListener("click", async () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    $("uplink-status").textContent = "connecting…";
    try {
        ws = new WebSocket(RELAY_WSS);
        ws.onopen = () => {
            $("uplink-status").textContent = "connected";
            $("btn-downlink").disabled = false;
            if (myNpub) {
                ws.send(JSON.stringify({ type: "subscribe", alias: myNpub }));
            } else {
                ws.send(JSON.stringify({ type: "ping" }));
            }
        };
        ws.onmessage = (ev) => {
            const txt = (typeof ev.data === "string") ? ev.data : "";
            let msg = null; try { msg = JSON.parse(txt); } catch { msg = { type: "raw", data: txt }; }
            handleWsMessage(msg);
        };
        ws.onerror = (e) => { $("uplink-status").textContent = "error: " + (e.message || "?"); };
        ws.onclose = () => { $("uplink-status").textContent = "disconnected"; $("btn-downlink").disabled = true; };
    } catch (e) {
        $("uplink-status").textContent = "exception: " + e;
    }
});

$("btn-downlink")?.addEventListener("click", () => {
    if (ws) ws.close();
});

$("btn-send")?.addEventListener("click", async () => {
    if (!myNpub) { $("send-out").textContent = "err: need identity first"; return; }
    const to = $("send-to").value.trim();
    const body = $("send-text").value;
    if (!to) { $("send-out").textContent = "err: recipient required"; return; }
    if (!body) { $("send-out").textContent = "err: body required"; return; }
    $("send-out").textContent = "signing…";

    // Build a tiny "envelope" payload as JSON string (will be postcard-encoded
    // client-side once murmur-id-wasm exposes an envelope builder; for now we
    // use sign_message over UTF-8 body and submit { body, sig } as octet-stream).
    const res = sign_message(body);
    if (!res.ok) { $("send-out").textContent = "sign err: " + res.error; return; }
    const sig = res.data; // hex string from wasm

    const payload = JSON.stringify({
        from: myNpub,
        to: to,
        body: body,
        sig: sig,
        ts: Date.now(),
    });
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
        }
    } catch (e) {
        $("send-out").textContent = "fetch err: " + e;
    }
});

function handleWsMessage(msg) {
    if (msg.type === "subscribed") {
        $("uplink-status").textContent = "subscribed to " + msg.alias + " (backlog=" + msg.backlog + ")";
        return;
    }
    if (msg.type === "pong") {
        $("uplink-status").textContent = "ping ok";
        return;
    }
    if (msg.type === "push") {
        inbox.unshift(msg.payload);
        renderInbox();
        return;
    }
    if (msg.type === "error") {
        $("uplink-status").textContent = "relay err: " + msg.message;
        return;
    }
}

function renderInbox() {
    if (!inbox.length) { $("inbox-out").textContent = "no messages yet"; return; }
    $("inbox-out").textContent = JSON.stringify(inbox, null, 2);
}

boot().catch((e) => {
    $("wasm-status").textContent = "wasm init failed: " + e;
});
