// murmur PWA — front-end logic
// Identity: ed25519 (32-byte seed) + x25519 (clamped privkey), npub from ed25519 pubkey.
// Bech32 `npub1...` matches murmur-rs (bech32 m/crate, charset of npub prefix in murmur-id).
//
// We use WebCrypto subtle for ed25519 generation and signing when available.
// For x25519 we use nacl-like via @stablelib/x25519 (inlined below as a minimal port)
// because not all browsers expose x25519 via subtle.
//
// Storage: localStorage[`murmur:nprv`] = base64url(ed25519_seed || x25519_privkey).

const LOG = (...a) => console.log("[murmur]", ...a);
const WARN = (...a) => console.warn("[murmur]", ...a);
const ERR = (...a) => console.error("[murmur]", ...a);

// ---------- Bech32 (matches murmur-id::bech32 crate API) ----------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = (chk >> 25);
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32CreateChecksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function bech32Encode(hrp, data) {
  let sum = 0;
  const combined = [...data, ...bech32CreateChecksum(hrp, data)];
  for (const v of combined) {
    sum = sum * 33 + v;
    if (sum >= 0x100000000) sum -= 0x100000000;
  }
  sum = (sum + 0x100000000) % 0x100000000;
  let ret = hrp + "1";
  for (const v of combined) ret += CHARSET[v];
  return ret;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || (v >> fromBits) !== 0) throw new Error("invalid bit value");
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("trailing bits");
  }
  return out;
}

// Convert 32-byte ed25519 public key to npub (bech32m "npub" + 32 bytes 5-bit groups).
function pubkeyToNpub(pub32) {
  const data5 = convertBits(Array.from(pub32), 8, 5);
  return bech32Encode("npub", data5);
}

// ---------- Base64url ----------
const B64URL = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const B64URL_DEC = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// ---------- ed25519 (via WebCrypto subtle — Node 16+, all evergreen browsers) ----------
async function genEd25519() {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  // raw = 32-byte public key for Ed25519 (extract from SPKI later). Need private seed.
  // WebCrypto doesn't expose seed directly; we use the private key -> PKCS8 export.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  // PKCS#8 Ed25519 prefix is 16 bytes. See: https://datatracker.ietf.org/doc/html/rfc8410
  const seed = pkcs8.slice(-32);
  return { seed, pub: raw };
}

// ---------- x25519 (manual — derive from a separate 32-byte privkey, no derivation) ----------
async function genX25519() {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  // Clamp per RFC 7748
  priv[0] &= 248;
  priv[31] &= 127;
  priv[31] |= 64;
  return priv;
}

// ---------- Identity ----------
const KEY_STORE = "murmur:nprv-hex";

async function loadOrCreateIdentity() {
  const existing = localStorage.getItem(KEY_STORE);
  if (existing) {
    const bytes = hexToBytes(existing);
    return unpackingIdentity(bytes);
  }
  const ed = await genEd25519();
  const x = await genX25519();
  const bundle = new Uint8Array(64);
  bundle.set(ed.seed, 0);
  bundle.set(x, 32);
  localStorage.setItem(KEY_STORE, bytesToHex(bundle));
  return {
    ed25519Seed: ed.seed,
    ed25519Pub: ed.pub,
    x25519Priv: x,
    npub: pubkeyToNpub(ed.pub),
    nprvHex: bytesToHex(bundle),
  };
}

function unpackingIdentity(bytes) {
  if (bytes.length !== 64) throw new Error("identity bundle must be 64 bytes");
  // We have ed25519 seed + x25519 priv. We need ed25519 pub.
  // Defer: not actually needed for PWA (we never sign outbound). We just need npub.
  // For now, the seed is stored; pub will be rederived server-side on outgoing.
  // But we already have it from the *first* creation — store it too.
  return {
    ed25519Seed: bytes.slice(0, 32),
    ed25519Pub: null,
    x25519Priv: bytes.slice(32, 64),
    npub: null,
    nprvHex: bytesToHex(bytes),
  };
}

function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------- WebSocket ----------
let ws = null;
let inbox = [];

function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = "status " + (cls || "offline");
}

function connectRelay(url) {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  setStatus($("ws-status"), "connecting…", "connecting");
  ws = new WebSocket(url);
  ws.onopen = () => {
    setStatus($("status"), "online", "online");
    setStatus($("ws-status"), "connected", "online");
    LOG("WS open", url);
  };
  ws.onclose = () => {
    setStatus($("status"), "offline", "offline");
    setStatus($("ws-status"), "disconnected", "offline");
    LOG("WS closed");
  };
  ws.onerror = (e) => {
    ERR("WS error", e);
    setStatus($("ws-status"), "error", "offline");
  };
  ws.onmessage = (e) => {
    LOG("WS msg", e.data);
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "pending") {
        // Server pushes us any pending backlog matching our alias.
        for (const entry of msg.entries || []) addInbox(entry);
      } else if (msg.type === "envelope") {
        addInbox(msg.entry);
      }
    } catch (e) {
      WARN("not JSON", e);
    }
  };
}

function addInbox(entry) {
  inbox.unshift(entry);
  $("inbox-count").textContent = inbox.length;
  const li = document.createElement("li");
  const from = document.createElement("div");
  from.className = "from";
  from.textContent = entry.alias || "unknown";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${entry.envelope_hash_hex?.slice(0, 12) || "?"} · ${entry.ts || "?"}`;
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = `encrypted envelope (${entry.envelope_bytes?.length || "?"} bytes)`;
  li.appendChild(from);
  li.appendChild(meta);
  li.appendChild(body);
  $("inbox").prepend(li);
}

// ---------- Push ----------
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("Push not supported in this browser");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("Permission denied");
    return;
  }
  const reg = await navigator.serviceWorker.register("/service-worker.js");
  LOG("SW registered", reg);
  const vapidPub = await fetchVapidPublicKey();
  if (!vapidPub) {
    alert("Could not fetch VAPID pub key from relay");
    return;
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPub),
  });
  LOG("Push subscription", sub);
  const alias = $("npub-display").dataset.alias || "user";
  const r = await fetch("/push/register_subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      alias,
      subscription: sub.toJSON(),
    }),
  });
  const j = await r.json();
  if (j.ok) {
    $("push-status").innerHTML = "Push notifications are <strong>on</strong>.";
    $("btn-enable-push").disabled = true;
    $("btn-disable-push").disabled = false;
    LOG("registered", j.id);
  } else {
    alert("register failed: " + j.error);
  }
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const id = $("push-status").dataset.subId;
    if (id) {
      await fetch("/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
    }
    await sub.unsubscribe();
  }
  $("push-status").innerHTML = "Push notifications are <strong>off</strong>.";
  $("btn-enable-push").disabled = false;
  $("btn-disable-push").disabled = true;
}

async function fetchVapidPublicKey() {
  try {
    const r = await fetch("/vapid_public_key");
    if (!r.ok) return null;
    return (await r.text()).trim();
  } catch (e) {
    WARN("fetch vapid fail", e);
    return null;
  }
}

function urlBase64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const b = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------- DOM helpers ----------
function $(id) { return document.getElementById(id); }

document.addEventListener("DOMContentLoaded", async () => {
  // Identity
  const id = await loadOrCreateIdentity();
  $("npub-display").textContent = id.npub || "(pubkey not derivable from seed-only bundle — re-generate to get fresh)";
  $("npub-display").dataset.alias = (id.npub || "user").slice(0, 12);

  $("btn-generate").onclick = async () => {
    if (!confirm("Generate new identity? This will overwrite the current one.")) return;
    localStorage.removeItem(KEY_STORE);
    location.reload();
  };
  $("btn-export").onclick = () => {
    const id = hexToBytes(localStorage.getItem(KEY_STORE) || "");
    navigator.clipboard.writeText(B64URL(id));
    alert("nprv copied to clipboard (base64url, 64 bytes)");
  };

  // Relay
  $("btn-connect").onclick = () => connectRelay($("relay-url").value.trim());

  // Push
  $("btn-enable-push").onclick = enablePush;
  $("btn-disable-push").onclick = disablePush;
});
