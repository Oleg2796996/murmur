// murmur PWA — contacts + chat-list (вынесено из app.js v160z6, 2026-09-26)
// Блоки 677–704 (names) + 1394–1705 (contacts) app.js: loadContactNames,
// setContactName/saveContactName/contactDisplay, loadContacts, setChatPreview
// (монотонность превью), renderChatList.
// Classic script, загружается ДО app.js (index.html) — глобалы общие.
// Зависимости: chat-state (isHiddenPeer/normalizePeer — грузится раньше), groups (renderChatList).

const LS_CONTACT_NAMES = "murmur.contact_names";

function loadContactNames() {
    try { return JSON.parse(localStorage.getItem(LS_CONTACT_NAMES) || "{}"); }
    catch (e) { return {}; }
}

function contactNameKey(peer) {
    return normalizePeer(peer);
}

function contactNameFor(peer, map = loadContactNames()) {
    const key = contactNameKey(peer);
    return map[key] || (key !== peer ? map[peer] : "") || "";
}

function setContactName(peer, name) {
    const key = contactNameKey(peer);
    if (!key || !name) return;
    const map = loadContactNames();
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    // Don't overwrite an existing manual name with a generic one.
    if (map[key] && map[key] === trimmed) return;
    map[key] = trimmed;
    localStorage.setItem(LS_CONTACT_NAMES, JSON.stringify(map));
}

function saveContactName(peer, name) {
    const key = contactNameKey(peer);
    if (!key) return;
    const map = loadContactNames();
    const trimmed = String(name || "").trim().slice(0, 24);
    if (trimmed) map[key] = trimmed;
    else {
        delete map[key];
        if (key !== peer) delete map[peer];
    }
    localStorage.setItem(LS_CONTACT_NAMES, JSON.stringify(map));
}

function contactDisplay(peer) {
    // Privacy v157: npub-fallback убран — без имени показываем «Без имени».
    return contactNameFor(peer) || "Без имени";
}


async function loadContacts() {
    if (!myNpub) return;
    try {
        const r = await fetch(RELAY + "/api/contacts?npub=" + encodeURIComponent(myNpub) + "&_t=" + Date.now(), { cache: "no-store", credentials: "omit" });
        if (!r.ok) return;
        const j = await r.json();
        if (j.contacts) {
            const unreadMap = loadUnreadMap();
            for (const c of j.contacts) {
                const key = normalizePeer(c.peer);
                if (!contacts[key]) {
                    // Новый контакт — восстанавливаем unread из localStorage.
                    contacts[key] = {
                        peer: c.peer,
                        lastMessagePreview: sanitizePreview(c.last_message_preview),
                        lastTs: c.last_ts || 0,
                        unreadCount: unreadMap[key] || 0,
                    };
                } else {
                    // v158c (Олег 22:49 «превью мерцает»): сервер не имеет ключей —
                    // его preview для E2E-сообщений всегда «🔒 зашифрованное…».
                    // Плюс квитанции v158 тоже поднимают server last_ts → условие
                    // «сервер новее» срабатывает постоянно → превью прыгает
                    // туда-сюда каждые ~5s. Если локально уже есть РЕАЛЬНЫЙ текст —
                    // серверным placeholder'ом его НЕ перетирать (ts синхронизируем,
                    // иначе loop). Реальный текст локально всё равно придёт через
                    // pollHist → resyncSidebarPreviews.
                    if (c.last_ts > contacts[key].lastTs) {
                        const serverPrev = sanitizePreview(c.last_message_preview);
                        const localPrev = contacts[key].lastMessagePreview || "";
                        const localReal = localPrev && localPrev !== "🔒 зашифрованное сообщение" && !localPrev.startsWith("{");
                        const serverReal = serverPrev && !serverPrev.startsWith("🔒") && !serverPrev.startsWith("{");
                        // v160t: серверное типовое превью («📎 файл») не содержит текст
                        // сообщения (ct sealed). Локальное «📎 фото · текст» богаче —
                        // не откатывать его до голого типового.
                        const bareServerKind = /^📎 (фото|видео|аудио|файл)( \+\d+)?$/.test(serverPrev.trim());
                        const localHasText = /^📎 .+· .+/.test(localPrev) || (!localPrev.startsWith("📎") && localReal);
                        if (serverReal || (!localReal && !localHasText)) {
                            if (!(bareServerKind && localHasText)) {
                                setChatPreview(key, c.last_ts, serverPrev);
                            }
                        }
                        contacts[key].lastTs = Math.max(contacts[key].lastTs || 0, c.last_ts || 0); // v160x: не откатывать в прошлое
                    }
                    // Не перезаписываем локальный unread с сервера — мы их считаем сами.
                }
            }
            renderChatList();
        }
    } catch (e) { console.warn("loadContacts failed:", e); }
    // Lesson #342 (Олег 2026-08-30): восстановление чатов из локальных хранилищ.
    // Если сервер не вернул контакты (alias race, network drop), чаты исчезают
    // из сайдбара хотя никуда не девались. Merge peers из IDB chats + outbox.
    try {
        const localPeers = new Set();
        if (window.appStore && window.appStore.chats.listPeers) {
            // Lesson #344 (Олег 2026-08-30 14:20 MSK): ключ chats в IDB — это
            // peer (npub БЕЗ владельца), old identities оставались в базе →
            // «12 чатов-призраков». Берём из кэша только тех peers, у которых
            // есть реальные сообщения и peer ≠ мой npub.
            for (const p of (await window.appStore.chats.listPeers())) {
                const np = normalizePeer(p);
                if (!np || np === myNpub) continue;
                const rec = await window.appStore.chats.getMessages(np);
                if (Array.isArray(rec) && rec.length > 0) localPeers.add(np);
            }
        }
        let outbox = {};
        if (window.appStore) {
            outbox = (await window.appStore.kv.get(LS_OUTBOX)) || {};
        } else {
            outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || "{}");
        }
        for (const [k, m] of Object.entries(outbox)) {
            // Lesson #343 (Олег 2026-08-30 13:29 MSK): брать только чаты,
            // относящиеся к ТЕКУЩЕЙ личности. Раньше брали from и to всех
            // записей — в outbox оставались адресаты старых (пересозданных)
            // личностей → в сайдбаре смешивались ключи и чаты.
            if (!m || typeof m !== "object") continue;
            if (m.from === myNpub && m.to && m.to.startsWith("npub1")) localPeers.add(normalizePeer(m.to));
            if (m.to === myNpub && m.from && m.from.startsWith("npub1")) localPeers.add(normalizePeer(m.from));
        }
        let addedAny = false;
        for (const peer of localPeers) {
            if (!peer || isHiddenPeer(peer) || contacts[peer]) continue;
            contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: getUnread(peer) };
            addedAny = true;
        }
        // v160k6 (Олег 2026-09-03 19:00 «превью «Нет сообщений» после перезапуска):
        // Восстановленные контакты имеют пустой preview; resyncSidebarPreviews
        // ходит только по in-memory messages[peer], не по кэшу. Берём последнюю
        // кэш-запись из IDB и строим превью сразу — до проваливания в чат.
        try {
            if (window.appStore && window.appStore.chats.getMessages) {
                for (const peer of Object.keys(contacts)) {
                    const np = normalizePeer(peer);
                    const rec = await window.appStore.chats.getMessages(np);
                    if (Array.isArray(rec) && rec.length > 0) {
                        // v160k7 (Олег 19:19 «показывается первое, а не последнее»: кэш
                        // arr НЕ сортирован по ts (id-порядок загрузки). Берем msg
                        // с МАКСимальным ts — это последнее сообщение.
                        // v160v (Олег 15:05): перебор «Нет сообщений → первое →
                        // последнее» = берём max-ts запись, а её превью часто 🔒
                        // (серверная строка из pollHist без decrypt) → превью
                        // остаётся от СТАРОГО сообщения, потом decrypt апгрейдит.
                        // Правильно: идём от конца (max ts) и берём ПЕРВУЮ запись
                        // с реальным превью — сразу финальный текст, без ступеней.
                        const withTs = rec.filter(m => m && (m.ts || m.created_at_ts || 0))
                            .sort((a, b) => ((b.ts || b.created_at_ts || 0) - (a.ts || a.created_at_ts || 0)));
                        for (const m of withTs) {
                            const prev = sanitizePreview(previewForMsg(m));
                            if (prev && prev !== "🔒 зашифрованное сообщение" && !prev.startsWith("{")) {
                                setChatPreview(peer, m.ts || m.created_at_ts || 0, prev);
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) { /* кэш не готов — превью придёт через resync/pollHist */ }
        if (addedAny || true) {
            console.log("[murmur] restored", localPeers.size, "local peers into contacts");
            renderChatList();
        }
    } catch (e) { console.warn("[murmur] local contact restore failed:", e); }
    // Lesson #344b (Олег 2026-08-30 14:20 MSK): зачистка кэша старых личностей.
    // IDB chats ключуется голым peer без владельца. Периодически вычищаем
    // записи, не относящиеся к текущемуmyNpub (по outbox связке from==myNpub).
    try {
        if (window.appStore && window.appStore.chats.listPeers) {
            const known = new Set(Object.keys(contacts).map(normalizePeer));
            for (const p of (await window.appStore.chats.listPeers())) {
                const np = normalizePeer(p);
                if (np && np !== myNpub && !known.has(np)) {
                    await window.appStore.chats.deleteMessages(np).catch(() => {});
                }
            }
        }
    } catch (e) { /* ignore */ }
    contactsLoaded = true;
}

// v160w (Олег 15:45 «превью бегает»): единый писатель превью с упорядочиванием
// по ts. Десяток асинхронных источников (WS, decrypt-батч, history, resync,
// outbox) писали contacts[peer].lastMessagePreview напрямую — кто последний,
// тот и в DOM: превью «бегало» между старым и новым значением. Теперь любое
// обновление только через setChatPreview: старое ts НЕ затираем, монотонность
// гарантирует ровно одну смену «старое → финальное».
function setChatPreview(peer, ts, preview) {
    if (!contacts[peer]) contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
    const cur = contacts[peer];
    const nts = ts || 0;
    if (!preview) return false;
    // v160x фикс регрессии «Нет сообщений»: серверный last_ts — по НОВЕЙШЕМУ
    // сообщению (часто 🔒-строка без превью), а первое реальное превью в кэше —
    // старее. Старый guard блокировал его навсегда → пустое превью рисовалось
    // как «Нет сообщений». Пустое превью заполняем ВСЕГДА; guard защищает
    // только непустое значение от затирания более старым.
    // v160y4: 🔒/{-плейсхолдер (сервер не имеет ключей) — ЗАМЕНЯЕМЫЙ независимо
    // от ts. Серверный last_ts раздут квитанциями (≥ новейшего реального msg),
    // а реальное превью из IDB-кэша/decrypt несёт ts самого сообщения (< last_ts).
    // v160x-guard «непустое не трогать при более старом ts» держал 🔒 вечно →
    // «Нет сообщений» после reload (v160x лечил только ПУСТОЕ превью).
    // call57 (Олег 15.10.2026): «[исходящее сообщение]» — запечённый fallback
    // (первый poll обогнал warmOutboxCache), НЕ реальный текст. Заменяемый
    // независимо от ts — иначе реальное превью старее не пробьёт guard и
    // заглушка расползается по списку чатов с каждым рестартом.
    const curIsPlaceholder = !cur.lastMessagePreview ||
        cur.lastMessagePreview === "🔒 зашифрованное сообщение" ||
        cur.lastMessagePreview === "[исходящее сообщение]" ||
        cur.lastMessagePreview.startsWith("{");
    if (!curIsPlaceholder && cur.lastTs && nts && nts < cur.lastTs) return false;
    cur.lastMessagePreview = preview;
    cur.lastTs = Math.max(cur.lastTs || 0, nts);
    return true;
}

// Cold-start UX: браузер/PWA может восстановить #chat-list уже у нижней
// границы. Первый рендер должен всегда начинаться с недавно активных чатов
// сверху; после этого пользовательскую позицию сохраняем как раньше.
let chatListHasRendered = false;

// v160w5g4-coldfix: WebKit восстанавливает сохранённый scroll offset
// overflow-контейнеров (и window) НЕ мгновенно при загрузке, а ПОСЛЕ
// нашего первого рендера — поэтому однократный scrollTop=0 на cold-start
// не сработал (проверено Олегом 09.10: «скролл не сработал»). Guard:
// первые ~3с после холодного рендера удерживаем список наверху, пока
// пользователь не тронул список. Каждое принудительное действие пишем в
// window.__murmurListDiag (диагностика вместо слепых сборок, правило
// Олега от 30.09): t, scrollTop/scrollHeight/clientHeight, window.scrollY.
let __chatListTopGuardUntil = 0;
let __chatListTopGuardTimer = null;
function startChatListTopGuard() {
    try {
        __chatListTopGuardUntil = Date.now() + 3000;
        if (__chatListTopGuardTimer) { clearInterval(__chatListTopGuardTimer); __chatListTopGuardTimer = null; }
        if (!window.__murmurListDiag) window.__murmurListDiag = [];
        const snap = (why) => {
            try {
                window.__murmurListDiag.push({ t: Date.now() - __chatListTopGuardUntil + 3000, why,
                    st: chatList.scrollTop, sh: chatList.scrollHeight, ch: chatList.clientHeight, wsy: window.scrollY });
                if (window.__murmurListDiag.length > 200) window.__murmurListDiag.shift();
            } catch (e) {}
        };
        snap("guard-start");
        __chatListTopGuardTimer = setInterval(() => {
            try {
                if (Date.now() >= __chatListTopGuardUntil) {
                    clearInterval(__chatListTopGuardTimer);
                    __chatListTopGuardTimer = null;
                    snap("guard-end");
                    return;
                }
                if (chatList.scrollTop !== 0) {
                    chatList.scrollTop = 0;
                    snap("guard-correct");
                }
            } catch (e) {}
        }, 120);
        // Пользователь тронул список — guard снимается немедленно.
        const cancel = () => {
            try {
                if (__chatListTopGuardTimer) { clearInterval(__chatListTopGuardTimer); __chatListTopGuardTimer = null; }
                __chatListTopGuardUntil = 0;
                snap("guard-user-cancel");
                chatList.removeEventListener("touchstart", cancel);
                chatList.removeEventListener("wheel", cancel);
            } catch (e) {}
        };
        chatList.addEventListener("touchstart", cancel, { passive: true });
        chatList.addEventListener("wheel", cancel, { passive: true });
    } catch (e) {}
}

function renderChatList() {
    const isColdStartRender = !chatListHasRendered;
    const filter = chatSearch.value.toLowerCase().trim();
    // v160x (Олег 2026-09-20): полный rebuild (innerHTML="") сбрасывал скролл
    // списка на КАЖДОЕ входящее сообщение/typing-пинг (20 вызовов) — юзер
    // скроллит, список прыгает к началу. Сохраняем позицию между перерисовками.
    const prevScrollTop = chatList.scrollTop;
    const prevHeight = chatList.scrollHeight;
    chatList.innerHTML = "";
    const nameMap = loadContactNames();
    const sorted = Object.values(contacts)
        .filter(c => {
            // Lesson #129: hidden peers не отображаются в sidebar.
            if (isHiddenPeer(c.peer)) return false;
            if (!filter) return true;
            const display = contactNameFor(c.peer, nameMap).toLowerCase();
            return c.peer.toLowerCase().includes(filter) || display.includes(filter);
        })
        .sort((a, b) => b.lastTs - a.lastTs);

    // v160x3 (Олег 2026-09-20 19:38): empty-state #no-chat («MurMur / Пригласите
    // друга») — flex:1 сосед сайдбара на мобильном → делил экран 50/50.
    // До v160x сайдбар переполнялся (min-height:auto) и выталкивал панель,
    // после фикса сжатия она легла под списком. Показываем ТОЛЬКО когда
    // видимых чатов нет (фильтр поиска не считаем — список рисует свой
    // empty-state «ничего не найдено» внутри).
    updateNoChatVisibility();

    if (sorted.length === 0) {
        const empty = document.createElement("div");
        empty.className = "chat-empty";
        empty.innerHTML =
            "<div class='chat-empty-title'>" +
                (filter ? "Ничего не найдено по запросу «" + escapeHtml(filter) + "»" : "Пока нет чатов") +
            "</div>" +
            "<div class='chat-empty-hint'>" +
                "Нажмите «Пригласить друга», чтобы отправить ссылку-приглашение." +
            "</div>"; // v157b: «+» убран (кнопки нет с v153), только «Пригласить друга»
        chatList.appendChild(empty);
        chatList.scrollTop = 0;
        startChatListTopGuard();
        chatListHasRendered = true;
        return;
    }

    for (const c of sorted) {
        const div = document.createElement("div");
        div.className = "chat-item" + (activePeer === c.peer ? " active" : "");
        // v160u (Олег 14:24): не показывать «🔒 зашифрованное сообщение» в сайдбаре.
        // Сервер отдаёт placeholder (не имеет ключей), локальный decrypt приходит
        // через 1-2 cек — раньше был видимый перебор «🔒 → текст».
        // v160v (Олег 15:05): убрали и перебор «Нет сообщений → … → финальный».
        // Пока данные грузятся (контакты с сервера/кэш не готовы) превью-строка
        // ПУСТАЯ; «Нет сообщений» рисуем только когда данные точно загружены
        // (contactsLoaded) и сообщений реально нет. Пользователь видит одну
        // смену: пусто → финальный текст (или честное «Нет сообщений»).
        const isLockedPlaceholder = c.lastMessagePreview === "🔒 зашифрованное сообщение" || c.lastMessagePreview.startsWith("{");
        const noPreview = !c.lastMessagePreview || isLockedPlaceholder;
        // v160u (Олег 18.09): «печатает…» в превью списка чатов — как в Telegram.
        // Эфемерный typingPeers имеет приоритет над preview (без persist).
        const preview = typingPeers.has(c.peer)
            ? window.MurmurI18N.t("печатает…")
            : noPreview
            ? (contactsLoaded ? "Нет сообщений" : "")
            : (c.lastMessagePreview.length > 60 ? c.lastMessagePreview.slice(0, 60) + "…" : c.lastMessagePreview)
        const name = contactNameFor(c.peer, nameMap);
        // Privacy v157: npub не показываем в списке чатов. Без имени — «Без имени».
        const displayName = name || "Без имени";
        const avatarInitial = (name || "?").slice(0, 1).toUpperCase();
        const avatarColor = avatarColorFor(c.peer);
        // Lesson #v157: active-highlight работал через textContent-сравнение
        // с несуществующим классом .chat-item-peer — никогда не срабатывал.
        // Теперь: data-peer атрибут + dataset-сравнение в openChat.
        const peerDisplay = escapeHtml(displayName);
        const timeDisplay = formatChatTime(c.lastTs);
        const badge = c.unreadCount > 0 ? "<span class='chat-item-badge'>" + c.unreadCount + "</span>" : "";
        const previewEsc = escapeHtml(preview);
        div.setAttribute("data-peer", c.peer);
        div.innerHTML =
            "<div class='chat-item-avatar' style='background:" + avatarColor + "'>" + avatarInitial + "</div>" +
            "<div class='chat-item-body'>" +
                "<div class='chat-item-name'>" + peerDisplay + "</div>" +
                "<div class='chat-item-preview'>" + previewEsc + "</div>" +
            "</div>" +
            "<div class='chat-item-meta'>" +
                "<span class='chat-item-time'>" + timeDisplay + "</span>" +
                badge +
            "</div>";
        // v160w5g (Олег 29.09 07:37 «залипающий тап на чате — зависит от
        // подкраски строки»): click-обработчики на самих .chat-item терялись,
        // когда renderChatList rebuild попадал между touchstart и click
        // (WS/typing-пинги, poll каждые 5с) — узел удалялся, клик умирал.
        // Подкрашенная строка = как раз свежий rebuild (active-класс).
        // Обработчики убраны с итемов; тап ловит ДЕЛЕГИРОВАННЫЙ слушатель
        // на #chat-list (живёт вечно) — setupChatListTap ниже.
        chatList.appendChild(div);
    }
    // v160x: вернуть скролл. Если высота не изменилась — точная позиция;
    // если изменилась (новый чат/фильтр) — держим у низа, если был у низа,
    // иначе клампим в допустимый диапазон (не дальше конца списка).
    try {
        if (isColdStartRender) {
            chatList.scrollTop = 0;
            startChatListTopGuard();
        } else if (chatList.scrollHeight === prevHeight) {
            chatList.scrollTop = prevScrollTop;
        } else {
            const wasAtBottom = prevScrollTop + chatList.clientHeight >= prevHeight - 2;
            if (wasAtBottom) {
                chatList.scrollTop = chatList.scrollHeight;
            } else {
                chatList.scrollTop = Math.min(prevScrollTop, Math.max(0, chatList.scrollHeight - chatList.clientHeight));
            }
        }
    } catch (e) { /* ignore */ }
    chatListHasRendered = true;
    // v160g3: секция «Группы» под личными чатами — локальные группы из
    // groups store, отсортированы по created_ts. Групповые ленты (messages
    // по member_npub с group_id в payload) пока не merge'им — в G4.
    try {
        const groups = loadGroups().slice().sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
        if (groups.length) {
            const hdr = document.createElement("div");
            hdr.className = "sidebar-section-hdr";
            hdr.textContent = "Группы";
            hdr.style.cssText = "padding:10px 12px 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;";
            chatList.appendChild(hdr);
            for (const g of groups) {
                if (filter && !(g.name || "").toLowerCase().includes(filter)) continue;
                const el = document.createElement("div");
                el.className = "chat-item group-item";
                el.dataset.groupId = g.id;
                const membersN = Array.isArray(g.members) ? g.members.length : 0;
                const epoch = g.epoch || 1;
                el.innerHTML =
                    '<div class="chat-item-avatar group-avatar" style="background:#2b5278;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">👥</div>' +
                    '<div class="chat-item-main" style="flex:1;min-width:0;">' +
                    '<div class="chat-item-name" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(g.name || "Группа") + '</div>' +
                    '<div class="chat-item-last" style="font-size:12px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + membersN + ' участн. · эпоха ' + epoch + '</div>' +
                    '</div>';
                el.addEventListener("click", () => {
                    try { openGroupChat(g.id); } catch (e) { console.warn("[murmur] openGroupChat:", e); }
                });
                chatList.appendChild(el);
            }
        }
    } catch (e) { console.warn("[murmur] groups render:", e); }
}

// v160w5g (Олег 29.09 07:37 «залипающий тап на чате»): ЕДИНСТВЕННЫЙ тап-обработчик
// на контейнере #chat-list (существует с загрузки, НЕ пересоздаётся renderChatList).
// Делегирование: e.target.closest(".chat-item") → data-peer → openChat;
// .group-item → data-group-id → openGroupChat. Ни один rebuild не убивает тап.
// touchstart с hover-гейтом НЕ нужен: hover уже в @media (hover:hover) (w5f).
// v160w5g2 (Олег 29.09 07:52 «совсем не проваливается в чат» при w5g):
// w5g вешал слушатель на chatList СРАЗУ при загрузке contacts.js — но contacts.js
// (классик) исполняется ДО app.js, где объявлена const chatList → в момент bind
// chatList ещё не существует, guard молча выходил, обработчик НЕ вешался (урок
// w5d3). Плюс итем-обработчики убраны → тапов нет вообще. Фикс: делегирование
// на DOCUMENT (существует всегда) + ЛЕНИВЫЙ поиск списка внутри обработчика
// (к моменту клика всё загружено).
function setupChatListTap() {
    if (setupChatListTap._bound || !document.addEventListener) return;
    setupChatListTap._bound = true;
    document.addEventListener("click", (e) => {
        try {
            const item = e.target && e.target.closest ? e.target.closest(".chat-item") : null;
            if (!item) return;
            const list = (typeof chatList !== "undefined" && chatList) || document.getElementById("chat-list");
            if (!list || !list.contains(item)) return;
            if (item.classList.contains("group-item")) {
                const gid = item.dataset && item.dataset.groupId;
                if (gid) { try { openGroupChat(gid); } catch (err) { console.warn("[murmur] openGroupChat:", err); } }
                return;
            }
            const peer = item.dataset && item.dataset.peer;
            if (peer && typeof openChat === "function") openChat(peer, { fromUser: true });
        } catch (err) { console.warn("[murmur] chat-list tap:", err); }
    });
}
setupChatListTap();

// v160g7 (Олег 13:32: «Я тапаю на группу, но ничего не происходит»):
// ЗАГЛУШКА БЕЗ ПОЛЯ ВВОДА выглядела как «ничего не произошло» — рисовали
// только состав группы в #chat-panel, inputArea оставалась hidden.
// Теперь группа открывается КАК 1:1 чат: лента + поле ввода + scrollCure.
// Пустая лента = приветственная строка в панели (не заглушка без ввода).
