/* MurMur test MVP: 1:1 audio calls, P2P-first, signaling over ephemeral WS. */
(function () {
  "use strict";
  // P2P remains preferred; TURN is a fallback for symmetric NAT/mobile
  // networks. Credentials are test-only and this file is never copied to prod
  // with the test endpoint.
  const ICE = [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: [
        "turn:2.27.1.2:3478?transport=udp",
        "turn:2.27.1.2:3478?transport=tcp"
      ],
      username: "murmur-test",
      credential: "645d64995e5670fdc8a5722aae7d7b339e0920c6"
    }
  ];
  let pc = null;
  let remotePeer = null;
  let localStream = null;
  const PHONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>';
  const ENDX = '<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(180 12 12)"><path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></g></svg>';
  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg>';
  const MICOF = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M4 4l16 16"/></svg>';
  const CAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="12" height="10" rx="2.5"/><path d="M15 10.5l6-3v9l-6-3"/></svg>';
  const CAMOF = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="12" height="10" rx="2.5"/><path d="M15 10.5l6-3v9l-6-3"/><path d="M4 4l16 16"/></svg>';
  const FS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5"/><path d="M15 20h5v-5"/><path d="M4 20l6-6"/><path d="M20 4l-6 6"/></svg>';
  const FSEX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h5V4"/><path d="M20 15h-5v5"/><path d="M9 9l-5-5"/><path d="M15 15l5 5"/></svg>';
  let pendingOffer = null;
  let pendingRemoteCandidates = [];
  let remoteDescriptionReady = false;
  let ring = null;
  let callState = "idle";
  let callOverlay = null;
  let callStartedAt = 0;
  let callTimer = null;
  let callDirection = "out";
  let callMode = "audio";
  let callModeKnown = false; // false до реального offer или своего звонка (push-путь mode не знает)
  let callRecorded = false;
  let ringbackTimer = null;
  let ringbackAudio = null;
  const iceDiag = { gathering: "new", connection: "new", candidates: [], errors: [], ws: "unknown" };
  function diagLog(event, value) {
    const item = { t: new Date().toISOString(), event, value: value == null ? "" : String(value) };
    iceDiag.last = item;
    if (event === "candidate") iceDiag.candidates.push(String(value));
    if (event === "error") iceDiag.errors.push(String(value));
    if (iceDiag.candidates.length > 20) iceDiag.candidates.shift();
    if (iceDiag.errors.length > 10) iceDiag.errors.shift();
    try { console.info("[MurmurCall]", event, value); } catch (_) {}
  }
  function diagSummary() {
    const types = [...new Set(iceDiag.candidates.map(c => (c.match(/ typ ([a-z]+)/) || [])[1]).filter(Boolean))];
    return "ICE " + iceDiag.connection + "/" + iceDiag.gathering + (types.length ? " · " + types.join(",") : " · кандидатов нет");
  }
  const $ = id => document.getElementById(id);
  const btn = () => $("btn-call");
  const videoBtn = () => $("btn-video-call");
  const modeLabel = () => !callModeKnown ? "Входящий звонок" : (callMode === "video" ? "Видеозвонок" : "Аудиозвонок");
  const modeIcon = () => callMode === "video" ? "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"7\" width=\"12\" height=\"10\" rx=\"2.5\"/><path d=\"M15 10.5l6-3v9l-6-3\"/></svg>" : "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z\"/></svg>";
  const runtime = () => window.MurmurRuntime || {};
  const peer = () => runtime().activePeer || null;
  const me = () => runtime().myNpub || null;
  const ws = () => runtime().ws || null;

  // v160g4-call9: буфер call-сигналов на холодном старте. После push-будилки
  // WS может ещё коннектиться (backoff до 60с) - раньше send() кидал
  // "WebSocket недоступен" и входящий звонок умирал по кнопке «Принять».
  // Теперь сигналы очередь + поллер-флаш каждые 100мс (таймаут 8с), порядок сохранён.
  const sendQueue = [];
  let sendFlusher = null;
  function doSend(to, signal, options) {
    const msg = { type: "call_signal", npub: me(), to, signal };
    if (options && options.push === false) msg.push = false;
    ws().send(JSON.stringify(msg));
  }
  function flushSendQueue() {
    const socket = ws();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (sendQueue.length) {
      const item = sendQueue.shift();
      try { doSend(item.to, item.signal, item.options); }
      catch (e) { diagLog("error", "flush call signal: " + e.message); }
    }
  }
  function queueSend(to, signal, options) {
    sendQueue.push({ to, signal, options, ts: Date.now() });
    if (sendFlusher) return;
    const startedAt = Date.now();
    sendFlusher = setInterval(() => {
      const socket = ws();
      const open = socket && socket.readyState === WebSocket.OPEN;
      if (open) {
        clearInterval(sendFlusher); sendFlusher = null;
        flushSendQueue();
      } else if (Date.now() - startedAt > 8000) {
        clearInterval(sendFlusher); sendFlusher = null;
        sendQueue.length = 0;
        diagLog("error", "call signal drop: WS не открылся за 8с");
      }
    }, 100);
  }
  function send(to, signal, options) {
    const socket = ws();
    if (!me() || !to) throw new Error("WebSocket недоступен");
    if (!socket || socket.readyState !== WebSocket.OPEN) { queueSend(to, signal, options); return; }
    doSend(to, signal, options);
  }
  function stopStream() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  function recordCall(status) {
    const target = remotePeer || (pendingOffer && pendingOffer.from);
    if (callRecorded || !target || !window.recordCallEvent) return;
    callRecorded = true;
    window.recordCallEvent(target, { status, direction: callDirection, duration: status === "completed" && callStartedAt ? (Date.now() - callStartedAt) / 1000 : 0, ts: Math.floor(Date.now() / 1000) });
  }
  function contactName(npub) {
    try {
      const names = typeof window.loadContactNames === "function" ? window.loadContactNames() : {};
      return (names && names[npub]) || "";
    } catch (_) { return ""; }
  }
  function shortPeer(npub) {
    return npub && npub.length > 18 ? npub.slice(0, 10) + "…" + npub.slice(-6) : (npub || "Неизвестный контакт");
  }
  function displayPeer(npub) { return contactName(npub) || shortPeer(npub); }
  function notifyIncoming(from, modeHint) {
    if (!from || pc || pendingOffer) return;
    callDirection = "in"; callRecorded = false;
    const hint = modeHint === "video" || modeHint === "audio" ? modeHint : null;
    pendingOffer = { from, signal: null, mode: hint };
    callMode = hint || "audio";
    // hint из push — надёжный источник (отправитель знал mode), карточку красим сразу
    callModeKnown = !!hint;
    setCallState("incoming", from);
  }
  function ensureOverlay() {
    if (callOverlay) return callOverlay;
    callOverlay = document.createElement("div");
    callOverlay.id = "call-overlay";
    callOverlay.className = "call-overlay";
    callOverlay.hidden = true;
    callOverlay.innerHTML = '<div class="call-card" role="dialog" aria-modal="true" aria-labelledby="call-title">' +
      '<div id="call-icon" class="call-icon" aria-hidden="true">' + PHONE + '</div>' +
      '<div id="call-kicker" class="call-kicker">Аудиозвонок</div>' +
      '<h2 id="call-title" class="call-title">Контакт</h2>' +
      '<div class="call-video-stage" hidden>' +
      '<video id="call-remote-video" autoplay playsinline></video>' +
      '<video id="call-local-video" autoplay muted playsinline></video>' +
      '</div>' +
      '<div id="call-state" class="call-state"></div>' +
      '<div id="call-timer" class="call-timer" hidden>00:00</div>' +
      '<div id="call-error" class="call-error" hidden></div>' +
      '<div class="call-actions call-main-actions">' +
      '<button id="call-mute" class="call-media-action" type="button" aria-label="Микрофон" title="Микрофон"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg></button>' +
      '<button id="call-decline" class="call-action call-decline" type="button" aria-label="Завершить звонок" title="Завершить звонок"><svg viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(180 12 12)"><path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></g></svg></button>' +
      '<button id="call-accept" class="call-action call-accept" type="button" aria-label="Принять звонок" title="Принять звонок">' + PHONE + '</button>' +
      '<button id="call-camera" class="call-media-action" type="button" aria-label="Камера" title="Камера"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="12" height="10" rx="2.5"/><path d="M15 10.5l6-3v9l-6-3"/></svg></button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(callOverlay);
    callOverlay.querySelector("#call-decline").addEventListener("click", () => {
      // This is the callee's explicit decision. Record locally before any
      // signaling/cleanup can clear pendingOffer, so the history always gets
      // "Входящий отменен" on the device that pressed Decline.
      if (pendingOffer && !pc) {
        const from = pendingOffer.from;
        recordCall("cancelled");
        try { send(from, { kind: "bye" }); } catch (_) {}
      } else if (callState !== "idle") {
        // v160w6o (Олег 07.10 21:15): продолжительность важнее того, кто положил
        // трубку. Если соединение состоялось (таймер тикал) — завершённый звонок
        // с длительностью, а не «отменен». Раньше кнопка всегда писала cancelled
        // ДО closeCall (callRecorded=true), и завершённый звонок терялся.
        recordCall(callState === "connected" || callStartedAt ? "completed" : "cancelled");
      }
      closeCall("cancelled");
    });
    callOverlay.querySelector("#call-accept").addEventListener("click", () => acceptCall().catch(showCallError));
    return callOverlay;
  }
  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function updateCallTimer() {
    const el = callOverlay && callOverlay.querySelector("#call-timer");
    if (el && callStartedAt) el.textContent = formatDuration((Date.now() - callStartedAt) / 1000);
  }
  function startCallTimer() {
    if (!callStartedAt) callStartedAt = Date.now();
    if (callTimer) clearInterval(callTimer);
    updateCallTimer();
    callTimer = setInterval(updateCallTimer, 1000);
  }
  function stopCallTimer() {
    if (callTimer) clearInterval(callTimer);
    callTimer = null;
    callStartedAt = 0;
  }
  function stopRingback() {
    if (ringbackTimer) clearInterval(ringbackTimer);
    ringbackTimer = null;
    if (ringbackAudio) {
      try { ringbackAudio.pause(); ringbackAudio.currentTime = 0; } catch (_) {}
      ringbackAudio = null;
    }
  }
  function startRingback() {
    stopRingback();
    try {
      ringbackAudio = new Audio("mur-mur-whisper.mp3");
      ringbackAudio.preload = "auto";
      ringbackAudio.volume = 0.63;
      ringbackAudio.loop = true;
      const play = ringbackAudio.play();
      if (play && typeof play.catch === "function") play.catch(err => console.warn("[call] ringback play blocked", err));
    } catch (_) {}
  }
  function setCallState(state, npub) {
    callState = state;
    const ov = ensureOverlay();
    ov.hidden = false;
    ov.querySelector("#call-title").textContent = displayPeer(npub || remotePeer || peer());
    ov.querySelector("#call-icon").innerHTML = modeIcon();
    const kicker = ov.querySelector("#call-kicker");
    const stateEl = ov.querySelector("#call-state");
    const accept = ov.querySelector("#call-accept");
    const timer = ov.querySelector("#call-timer");
    if (state === "incoming") { kicker.textContent = callModeKnown ? ("Входящий " + modeLabel().toLowerCase()) : "Входящий звонок"; stateEl.textContent = "Готовы принять звонок?"; accept.hidden = false; timer.hidden = true; }
    else if (state === "connecting") { kicker.textContent = modeLabel(); stateEl.textContent = "Соединение…"; accept.hidden = true; timer.hidden = true; }
    else if (state === "connected") { stopRingback(); kicker.textContent = modeLabel(); stateEl.textContent = "На связи"; accept.hidden = true; timer.hidden = false; startCallTimer(); }
    else { kicker.textContent = modeLabel(); stateEl.textContent = ""; accept.hidden = true; timer.hidden = true; }
    const stage = ov.querySelector(".call-video-stage");
    const camera = ov.querySelector("#call-camera");
    const showVideo = callMode === "video" && (state === "connected" || state === "connecting");
    if (stage) stage.hidden = !showVideo;
    // call31b: камера ТОЛЬКО на экране разговора (connected); в меню
    // входящего/исходящего ей не место.
    if (camera) camera.hidden = callMode !== "video" || state !== "connected";
    const mute = ov.querySelector("#call-mute");
    if (mute) mute.hidden = state !== "connected";
    // call28: fullscreen from here — the overlay is already visible, so both
    // incoming (accept) and outgoing (start) video calls land in fs. enterFs
    // guards itself against duplicates.
    if (showVideo) enterFs();
  }
  let fsScrollLockY = 0;
  let fsSpacer = null;
  function fsViewportKick() {
    // call32: stale viewport (innerH 844 при screenH 912) иногда ПЕРЕЖИВАЕТ
    // scroll-nudge (документу нечего скроллить). Касание meta viewport —
    // надёжный kick: WebKit заново применяет viewport-fit=cover.
    try {
      const m = document.querySelector('meta[name="viewport"]');
      if (!m) return;
      const c = m.getAttribute("content") || "";
      if (!c.includes("viewport-fit=cover")) return;
      m.setAttribute("content", c.replace("viewport-fit=cover", "viewport-fit=auto"));
      void document.documentElement.offsetWidth; // reflow между сменами
      m.setAttribute("content", c);
    } catch (_) {}
  }
  function htmlFs(on) {
    // call24: iOS standalone paints the html background (grey --bg) inside the
    // bottom safe-area zone where no fixed element can reach. Toggle a class
    // on <html> so that zone turns black for the whole fullscreen call;
    // :has() proved unreliable on iOS WebKit.
    try { document.documentElement.classList.toggle("call-fs-active", !!on); } catch (_) {}
    // call30g: полоска внизу вернулась после удаления диагностических
    // полосок. LIME-пробка (position:absolute, height:960px, ребёнок <html>)
    // помимо диагностики держала overflow документа на 960px — WebKit в
    // standalone не сжимал видимую область до 844 и красил до физического
    // низа экрана. Возвращаем ТО ЖУ геометрию невидимым спейсером.
    try {
      if (on && !fsSpacer) {
        fsSpacer = document.createElement("div");
        fsSpacer.style.cssText = "position:absolute;top:0;left:0;width:1px;height:960px;pointer-events:none;background:transparent";
        fsSpacer.setAttribute("aria-hidden", "true");
        document.documentElement.appendChild(fsSpacer);
      } else if (!on && fsSpacer) {
        fsSpacer.remove(); fsSpacer = null;
      }
    } catch (_) {}
    // call29: the fs stage is now IN FLOW (position:static) so its paint
    // reaches the physical bottom edge (fixed paint is clipped to the ICB).
    // Pin the window scroll to 0 while fs is active.
    try {
      if (on) {
        fsScrollLockY = window.scrollY || 0;
        window.scrollTo(0, 0);
      } else {
        window.scrollTo(0, 0);
      }
    } catch (_) {}
  }
  function hideOverlay() {
    htmlFs(false);
    if (callOverlay) {
      // call23 FIX: drop the fullscreen state with the overlay. Leaving
      // call-fs in place made the NEXT incoming call render in fullscreen
      // layout, where #call-accept is display:none ("only Decline" bug).
      callOverlay.classList.remove("call-fs");
      const fsStage = callOverlay.querySelector(".call-video-stage");
      if (fsStage) fsStage.style.height = ""; // call26: drop inline px height
      callOverlay.hidden = true;
    }
    // call30b: после fs-звонка iOS может оставить сдвинутый/недосчитанный
    // вьюпорт — строка ввода в чате уезжает ниже экрана. Полный сброс:
    // скролл в 0 + kick вьюпорта + resize (app.js пересчитает --vvh).
    try { window.scrollTo(0, 0); } catch (_) {}
    try { fsViewportKick(); } catch (_) {}
    try { window.dispatchEvent(new Event("resize")); } catch (_) {}
    // call30c: --vvh в app.js слушает ТОЛЬКО visualViewport (window-resize
    // не будит vv) — после звонка композер стоял на stale-высоте («строка
    // ввода ниже»). Дёргаем vv-слушатели явно. Затем серия догонов.
    try { if (window.visualViewport) window.visualViewport.dispatchEvent(new Event("resize")); } catch (_) {}
    [100, 250, 500].forEach(t => setTimeout(() => {
      try { window.scrollTo(0, 0); } catch (_) {}
      try { if (window.visualViewport) window.visualViewport.dispatchEvent(new Event("resize")); } catch (_) {}
    }, t));
    callState = "idle";
  }
  function showCallError(err) {
    const ov = ensureOverlay();
    stopRingback();
    ov.hidden = false;
    const el = ov.querySelector("#call-error");
    el.hidden = false;
    el.textContent = "Не удалось подключить микрофон: " + ((err && err.message) || err || "проверьте разрешение браузера");
  }
  function closeCall(reason) {
    // Notify the callee when the outgoing caller cancels before connection.
    // Without this bye, the callee has no event from which to create
    // "Входящий отменен" in local chat history.
    if (reason === "cancelled" && callDirection === "out" && remotePeer) {
      try { send(remotePeer, { kind: "bye" }); } catch (_) {}
    }
    if (callState !== "idle" && !callRecorded) {
      // v160w6o: callStartedAt > 0 значит соединение состоялось — завершённый
      // звонок с длительностью независимо от reason (bye/failed/disconnect).
      const status = (callState === "connected" || callStartedAt) ? "completed" :
        (reason || (callDirection === "out" ? "cancelled" : "missed"));
      recordCall(status);
    }
    if (pc) pc.close();
    pc = null; remotePeer = null; pendingOffer = null;
    pendingRemoteCandidates = [];
    remoteDescriptionReady = false;
    stopCallTimer();
    stopRingback();
    stopStream();
    if (ring) { clearTimeout(ring); ring = null; }
    const b = btn(); if (b) { b.hidden = !peer(); b.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z\"/></svg>"; b.title = "Аудиозвонок"; }
    const vb = videoBtn(); if (vb) { vb.hidden = !peer(); vb.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"7\" width=\"12\" height=\"10\" rx=\"2.5\"/><path d=\"M15 10.5l6-3v9l-6-3\"/></svg>"; vb.title = "Видеозвонок"; }
    // iOS: полностью освобождаем медиа-элементы, иначе локскрин-плеер (AirPlay) висит после звонка
    const audio = $("call-remote-audio");
    if (audio) { try { audio.pause(); } catch (_) {} audio.srcObject = null; try { audio.load(); } catch (_) {} audio.remove(); }
    const localVideo = $("call-local-video"); if (localVideo) { try { localVideo.pause(); } catch (_) {} localVideo.srcObject = null; try { localVideo.load(); } catch (_) {} }
    const remoteVideo = $("call-remote-video"); if (remoteVideo) { try { remoteVideo.pause(); } catch (_) {} remoteVideo.srcObject = null; try { remoteVideo.load(); } catch (_) {} }
    try { if (navigator.mediaSession) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; } } catch (_) {}
    hideOverlay();
  }
  function ensureAudio() {
    let audio = $("call-remote-audio");
    if (!audio) { audio = document.createElement("audio"); audio.id = "call-remote-audio"; audio.autoplay = true; audio.playsInline = true; audio.style.display = "none"; document.body.appendChild(audio); }
    return audio;
  }
  async function setup(remote) {
    remotePeer = remote;
    // Prefer direct P2P; coturn remains available as a fallback.
    pc = new RTCPeerConnection({ iceServers: ICE, iceTransportPolicy: "all" });
    diagLog("pc", "created");
    pc.onicecandidate = e => {
      if (e.candidate) {
        diagLog("candidate", e.candidate.candidate);
        try { send(remotePeer, { kind: "ice", candidate: e.candidate }); } catch (err) { diagLog("error", "send ICE: " + err.message); }
      } else diagLog("gathering", "complete");
      if (callState === "connecting") setCallState("connecting", remotePeer);
    };
    pc.onicecandidateerror = e => { diagLog("error", (e.errorCode || "") + " " + (e.errorText || "") + " " + (e.url || "")); if (callState === "connecting") setCallState("connecting", remotePeer); };
    pc.onicegatheringstatechange = () => { iceDiag.gathering = pc.iceGatheringState; diagLog("gathering", pc.iceGatheringState); if (callState === "connecting") setCallState("connecting", remotePeer); };
    pc.oniceconnectionstatechange = () => { iceDiag.connection = pc.iceConnectionState; diagLog("ice", pc.iceConnectionState); if (callState === "connecting") setCallState("connecting", remotePeer); };
    pc.ontrack = e => {
      const stream = e.streams[0];
      if (e.track.kind === "video") {
        const video = $("call-remote-video");
        if (video) { video.srcObject = stream; video.play().catch(err => console.warn("[call] remote video play blocked", err)); }
      } else {
        const audio = ensureAudio();
        audio.srcObject = stream;
        // Safari/iOS may not autoplay a MediaStream assigned after the tap.
        const p = audio.play();
        if (p && typeof p.catch === "function") p.catch(err => console.warn("[call] remote audio play blocked", err));
      }
    };
    pc.onconnectionstatechange = () => {
      iceDiag.ws = ws() ? [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED][ws().readyState] : "none";
      diagLog("connection", pc.connectionState);
      if (pc.connectionState === "connected") {
        if (ring) { clearTimeout(ring); ring = null; }
        if (!callStartedAt) callStartedAt = Date.now();
        setCallState("connected", remote);
      }
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) closeCall();
    };
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callMode === "video" });
    const localVideo = $("call-local-video");
    if (localVideo) { localVideo.srcObject = localStream; localVideo.play().catch(() => {}); }
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  async function startCallTo(to, options) {
    if (!to) return;
    options = options || {};
    const responseToIncoming = options.responseToIncoming === true;
    if (!responseToIncoming) callDirection = "out";
    callRecorded = false;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return alert("Звонки не поддерживаются этим браузером");
    if (pc) return;
    setCallState("connecting", to);
    if (!responseToIncoming) startRingback();
    await setup(to);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    send(to, { kind: "offer", mode: callMode, sdp: pc.localDescription }, options);
    const activeBtn = callMode === "video" ? videoBtn() : btn();
    if (activeBtn) { activeBtn.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><g transform=\"rotate(180 12 12)\"><path d=\"M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z\"/></g></svg>"; activeBtn.title = "Завершить звонок"; }
    // This timeout is only for an unanswered outgoing call. It must not run
    // after the call connects; otherwise every conversation ended at ~60s.
    ring = setTimeout(() => { if (callState !== "connected") closeCall(callDirection === "out" ? "declined" : "cancelled"); }, 60000);
  }
  async function startCall(mode) { callMode = mode === "video" ? "video" : "audio"; callModeKnown = true; await startCallTo(peer()); }
  let fsFitHandler = null;
  let fsEnvProbe = null;
  function envSafeBottom() {
    // call28: measure env(safe-area-inset-bottom) at runtime (cached probe div).
    if (!fsEnvProbe) {
      fsEnvProbe = document.createElement("div");
      fsEnvProbe.style.cssText = "position:absolute;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px);padding-top:env(safe-area-inset-top,0px);pointer-events:none";
      (document.body || document.documentElement).appendChild(fsEnvProbe);
    }
    const cs = getComputedStyle(fsEnvProbe);
    return { bottom: parseFloat(cs.paddingBottom) || 0, top: parseFloat(cs.paddingTop) || 0 };
  }
  function fsFitStage() {
    // call26: iOS standalone resolves % heights against a viewport that ends
    // above the physical bottom edge (safe-area zone), so calc(100%+env())
    // still leaves a strip. innerHeight is honest on this device (v160x19
    // lesson) — size the stage in px and keep it synced on resize/rotation.
    const stage = callOverlay && callOverlay.querySelector(".call-video-stage");
    if (!stage) return;
    const fit = () => {
      if (!callOverlay.classList.contains("call-fs")) return;
      // call28/call29: diag (call27) showed innerH=844 vs screenH=912:
      // the viewport excludes both safe zones, and fixed paint is clipped at
      // the ICB bottom. Stage is now in-flow (position:static, call29) and
      // sized to the full physical screen in px.
      const env = envSafeBottom();
      stage.style.height = (window.innerHeight + env.bottom + env.top) + "px";
    };
    fit();
    if (!fsFitHandler) {
      fsFitHandler = fit;
      window.addEventListener("resize", fit);
      if (window.visualViewport) window.visualViewport.addEventListener("resize", fit);
    }
  }
  function enterFs() {
    // call25: fullscreen is the default (and only) video view. Called on
    // accept and on outgoing video start; landscape already looked right,
    // portrait now gets edge-to-edge video too.
    if (!callOverlay || callOverlay.hidden) return;
    if (callOverlay.classList.contains("call-fs")) return;
    callOverlay.classList.add("call-fs");
    htmlFs(true);
    fsFitStage();

  }
  async function acceptCall() {
    if (!pendingOffer) return;
    // call28: fullscreen now driven from setCallState (single source).
    const call = pendingOffer; pendingOffer = null;
    if (call.mode) { callMode = call.mode; callModeKnown = true; }
    callDirection = "in"; callRecorded = false;
    // Push can wake the app without SDP. In that case Accept starts a fresh
    // offer, but this is the already-notified caller's response path: never
    // send a second push back to the initiator, even when it is offline.
    if (!call.signal) return startCallTo(call.from, { push: false, responseToIncoming: true });
    setCallState("connecting", call.from);
    await setup(call.from);
    await pc.setRemoteDescription(call.signal.sdp);
    remoteDescriptionReady = true;
    for (const candidate of pendingRemoteCandidates.splice(0)) {
      try { await pc.addIceCandidate(candidate); } catch (err) { diagLog("error", "queued ICE: " + err.message); }
    }
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    send(call.from, { kind: "answer", sdp: pc.localDescription });
    const activeBtn = callMode === "video" ? videoBtn() : btn();
    if (activeBtn) { activeBtn.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><g transform=\"rotate(180 12 12)\"><path d=\"M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z\"/></g></svg>"; activeBtn.title = "Завершить звонок"; }
  }
  async function onSignal(msg) {
    const from = msg.from_npub; const s = msg.signal;
    if (!from || !s) return;
    if (s.kind === "bye") {
      // v160w6o (Олег 07.10 21:15): продолжительность важнее того, кто положил
      // трубку. Если соединение состоялось (таймер тикал) — у ОБЕИХ сторон в
      // истории завершённый звонок с длительностью, независимо от того,
      // кто инициировал разрыв. Раньше получатель bye писал «отменен».
      closeCall(callStartedAt ? "completed" : (callDirection === "out" ? "declined" : "cancelled"));
      return;
    }
    if (s.kind === "ring") {
      if (!pc && !pendingOffer) { pendingOffer = { from, signal: null, mode: null }; callModeKnown = false; setCallState("incoming", from); }
      return;
    }
    if (s.kind === "offer") {
      // v160w6q (Олег 07.10 22:01 «исходящий отображается как входящий без минут»):
      // glare-разрешение холодного ответа: МЫ звоним (out, connecting), пир
      // проснулся от пуша, принял и выслал СВОЙ fresh offer. Это НЕ входящий:
      // направление остаётся "out", замена полу-открытой связи — без записи
      // в историю (иначе closeCall пишет "missed/Входящий" и callRecorded=true
      // съедает финальный completed с длительностью).
      const glare = callDirection === "out" && remotePeer === from && !!pc;
      if (!glare) callDirection = "in";
      callMode = s.mode === "video" ? "video" : "audio";
      // call25: mode can arrive with the offer AFTER accept (push path) —
      // enter fullscreen then too, not only at accept time.
      if (callState === "connecting" || callState === "connected") enterFs();
      // A cold-start push carries only the caller identity, not SDP. When the
      // Mac accepts, it creates a fresh offer. The iPhone may still have its
      // original outgoing offer/PeerConnection, so replace that half-open
      // connection and answer the Mac's fresh offer.
      if (pc) {
        if (remotePeer && remotePeer !== from) return;
        if (callState !== "connecting") return;
        // glare: закрываем старую полу-открытую связь БЕЗ промежуточной записи
        // (финальный completed с длительностью запишется по завершении).
        if (glare) callRecorded = true;
        closeCall();
        if (glare) callRecorded = false;
        try {
          setCallState("connecting", from);
          await setup(from);
          await pc.setRemoteDescription(s.sdp);
          remoteDescriptionReady = true;
          for (const candidate of pendingRemoteCandidates.splice(0)) {
            try { await pc.addIceCandidate(candidate); } catch (err) { diagLog("error", "queued ICE: " + err.message); }
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send(from, { kind: "answer", sdp: pc.localDescription });
        } catch (err) {
          showCallError(err);
          closeCall();
        }
        return;
      }
      if (pendingOffer && pendingOffer.from === from && !pendingOffer.signal) {
        // push-путь: UI уже показан нейтральным, теперь знаем реальный mode из offer
        pendingOffer.signal = s;
        pendingOffer.mode = s.mode === "video" ? "video" : "audio";
        callMode = pendingOffer.mode;
        callModeKnown = true;
        setCallState("incoming", from);
        return;
      }
      pendingOffer = { from, signal: s, mode: s.mode === "video" ? "video" : "audio" };
      callModeKnown = true;
      setCallState("incoming", from);
      if (ring) clearTimeout(ring);
      ring = setTimeout(() => { if (pendingOffer && !pc) { try { send(from, { kind: "bye" }); } catch (_) {} closeCall(); } }, 60000);
      return;
    }
    // The callee has no PeerConnection while the incoming-call UI is shown.
    // Do not drop the caller's trickle-ICE candidates during that interval;
    // apply them after Accept establishes the remote description.
    if (s.kind === "ice" && !pc) {
      if (pendingOffer && pendingOffer.from === from) {
        pendingRemoteCandidates.push(s.candidate);
        diagLog("ice-queued-before-accept", pendingRemoteCandidates.length);
      }
      return;
    }
    if (!pc || remotePeer !== from) return;
    if (s.kind === "answer") {
      await pc.setRemoteDescription(s.sdp);
      remoteDescriptionReady = true;
      for (const candidate of pendingRemoteCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch (err) { diagLog("error", "queued ICE: " + err.message); }
      }
    }
    if (s.kind === "ice") {
      if (!remoteDescriptionReady) {
        pendingRemoteCandidates.push(s.candidate);
        diagLog("ice-queued", pendingRemoteCandidates.length);
      } else {
        try { await pc.addIceCandidate(s.candidate); } catch (err) { diagLog("error", "ICE: " + err.message); }
      }
    }
  }
  window.MurmurCall = { onSignal, notifyIncoming, close: () => { if (remotePeer) try { send(remotePeer, { kind: "bye" }); } catch (_) {} closeCall(); }, diagnostics: () => ({ ...iceDiag, summary: diagSummary() }) };
  document.addEventListener("DOMContentLoaded", () => {
    const ov = ensureOverlay();
    ov.querySelector("#call-mute").addEventListener("click", () => {
      const track = localStream && localStream.getAudioTracks()[0]; if (!track) return;
      track.enabled = !track.enabled;
      const mb = ov.querySelector("#call-mute");
      mb.innerHTML = track.enabled ? "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5.5 11a6.5 6.5 0 0 0 13 0\"/><path d=\"M12 17.5V21\"/></svg>" : "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5.5 11a6.5 6.5 0 0 0 13 0\"/><path d=\"M12 17.5V21\"/><path d=\"M4 4l16 16\"/></svg>";
      mb.classList.toggle("is-off", !track.enabled);
      mb.setAttribute("aria-label", track.enabled ? "Выключить микрофон" : "Включить микрофон");
    });
    ov.querySelector("#call-camera").addEventListener("click", () => {
      const track = localStream && localStream.getVideoTracks()[0]; if (!track) return;
      track.enabled = !track.enabled;
      const cb = ov.querySelector("#call-camera");
      cb.innerHTML = track.enabled ? "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"7\" width=\"12\" height=\"10\" rx=\"2.5\"/><path d=\"M15 10.5l6-3v9l-6-3\"/></svg>" : "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"3\" y=\"7\" width=\"12\" height=\"10\" rx=\"2.5\"/><path d=\"M15 10.5l6-3v9l-6-3\"/><path d=\"M4 4l16 16\"/></svg>";
      cb.classList.toggle("is-off", !track.enabled);
      cb.setAttribute("aria-label", track.enabled ? "Выключить камеру" : "Включить камеру");
    });
    // v160g4-call10: свой CSS-fullscreen вместо нативного iOS fullscreen.
    // Нативный (webkitEnterFullscreen) на iOS: (а) не даёт наложить локальное
    // PiP-окно, (б) после выхода inline-video замирает на кадре (WebKit-баг).
    // CSS-fullscreen: stage -> position:fixed поверх всего, PiP виден, при
    // выходе тот же stream продолжает рисоваться inline - без замирания.
    const fsBtn = ov.querySelector("#call-fullscreen");
    const setFsLabel = () => {
      if (fsBtn) {
        fsBtn.innerHTML = ov.classList.contains("call-fs") ? "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 9h5V4\"/><path d=\"M20 15h-5v5\"/><path d=\"M9 9l-5-5\"/><path d=\"M15 15l5 5\"/></svg>" : "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M9 4H4v5\"/><path d=\"M15 20h5v-5\"/><path d=\"M4 20l6-6\"/><path d=\"M20 4l-6 6\"/></svg>";
        fsBtn.setAttribute("aria-label", ov.classList.contains("call-fs") ? "Выйти из полноэкранного режима" : "На весь экран");
      }
    };
    if (fsBtn) fsBtn.addEventListener("click", () => {
      ov.classList.toggle("call-fs");
      htmlFs(ov.classList.contains("call-fs"));
      setFsLabel();
    });
    // Esc/аппаратный «назад» закрывает CSS-fullscreen (desktop + Android).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && ov.classList.contains("call-fs")) {
        ov.classList.remove("call-fs");
        htmlFs(false);
        setFsLabel();
      }
    });
  });
  document.addEventListener("DOMContentLoaded", () => {
    const b = btn();
    const vb = videoBtn();
    if (b) b.addEventListener("click", () => { if (pc) window.MurmurCall.close(); else startCall("audio").catch(e => { alert("Не удалось начать звонок: " + e.message); closeCall(); }); });
    if (vb) vb.addEventListener("click", () => { if (pc) window.MurmurCall.close(); else startCall("video").catch(e => { alert("Не удалось начать видеозвонок: " + e.message); closeCall(); }); });
  });
  window.addEventListener("beforeunload", () => { try { window.MurmurCall.close(); } catch (_) {} });
})();
