// MurMur encrypted backup/restore (test contour MVP).
// Password is never persisted. Backup contains identity, contacts/groups and chat history.
(() => {
  "use strict";
  const MAGIC = "MURMURBAK1";
  const VERSION = 1;
  const PBKDF2_ITERATIONS = 250000;
  const BACKUP_META_KEY = "murmur.backup.meta";
  const LS_KEYS = [
    "murmur.npub", "murmur.sk", "murmur.name", "murmur.contact_names",
    "murmur.groups", "murmur_unread_v1", "murmur_maxts_v1",
    "murmur_hidden_peers_v1", "murmur_deleted_ts_v1", "murmur.posters.v1",
    "murmur_lang"
  ];
  let sessionPassword = null;
  let lastEncrypted = null;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const $ = id => document.getElementById(id);
  const b64 = bytes => { let s = ""; for (let i=0;i<bytes.length;i+=0x8000) s += String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const random = n => crypto.getRandomValues(new Uint8Array(n));
  const text = x => enc.encode(JSON.stringify(x));
  const parse = x => JSON.parse(dec.decode(x));

  async function derive(password, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:PBKDF2_ITERATIONS, hash:"SHA-256"}, base,
      {name:"AES-GCM", length:256}, false, ["encrypt", "decrypt"]);
  }
  function fileName() { return "murmur-backup-" + new Date().toISOString().slice(0,10) + ".murmur"; }

  async function collect() {
    const data = { ls: {}, kv: {}, chats: {}, identity: { npub: localStorage.getItem("murmur.npub") || "", name: localStorage.getItem("murmur.name") || "" } };
    for (const k of LS_KEYS) { const v = localStorage.getItem(k); if (v !== null) { try { data.ls[k] = JSON.parse(v); } catch { data.ls[k] = v; } } }
    if (window.appStore) {
      const exported = await window.appStore.exportBackupData();
      data.kv = exported.kv || {};
      data.chats = exported.chats || {};
      data.blobs = exported.blobs || [];
      // appStore migration may have identity in IDB while live app still uses LS.
      if (!data.identity.npub && data.kv["murmur.npub"]) data.identity.npub = data.kv["murmur.npub"];
    }
    data.createdAt = Date.now();
    return data;
  }

  async function encryptPayload(payload, password) {
    if (!password || password.length < 8) throw new Error("Пароль должен содержать минимум 8 символов");
    const salt = random(16), iv = random(12), key = await derive(password, salt);
    return encryptWithKey(payload, key, salt, iv);
  }
  async function encryptWithKey(payload, key, salt=random(16), iv=random(12)) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, text(payload)));
    return JSON.stringify({ magic: MAGIC, v: VERSION, kdf: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(ct) });
  }
  async function decryptPayload(raw, password) {
    let box; try { box = JSON.parse(raw); } catch { throw new Error("Файл backup повреждён"); }
    if (!box || box.magic !== MAGIC || box.v !== VERSION) throw new Error("Неподдерживаемый файл MurMur backup");
    const key = await derive(password, unb64(box.salt));
    try { return parse(await crypto.subtle.decrypt({name:"AES-GCM", iv:unb64(box.iv)}, key, unb64(box.data))); }
    catch { throw new Error("Неверный пароль или повреждённый backup"); }
  }
  function download(raw) {
    const blob = new Blob([raw], {type:"application/octet-stream"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function saveInternal(raw) {
    lastEncrypted = raw;
    if (window.appStore) await window.appStore.kv.set(BACKUP_META_KEY, { raw, savedAt: Date.now() });
  }
  async function createBackup({downloadFile=true, password=null}={}) {
    password = password || await askPassword("Введите пароль для резервной копии", true);
    if (!password) return null;
    const raw = await encryptPayload(await collect(), password);
    sessionPassword = password;
    // Non-extractable CryptoKey enables the requested 24h refresh after reload;
    // the plaintext password is never persisted.
    if (window.appStore) { try { await window.appStore.kv.set("murmur.backup.key", await derive(password, random(16))); } catch (e) { console.warn("[backup] key persist skipped", e); } }
    await saveInternal(raw);
    if (downloadFile) download(raw);
    setStatus("Резервная копия создана: " + fileName());
    return raw;
  }
  async function restoreFromRaw(raw, password) {
    const data = await decryptPayload(raw, password);
    if (!data.identity || !data.identity.npub || !data.identity.npub.startsWith("npub1")) throw new Error("В backup нет корректной identity");
    if (localStorage.getItem("murmur.npub") && !confirm("На этом устройстве уже есть аккаунт. Заменить локальные данные backup-файлом?")) return false;
    for (const k of LS_KEYS) localStorage.removeItem(k);
    for (const [k,v] of Object.entries(data.ls || {})) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    if (data.identity.npub) localStorage.setItem("murmur.npub", data.identity.npub);
    if (data.identity.name) localStorage.setItem("murmur.name", data.identity.name);
    if (window.appStore) await window.appStore.importBackupData({kv:data.kv || {}, chats:data.chats || {}, blobs:data.blobs || []});
    await saveInternal(raw);
    alert("Резервная копия восстановлена. MurMur перезапустится.");
    location.reload();
    return true;
  }
  async function chooseRestoreFile() {
    // Keep the file input in the document: iOS/Safari can ignore a click on a
    // detached input, which made the identity-screen restore button appear dead.
    const input = $("backup-restore-file") || document.createElement("input");
    input.type = "file";
    input.accept = ".murmur,application/octet-stream";
    input.value = "";
    if (!input.id) { input.id = "backup-restore-file"; input.hidden = true; document.body.appendChild(input); }
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        setStatus("Читаю резервную копию…");
        const raw = await f.text();
        const p = await askPassword("Пароль резервной копии", false);
        if (p) await restoreFromRaw(raw, p);
      } catch(e) {
        setStatus(e.message || "Не удалось восстановить backup");
        alert(e.message || "Не удалось восстановить backup");
      }
    };
    input.click();
  }
  async function chooseAutoFile() {
    if (!window.showSaveFilePicker) { alert("Автосохранение файла поддерживается в Chrome/Edge на ПК и Android. На этом браузере используйте кнопку «Скачать backup»."); return; }
    try {
      const h = await window.showSaveFilePicker({suggestedName:fileName(), types:[{description:"MurMur backup",accept:{"application/octet-stream":[".murmur"]}}]});
      const p = await askPassword("Пароль для автоматического backup", true); if (!p) return;
      sessionPassword = p;
      if (window.appStore) {
        await window.appStore.kv.set("murmur.backup.key", await derive(p, random(16))).catch(()=>{});
        await window.appStore.kv.set("murmur.backup.handle", h);
      }
      await autoSave(true); setStatus("Файл backup выбран и сохранён.");
    } catch(e) { if (e.name !== "AbortError") alert(e.message || "Не удалось выбрать файл"); }
  }
  async function autoSave(force=false) {
    let key = null;
    if (window.appStore) key = await window.appStore.kv.get("murmur.backup.key").catch(()=>null);
    if (!key && sessionPassword) { key = await derive(sessionPassword, random(16)); if (window.appStore) await window.appStore.kv.set("murmur.backup.key", key).catch(()=>{}); }
    if (!key) return;
    const meta = window.appStore ? await window.appStore.kv.get(BACKUP_META_KEY).catch(()=>null) : null;
    if (!force && meta && Date.now() - (meta.savedAt || 0) < 86400000) return;
    const raw = await encryptWithKey(await collect(), key); await saveInternal(raw);
    let h = window.appStore ? await window.appStore.kv.get("murmur.backup.handle").catch(()=>null) : null;
    if (h) { try { const perm = await h.queryPermission({mode:"readwrite"}); if (perm === "granted") { const w = await h.createWritable(); await w.write(raw); await w.close(); } } catch(e) { console.warn("[backup] file update failed", e); } }
  }
  function askPassword(title, confirmIt) { return new Promise(resolve => { const o=document.createElement("div"); o.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:18px"; o.innerHTML='<div style="background:#17212b;color:#e8edf2;border-radius:14px;padding:18px;max-width:360px;width:100%"><h3 style="margin:0 0 10px">'+title+'</h3><p style="font-size:12px;color:#9aaabd;line-height:1.4">Пароль не сохраняется в приложении. Запишите его отдельно — без него восстановление невозможно.</p><input id="bak-p1" type="password" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:11px;margin:8px 0;background:#0e1621;color:#fff;border:1px solid #34485d;border-radius:8px"><input id="bak-p2" type="password" autocomplete="new-password" placeholder="Повторите пароль" style="width:100%;box-sizing:border-box;padding:11px;margin:0 0 10px;background:#0e1621;color:#fff;border:1px solid #34485d;border-radius:8px;display:'+(confirmIt?'block':'none')+'"><div id="bak-err" style="color:#ff8d8d;font-size:12px;min-height:18px"></div><div style="display:flex;gap:8px"><button id="bak-c" style="flex:1;padding:10px">Отмена</button><button id="bak-ok" style="flex:1;padding:10px;background:#2b5278;color:#fff;border:0;border-radius:8px">Продолжить</button></div></div>'; document.body.appendChild(o); const p1=o.querySelector('#bak-p1'),p2=o.querySelector('#bak-p2'),err=o.querySelector('#bak-err'); o.querySelector('#bak-c').onclick=()=>{o.remove();resolve(null)}; o.querySelector('#bak-ok').onclick=()=>{if(p1.value.length<8){err.textContent='Минимум 8 символов';return} if(confirmIt&&p1.value!==p2.value){err.textContent='Пароли не совпадают';return} o.remove();resolve(p1.value)}; p1.focus(); }); }
  function setStatus(s) { const e=$("backup-status"); if(e){e.textContent=s;e.hidden=false;setTimeout(()=>e.hidden=true,5000);} }
  function wire() {
    ["btn-backup-download","btn-backup-restore","btn-backup-restore-identity"].forEach(id=>$(id)?.addEventListener("click", async()=>{
      try {
        if (id.endsWith("download")) await createBackup();
        else if (id.includes("restore")) await chooseRestoreFile();
        else await chooseAutoFile();
      } catch(e) {
        setStatus(e.message || "Ошибка backup");
        alert(e.message || "Ошибка backup");
      }
    }));
    if (window.appStore) window.appStore.kv.get(BACKUP_META_KEY).then(m=>{if(m?.raw) lastEncrypted=m.raw}).catch(()=>{});
  }
  window.MurMurBackup = {createBackup, restoreFromRaw, chooseRestoreFile, chooseAutoFile, autoSave, collect};
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded",wire); else wire();
})();
