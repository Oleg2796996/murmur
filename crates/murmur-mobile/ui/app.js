// murmur-mobile UI — Step 9a
// Talks to the Rust backend via Tauri's invoke().

const { invoke } = window.__TAURI__.core;

const el = (id) => document.getElementById(id);

async function main() {
    el("btn-new-id").addEventListener("click", onGenerate);
    el("btn-ping").addEventListener("click", onPing);
}

async function onGenerate() {
    el("btn-new-id").disabled = true;
    el("identity-status").textContent = "Generating…";
    try {
        const result = await invoke("identity_new");
        if (!result.ok) throw new Error(result.error);
        const id = result.data;
        el("identity-status").textContent = "Identity loaded.";
        el("npub-out").textContent = id.npub;
        el("npub-out").classList.remove("hidden");
    } catch (e) {
        el("identity-status").textContent = `Error: ${e.message}`;
    } finally {
        el("btn-new-id").disabled = false;
    }
}

async function onPing() {
    const msg = el("ping-input").value || "hello";
    try {
        const result = await invoke("ping", { msg });
        el("ping-out").textContent = result.ok ? result.data : `Error: ${result.error}`;
    } catch (e) {
        el("ping-out").textContent = `Error: ${e.message}`;
    }
}

document.addEventListener("DOMContentLoaded", main);