// ============================================================================
// i18n.js — MurMur i18n (v160y33, 2026-09-24)
// Словарь ru + переводы en/fr/es/de. Авто-детект: navigator.language
// (системный), en — fallback. Кнопка 🌐 циклом ru→en→fr→es→de.
// + DOM-pass (MutationObserver переводит динамические перерендеры)
// + обёртки confirm/alert. Логику app.js НЕ трогаем.
// ============================================================================
(function () {
    "use strict";
    const LS_KEY = "murmur_lang"; // "ru"|"en"|"fr"|"es"|"de"|null (auto)
    const LANGS = ["ru", "en", "fr", "es", "de"];

    // ── Словарь. Ключ = русская строка-каноникал. en = перевод.
    const dict = {
        // index.html: identity screen + sidebar + placeholders + titles
        "приватный мессенджер": { en: "private messenger", fr: "messagerie privée", es: "mensajería privada", de: "privater Messenger" },
        "Новый аккаунт": { en: "New account", fr: "Nouveau compte", es: "Nueva cuenta", de: "Neues Konto" },
        "Создать": { en: "Create", fr: "Créer", es: "Crear", de: "Erstellen" },
        "Восстановить": { en: "Restore", fr: "Restaurer", es: "Restaurar", de: "Wiederherstellen" },
        "Пригласить друга ✉": { en: "Invite a friend ✉", fr: "Inviter un ami ✉", es: "Invitar a un amigo ✉", de: "Freund einladen ✉" },
        "Вставить ссылку 📋": { en: "Paste link 📋", fr: "Coller le lien 📋", es: "Pegar enlace 📋", de: "Link einfügen 📋" },
        "Удалить все данные": { en: "Delete all data", fr: "Supprimer toutes les données", es: "Eliminar todos los datos", de: "Alle Daten löschen" },
        "Пригласите друга или вставьте полученную ссылку для начала общения": { en: "Invite a friend or paste a received link to start chatting", fr: "Invitez un ami ou collez le lien reçu pour commencer", es: "Invita a un amigo o pega el enlace recibido para empezar", de: "Lade einen Freund ein oder füge den erhaltenen Link ein" },
        "Выберите чат": { en: "Select a chat", fr: "Sélectionnez un chat", es: "Selecciona un chat", de: "Chat auswählen" },
        "поиск чатов…": { en: "search chats…", fr: "rechercher…", es: "buscar chats…", de: "Chats suchen…" },
        "сообщение…": { en: "message…", fr: "message…", es: "mensaje…", de: "Nachricht…" },
        "Включить уведомления": { en: "Enable notifications", fr: "Activer les notifications", es: "Activar notificaciones", de: "Benachrichtigungen aktivieren" },
        "Вставить invite-ссылку или npub": { en: "Paste invite link or npub", fr: "Collez le lien d’invitation ou npub", es: "Pega el enlace de invitación o npub", de: "Einladungslink oder npub einfügen" },
        "Назад": { en: "Back", fr: "Retour", es: "Atrás", de: "Zurück" },
        "Удалить чат": { en: "Delete chat", fr: "Supprimer le chat", es: "Eliminar chat", de: "Chat löschen" },
        "Прикрепить файл (до 50 МБ)": { en: "Attach a file (up to 50 MB)", fr: "Joindre un fichier (max 50 Mo)", es: "Adjuntar archivo (hasta 50 MB)", de: "Datei anhängen (max. 50 MB)" },
        "отправить": { en: "send", fr: "envoyer", es: "enviar", de: "senden" },
        "Чаты": { en: "Chats", fr: "Discussions", es: "Chats", de: "Chats" },
        "назад к списку": { en: "back to list", fr: "retour à la liste", es: "volver a la lista", de: "zurück zur Liste" },
        "удалить чат": { en: "delete chat", fr: "supprimer le chat", es: "eliminar chat", de: "Chat löschen" },
        "MurMur требует JavaScript. Включи JS в настройках Safari.": { en: "MurMur requires JavaScript. Enable JS in Safari settings.", fr: "MurMur nécessite JavaScript. Activez JS dans Safari.", es: "MurMur requiere JavaScript. Activa JS en Safari.", de: "MurMur benötigt JavaScript. Aktiviere JS in Safari." },
        "Ошибка: ": { en: "Error: ", fr: "Erreur : ", es: "Error: ", de: "Fehler: " },
        "PWA загружается… подожди (до 30 сек)": { en: "PWA is loading… wait (up to 30 s)", fr: "PWA en cours de chargement… patientez (30 s)", es: "PWA cargando… espera (hasta 30 s)", de: "PWA lädt… warte (bis 30 s)" },
        "PWA не загрузилась. Проверь интернет и обнови страницу.": { en: "PWA failed to load. Check your connection and reload.", fr: "Échec du chargement. Vérifiez la connexion.", es: "La PWA no cargó. Verifica la conexión y recarga.", de: "PWA nicht geladen. Verbindung prüfen und neu laden." },
        "Ошибка создания аккаунта:": { en: "Account creation error:", fr: "Erreur de création du compte :", es: "Error al crear la cuenta:", de: "Fehler beim Erstellen des Kontos:" },
        "Ошибка восстановления:": { en: "Restore error:", fr: "Erreur de restauration :", es: "Error de restauración:", de: "Fehler bei der Wiederherstellung:" },
        "Введите ключ: 64 символа": { en: "Enter key: 64 characters", fr: "Entrez la clé : 64 caractères", es: "Introduce la clave: 64 caracteres", de: "Schlüssel eingeben: 64 Zeichen" },

        // index.html (v160y33): кнопки/лейблы identity
        "Скопировать ключ": { en: "Copy key", fr: "Copier la clé", es: "Copiar clave", de: "Schlüssel kopieren" },
        "Ключ скопирован": { en: "Key copied", fr: "Clé copiée", es: "Clave copiada", de: "Schlüssel kopiert" },
        "Установить приложение": { en: "Install app", fr: "Installer l’application", es: "Instalar app", de: "App installieren" },
        "Приложение установлено": { en: "App installed", fr: "Application installée", es: "App instalada", de: "App installiert" },

        // app.js: sidebar/empty/preview
        "Пока нет чатов": { en: "No chats yet", fr: "Aucune discussion", es: "Aún no hay chats", de: "Noch keine Chats" },
        "Нажмите «Пригласить друга», чтобы отправить ссылку-приглашение.": { en: "Tap \u201cInvite a friend\u201d to send an invite link.", fr: "Touchez « Inviter un ami » pour envoyer un lien.", es: "Toca “Invitar a un amigo” para enviar un enlace.", de: "Tippe „Freund einladen“, um einen Link zu senden." },
        "Ничего не найдено по запросу «": { en: "Nothing found for \u201c", fr: "Aucun résultat pour «", es: "Nada encontrado para “", de: "Nichts gefunden für „" },
        "Нет сообщений": { en: "No messages", fr: "Aucun message", es: "Sin mensajes", de: "Keine Nachrichten" },
        "Вчера": { en: "Yesterday", fr: "Hier", es: "Ayer", de: "Gestern" },
        "Без имени": { en: "Unnamed", fr: "Sans nom", es: "Sin nombre", de: "Ohne Namen" },
        "фото": { en: "photo", fr: "photo", es: "foto", de: "Foto" },
        "видео": { en: "video", fr: "vidéo", es: "vídeo", de: "Video" },
        "аудио": { en: "audio", fr: "audio", es: "audio", de: "Audio" },
        "файл": { en: "file", fr: "fichier", es: "archivo", de: "Datei" },
        "Загрузка…": { en: "Loading…", fr: "Chargement…", es: "Cargando…", de: "Laden…" },
        "⏳ Не удалось загрузить историю. Плохой инет — ": { en: "⏳ Failed to load history. Bad connection — ", fr: "⏳ Échec du chargement de l’historique — ", es: "⏳ No se pudo cargar el historial — ", de: "⏳ Verlauf konnte nicht geladen werden — " },
        "повторить": { en: "retry", fr: "réessayer", es: "reintentar", de: "wiederholen" },
        "печатает…": { en: "typing…", fr: "écrit…", es: "escribiendo…", de: "schreibt…" },

        // app.js: invite UI / npub / key modal
        "Вставь invite-ссылку или npub собеседника:": { en: "Paste invite link or peer npub:", fr: "Collez le lien ou npub du correspondant :", es: "Pega el enlace o npub del contacto:", de: "Einladungslink oder npub des Kontakts:" },
        "Не нашла npub1… в вставленном тексте": { en: "No npub1… found in the pasted text", fr: "Aucun npub1… dans le texte collé", es: "No se encontró npub1… en el texto", de: "Kein npub1… im eingefügten Text" },
        "Ключ не найден (нет аккаунта?)": { en: "Key not found (no account?)", fr: "Clé introuvable (pas de compte ?)", es: "Clave no encontrada (¿sin cuenta?)", de: "Schlüssel nicht gefunden (kein Konto?)" },
        "Твой ключ (секрет!)": { en: "Your key (secret!)", fr: "Ta clé (secret !)", es: "Tu clave (¡secreto!)", de: "Dein Schlüssel (geheim!)" },
        "Вставь его на другом устройстве / в PWA через «У меня есть ключ». Никому не показывай.": { en: "Paste it on another device / in the PWA via \u201cI have a key\u201d. Never show it to anyone.", fr: "Collez-la sur un autre appareil via \u00ab J\u2019ai une cl\u00e9 \u00bb. Ne la montrez \u00e0 personne.", es: "P\u00e9gala en otro dispositivo con \u201cTengo una clave\u201d. No la muestres a nadie.", de: "Auf anderem Ger\u00e4t \u00fcber \u201eIch habe einen Schl\u00fcssel\u201c einf\u00fcgen. Niemals zeigen." },
        "Копировать": { en: "Copy", fr: "Copier", es: "Copiar", de: "Kopieren" },
        "Скопировать": { en: "Copy", fr: "Copier", es: "Copiar", de: "Kopieren" },
        "Скопировано ✓": { en: "Copied ✓", fr: "Copié ✓", es: "Copiado ✓", de: "Kopiert ✓" },
        "✓ Скопировано": { en: "✓ Copied", fr: "✓ Copié", es: "✓ Copiado", de: "✓ Kopiert" },
        "✓ Скопировано — вставьте в MurMur": { en: "✓ Copied — paste into MurMur", fr: "✓ Copié — collez dans MurMur", es: "✓ Copiado — pega en MurMur", de: "✓ Kopiert — in MurMur einfügen" },
        "✗ Ошибка": { en: "✗ Error", fr: "✗ Erreur", es: "✗ Error", de: "✗ Fehler" },
        "Закрыть": { en: "Close", fr: "Fermer", es: "Cerrar", de: "Schließen" },
        "✕ ЗАКРЫТЬ": { en: "✕ CLOSE", fr: "✕ FERMER", es: "✕ CERRAR", de: "✕ SCHLIESSEN" },
        "Нажмите, чтобы задать имя": { en: "Tap to set a name", fr: "Touchez pour définir un nom", es: "Toca para poner un nombre", de: "Tippen für Namen" },
        "Название чата:": { en: "Chat name:", fr: "Nom du chat :", es: "Nombre del chat:", de: "Chatname:" },

        // app.js: notif / cache / warnings
        "Уведомления включены": { en: "Notifications on", fr: "Notifications activées", es: "Notificaciones activadas", de: "Benachrichtigungen an" },
        "— нажми чтобы отключить": { en: "— tap to turn off", fr: "— touchez pour d\u00e9sactiver", es: "— toca para desactivar", de: "— tippen zum Deaktivieren" },
        "Браузер разрешил, но подписки нет — нажми чтобы переподключить": { en: "Browser allowed, but no subscription — tap to reconnect", fr: "Navigateur OK, pas d’abonnement — touchez pour reconnecter", es: "Navegador OK, sin suscripción — toca para reconectar", de: "Browser OK, kein Abo — tippen zum Neuverbinden" },
        "Уведомления заблокированы в Safari — разрешите в Настройки": { en: "Notifications blocked in Safari — allow in Settings", fr: "Notifications bloquées dans Safari — autorisez dans Réglages", es: "Notificaciones bloqueadas en Safari — permite en Ajustes", de: "Benachrichtigungen in Safari blockiert — in Einstellungen erlauben" },
        "Браузер не поддерживает уведомления": { en: "Browser does not support notifications", fr: "Le navigateur ne supporte pas les notifications", es: "El navegador no admite notificaciones", de: "Browser unterstützt keine Benachrichtigungen" },
        "Уведомления заблокированы. Включите в Safari → Настройки сайтов → Уведомления.": { en: "Notifications blocked. Enable in Safari → Settings for Websites → Notifications.", fr: "Notifications bloqu\u00e9es. Activez dans Safari → Sites → Notifications.", es: "Notificaciones bloqueadas. Activa en Safari → Sitios → Notificaciones.", de: "Blockiert. Safari → Website-Einstellungen → Mitteilungen." },
        "Кэш очищен. Перезагрузи страницу для применения.": { en: "Cache cleared. Reload the page to apply.", fr: "Cache vid\u00e9. Rechargez la page.", es: "Cach\u00e9 borrado. Recarga la p\u00e1gina.", de: "Cache geleert. Seite neu laden." },
        "Кэш очищен (пуст)": { en: "Cache cleared (empty)", fr: "Cache vidé (vide)", es: "Caché borrado (vacío)", de: "Cache geleert (leer)" },
        "Скрыть": { en: "Hide", fr: "Masquer", es: "Ocultar", de: "Ausblenden" },
        "Показать": { en: "Show", fr: "Afficher", es: "Mostrar", de: "Anzeigen" },
        "Очистить": { en: "Clear", fr: "Effacer", es: "Borrar", de: "Leeren" },

        // app.js: send/attach errors
        "Выберите чат перед прикреплением файла.": { en: "Select a chat before attaching a file.", fr: "Sélectionnez un chat avant de joindre.", es: "Selecciona un chat antes de adjuntar.", de: "Chat vor dem Anhängen wählen." },
        "Модуль шифрования не загрузился:": { en: "Encryption module failed to load:", fr: "Échec du module de chiffrement :", es: "Falló el módulo de cifrado:", de: "Verschlüsselungsmodul nicht geladen:" },
        "Не удалось разрешить ключ получателя.": { en: "Failed to resolve peer key.", fr: "Cl\u00e9 du destinataire introuvable.", es: "No se pudo resolver la clave del contacto.", de: "Kontakt-Schl\u00fcssel nicht aufgel\u00f6st." },
        "Не удалось загрузить модуль шифрования (сеть? проверьте соединение и откройте приложение заново).": { en: "Failed to load encryption module (network? check connection and reopen the app).", fr: "\u00c9chec du module de chiffrement (r\u00e9seau ?)", es: "Fall\u00f3 el m\u00f3dulo de cifrado (\u00bfred?)", de: "Verschl\u00fcsselungsmodul nicht geladen (Netzwerk?)" },
        "HEIC/HEIF не поддерживается. Сконвертируйте в JPG/PNG.": { en: "HEIC/HEIF not supported. Convert to JPG/PNG.", fr: "HEIC/HEIF non supporté. Convertissez en JPG/PNG.", es: "HEIC/HEIF no admitido. Convierte a JPG/PNG.", de: "HEIC/HEIF nicht unterstützt. Zu JPG/PNG konvertieren." },
        "Ошибка загрузки: ": { en: "Upload error: ", fr: "Erreur d’envoi : ", es: "Error de subida: ", de: "Fehler beim Hochladen: " },

        // app.js: dialogs (confirm/alert)
        "Все ваши данные (личность, ключи, история чатов) будут безвозвратно удалены с этого устройства. Продолжить?": { en: "All your data (identity, keys, chat history) will be permanently deleted from this device. Continue?", fr: "Toutes vos donn\u00e9es seront supprim\u00e9es d\u00e9finitivement. Continuer ?", es: "Todos tus datos se borrar\u00e1n permanentemente. \u00bfContinuar?", de: "Alle Daten werden unwiderruflich gel\u00f6scht. Fortfahren?" },
        "Удалить чат с «": { en: "Delete chat with \u201c", fr: "Supprimer le chat avec \u00ab", es: "Eliminar chat con \u201c", de: "Chat l\u00f6schen mit \u201e" },
        "Чат исчезнет из списка. История хранится только в памяти этого": { en: "The chat will disappear from the list. History is kept only in this", fr: "Le chat disparaîtra de la liste. L’historique reste sur cet", es: "El chat desaparecerá de la lista. El historial queda en este", de: "Der Chat verschwindet aus der Liste. Verlauf nur auf diesem" },
        "приложения; после удаления сервер не сможет её восстановить.\n\n": { en: "app; the server cannot restore it after deletion.\n\n", fr: "application ; le serveur ne pourra pas la restaurer.\n\n", es: "app; el servidor no podr\u00e1 restaurarlo.\n\n", de: "App; der Server kann sie nicht wiederherstellen.\n\n" },
        "Если «": { en: "If \u201c", fr: "Si \u00ab", es: "Si \u201c", de: "Wenn \u201e" },
        "» пришлёт новое сообщение — чат": { en: "\u201d sends a new message, the chat", fr: "\u00bb envoie un message, le chat", es: "\u201d env\u00eda un mensaje, el chat", de: "\u201c eine neue Nachricht sendet, der Chat" },
        "вернётся в список автоматически.": { en: "will return to the list automatically.", fr: "reviendra automatiquement dans la liste.", es: "volver\u00e1 a la lista autom\u00e1ticamente.", de: "kehrt automatisch zur\u00fcck." },
        "Адресат не получил сообщение.": { en: "The recipient did not receive the message.", fr: "Le destinataire n’a pas reçu le message.", es: "El destinario no recibió el mensaje.", de: "Der Empfänger hat die Nachricht nicht erhalten." },
        "Не доставлено": { en: "Not delivered", fr: "Non remis", es: "No entregado", de: "Nicht zugestellt" },

        // app.js: status labels
        "[исходящее, шифрование нарушено]": { en: "[outgoing, encryption broken]", fr: "[sortant, chiffrement cassé]", es: "[saliente, cifrado roto]", de: "[ausgehend, Verschlüsselung defekt]" },
        "[не удалось расшифровать]": { en: "[decryption failed]", fr: "[\u00e9chec du d\u00e9chiffrement]", es: "[fallo de descifrado]", de: "[Entschl\u00fcsselung fehlgeschlagen]" },

        // app.js: placeholders in chat (🔒)
        "🔒 шифрованное сообщение": { en: "🔒 encrypted message", fr: "🔒 message chiffré", es: "🔒 mensaje cifrado", de: "🔒 verschlüsselte Nachricht" },
        "🔒 зашифрованное сообщение": { en: "🔒 encrypted message", fr: "🔒 message chiffré", es: "🔒 mensaje cifrado", de: "🔒 verschlüsselte Nachricht" },

        // app.js: invite landing (showInviteLanding inline HTML)
        "Присоединяйся в приватном мессенджере murmur!": { en: "Join me on murmur — the private messenger!", fr: "Rejoins-moi sur murmur — la messagerie priv\u00e9e !", es: "\u00danete a murmur — la mensajer\u00eda privada!", de: "Komm zu murmur — dem privaten Messenger!" },
        "Ссылка скопирована в буфер обмена!": { en: "Link copied to clipboard!", fr: "Lien copié !", es: "¡Enlace copiado!", de: "Link kopiert!" },
        "Ссылка-приглашение": { en: "Invite link", fr: "Lien d’invitation", es: "Enlace de invitación", de: "Einladungslink" },
        "Удерживайте палец на поле ниже → «Скопировать», либо нажмите кнопку.": { en: "Press and hold the field below → \u201cCopy\u201d, or tap the button.", fr: "Maintenez le champ → \u00ab Copier \u00bb, ou touchez le bouton.", es: "Mant\u00e9n el campo → \u201cCopiar\u201d, o toca el bot\u00f3n.", de: "Feld gedr\u00fcckt halten → \u201eKopieren\u201c, oder Taste tippen." },
        "Нажмите, чтобы скопировать": { en: "Tap to copy", fr: "Touchez pour copier", es: "Toca para copiar", de: "Tippen zum Kopieren" },

        // app.js: PWA install instructions (лендинг-инструкция, B-ветка)
        "1. Внизу Safari жми ⟨Поделиться⟩ (квадрат со стрелкой)": { en: "1. In Safari, tap ⟨Share⟩ (square with arrow)", fr: "1. Dans Safari, touchez ⟨Partager⟩", es: "1. En Safari, toca ⟨Compartir⟩", de: "1. In Safari ⟨Teilen⟩ tippen" },
        "2. Выбери ⟨На экран „Домой“⟩ → ⟨Добавить⟩": { en: "2. Choose ⟨Add to Home Screen⟩ → ⟨Add⟩", fr: "2. Choisissez ⟨Sur l’écran d’accueil⟩ → ⟨Ajouter⟩", es: "2. Elige ⟨Añadir a inicio⟩ → ⟨Añadir⟩", de: "2. ⟨Zum Home-Bildschirm⟩ → ⟨Hinzufügen⟩" },
        "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать": { en: "3. Open murmur from the new icon — the account is created automatically, and the chat is already waiting", fr: "3. Ouvrez murmur depuis la nouvelle ic\u00f4ne — le compte se cr\u00e9e, le chat attend", es: "3. Abre murmur desde el icono nuevo — la cuenta se crea sola", de: "3. murmur \u00fcber das neue Icon \u00f6ffnen — Konto wird erstellt" },
        "1. Внизу Chrome жми ⟨Поделиться⟩ (квадрат со стрелкой)": { en: "1. In Chrome, tap ⟨Share⟩ (square with arrow)", fr: "1. Dans Chrome, touchez ⟨Partager⟩", es: "1. En Chrome, toca ⟨Compartir⟩", de: "1. In Chrome ⟨Teilen⟩ tippen" },
        "2. Выбери ⟨Открыть в Safari⟩": { en: "2. Choose ⟨Open in Safari⟩", fr: "2. Choisissez ⟨Ouvrir dans Safari⟩", es: "2. Elige ⟨Abrir en Safari⟩", de: "2. ⟨In Safari öffnen⟩" },
        "3. Дальше как в Safari: ⟨Поделиться⟩ → ⟨На экран „Домой“⟩ → ⟨Добавить⟩": { en: "3. Then like Safari: ⟨Share⟩ → ⟨Add to Home Screen⟩ → ⟨Add⟩", fr: "3. Puis comme Safari : ⟨Partager⟩ → ⟨\u00c9cran d\u2019accueil⟩", es: "3. Luego como Safari: ⟨Compartir⟩ → ⟨A\u00f1adir a inicio⟩", de: "3. Wie Safari: ⟨Teilen⟩ → ⟨Home-Bildschirm⟩" },
        "1. В Chrome жми ⟨⋮⟩ (три точки справа сверху)": { en: "1. In Chrome, tap ⟨⋮⟩ (three dots top right)", fr: "1. Dans Chrome, touchez ⟨⋮⟩ (trois points)", es: "1. En Chrome, toca ⟨⋮⟩ (tres puntos arriba)", de: "1. In Chrome ⟨⋮⟩ (drei Punkte oben)" },
        "2. Выбери ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": { en: "2. Choose ⟨Add to Home Screen⟩ / ⟨Install app⟩", fr: "2. Choisissez ⟨Ajouter à l’écran d’accueil⟩ / ⟨Installer⟩", es: "2. Elige ⟨Añadir a inicio⟩ / ⟨Instalar app⟩", de: "2. ⟨Zum Startbildschirm⟩ / ⟨App installieren⟩" },
        "3. Подтверди ⟨Установить⟩ — аккаунт создастся сам, и чат уже будет ждать": { en: "3. Confirm ⟨Install⟩ — the account is created automatically, and the chat is already waiting", fr: "3. Confirmez ⟨Installer⟩ — le compte se cr\u00e9e, le chat attend", es: "3. Confirma ⟨Instalar⟩ — la cuenta se crea sola", de: "3. ⟨Installieren⟩ best\u00e4tigen — Konto wird erstellt" },
        "1. В Samsung Internet жми ⟨≡⟩ (три полоски снизу справа)": { en: "1. In Samsung Internet, tap ⟨≡⟩ (three lines bottom right)", fr: "1. Dans Samsung Internet, touchez ⟨≡⟩", es: "1. En Samsung Internet, toca ⟨≡⟩", de: "1. In Samsung Internet ⟨≡⟩ (unten)" },
        "2. Выбери ⟨Добавить страницу в⟩ → ⟨Экран „Домой“⟩": { en: "2. Choose ⟨Add page to⟩ → ⟨Home screen⟩", fr: "2. Choisissez ⟨Ajouter la page à⟩ → ⟨Écran d’accueil⟩", es: "2. Elige ⟨Añadir página a⟩ → ⟨Inicio⟩", de: "2. ⟨Seite hinzufügen zu⟩ → ⟨Startbildschirm⟩" },
        "1. В Firefox жми ⟨⋮⟩ (три точки)": { en: "1. In Firefox, tap ⟨⋮⟩ (three dots)", fr: "1. Dans Firefox, touchez ⟨⋮⟩", es: "1. En Firefox, toca ⟨⋮⟩", de: "1. In Firefox ⟨⋮⟩" },
        "2. Выбери ⟨Установить⟩ / ⟨Добавить на главный экран⟩": { en: "2. Choose ⟨Install⟩ / ⟨Add to Home Screen⟩", fr: "2. Choisissez ⟨Installer⟩ / ⟨Ajouter à l’écran⟩", es: "2. Elige ⟨Instalar⟩ / ⟨Añadir a inicio⟩", de: "2. ⟨Installieren⟩ / ⟨Zum Startbildschirm⟩" },
        "2. Подтверди ⟨Установить⟩": { en: "2. Confirm ⟨Install⟩", fr: "2. Confirmez ⟨Installer⟩", es: "2. Confirma ⟨Instalar⟩", de: "2. ⟨Installieren⟩ bestätigen" },
        "3. murmur откроется в отдельном окне — аккаунт создастся сам, и чат уже будет ждать": { en: "3. murmur opens in a separate window — the account is created automatically, and the chat is already waiting", fr: "3. murmur s\u2019ouvre dans une fen\u00eatre — le compte se cr\u00e9e", es: "3. murmur se abre en ventana — la cuenta se crea sola", de: "3. murmur \u00f6ffnet in eigenem Fenster — Konto wird erstellt" },
        "1. В Chrome жми иконку установки в правой части адресной строки (монитор со стрелкой)": { en: "1. In Chrome, tap the install icon on the right of the address bar (monitor with arrow)", fr: "1. Dans Chrome, l\u2019ic\u00f4ne d\u2019installation dans la barre", es: "1. En Chrome, el icono de instalaci\u00f3n en la barra", de: "1. In Chrome das Install-Icon in der Adressleiste" },
        "2. Или ⟨⋮ меню⟩ → ⟨Транслировать, сохранить и поделиться⟩ → ⟨Установить страницу как приложение…⟩": { en: "2. Or ⟨⋮ menu⟩ → ⟨Cast, save and share⟩ → ⟨Install page as app…⟩", fr: "2. Ou ⟨⋮ menu⟩ → ⟨Diffuser, enregistrer, partager⟩ → ⟨Installer⟩", es: "2. O ⟨⋮ menú⟩ → ⟨Transmitir, guardar, compartir⟩", de: "2. Oder ⟨⋮ Menü⟩ → ⟨Installieren als App…⟩" },
        "1. В Safari жми ⟨Файл⟩ (в строке меню Mac)": { en: "1. In Safari, tap ⟨File⟩ (Mac menu bar)", fr: "1. Dans Safari, touchez ⟨Fichier⟩ (barre Mac)", es: "1. En Safari, toca ⟨Archivo⟩ (men\u00fa Mac)", de: "1. In Safari ⟨Ablage⟩ (Mac-Men\u00fcleiste)" },
        "2. Выбери ⟨Добавить в Dock…⟩": { en: "2. Choose ⟨Add to Dock…⟩", fr: "2. Choisissez ⟨Ajouter au Dock…⟩", es: "2. Elige ⟨Añadir al Dock…⟩", de: "2. ⟨Zum Dock hinzufügen…⟩" },
        "3. Подтверди ⟨Добавить⟩ — аккаунт создастся сам, и чат уже будет ждать": { en: "3. Confirm ⟨Add⟩ — the account is created automatically, and the chat is already waiting", fr: "3. Confirmez ⟨Ajouter⟩ — le compte se cr\u00e9e, le chat attend", es: "3. Confirma ⟨A\u00f1adir⟩ — la cuenta se crea sola", de: "3. ⟨Hinzuf\u00fcgen⟩ best\u00e4tigen — Konto wird erstellt" },
        "1. Найди в меню браузера пункт ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": { en: "1. Find \u201cAdd to Home Screen\u201d / \u201cInstall app\u201d in the browser menu", fr: "1. Trouvez \u00ab Ajouter \u00e0 l\u2019\u00e9cran \u00bb dans le menu", es: "1. Busca \u201cA\u00f1adir a inicio\u201d en el men\u00fa", de: "1. \u201eZum Startbildschirm\u201c im Men\u00fc" },
        "2. Подтверди установку": { en: "2. Confirm the installation", fr: "2. Confirmez l’installation", es: "2. Confirma la instalación", de: "2. Installation bestätigen" },

        // render-attachments.js: 🔒 строки
        "🔓 расшифровка…": { en: "🔓 decrypting…", fr: "🔓 déchiffrement…", es: "🔓 descifrando…", de: "🔓 Entschlüsselung…" },
        "не удалось расшифровать": { en: "decryption failed", fr: "\u00e9chec du d\u00e9chiffrement", es: "fallo de descifrado", de: "Entschl\u00fcsselung fehlgeschlagen" }
    };

    // ── Block-level replacements для invite-лендинга (HTML-фрагменты).
    const htmlBlocks = [
        ["Почему это приватно", { en: "Why this is private", fr: "Pourquoi c\u2019est priv\u00e9", es: "Por qu\u00e9 es privado", de: "Warum das privat ist" }],
        ["Всё хранится на вашем устройстве", { en: "Everything stays on your device", fr: "Tout reste sur votre appareil", es: "Todo queda en tu dispositivo", de: "Alles bleibt auf deinem Ger\u00e4t" }],
        ["— сервер видит только зашифрованные сообщения", { en: "— the server sees only encrypted messages", fr: "— le serveur ne voit que du chiffr\u00e9", es: "— el servidor solo ve cifrado", de: "— der Server sieht nur Verschl\u00fcsseltes" }],
        ["Переписка удаляется с сервера", { en: "Conversations are deleted from the server", fr: "Les conversations sont supprim\u00e9es du serveur", es: "Las conversaciones se borran del servidor", de: "Unterhaltungen werden vom Server gel\u00f6scht" }],
        ["после доставки", { en: "after delivery", fr: "apr\u00e8s remise", es: "tras la entrega", de: "nach Zustellung" }],
        ["Нам не нужно знать", { en: "We never need to know", fr: "Nous n\u2019avons pas besoin de savoir", es: "No necesitamos saber", de: "Wir m\u00fcssen nicht wissen" }],
        ["ваши имена, телефоны и почту", { en: "your name, phone or email", fr: "vos noms, t\u00e9l\u00e9phones et e-mails", es: "tus nombres, tel\u00e9fonos y correo", de: "Namen, Telefonnummern und E-Mails" }],
        ["Нам нечего передавать", { en: "We have nothing to hand over", fr: "Nous n\u2019avons rien \u00e0 remettre", es: "No tenemos nada que entregar", de: "Wir haben nichts herauszugeben" }],
        ["Чтобы принять приглашение", { en: "To accept the invitation", fr: "Pour accepter l\u2019invitation", es: "Para aceptar la invitaci\u00f3n", de: "Um die Einladung anzunehmen" }],
        ["MurMur уже установлен?", { en: "MurMur already installed?", fr: "MurMur d\u00e9j\u00e0 install\u00e9 ?", es: "\u00bfMurMur ya instalado?", de: "MurMur schon installiert?" }],
        ["Нажмите на ссылку</b> — она скопируется, вставьте её в приложение:", { en: "Tap the link</b> — it copies, paste it into the app:", fr: "Touchez le lien</b> — il se copie, collez-le dans l\u2019application :", es: "Toca el enlace</b> — se copia, p\u00e9galo en la app:", de: "Link antippen</b> — kopiert, in der App einf\u00fcgen:" }],
        ["✓ Скопировано — вставьте в MurMur", { en: "✓ Copied — paste into MurMur", fr: "✓ Copi\u00e9 — collez dans MurMur", es: "✓ Copiado — pega en MurMur", de: "✓ Kopiert — in MurMur einf\u00fcgen" }],
        ["Ещё не установлен? Пара шагов:", { en: "Not installed yet? A few steps:", fr: "Pas encore install\u00e9 ? Quelques \u00e9tapes :", es: "\u00bfA\u00fan no instalado? Unos pasos:", de: "Noch nicht installiert? Ein paar Schritte:" }],
        ["(iPhone/iPad): Поделиться → На экран «Домой»", { en: "(iPhone/iPad): Share → Add to Home Screen", fr: "(iPhone/iPad) : Partager → \u00c9cran d\u2019accueil", es: "(iPhone/iPad): Compartir → A\u00f1adir a inicio", de: "(iPhone/iPad): Teilen → Home-Bildschirm" }],
        ["(Android/ПК): ⋮ → Добавить на главный экран", { en: "(Android/PC): ⋮ → Add to Home Screen", fr: "(Android/PC) : ⋮ → Ajouter \u00e0 l\u2019\u00e9cran d\u2019accueil", es: "(Android/PC): ⋮ → A\u00f1adir a inicio", de: "(Android/PC): ⋮ → Zum Startbildschirm" }],
        [": меню → Установить", { en: ": menu → Install", fr: ": menu → Installer", es: ": men\u00fa → Instalar", de: ": Men\u00fc → Installieren" }],
        ["Откройте MurMur с новой иконки — аккаунт создастся сам, и чат уже будет ждать", { en: "Open MurMur from the new icon — the account is created automatically, and the chat is already waiting", fr: "Ouvrez MurMur depuis la nouvelle ic\u00f4ne — le compte se cr\u00e9e, le chat attend", es: "Abre MurMur desde el icono nuevo — la cuenta se crea sola", de: "MurMur \u00fcber das neue Icon \u00f6ffnen — Konto wird erstellt" }],
        ["Нажмите на ссылку", { en: "Tap the link", fr: "Touchez le lien", es: "Toca el enlace", de: "Link antippen" }]
    ];

    // ── Resolve current language (v160y33: системный детект, en fallback)
    // Приоритет: localStorage → navigator.language (ru/en/fr/es/de префиксы)
    // → en. Системный язык используется, если пользователь не выбирал вручную.
    const SYS_PREFIXES = ["ru", "en", "fr", "es", "de"];
    let lang = null;
    try { lang = localStorage.getItem(LS_KEY); } catch (e) {}
    if (lang !== "ru" && lang !== "en" && lang !== "fr" && lang !== "es" && lang !== "de") {
        const nl = (navigator.language || "en").toLowerCase();
        lang = SYS_PREFIXES.find(function (p) { return nl.startsWith(p); }) || "en";
    }
    const isEn = lang === "en";
    const isRu = lang === "ru";
    const isFr = lang === "fr";
    const isEs = lang === "es";
    const isDe = lang === "de";

    // ── Public API (v160y33: t() выбирает перевод по активному языку)
    function pick(entry) {
        if (!entry) return null;
        if (typeof entry === "string") return isEn ? entry : null; // старые ru→en пары: только en
        return entry[lang] || entry.en || null;
    }
    function t(s) {
        if (isRu || !s) return s; // ru — родной текст, переводить нечего
        const e = dict[s];
        if (e === undefined) return s;
        const v = pick(e);
        return v !== null ? v : s;
    }
    function currentLang() { return lang; }
    function nextLang(l) {
        const i = LANGS.indexOf(l);
        return LANGS[(i + 1) % LANGS.length];
    }
    function setLang(l) {
        try { localStorage.setItem(LS_KEY, l); } catch (e) {}
        location.reload();
    }
    window.MurmurI18N = { t, currentLang, setLang, dict, isEn };

    // ── confirm/alert/prompt обёртки (v160y49: prompt добавлен — Олег 23:37:
    // «когда меняешь название чата всегда на русском» — prompt("Название чата:")
    // в app.js переименование чата нативный, DOM-pass его не трогает). Обёртки
    // в не-ru режиме (en/fr/es/de), ru — родной текст, переводить нечего.
    if (!isRu) {
        const _confirm = window.confirm.bind(window);
        const _alert = window.alert.bind(window);
        const _prompt = window.prompt.bind(window);
        window.confirm = function (msg) { return _confirm(t(String(msg))); };
        window.alert = function (msg) { _alert(t(String(msg))); };
        window.prompt = function (msg, def) { return _prompt(t(String(msg)), def); };
    }

    // ── DOM-pass: переводим видимые text-узлы + placeholder/title/aria (v160y33:
    // работает для en/fr/es/de — активный не-ru язык). Мутация → динамические
    // перерендеры переводятся БЕЗ трогания логики app.js.
    function translateRoot(root) {
        if (isRu || !root) return; // ru — родной текст, переводить нечего
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
            for (const [ru, entry] of Object.entries(dict)) {
                const trv = pick(entry);
                if (trv && v.indexOf(ru) >= 0) v = v.split(ru).join(trv);
            }
            for (const [ru, entry] of htmlBlocks) {
                const trv = pick(entry);
                if (trv && v.indexOf(ru) >= 0) v = v.split(ru).join(trv);
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
                    for (const [ru, entry] of Object.entries(dict)) {
                        const trv = pick(entry);
                        if (trv && nv.indexOf(ru) >= 0) nv = nv.split(ru).join(trv);
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
            // v160y33: цикл ru → en → fr → es → de → ru
            window.MurmurI18N.setLang(nextLang(cur));
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

    // ── Boot: первичный pass + наблюдатель + кнопка (v160y33).
    function boot() {
        // Кнопка 🌐 нужна в ОБОИХ режимах (иначе с ru не переключиться).
        addLangToggle();
        if (isRu) return; // ru — родной текст, переводить нечего
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
