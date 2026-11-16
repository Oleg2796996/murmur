// GENERATED from pwa/i18n.js — DO NOT EDIT BY HAND.
// Source of truth: pwa/i18n.js (v160y33+). Regenerate: node tools/gen-ios-i18n.js
// Keys are the RUSSIAN canonical strings — same convention as the PWA:
// ru is the native language; en/fr/es/de are translations.

enum MurmurI18N {

    /// Languages, same set and cycle order as the PWA: ru → en → fr → es → de.
    enum Lang: String, CaseIterable {
        case ru, en, fr, es, de

        /// 🌐-кнопка подписи (PWA LANG_LABEL).
        var label: String { rawValue.uppercased() }

        var next: Lang {
            let all = Lang.allCases
            let i = all.firstIndex(of: self)!
            return all[(i + 1) % all.count]
        }
    }

    /// One dictionary entry: RU key + translations.
    private struct Entry {
        let en: String?
        let fr: String?
        let es: String?
        let de: String?
        func translation(for lang: Lang) -> String? {
            switch lang {
            case .ru: return nil          // ru — родной текст
            case .en: return en
            case .fr: return fr
            case .es: return es
            case .de: return de
            }
        }
    }

    private static let dict: [String: Entry] = [
        "приватный мессенджер": Entry(en: "private messenger", fr: "messagerie privée", es: "mensajería privada", de: "privater Messenger"),
        "Новый аккаунт": Entry(en: "New account", fr: "Nouveau compte", es: "Nueva cuenta", de: "Neues Konto"),
        "Создать": Entry(en: "Create", fr: "Créer", es: "Crear", de: "Erstellen"),
        "Восстановить": Entry(en: "Restore", fr: "Restaurer", es: "Restaurar", de: "Wiederherstellen"),
        "Пригласить друга ✉": Entry(en: "Invite a friend ✉", fr: "Inviter un ami ✉", es: "Invitar a un amigo ✉", de: "Freund einladen ✉"),
        "Вставить ссылку 📋": Entry(en: "Paste link 📋", fr: "Coller le lien 📋", es: "Pegar enlace 📋", de: "Link einfügen 📋"),
        "Скачать": Entry(en: "Download", fr: "Télécharger", es: "Descargar", de: "Herunterladen"),
        "Скачать backup": Entry(en: "Download backup", fr: "Télécharger la sauvegarde", es: "Descargar copia de seguridad", de: "Backup herunterladen"),
        "Восстановить backup": Entry(en: "Restore backup", fr: "Restaurer la sauvegarde", es: "Restaurar copia de seguridad", de: "Backup wiederherstellen"),
        "Восстановить из backup": Entry(en: "Restore from backup", fr: "Restaurer depuis une sauvegarde", es: "Restaurar desde una copia de seguridad", de: "Aus Backup wiederherstellen"),
        "Удалить все данные": Entry(en: "Delete all data", fr: "Supprimer toutes les données", es: "Eliminar todos los datos", de: "Alle Daten löschen"),
        "Пригласите друга или вставьте полученную ссылку для начала общения": Entry(en: "Invite a friend or paste a received link to start chatting", fr: "Invitez un ami ou collez le lien reçu pour commencer", es: "Invita a un amigo o pega el enlace recibido para empezar", de: "Lade einen Freund ein oder füge den erhaltenen Link ein"),
        "Выберите чат": Entry(en: "Select a chat", fr: "Sélectionnez un chat", es: "Selecciona un chat", de: "Chat auswählen"),
        "поиск чатов…": Entry(en: "search chats…", fr: "rechercher…", es: "buscar chats…", de: "Chats suchen…"),
        "сообщение…": Entry(en: "message…", fr: "message…", es: "mensaje…", de: "Nachricht…"),
        "Включить уведомления": Entry(en: "Enable notifications", fr: "Activer les notifications", es: "Activar notificaciones", de: "Benachrichtigungen aktivieren"),
        "Вставить invite-ссылку или npub": Entry(en: "Paste invite link or npub", fr: "Collez le lien d’invitation ou npub", es: "Pega el enlace de invitación o npub", de: "Einladungslink oder npub einfügen"),
        "Назад": Entry(en: "Back", fr: "Retour", es: "Atrás", de: "Zurück"),
        "Удалить чат": Entry(en: "Delete chat", fr: "Supprimer le chat", es: "Eliminar chat", de: "Chat löschen"),
        "Прикрепить файл (до 50 МБ)": Entry(en: "Attach a file (up to 50 MB)", fr: "Joindre un fichier (max 50 Mo)", es: "Adjuntar archivo (hasta 50 MB)", de: "Datei anhängen (max. 50 MB)"),
        "отправить": Entry(en: "send", fr: "envoyer", es: "enviar", de: "senden"),
        "Чаты": Entry(en: "Chats", fr: "Discussions", es: "Chats", de: "Chats"),
        "Ответ": Entry(en: "Reply", fr: "Répondre", es: "Responder", de: "Antworten"),
        "Отменить ответ": Entry(en: "Cancel reply", fr: "Annuler la réponse", es: "Cancelar respuesta", de: "Antwort abbrechen"),
        "Видео-инструкция": Entry(en: "Video guide", fr: "Guide vidéo", es: "Guía en video", de: "Video-Anleitung"),
        "назад к списку": Entry(en: "back to list", fr: "retour à la liste", es: "volver a la lista", de: "zurück zur Liste"),
        "удалить чат": Entry(en: "delete chat", fr: "supprimer le chat", es: "eliminar chat", de: "Chat löschen"),
        "MurMur требует JavaScript. Включи JS в настройках Safari.": Entry(en: "MurMur requires JavaScript. Enable JS in Safari settings.", fr: "MurMur nécessite JavaScript. Activez JS dans Safari.", es: "MurMur requiere JavaScript. Activa JS en Safari.", de: "MurMur benötigt JavaScript. Aktiviere JS in Safari."),
        "Ошибка: ": Entry(en: "Error: ", fr: "Erreur : ", es: "Error: ", de: "Fehler: "),
        "PWA загружается… подожди (до 30 сек)": Entry(en: "PWA is loading… wait (up to 30 s)", fr: "PWA en cours de chargement… patientez (30 s)", es: "PWA cargando… espera (hasta 30 s)", de: "PWA lädt… warte (bis 30 s)"),
        "PWA не загрузилась. Проверь интернет и обнови страницу.": Entry(en: "PWA failed to load. Check your connection and reload.", fr: "Échec du chargement. Vérifiez la connexion.", es: "La PWA no cargó. Verifica la conexión y recarga.", de: "PWA nicht geladen. Verbindung prüfen und neu laden."),
        "Ошибка создания аккаунта:": Entry(en: "Account creation error:", fr: "Erreur de création du compte :", es: "Error al crear la cuenta:", de: "Fehler beim Erstellen des Kontos:"),
        "Ошибка восстановления:": Entry(en: "Restore error:", fr: "Erreur de restauration :", es: "Error de restauración:", de: "Fehler bei der Wiederherstellung:"),
        "Введите ключ: 64 символа": Entry(en: "Enter key: 64 characters", fr: "Entrez la clé : 64 caractères", es: "Introduce la clave: 64 caracteres", de: "Schlüssel eingeben: 64 Zeichen"),
        "Скопировать ключ": Entry(en: "Copy key", fr: "Copier la clé", es: "Copiar clave", de: "Schlüssel kopieren"),
        "Ключ скопирован": Entry(en: "Key copied", fr: "Clé copiée", es: "Clave copiada", de: "Schlüssel kopiert"),
        "Установить приложение": Entry(en: "Install app", fr: "Installer l’application", es: "Instalar app", de: "App installieren"),
        "Приложение установлено": Entry(en: "App installed", fr: "Application installée", es: "App instalada", de: "App installiert"),
        "Пока нет чатов": Entry(en: "No chats yet", fr: "Aucune discussion", es: "Aún no hay chats", de: "Noch keine Chats"),
        "Нажмите «Пригласить друга», чтобы отправить ссылку-приглашение.": Entry(en: "Tap “Invite a friend” to send an invite link.", fr: "Touchez « Inviter un ami » pour envoyer un lien.", es: "Toca “Invitar a un amigo” para enviar un enlace.", de: "Tippe „Freund einladen“, um einen Link zu senden."),
        "Ничего не найдено по запросу «": Entry(en: "Nothing found for “", fr: "Aucun résultat pour «", es: "Nada encontrado para “", de: "Nichts gefunden für „"),
        "Нет сообщений": Entry(en: "No messages", fr: "Aucun message", es: "Sin mensajes", de: "Keine Nachrichten"),
        "Вчера": Entry(en: "Yesterday", fr: "Hier", es: "Ayer", de: "Gestern"),
        "Без имени": Entry(en: "Unnamed", fr: "Sans nom", es: "Sin nombre", de: "Ohne Namen"),
        "фото": Entry(en: "photo", fr: "photo", es: "foto", de: "Foto"),
        "видео": Entry(en: "video", fr: "vidéo", es: "vídeo", de: "Video"),
        "аудио": Entry(en: "audio", fr: "audio", es: "audio", de: "Audio"),
        "файл": Entry(en: "file", fr: "fichier", es: "archivo", de: "Datei"),
        "Загрузка…": Entry(en: "Loading…", fr: "Chargement…", es: "Cargando…", de: "Laden…"),
        "⏳ Не удалось загрузить историю. Плохой инет — ": Entry(en: "⏳ Failed to load history. Bad connection — ", fr: "⏳ Échec du chargement de l’historique — ", es: "⏳ No se pudo cargar el historial — ", de: "⏳ Verlauf konnte nicht geladen werden — "),
        "повторить": Entry(en: "retry", fr: "réessayer", es: "reintentar", de: "wiederholen"),
        "печатает…": Entry(en: "typing…", fr: "écrit…", es: "escribiendo…", de: "schreibt…"),
        "Вставь invite-ссылку или npub собеседника:": Entry(en: "Paste invite link or peer npub:", fr: "Collez le lien ou npub du correspondant :", es: "Pega el enlace o npub del contacto:", de: "Einladungslink oder npub des Kontakts:"),
        "Не нашла npub1… в вставленном тексте": Entry(en: "No npub1… found in the pasted text", fr: "Aucun npub1… dans le texte collé", es: "No se encontró npub1… en el texto", de: "Kein npub1… im eingefügten Text"),
        "Ключ не найден (нет аккаунта?)": Entry(en: "Key not found (no account?)", fr: "Clé introuvable (pas de compte ?)", es: "Clave no encontrada (¿sin cuenta?)", de: "Schlüssel nicht gefunden (kein Konto?)"),
        "Твой ключ (секрет!)": Entry(en: "Your key (secret!)", fr: "Ta clé (secret !)", es: "Tu clave (¡secreto!)", de: "Dein Schlüssel (geheim!)"),
        "Вставь его на другом устройстве / в PWA через «У меня есть ключ». Никому не показывай.": Entry(en: "Paste it on another device / in the PWA via “I have a key”. Never show it to anyone.", fr: "Collez-la sur un autre appareil via « J’ai une clé ». Ne la montrez à personne.", es: "Pégala en otro dispositivo con “Tengo una clave”. No la muestres a nadie.", de: "Auf anderem Gerät über „Ich habe einen Schlüssel“ einfügen. Niemals zeigen."),
        "Копировать": Entry(en: "Copy", fr: "Copier", es: "Copiar", de: "Kopieren"),
        "Скопировать": Entry(en: "Copy", fr: "Copier", es: "Copiar", de: "Kopieren"),
        "Скопировано ✓": Entry(en: "Copied ✓", fr: "Copié ✓", es: "Copiado ✓", de: "Kopiert ✓"),
        "✓ Скопировано": Entry(en: "✓ Copied", fr: "✓ Copié", es: "✓ Copiado", de: "✓ Kopiert"),
        "✓ Скопировано — вставьте в MurMur": Entry(en: "✓ Copied — paste into MurMur", fr: "✓ Copié — collez dans MurMur", es: "✓ Copiado — pega en MurMur", de: "✓ Kopiert — in MurMur einfügen"),
        "вставьте в MurMur": Entry(en: "paste into MurMur", fr: "collez dans MurMur", es: "pega en MurMur", de: "in MurMur einfügen"),
        "✗ Ошибка": Entry(en: "✗ Error", fr: "✗ Erreur", es: "✗ Error", de: "✗ Fehler"),
        "Закрыть": Entry(en: "Close", fr: "Fermer", es: "Cerrar", de: "Schließen"),
        "✕ ЗАКРЫТЬ": Entry(en: "✕ CLOSE", fr: "✕ FERMER", es: "✕ CERRAR", de: "✕ SCHLIESSEN"),
        "Нажмите, чтобы задать имя": Entry(en: "Tap to set a name", fr: "Touchez pour définir un nom", es: "Toca para poner un nombre", de: "Tippen für Namen"),
        "Название чата:": Entry(en: "Chat name:", fr: "Nom du chat :", es: "Nombre del chat:", de: "Chatname:"),
        "Уведомления включены": Entry(en: "Notifications on", fr: "Notifications activées", es: "Notificaciones activadas", de: "Benachrichtigungen an"),
        "— нажми чтобы отключить": Entry(en: "— tap to turn off", fr: "— touchez pour désactiver", es: "— toca para desactivar", de: "— tippen zum Deaktivieren"),
        "Браузер разрешил, но подписки нет — нажми чтобы переподключить": Entry(en: "Browser allowed, but no subscription — tap to reconnect", fr: "Navigateur OK, pas d’abonnement — touchez pour reconnecter", es: "Navegador OK, sin suscripción — toca para reconectar", de: "Browser OK, kein Abo — tippen zum Neuverbinden"),
        "Уведомления заблокированы в Safari — разрешите в Настройки": Entry(en: "Notifications blocked in Safari — allow in Settings", fr: "Notifications bloquées dans Safari — autorisez dans Réglages", es: "Notificaciones bloqueadas en Safari — permite en Ajustes", de: "Benachrichtigungen in Safari blockiert — in Einstellungen erlauben"),
        "Браузер не поддерживает уведомления": Entry(en: "Browser does not support notifications", fr: "Le navigateur ne supporte pas les notifications", es: "El navegador no admite notificaciones", de: "Browser unterstützt keine Benachrichtigungen"),
        "Уведомления заблокированы. Включите в Safari → Настройки сайтов → Уведомления.": Entry(en: "Notifications blocked. Enable in Safari → Settings for Websites → Notifications.", fr: "Notifications bloquées. Activez dans Safari → Sites → Notifications.", es: "Notificaciones bloqueadas. Activa en Safari → Sitios → Notificaciones.", de: "Blockiert. Safari → Website-Einstellungen → Mitteilungen."),
        "Кэш очищен. Перезагрузи страницу для применения.": Entry(en: "Cache cleared. Reload the page to apply.", fr: "Cache vidé. Rechargez la page.", es: "Caché borrado. Recarga la página.", de: "Cache geleert. Seite neu laden."),
        "Кэш очищен (пуст)": Entry(en: "Cache cleared (empty)", fr: "Cache vidé (vide)", es: "Caché borrado (vacío)", de: "Cache geleert (leer)"),
        "Скрыть": Entry(en: "Hide", fr: "Masquer", es: "Ocultar", de: "Ausblenden"),
        "Показать": Entry(en: "Show", fr: "Afficher", es: "Mostrar", de: "Anzeigen"),
        "Очистить": Entry(en: "Clear", fr: "Effacer", es: "Borrar", de: "Leeren"),
        "Выберите чат перед прикреплением файла.": Entry(en: "Select a chat before attaching a file.", fr: "Sélectionnez un chat avant de joindre.", es: "Selecciona un chat antes de adjuntar.", de: "Chat vor dem Anhängen wählen."),
        "Модуль шифрования не загрузился:": Entry(en: "Encryption module failed to load:", fr: "Échec du module de chiffrement :", es: "Falló el módulo de cifrado:", de: "Verschlüsselungsmodul nicht geladen:"),
        "Не удалось разрешить ключ получателя.": Entry(en: "Failed to resolve peer key.", fr: "Clé du destinataire introuvable.", es: "No se pudo resolver la clave del contacto.", de: "Kontakt-Schlüssel nicht aufgelöst."),
        "Не удалось загрузить модуль шифрования (сеть? проверьте соединение и откройте приложение заново).": Entry(en: "Failed to load encryption module (network? check connection and reopen the app).", fr: "Échec du module de chiffrement (réseau ?)", es: "Falló el módulo de cifrado (¿red?)", de: "Verschlüsselungsmodul nicht geladen (Netzwerk?)"),
        "HEIC/HEIF не поддерживается. Сконвертируйте в JPG/PNG.": Entry(en: "HEIC/HEIF not supported. Convert to JPG/PNG.", fr: "HEIC/HEIF non supporté. Convertissez en JPG/PNG.", es: "HEIC/HEIF no admitido. Convierte a JPG/PNG.", de: "HEIC/HEIF nicht unterstützt. Zu JPG/PNG konvertieren."),
        "Ошибка загрузки: ": Entry(en: "Upload error: ", fr: "Erreur d’envoi : ", es: "Error de subida: ", de: "Fehler beim Hochladen: "),
        "Все ваши данные (личность, ключи, история чатов) будут безвозвратно удалены с этого устройства. Продолжить?": Entry(en: "All your data (identity, keys, chat history) will be permanently deleted from this device. Continue?", fr: "Toutes vos données seront supprimées définitivement. Continuer ?", es: "Todos tus datos se borrarán permanentemente. ¿Continuar?", de: "Alle Daten werden unwiderruflich gelöscht. Fortfahren?"),
        "Удалить чат с «": Entry(en: "Delete chat with “", fr: "Supprimer le chat avec «", es: "Eliminar chat con “", de: "Chat löschen mit „"),
        "Чат исчезнет из списка. История хранится только в памяти этого": Entry(en: "The chat will disappear from the list. History is kept only in this", fr: "Le chat disparaîtra de la liste. L’historique reste sur cet", es: "El chat desaparecerá de la lista. El historial queda en este", de: "Der Chat verschwindet aus der Liste. Verlauf nur auf diesem"),
        "приложения; после удаления сервер не сможет её восстановить.\n\n": Entry(en: "app; the server cannot restore it after deletion.\n\n", fr: "application ; le serveur ne pourra pas la restaurer.\n\n", es: "app; el servidor no podrá restaurarlo.\n\n", de: "App; der Server kann sie nicht wiederherstellen.\n\n"),
        "Если «": Entry(en: "If “", fr: "Si «", es: "Si “", de: "Wenn „"),
        "» пришлёт новое сообщение — чат": Entry(en: "” sends a new message, the chat", fr: "» envoie un message, le chat", es: "” envía un mensaje, el chat", de: "“ eine neue Nachricht sendet, der Chat"),
        "вернётся в список автоматически.": Entry(en: "will return to the list automatically.", fr: "reviendra automatiquement dans la liste.", es: "volverá a la lista automáticamente.", de: "kehrt automatisch zurück."),
        "Адресат не получил сообщение.": Entry(en: "The recipient did not receive the message.", fr: "Le destinataire n’a pas reçu le message.", es: "El destinario no recibió el mensaje.", de: "Der Empfänger hat die Nachricht nicht erhalten."),
        "Не доставлено": Entry(en: "Not delivered", fr: "Non remis", es: "No entregado", de: "Nicht zugestellt"),
        "[исходящее, шифрование нарушено]": Entry(en: "[outgoing, encryption broken]", fr: "[sortant, chiffrement cassé]", es: "[saliente, cifrado roto]", de: "[ausgehend, Verschlüsselung defekt]"),
        "[не удалось расшифровать]": Entry(en: "[decryption failed]", fr: "[échec du déchiffrement]", es: "[fallo de descifrado]", de: "[Entschlüsselung fehlgeschlagen]"),
        "🔒 шифрованное сообщение": Entry(en: "🔒 encrypted message", fr: "🔒 message chiffré", es: "🔒 mensaje cifrado", de: "🔒 verschlüsselte Nachricht"),
        "🔒 зашифрованное сообщение": Entry(en: "🔒 encrypted message", fr: "🔒 message chiffré", es: "🔒 mensaje cifrado", de: "🔒 verschlüsselte Nachricht"),
        "Присоединяйся в приватном мессенджере murmur!": Entry(en: "Join me on murmur — the private messenger!", fr: "Rejoins-moi sur murmur — la messagerie privée !", es: "Únete a murmur — la mensajería privada!", de: "Komm zu murmur — dem privaten Messenger!"),
        "Ссылка скопирована в буфер обмена!": Entry(en: "Link copied to clipboard!", fr: "Lien copié !", es: "¡Enlace copiado!", de: "Link kopiert!"),
        "Ссылка-приглашение": Entry(en: "Invite link", fr: "Lien d’invitation", es: "Enlace de invitación", de: "Einladungslink"),
        "Удерживайте палец на поле ниже → «Скопировать», либо нажмите кнопку.": Entry(en: "Press and hold the field below → “Copy”, or tap the button.", fr: "Maintenez le champ → « Copier », ou touchez le bouton.", es: "Mantén el campo → “Copiar”, o toca el botón.", de: "Feld gedrückt halten → „Kopieren“, oder Taste tippen."),
        "Нажмите, чтобы скопировать": Entry(en: "Tap to copy", fr: "Touchez pour copier", es: "Toca para copiar", de: "Tippen zum Kopieren"),
        "1. Внизу Safari жми ⟨Поделиться⟩ (квадрат со стрелкой)": Entry(en: "1. In Safari, tap ⟨Share⟩ (square with arrow)", fr: "1. Dans Safari, touchez ⟨Partager⟩", es: "1. En Safari, toca ⟨Compartir⟩", de: "1. In Safari ⟨Teilen⟩ tippen"),
        "2. Выбери ⟨На экран „Домой“⟩ → ⟨Добавить⟩": Entry(en: "2. Choose ⟨Add to Home Screen⟩ → ⟨Add⟩", fr: "2. Choisissez ⟨Sur l’écran d’accueil⟩ → ⟨Ajouter⟩", es: "2. Elige ⟨Añadir a inicio⟩ → ⟨Añadir⟩", de: "2. ⟨Zum Home-Bildschirm⟩ → ⟨Hinzufügen⟩"),
        "3. Открой murmur с новой иконки — аккаунт создастся сам, и чат уже будет ждать": Entry(en: "3. Open murmur from the new icon — the account is created automatically, and the chat is already waiting", fr: "3. Ouvrez murmur depuis la nouvelle icône — le compte se crée, le chat attend", es: "3. Abre murmur desde el icono nuevo — la cuenta se crea sola", de: "3. murmur über das neue Icon öffnen — Konto wird erstellt"),
        "1. Внизу Chrome жми ⟨Поделиться⟩ (квадрат со стрелкой)": Entry(en: "1. In Chrome, tap ⟨Share⟩ (square with arrow)", fr: "1. Dans Chrome, touchez ⟨Partager⟩", es: "1. En Chrome, toca ⟨Compartir⟩", de: "1. In Chrome ⟨Teilen⟩ tippen"),
        "2. Выбери ⟨Открыть в Safari⟩": Entry(en: "2. Choose ⟨Open in Safari⟩", fr: "2. Choisissez ⟨Ouvrir dans Safari⟩", es: "2. Elige ⟨Abrir en Safari⟩", de: "2. ⟨In Safari öffnen⟩"),
        "3. Дальше как в Safari: ⟨Поделиться⟩ → ⟨На экран „Домой“⟩ → ⟨Добавить⟩": Entry(en: "3. Then like Safari: ⟨Share⟩ → ⟨Add to Home Screen⟩ → ⟨Add⟩", fr: "3. Puis comme Safari : ⟨Partager⟩ → ⟨Écran d’accueil⟩", es: "3. Luego como Safari: ⟨Compartir⟩ → ⟨Añadir a inicio⟩", de: "3. Wie Safari: ⟨Teilen⟩ → ⟨Home-Bildschirm⟩"),
        "1. В Chrome жми ⟨⋮⟩ (три точки справа сверху)": Entry(en: "1. In Chrome, tap ⟨⋮⟩ (three dots top right)", fr: "1. Dans Chrome, touchez ⟨⋮⟩ (trois points)", es: "1. En Chrome, toca ⟨⋮⟩ (tres puntos arriba)", de: "1. In Chrome ⟨⋮⟩ (drei Punkte oben)"),
        "2. Выбери ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": Entry(en: "2. Choose ⟨Add to Home Screen⟩ / ⟨Install app⟩", fr: "2. Choisissez ⟨Ajouter à l’écran d’accueil⟩ / ⟨Installer⟩", es: "2. Elige ⟨Añadir a inicio⟩ / ⟨Instalar app⟩", de: "2. ⟨Zum Startbildschirm⟩ / ⟨App installieren⟩"),
        "3. Подтверди ⟨Установить⟩ — аккаунт создастся сам, и чат уже будет ждать": Entry(en: "3. Confirm ⟨Install⟩ — the account is created automatically, and the chat is already waiting", fr: "3. Confirmez ⟨Installer⟩ — le compte se crée, le chat attend", es: "3. Confirma ⟨Instalar⟩ — la cuenta se crea sola", de: "3. ⟨Installieren⟩ bestätigen — Konto wird erstellt"),
        "1. В Samsung Internet жми ⟨≡⟩ (три полоски снизу справа)": Entry(en: "1. In Samsung Internet, tap ⟨≡⟩ (three lines bottom right)", fr: "1. Dans Samsung Internet, touchez ⟨≡⟩", es: "1. En Samsung Internet, toca ⟨≡⟩", de: "1. In Samsung Internet ⟨≡⟩ (unten)"),
        "2. Выбери ⟨Добавить страницу в⟩ → ⟨Экран „Домой“⟩": Entry(en: "2. Choose ⟨Add page to⟩ → ⟨Home screen⟩", fr: "2. Choisissez ⟨Ajouter la page à⟩ → ⟨Écran d’accueil⟩", es: "2. Elige ⟨Añadir página a⟩ → ⟨Inicio⟩", de: "2. ⟨Seite hinzufügen zu⟩ → ⟨Startbildschirm⟩"),
        "1. В Firefox жми ⟨⋮⟩ (три точки)": Entry(en: "1. In Firefox, tap ⟨⋮⟩ (three dots)", fr: "1. Dans Firefox, touchez ⟨⋮⟩", es: "1. En Firefox, toca ⟨⋮⟩", de: "1. In Firefox ⟨⋮⟩"),
        "2. Выбери ⟨Установить⟩ / ⟨Добавить на главный экран⟩": Entry(en: "2. Choose ⟨Install⟩ / ⟨Add to Home Screen⟩", fr: "2. Choisissez ⟨Installer⟩ / ⟨Ajouter à l’écran⟩", es: "2. Elige ⟨Instalar⟩ / ⟨Añadir a inicio⟩", de: "2. ⟨Installieren⟩ / ⟨Zum Startbildschirm⟩"),
        "2. Подтверди ⟨Установить⟩": Entry(en: "2. Confirm ⟨Install⟩", fr: "2. Confirmez ⟨Installer⟩", es: "2. Confirma ⟨Instalar⟩", de: "2. ⟨Installieren⟩ bestätigen"),
        "3. murmur откроется в отдельном окне — аккаунт создастся сам, и чат уже будет ждать": Entry(en: "3. murmur opens in a separate window — the account is created automatically, and the chat is already waiting", fr: "3. murmur s’ouvre dans une fenêtre — le compte se crée", es: "3. murmur se abre en ventana — la cuenta se crea sola", de: "3. murmur öffnet in eigenem Fenster — Konto wird erstellt"),
        "1. В Chrome жми иконку установки в правой части адресной строки (монитор со стрелкой)": Entry(en: "1. In Chrome, tap the install icon on the right of the address bar (monitor with arrow)", fr: "1. Dans Chrome, l’icône d’installation dans la barre", es: "1. En Chrome, el icono de instalación en la barra", de: "1. In Chrome das Install-Icon in der Adressleiste"),
        "2. Или ⟨⋮ меню⟩ → ⟨Транслировать, сохранить и поделиться⟩ → ⟨Установить страницу как приложение…⟩": Entry(en: "2. Or ⟨⋮ menu⟩ → ⟨Cast, save and share⟩ → ⟨Install page as app…⟩", fr: "2. Ou ⟨⋮ menu⟩ → ⟨Diffuser, enregistrer, partager⟩ → ⟨Installer⟩", es: "2. O ⟨⋮ menú⟩ → ⟨Transmitir, guardar, compartir⟩", de: "2. Oder ⟨⋮ Menü⟩ → ⟨Installieren als App…⟩"),
        "1. В Safari жми ⟨Файл⟩ (в строке меню Mac)": Entry(en: "1. In Safari, tap ⟨File⟩ (Mac menu bar)", fr: "1. Dans Safari, touchez ⟨Fichier⟩ (barre Mac)", es: "1. En Safari, toca ⟨Archivo⟩ (menú Mac)", de: "1. In Safari ⟨Ablage⟩ (Mac-Menüleiste)"),
        "2. Выбери ⟨Добавить в Dock…⟩": Entry(en: "2. Choose ⟨Add to Dock…⟩", fr: "2. Choisissez ⟨Ajouter au Dock…⟩", es: "2. Elige ⟨Añadir al Dock…⟩", de: "2. ⟨Zum Dock hinzufügen…⟩"),
        "3. Подтверди ⟨Добавить⟩ — аккаунт создастся сам, и чат уже будет ждать": Entry(en: "3. Confirm ⟨Add⟩ — the account is created automatically, and the chat is already waiting", fr: "3. Confirmez ⟨Ajouter⟩ — le compte se crée, le chat attend", es: "3. Confirma ⟨Añadir⟩ — la cuenta se crea sola", de: "3. ⟨Hinzufügen⟩ bestätigen — Konto wird erstellt"),
        "1. Найди в меню браузера пункт ⟨Добавить на главный экран⟩ / ⟨Установить приложение⟩": Entry(en: "1. Find “Add to Home Screen” / “Install app” in the browser menu", fr: "1. Trouvez « Ajouter à l’écran » dans le menu", es: "1. Busca “Añadir a inicio” en el menú", de: "1. „Zum Startbildschirm“ im Menü"),
        "2. Подтверди установку": Entry(en: "2. Confirm the installation", fr: "2. Confirmez l’installation", es: "2. Confirma la instalación", de: "2. Installation bestätigen"),
        "🔓 расшифровка…": Entry(en: "🔓 decrypting…", fr: "🔓 déchiffrement…", es: "🔓 descifrando…", de: "🔓 Entschlüsselung…"),
        "не удалось расшифровать": Entry(en: "decryption failed", fr: "échec du déchiffrement", es: "fallo de descifrado", de: "Entschlüsselung fehlgeschlagen"),
    ]

    /// UI-переключатель языка (как в PWA: цикл ru → en → fr → es → de).
    nonisolated(unsafe) static var current: Lang = {
        // Системный язык, если пользователь не выбирал.
        if let saved = UserDefaults.standard.string(forKey: "murmur_lang"),
           let l = Lang(rawValue: saved) { return l }
        let sys = Locale.preferredLanguages.first?.lowercased() ?? "en"
        for l in Lang.allCases where sys.hasPrefix(l.rawValue) { return l }
        return .en
    }()

    /// Главная функция — тот же контракт, что window.MurmurI18N.t():
    /// строка может быть каноникалом ИЛИ содержать подстроки-каноникалы.
    static func t(_ s: String) -> String {
        guard current != .ru, !s.isEmpty else { return s }
        guard let e = dict[s] else { return translateSubstring(s) }
        return e.translation(for: current) ?? s
    }

    /// Перевод подстрок внутри строки (PWA DOM-pass parity) — для строк,
    /// собранных из каноникалов с интерполяцией.
    static func translateSubstring(_ s: String) -> String {
        var v = s
        for (ru, e) in dict.sorted(by: { $0.key.count > $1.key.count }) {
            guard let tr = e.translation(for: current) else { continue }
            if v.contains(ru) { v = v.replacingOccurrences(of: ru, with: tr) }
        }
        // PWA htmlBlocks: подстрочные правила поверх (лендинг-фразы).
        for (ru, e) in substringRules {
            guard let tr = e.translation(for: current) else { continue }
            if v.contains(ru) { v = v.replacingOccurrences(of: ru, with: tr) }
        }
        return v
    }

    /// PWA htmlBlocks — подстрочные правила (длинные фразы лендинга,
    /// склеенные в предложения с интерполяцией). Применяются ВНУТРИ строк.
    /// Longest-first — как в PWA DOM-pass.
    static let substringRules: [(String, Entry)] = [
        ("Почему это приватно", Entry(en: "Why this is private", fr: "Pourquoi c’est privé", es: "Por qué es privado", de: "Warum das privat ist")),
        ("Всё хранится на вашем устройстве", Entry(en: "Everything stays on your device", fr: "Tout reste sur votre appareil", es: "Todo queda en tu dispositivo", de: "Alles bleibt auf deinem Gerät")),
        ("— сервер видит только зашифрованные сообщения", Entry(en: "— the server sees only encrypted messages", fr: "— le serveur ne voit que du chiffré", es: "— el servidor solo ve cifrado", de: "— der Server sieht nur Verschlüsseltes")),
        ("Переписка стирается с сервера", Entry(en: "Conversations are wiped from the server", fr: "Les conversations sont effacées du serveur", es: "Las conversaciones se borran del servidor", de: "Unterhaltungen werden vom Server gelöscht")),
        ("Переписка удаляется с сервера", Entry(en: "Conversations are deleted from the server", fr: "Les conversations sont supprimées du serveur", es: "Las conversaciones se borran del servidor", de: "Unterhaltungen werden vom Server gelöscht")),
        ("через минуты после доставки", Entry(en: "wiped minutes after delivery", fr: "effacées quelques minutes après remise", es: "se borran minutos tras la entrega", de: "wenige Minuten nach Zustellung vom Server gelöscht")),
        ("после доставки", Entry(en: "after delivery", fr: "après remise", es: "tras la entrega", de: "nach Zustellung")),
        ("Нам не нужно знать", Entry(en: "We never need to know", fr: "Nous n’avons pas besoin de savoir", es: "No necesitamos saber", de: "Wir müssen nicht wissen")),
        ("ваши имена, телефоны и почту", Entry(en: "your name, phone or email", fr: "vos noms, téléphones et e-mails", es: "tus nombres, teléfonos y correo", de: "Namen, Telefonnummern und E-Mails")),
        ("Нам нечего передавать", Entry(en: "We have nothing to hand over", fr: "Nous n’avons rien à remettre", es: "No tenemos nada que entregar", de: "Wir haben nichts herauszugeben")),
        ("Просьба передать данные?", Entry(en: "Asked to hand over data?", fr: "Qu’on demande vos données ?", es: "¿Te piden tus datos?", de: "Aufforderung, Daten herauszugeben?")),
        ("Чтобы принять приглашение", Entry(en: "To accept the invitation", fr: "Pour accepter l’invitation", es: "Para aceptar la invitación", de: "Um die Einladung anzunehmen")),
        ("MurMur уже установлен?", Entry(en: "MurMur already installed?", fr: "MurMur déjà installé ?", es: "¿MurMur ya instalado?", de: "MurMur schon installiert?")),
        ("Нажмите на ссылку</b> — она скопируется, вставьте её в приложение:", Entry(en: "Tap the link</b> — it copies, paste it into the app:", fr: "Touchez le lien</b> — il se copie, collez-le dans l’application :", es: "Toca el enlace</b> — se copia, pégalo en la app:", de: "Link antippen</b> — kopiert, in der App einfügen:")),
        ("— она скопируется, вставьте её в приложение:", Entry(en: "— it copies, paste it into the app:", fr: "— il se copie, collez-le dans l’application :", es: "— se copia, pégalo en la app:", de: "— kopiert, in der App einfügen:")),
        ("✓ Скопировано — вставьте в MurMur", Entry(en: "✓ Copied — paste into MurMur", fr: "✓ Copié — collez dans MurMur", es: "✓ Copiado — pega en MurMur", de: "✓ Kopiert — in MurMur einfügen")),
        ("Ещё не установлен? Пара шагов:", Entry(en: "Not installed yet? A few steps:", fr: "Pas encore installé ? Quelques étapes :", es: "¿Aún no instalado? Unos pasos:", de: "Noch nicht installiert? Ein paar Schritte:")),
        ("(iPhone/iPad): Поделиться → На экран «Домой»", Entry(en: "(iPhone/iPad): Share → Add to Home Screen", fr: "(iPhone/iPad) : Partager → Écran d’accueil", es: "(iPhone/iPad): Compartir → Añadir a inicio", de: "(iPhone/iPad): Teilen → Home-Bildschirm")),
        ("(Android/ПК): ⋮ → Добавить на главный экран", Entry(en: "(Android/PC): ⋮ → Add to Home Screen", fr: "(Android/PC) : ⋮ → Ajouter à l’écran d’accueil", es: "(Android/PC): ⋮ → Añadir a inicio", de: "(Android/PC): ⋮ → Zum Startbildschirm")),
        (": меню → Установить", Entry(en: ": menu → Install", fr: ": menu → Installer", es: ": menú → Instalar", de: ": Menü → Installieren")),
        ("Откройте MurMur с новой иконки — аккаунт создастся сам, и чат уже будет ждать", Entry(en: "Open MurMur from the new icon — the account is created automatically, and the chat is already waiting", fr: "Ouvrez MurMur depuis la nouvelle icône — le compte se crée, le chat attend", es: "Abre MurMur desde el icono nuevo — la cuenta se crea sola", de: "MurMur über das neue Icon öffnen — Konto wird erstellt")),
        ("Нажмите на ссылку", Entry(en: "Tap the link", fr: "Touchez le lien", es: "Toca el enlace", de: "Link antippen")),
        ("Как установить MurMur", Entry(en: "How to install MurMur", fr: "Comment installer MurMur", es: "Cómo instalar MurMur", de: "MurMur installieren")),
        ("Откройте MurMur с новой иконки — аккаунт создастся сам, ничего больше не нужно", Entry(en: "Open MurMur from the new icon — the account is created automatically, nothing else needed", fr: "Ouvrez MurMur depuis la nouvelle icône — le compte se crée, rien de plus", es: "Abre MurMur desde el icono nuevo — la cuenta se crea sola, nada más", de: "MurMur über das neue Icon öffnen — Konto wird erstellt, mehr nicht")),
    ]

    static func setLanguage(_ l: Lang) {
        current = l
        UserDefaults.standard.set(l.rawValue, forKey: "murmur_lang")
        NotificationCenter.default.post(name: .murmurLanguageChanged, object: nil)
    }
}

extension Notification.Name {
    static let murmurLanguageChanged = Notification.Name("murmurLanguageChanged")
}

