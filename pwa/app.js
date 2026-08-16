// murmur-mobile UI — Step 9a (PWA fallback)
// Uses Tauri invoke() when available (desktop), otherwise WASM module.

const el = (id) => document.getElementById(id);

// Choose backend at startup.
const backend = {
    async identity_new() {
        if (window.__TAURI__?.core?.invoke) {
            const result = await window.__TAURI__.core.invoke("identity_new");
            // Tauri commands now return CmdResult<String> — but old builds may
            // return naked String. Handle both.
            if (typeof result === "string") return { ok: true, data: result };
            return result;
        }
        if (backend.wasm) {
            return backend.wasm.identity_new();
        }
        return { ok: false, error: "no backend (Tauri or WASM)" };
    },
    async ping(msg) {
        if (window.__TAURI__?.core?.invoke) {
            const result = await window.__TAURI__.core.invoke("ping", { msg });
            if (typeof result === "string") return { ok: true, data: result };
            return result;
        }
        if (backend.wasm) {
            return backend.wasm.ping(msg);
        }
        return { ok: false, error: "no backend (Tauri or WASM)" };
    },
    wasm: null,
};

async function loadWasm() {
    try {
        // wasm-pack output layout: pkg/murmur_id_wasm.js + _bg.wasm
        const mod = await import("./pkg/murmur_id_wasm.js");
        await mod.default(); // init()
        backend.wasm = {
            // Rust returns serde_wasm_bindgen::to_value() — plain JS object,
            // not a Promise. Wrap in Promise.resolve so callers can await it.
            identity_new: () => {
                try {
                    const r = mod.identity_new();
                    return Promise.resolve(r && r.ok !== undefined
                        ? r
                        : { ok: true, data: String(r) });
                } catch (e) {
                    return Promise.resolve({ ok: false, error: String(e) });
                }
            },
            npub_to_pubkey_hex: (npub) => {
                try {
                    const r = mod.npub_to_pubkey_hex(npub);
                    return Promise.resolve(r && r.ok !== undefined
                        ? r
                        : { ok: true, data: String(r) });
                } catch (e) {
                    return Promise.resolve({ ok: false, error: String(e) });
                }
            },
            // WASM "ping" sanity: generates a fresh identity and returns it,
            // proving the WASM ↔ JS bridge is alive.
            ping: (_msg) => {
                try {
                    const r = mod.identity_new();
                    if (r && r.ok) {
                        return Promise.resolve({
                            ok: true,
                            data: `pong: generated ${r.data.slice(0, 16)}…`,
                        });
                    }
                    return Promise.resolve({ ok: false, error: String(r) });
                } catch (e) {
                    return Promise.resolve({ ok: false, error: String(e) });
                }
            },
        };
        el("wasm-status").textContent = `wasm v${mod.version()} loaded`;
        el("rt-tau").textContent = "runtime: wasm";
        el("rt-tau").classList.add("wasm");
        return true;
    } catch (e) {
        el("wasm-status").textContent = `wasm load failed: ${e.message}`;
        return false;
    }
}

async function main() {
    if (window.__TAURI__?.core?.invoke) {
        el("rt-tau").textContent = "runtime: tauri";
        el("rt-tau").classList.add("tauri");
    } else {
        el("rt-tau").textContent = "runtime: loading wasm…";
        await loadWasm();
    }
    el("btn-new-id").addEventListener("click", onGenerate);
    el("btn-ping").addEventListener("click", onPing);

    // Register service worker for PWA + push.
    if ("serviceWorker" in navigator) {
        try {
            await navigator.serviceWorker.register("./service-worker.js");
            console.log("[murmur-pwa] service worker registered");
        } catch (e) {
            console.warn("[murmur-pwa] service worker registration failed:", e);
        }
    }
}

async function onGenerate() {
    el("btn-new-id").disabled = true;
    el("identity-status").textContent = "Generating…";
    try {
        const result = await backend.identity_new();
        if (!result.ok) throw new Error(result.error || "unknown error");
        el("identity-status").textContent = "Identity loaded.";
        el("npub-out").textContent = result.data;
        el("npub-out").classList.remove("hidden");

        // Try to expand the pubkey hex for the curious.
        if (backend.wasm) {
            const hex = backend.wasm.npub_to_pubkey_hex(result.data);
            if (hex.ok) {
                el("pubkey-out").textContent = `pubkey hex: ${hex.data}`;
                el("pubkey-out").classList.remove("hidden");
            }
        }
    } catch (e) {
        el("identity-status").textContent = `Error: ${e.message}`;
    } finally {
        el("btn-new-id").disabled = false;
    }
}

async function onPing() {
    const msg = el("ping-input").value || "hello";
    try {
        const result = await backend.ping(msg);
        el("ping-out").textContent = result.ok ? result.data : `Error: ${result.error}`;
    } catch (e) {
        el("ping-out").textContent = `Error: ${e.message}`;
    }
}

document.addEventListener("DOMContentLoaded", main);