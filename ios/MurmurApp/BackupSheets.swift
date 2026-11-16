import SwiftUI
import UniformTypeIdentifiers

/// Export sheet — password prompt + share the .murmur file.
/// Mirrors pwa/backup.js createBackup() flow.
///
/// 2026-11-14: the export now includes the local chat history (the old one
/// wrote an empty `chats` object, so a backup carried nothing but the
/// identity — a PWA→iOS→PWA round trip lost the whole history).
struct BackupExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var app: AppState
    @State private var password = ""
    @State private var confirm = ""
    @State private var errorText: String?
    @State private var busy = false
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            Form {
                Section("Пароль резервной копии") {
                    SecureField("Минимум 8 символов", text: $password)
                    SecureField("Повторите пароль", text: $confirm)
                }
                Section {
                    Text("Файл .murmur содержит вашу личность, историю чатов и имена контактов. Без пароля восстановить его невозможно — сохраните пароль надёжно.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button {
                    export()
                } label: {
                    Label("Создать и сохранить", systemImage: "square.and.arrow.down")
                }
                .disabled(busy || password.count < 8 || password != confirm)

                if busy { ProgressView() }
                if let errorText {
                    Text(errorText).foregroundStyle(.red).font(.footnote)
                }
            }
            .navigationTitle("Скачать backup")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
        }
    }

    private func export() {
        busy = true; errorText = nil
        // Snapshot the state ON the main actor — `app.chats` / `app.contactNames`
        // are @Published properties of a @MainActor class and must not be
        // touched from a background task.
        let npub = IdentityStore.shared.npub ?? ""
        let name = UserDefaults.standard.string(forKey: "murmur.name") ?? npub
        let contactNames = app.contactNames
        let chats = app.chats
        let unread = app.unreadByPeer
        // PWA's `murmur_maxts_v1` map: peer -> newest ts already shown.
        // Without it the PWA re-bumps unread for every restored message on
        // each reload (Lesson #127) and loses the badge mirror.
        var maxTs: [String: Int] = [:]
        for chat in chats where chat.peer != "system:relay" {
            maxTs[chat.peer] = chat.lastTs
        }
        let password = self.password
        // PBKDF2 (250k iterations) + AES-GCM over the whole history takes
        // seconds — keep it off the main thread (iOS watchdog).
        Task.detached(priority: .userInitiated) {
            do {
                guard let sk = IdentityStore.shared.exportSkHex() else {
                    throw RelayError.make("Ключ не найден")
                }
                let data = try BackupManager.exportBackup(
                    skHex: sk,
                    npub: npub,
                    name: name,
                    password: password,
                    contactNamesJSON: Self.jsonString(contactNames),
                    chats: Self.exportChats(chats),
                    unread: unread,
                    maxTs: maxTs
                )
                let dir = FileManager.default.temporaryDirectory
                let url = dir.appendingPathComponent(BackupManager.fileName())
                try data.write(to: url)
                await MainActor.run { exportURL = url }
                await MainActor.run { presentShareSheet(url) }
            } catch {
                await MainActor.run { errorText = error.localizedDescription }
            }
            await MainActor.run { busy = false }
        }
    }

    /// Local history -> PWA export shape.
    ///
    /// The PWA keeps `direction: "system"` for call events and `"in"`/`"out"`
    /// for regular messages; the body of an outgoing message is the plaintext
    /// we already have locally (the PWA stores the same).
    private static func exportChats(_ chats: [ChatSummary]) -> [String: [BackupManager.ExportMessage]] {
        var out: [String: [BackupManager.ExportMessage]] = [:]
        for chat in chats {
            guard chat.peer != "system:relay" else { continue }
            var msgs: [BackupManager.ExportMessage] = []
            for m in chat.messages {
                if m.callEvent {
                    msgs.append(BackupManager.ExportMessage(
                        id: m.id, body: "", ts: m.ts, direction: "system", hash: nil,
                        attachments: [], callEvent: true,
                        callStatus: m.callStatus ?? "completed",
                        callDirection: m.callDirection ?? "in",
                        callDuration: m.callDuration))
                } else {
                    // Skip the empty "…" placeholder rows (pre-guard legacy).
                    if m.body.isEmpty && m.attachments.isEmpty { continue }
                    msgs.append(BackupManager.ExportMessage(
                        id: m.id, body: m.body, ts: m.ts,
                        direction: m.direction == .outgoing ? "out" : "in",
                        hash: m.hash, attachments: m.attachments,
                        callEvent: false, callStatus: nil, callDirection: nil, callDuration: 0))
                }
            }
            if !msgs.isEmpty { out[chat.peer] = msgs }
        }
        return out
    }

    private static func jsonString(_ dict: [String: String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func presentShareSheet(_ url: URL) {
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let root = scene.keyWindow?.rootViewController {
            var top = root
            while let p = top.presentedViewController { top = p }
            top.present(av, animated: true)
        }
    }
}

/// Import sheet — pick a .murmur file, decrypt with password.
/// Identity swap logic mirrors IdentityStore.importBackup (Rust parse).
struct BackupImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var app: AppState
    /// Pre-selected file (e.g. opened from Files) — the sheet skips the
    /// picker and asks only for the password (2026-11-14).
    ///
    /// ВАЖНО: объявлен ПЕРЕД `onSuccess` — trailing closure привязывается к
    /// ПЕРВОМУ closure-параметру структуры. Если первым объявлен `onSuccess`,
    /// вызов `BackupImportSheet(initialURL: url) { ... }` не компилируется
    /// («Incorrect argument label… expected 'onSuccess:initialURL:'») —
    /// эта ошибка блокировала СБОРКУ и из-за неё ни одна сборка после
    /// v160z28 не попадала на телефон (Олег, 16.11 16:41).
    var initialURL: URL? = nil
    var onSuccess: (() -> Void)?

    @State private var password = ""
    @State private var showImporter = false
    @State private var errorText: String?
    @State private var busy = false
    @State private var statusText: String?
    /// The file to restore from (chosen via the picker, or handed to us when
    /// the backup was opened from Files).
    @State private var selectedURL: URL?

    var body: some View {
        NavigationStack {
            Form {
                Section("Файл .murmur") {
                    SecureField("Пароль бэкапа", text: $password)
                    if let url = selectedURL {
                        LabeledContent("Файл", value: url.lastPathComponent)
                        Button {
                            restore(from: url)
                        } label: {
                            Label("Восстановить", systemImage: "arrow.counterclockwise")
                        }
                        .disabled(password.isEmpty || busy)
                    } else {
                        Button {
                            showImporter = true
                        } label: {
                            Label("Выбрать файл", systemImage: "doc")
                        }
                        .disabled(busy)
                    }
                }
                if busy { ProgressView() }
                if let statusText {
                    Text(statusText).font(.footnote).foregroundStyle(.secondary)
                }
                if let errorText {
                    Text(errorText).foregroundStyle(.red).font(.footnote)
                }
            }
            .navigationTitle("Восстановить backup")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.data, .murmurBackup],
                          allowsMultipleSelection: false) { result in
                importBackup(result)
            }
            .onAppear {
                // A file handed to us (opened from Files): pre-select it, the
                // user only has to type the password and press "Восстановить".
                if let url = initialURL {
                    selectedURL = url
                }
            }
        }
    }

    private func importBackup(_ result: Result<[URL], Error>) {
        do {
            guard let url = try result.get().first else { return }
            selectedURL = url
            NSLog("murmur import: file selected \(url.lastPathComponent)")
            // 2026-11-16 (Олег: «ввел пароль и выбрал файл — ничего не
            // произошло»): после выбора файла восстановление НЕ запускалось
            // само — надо было ещё заметить и нажать «Восстановить».
            // Теперь: если пароль уже введён — запускаем сразу.
            if password.isEmpty {
                statusText = "Файл выбран — введите пароль и нажмите «Восстановить»"
            } else {
                restore(from: url)
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    /// Restore from the selected file.
    private func restore(from url: URL) {
        busy = true; errorText = nil; statusText = "Расшифровка…"
        Task {
            do {
                // Security-scoped access + a 16 MB read + PBKDF2 + AES-GCM:
                // everything off the main actor (iOS watchdog kills a frozen UI).
                let data: Data = try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return try Data(contentsOf: url, options: .mappedIfSafe)
                }.value
                NSLog("murmur import: file read \(data.count) bytes")
                let password = self.password
                guard !password.isEmpty else {
                    await MainActor.run {
                        busy = false
                        statusText = "Введите пароль бэкапа"
                    }
                    return
                }
                let payload: BackupManager.Payload = try await Task.detached(priority: .userInitiated) {
                    try BackupManager.decodeBackup(data: data, password: password)
                }.value
                NSLog("murmur import: decrypt ok, peers=\(payload.chats.count) contacts=\(payload.contactNames.count)")

                // Identity first (Keychain), then the rest of the payload.
                let npub = try await Task.detached(priority: .userInitiated) { () -> String in
                    try IdentityStore.shared.importHex(payload.skHex)
                }.value
                await MainActor.run {
                    // `myNpub` must be the RESTORED npub before the payload is
                    // applied — applyBackupPayload filters our own npub out of
                    // the contact list using it.
                    //
                    // 2026-11-16: the npub the device had BEFORE the import is
                    // captured first — if the backup belongs to a different
                    // identity, the old (foreign) chats must be dropped
                    // instead of being mixed into the restored account.
                    let previousNpub = app.myNpub.isEmpty ? nil : app.myNpub
                    app.myNpub = npub
                    app.applyBackupPayload(payload, previousNpub: previousNpub)
                    let r = app.lastRestoreReport
                    statusText = "Восстановлено: \(r?.summary ?? payload.chats.count.description)"
                    busy = false
                }
                // The host view performs the post-import handshake
                // (didAuthenticate: register alias, connect, load contacts).
                await MainActor.run {
                    dismiss()
                    onSuccess?()
                }
            } catch {
                await MainActor.run {
                    errorText = error.localizedDescription
                    statusText = nil
                    busy = false
                }
            }
        }
    }
}

extension UTType {
    /// `.murmur` — MurMur backup file (custom extension, no system type).
    static let murmurBackup = UTType(exportedAs: "org.murmurchat.backup",
                                     conformingTo: .data)
}
