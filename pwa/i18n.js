// ============================================================================
// i18n.js — MurMur i18n (v160i18n)
// Словарь ru/en + авто-детект (navigator.language, override localStorage)
// + кнопка 🌐 + DOM-pass (MutationObserver переводит динамические перерендеры)
// + обёртки confirm/alert. Логику app.js НЕ трогаем.
// ============================================================================
(function () {
    "use strict";
    const LS_KEY = "murmur_lang"; // "ru" | "en" | null (auto)

    // ── Словарь. Ключ = русская строка-каноникал. en = перевод.
    const dict = {
        // index.html: identity screen + sidebar + placeholders + titles
        "приватный мессенджер": "private messenger",
        "Новый аккаунт": "New account",
        "Создать": "Create",
        "Восстановить": "Restore",
        "Пригласить друга ✉": "Invite a friend ✉",
        "Вставить ссылку 📋": "Paste link 📋",
        "Удалить все данные": "Delete all data",
        "Пригласите друга или вставьте полученную ссылку для начала общения": "Invite a friend or paste a received link to start chatting",
        "Выберите чат": "Select a chat",
        "поиск чатов…": "search chats…",
        "сообщение…": "message…",
        "Включить уведомления": "Enable notifications",
        "Вставить invite-ссылку или npub": "Paste invite link or npub",
        "Назад": "Back",
        "Удалить чат": "Delete chat",
        "Прикрепить файл (до 50 МБ)": "Attach a file (up to 50 MB)",
        "отправить": "send",
        "Чаты": "Chats",
        "назад к списку": "back to list",
        "удалить чат": "delete chat",
        "MurMur требует JavaScript. Включи JS в настройках Safari.": "MurMur requires JavaScript. Enable JS in Safari settings.",
        "Ошибка: ": "Error: ",
        "PWA загружается… подожди (до 30 сек)": "PWA is loading… wait (up to 30 s)",
        "PWA не загрузилась. Проверь интернет и обнови страницу.": "PWA failed to load. Check your connection and reload.",
        "Ошибка создания аккаунта:": "Account creation error:",
        "Ошибка восстановления:": "Restore error:",
        "Введите ключ: 64 символа": "Enter key: 64 characters",

        // app.js: sidebar/empty/preview
        "Пока нет чатов": "No chats yet",
        "Нажмите «Пригласить друга», чтобы отправить ссылку-приглашение.": "Tap \u201cInvite a friend\u201d to send an invite link.",
        "Ничего не найдено по запросу «": "Nothing found for \u201c",
        "Нет сообщений": "No messages",
        "Вчера": "Yesterday",
        "Без имени": "Unnamed",
        "фото": "photo",
        "видео": "video",
        "аудио": "audio",
        "файл": "file",
        "Загрузка…": "Loading…",
        "⏳ Не удалось загрузить историю. Плохой инет — ": "⏳ Failed to load history. Bad connection — ",
        "повторить": "retry",
        "печатает…": "typing…",

        // app.js: invite UI / npub / key modal
        "Вставь invite-ссылку или npub собеседника:": "Paste invite link or peer npub:",
        "Не нашла npub1… в вставленном тексте": "No npub1… found in the pasted text",
        "Ключ не найден (нет аккаунта?)": "Key not found (no account?)",
        "Твой ключ (секрет!)": "Your key (secret!)",
        "Вставь его на другом устройстве / в PWA через «У меня есть ключ». Никому не показывай.": "Paste it on another device / in the PWA via \u201cI have a key\u201d. Never show it to anyone.",
        "Копировать": "Copy",
        "Скопировать": "Copy",
        "Скопировано ✓": "Copied ✓",
        "✓ Скопировано": "✓ Copied",
        "✓ Скопировано — вставьте в MurMur": "✓ Copied — paste into MurMur",
        "✗ Ошибка": "✗ Error",
        "Закрыть": "Close",
        "✕ ЗАКРЫТЬ": "✕ CLOSE",
        "Нажмите, чтобы задать имя": "Tap to set a name",
        "Название чата:": "Chat name:",

        // app.js: notif / cache / warnings
        "Уведомления включены": "Notifications on",
        "— нажми чтобы отключить": "— tap to turn off",
        "Браузер разрешил, но подписки нет — нажми чтобы переподключить": "Browser allowed, but no subscription — tap to reconnect",
        "Уведомления заблокированы в Safari — разрешите в Настройки": "Notifications blocked in Safari — allow in Settings",
        "Браузер не поддерживает уведомления": "Browser does not support notifications",
        "Уведомления заблокированы. Включите в Safari → Настройки сайтов → Уведомления.": "Notifications blocked. Enable in Safari → Settings for Websites → Notifications.",
        "Кэш очищен. Перезагрузи страницу для применения.": "Cache cleared. Reload the page to apply.",
        "Кэш очищен (пуст)": "Cache cleared (empty)",
        "Скрыть": "Hide",
        "Показать": "Show",
        "Очистить": "Clear",

        // app.js: send/attach errors
        "Выберите чат перед прикреплением файла.": "Select a chat before attaching a file.",
        "Модуль шифрования не загрузился:": "Encryption module failed to load:",
        "Не удалось разрешить ключ получателя.": "Failed to resolve peer key.",
        "Не удалось загрузить модуль шифрования (сеть? проверьте соединение и откройте приложение заново).": "Failed to load encryption module (network? check connection and reopen the app).",
        "HEIC/HEIF не поддерживается. Сконвертируйте в JPG/PNG.": "HEIC/HEIF not supported. Convert to JPG/PNG.",
        "Ошибка загрузки: ": "Upload error: ",

        // app.js: dialogs (confirm/alert)
        "Все ваши данные (личность, ключи, история чатов) будут безвозвратно удалены с этого устройства. Продолжить?": "All your data (identity, keys, chat history) will be permanently deleted from this device. Continue?",
        "Удалить чат с «": "Delete chat with \u201c",
        "Чат исчезнет из списка. История хранится только в памяти этого": "The chat will disappear from the list. History is kept only in this",
        "приложения; после удаления сервер не сможет её восстановить.\n\n": "app; the server cannot restore it after deletion.\n\n",
        "Если «": "If \u201c",
        "» пришлёт новое сообщение — чат": "\u201d sends a new message, the chat",
        "вернётся в список автоматически.": "will return to the list automatically.",
        "Адресат не получил сообщение.": "The recipient did not receive the message.",
        "Не доставлено": "Not delivered",

        // app.js: status labels
        "[исходящее, шифрование нарушено]": "[outgoing, encryption broken]",
        "[не удалось расшифровать]": "[decryption failed]",

        // app.js: placeholders in chat (🔒)
        "🔒 шифрованное сообщение": "🔒 encrypted message",
        "🔒 зашифрованное сообщение": "🔒 encrypted message",

        // app.js: invite landing (showInviteLanding inline HTML)
        "Присоединяйся в приватном мессенджере murmur!": "Join me on murmur — the private messenger!",
        "Ссылка скопирована в буфер обмена!": "Link copied to clipboard!",
        "Ссылка-приглашение": "Invite link",
        "Удерживайте палец на поле ниже → «Скопировать», либо нажмите кнопку.": "Press and hold the field below → \u201cCopy\u201d, or tap the button.",
        "Нажмите, чтобы скопировать": "Tap to copy",

        // app.js: PWA install instructions (лендинг-инструкция, B-ветка)
        "1. Внизу Safari жми ⟨Поделиться⟩ (квадрат со стрелкой)": "1. In Safari, tap ⟨Share⟩ (square with arrow)",
        "2. Выбери ⟨На экран „Домой“⟩ → ⟨Добавить⟩": "2. Choose ⟨Add to Home Screen⟩ → ⟨Add⟩",
        "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать": "3. Open murmur from the new icon — the account is created automatically, and the chat is already waiting",
        "1. Внизу Chrome жми ⟨Поделиться⟩ (квадрат со стрелкой)": "1. In Chrome, tap ⟨Share⟩ (square with arrow)",
        "2. Выбери ⟨Открыть в Safari⟩": "2. Choose ⟨Open in Safari⟩",
        "3. Дальше как в Safari: ⟨Поделиться⟩ → ⟨На экран „Домой“⟩ → ⟨Добавить⟩": "3. Then like Safari: ⟨Share⟩ → ⟨Add to Home Screen⟩ → ⟨Add⟩",
        "1. В Chrome жми ⟨⋮⟩ (три точки справа сверху)": "1. In Chrome, tap ⟨⋮⟩ (three dots top right)",
        "2. Выбери ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": "2. Choose ⟨Add to Home Screen⟩ / ⟨Install app⟩",
        "3. Подтверди ⟨Установить⟩ — аккаунт создастся сам, и чат уже будет ждать": "3. Confirm ⟨Install⟩ — the account is created automatically, and the chat is already waiting",
        "1. В Samsung Internet жми ⟨≡⟩ (три полоски снизу справа)": "1. In Samsung Internet, tap ⟨≡⟩ (three lines bottom right)",
        "2. Выбери ⟨Добавить страницу в⟩ → ⟨Экран „Домой“⟩": "2. Choose ⟨Add page to⟩ → ⟨Home screen⟩",
        "1. В Firefox жми ⟨⋮⟩ (три точки)": "1. In Firefox, tap ⟨⋮⟩ (three dots)",
        "2. Выбери ⟨Установить⟩ / ⟨Добавить на главный экран⟩": "2. Choose ⟨Install⟩ / ⟨Add to Home Screen⟩",
        "2. Подтверди ⟨Установить⟩": "2. Confirm ⟨Install⟩",
        "3. murmur откроется в отдельном окне — аккаунт создастся сам, и чат уже будет ждать": "3. murmur opens in a separate window — the account is created automatically, and the chat is already waiting",
        "1. В Chrome жми иконку установки в правой части адресной строки (монитор со стрелкой)": "1. In Chrome, tap the install icon on the right of the address bar (monitor with arrow)",
        "2. Или ⟨⋮ меню⟩ → ⟨Транслировать, сохранить и поделиться⟩ → ⟨Установить страницу как приложение…⟩": "2. Or ⟨⋮ menu⟩ → ⟨Cast, save and share⟩ → ⟨Install page as app…⟩",
        "1. В Safari жми ⟨Файл⟩ (в строке меню Mac)": "1. In Safari, tap ⟨File⟩ (Mac menu bar)",
        "2. Выбери ⟨Добавить в Dock…⟩": "2. Choose ⟨Add to Dock…⟩",
        "3. Подтверди ⟨Добавить⟩ — аккаунт создастся сам, и чат уже будет ждать": "3. Confirm ⟨Add⟩ — the account is created automatically, and the chat is already waiting",
        "1. Найди в меню браузера пункт ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": "1. Find \u201cAdd to Home Screen\u201d / \u201cInstall app\u201d in the browser menu",
        "2. Подтверди установку": "2. Confirm the installation",

        // render-attachments.js: 🔒 строки
        "🔓 расшифровка…": "🔓 decrypting…",
        "не удалось расшифровать": "decryption failed"
    };

    // ── Block-level replacements для invite-лендинга (HTML-фрагменты).
    const htmlBlocks = [
        ["Почему это приватно", "Why this is private"],
        ["Всё хранится на вашем устройстве", "Everything stays on your device"],
        ["— сервер видит только зашифрованные сообщения", "— the server sees only encrypted messages"],
        ["Переписка удаляется с сервера", "Conversations are deleted from the server"],
        ["после доставки", "after delivery"],
        ["Нам не нужно знать", "We never need to know"],
        ["ваши имена, телефоны и почту", "your name, phone or email"],
        ["Нам нечего передавать", "We have nothing to hand over"],
        ["Чтобы принять приглашение", "To accept the invitation"],
        ["MurMur уже установлен?", "MurMur already installed?"],
        ["Нажмите на ссылку</b> — она скопируется, вставьте её в приложение:", "Tap the link</b> — it copies, paste it into the app:"],
        ["✓ Скопировано — вставьте в MurMur", "✓ Copied — paste into MurMur"],
        ["Ещё не установлен? Пара шагов:", "Not installed yet? A few steps:"],
        ["(iPhone/iPad): Поделиться → На экран «Домой»", "(iPhone/iPad): Share → Add to Home Screen"],
        ["(Android/ПК): ⋮ → Добавить на главный экран", "(Android/PC): ⋮ → Add to Home Screen"],
        [": меню → Установить", ": menu → Install"],
        ["Откройте MurMur с новой иконки — аккаунт создастся сам, и чат уже будет ждать", "Open MurMur from the new icon — the account is created automatically, and the chat is already waiting"],
        ["Нажмите на ссылку", "Tap the link"]
    ];

    // ── Resolve current language
    let lang = null;
    try { lang = localStorage.getItem(LS_KEY); } catch (e) {}
    if (lang !== "ru" && lang !== "en") {
        const nl = (navigator.language || "en").toLowerCase();
        lang = nl.startsWith("ru") ? "ru" : "en";
    }
    const isEn = lang === "en";

    // ── Public API
    function t(s) {
        if (!isEn || !s) return s;
        return dict[s] !== undefined ? dict[s] : s;
    }
    function currentLang() { return lang; }
    function setLang(l) {
        try { localStorage.setItem(LS_KEY, l); } catch (e) {}
        location.reload();
    }
    window.MurmurI18N = { t, currentLang, setLang, dict, isEn };

    // ── confirm/alert обёртки (только en-режим)
    if (isEn) {
        const _confirm = window.confirm.bind(window);
        const _alert = window.alert.bind(window);
        window.confirm = function (msg) { return _confirm(t(String(msg))); };
        window.alert = function (msg) { _alert(t(String(msg))); };
    }

    // ── DOM-pass: переводим видимые text-узлы + placeholder/title/aria.
    // MutationObserver → динамические перерендеры (chat-list, messages,
    // invite-лендинг) переводятся БЕЗ трогания логики app.js.
    function translateRoot(root) {
        if (!isEn || !root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                return /[А-Яа-яЁё]/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        for (const tn of nodes) {
            let v = tn.nodeValue;
            for (const [ru, en] of Object.entries(dict)) {
                if (v.indexOf(ru) >= 0) v = v.split(ru).join(en);
            }
            for (const [
ru, en] of htmlBlocks) {
                if (v.indexOf(ru) >= 0) v = v.split(ru).join(en);
            }
            if (v !== tn.nodeValue) tn.nodeValue = v;
        }
        // placeholder/title/aria-label
        if (root.querySelectorAll) {
            for (const el of root.querySelectorAll("[placeholder],[title],[aria-label]")) {
                for (const attr of ["placeholder", "title", "aria-label"]) {
                    const v = el.getAttribute(attr);
                    if (!v || !/[А-Яа-яЁё]/.test(v)) continue;
                    let nv = v;
                    for (const [ru, en] of Object.entries(dict)) {
                        if (nv.indexOf(ru) >= 0) nv = nv.split(ru).join(en);
                    }
                    if (nv !== v) el.setAttribute(attr, nv);
                }
            }
        }
    }

    // ── Кнопка 🌐: (a) в sidebar-header для messenger; (b) на identity-card
    // для identity-экрана (messenger[hidden] — header внутри скрытого дерева).
    function makeLangBtn() {
        const btn = document.createElement("button");
        btn.className = "i18n-btn";
        btn.title = "Language / Язык";
        btn.style.cssText = "background:none;border:none;cursor:pointer;font-size:1.1em;padding:4px 6px;margin-left:2px;opacity:.85;line-height:1;";
        btn.textContent = "🌐";
        btn.addEventListener("click", function () {
            const cur = window.MurmurI18N.currentLang();
            window.MurmurI18N.setLang(cur === "ru" ? "en" : "ru");
        });
        return btn;
    }
    function addLangToggle() {
        // (a) sidebar-header (messenger активен)
        const header = document.querySelector(".sidebar-header");
        if (header && !document.getElementById("btn-lang")) {
            const btn = makeLangBtn();
            btn.id = "btn-lang";
            const anchor = header.querySelector("button");
            if (anchor && anchor.parentNode === header) header.insertBefore(btn, anchor);
            else header.insertBefore(btn, header.firstChild);
        }
        // (b) identity-экран (identity-card показывается при создании/restore).
        // Лендинг-режим: card.style.display="none" (app.js) — кнопка внутри card
        // НЕ видна → ставим fixed в углу ЭКРАНА.
        const scr = document.getElementById("identity-screen");
        const card = scr ? scr.querySelector(".identity-card") : null;
        const msgEl = document.getElementById("messenger");
        const messengerHidden = !msgEl || msgEl.hidden || (msgEl.offsetParent === null && getComputedStyle(msgEl).display === "none");
        const screenActive = scr && scr.getBoundingClientRect().width > 0 &&
            (!messengerHidden || (card && getComputedStyle(card).display !== "none"));
        const landingVisible = !!document.getElementById("invite-landing");
        if (scr && (landingVisible || screenActive) && !document.getElementById("btn-lang-identity")) {
            const btn = makeLangBtn();
            btn.id = "btn-lang-identity";
            btn.style.cssText += "position:fixed;top:10px;right:10px;font-size:1.4em;z-index:9999;";
            scr.appendChild(btn);
        }
    }

    // ── Boot: первичный pass + наблюдатель + кнопка.
    function boot() {
        // Кнопка 🌐 нужна в ОБОИХ режимах (иначе с ru не переключиться на en).
        addLangToggle();
        if (!isEn) return; // ru — родной текст, переводить нечего
        translateRoot(document.body);
        addLangToggle();
        const mo = new MutationObserver(function (muts) {
            // батчим: один pass на мутацию-всплеск
            requestAnimationFrame(function () {
                for (const m of muts) {
                    if (m.type === "childList") {
                        for (const node of m.addedNodes) {
                            if (node.nodeType === 1) translateRoot(node);
                            else if (node.nodeType === 3 && /[А-Яа-яЁё]/.test(node.nodeValue)) translateRoot(node.parentNode || document.body);
                        }
                    } else if (m.type === "characterData" && /[А-Яа-яЁё]/.test(m.target.nodeValue || "")) {
                        translateRoot(m.target.parentNode || document.body);
                    }
                }
            });
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
