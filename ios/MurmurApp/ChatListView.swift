import SwiftUI

/// Chat list + sidebar actions — parity with the PWA sidebar footer grid:
///   Пригласить друга ✉ | Вставить ссылку 📋
///   Скачать backup     | Восстановить backup
///   Удалить все данные
/// Plus chat search and swipe-to-delete (PWA chat-search + 🗑).
struct ChatListView: View {
    @EnvironmentObject private var app: AppState
    @State private var newPeer = ""
    @State private var showNewChat = false
    @State private var showInvite = false
    @State private var showKeyReveal = false
    @State private var showBackupExport = false
    @State private var showBackupImporter = false
    @State private var importPassword = ""
    @State private var showWipeConfirm = false
    @State private var searchText = ""
    @State private var pasteText = ""
    @State private var selfLinkAlert = false

    var body: some View {
        NavigationStack {
            List {
                if app.chats.isEmpty {
                    ContentUnavailableView {
                        Label("Пока нет чатов", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Пригласите друга или вставьте полученную ссылку для начала общения")
                    }
                }
                ForEach(filteredChats) { chat in
                    NavigationLink {
                        ChatView(peer: chat.peer)
                    } label: {
                        row(chat)
                    }
                }
                .onDelete { indexes in
                    for i in indexes {
                        app.deleteChat(peer: filteredChats[i].peer)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "поиск чатов…")
            .navigationTitle("MurMur")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewChat = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                }
            }
            .sheet(isPresented: $showNewChat) { newChatSheet }
            .sheet(isPresented: $showInvite) {
                InviteView(myNpub: app.myNpub)
            }
            .sheet(isPresented: $showKeyReveal) { KeyRevealView() }
            .sheet(isPresented: $showBackupExport) { BackupExportSheet() }
            .sheet(isPresented: $showBackupImporter) { BackupImportSheet { app.didAuthenticate() } }
            .confirmationDialog(
                "Все ваши данные (личность, ключи, история чатов) будут безвозвратно удалены с этого устройства. Продолжить?",
                isPresented: $showWipeConfirm, titleVisibility: .visible
            ) {
                Button("Удалить все данные", role: .destructive) {
                    app.wipeEverything()
                }
                Button("Отмена", role: .cancel) {}
            }
            .alert("Это ваша собственная ссылка-приглашение", isPresented: $selfLinkAlert) {
                Button("Понятно", role: .cancel) {}
            } message: {
                Text("Скопируйте ссылку из приложения СОБЕСЕДНИКА («Пригласить друга» у него), либо попросите его прислать вам его ссылку.")
            }
            .safeAreaInset(edge: .bottom) {
                sidebarFooter
            }
        }
    }

    // MARK: - Sidebar footer (PWA parity)

    private var sidebarFooter: some View {
        VStack(spacing: 8) {
            if let status = app.statusLine {
                Text(status).font(.caption2).foregroundStyle(.secondary)
            }
            VStack(spacing: 6) {
                Button {
                    showInvite = true
                } label: {
                    Label("Пригласить друга", systemImage: "envelope")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                HStack(spacing: 6) {
                    actionTile("Вставить ссылку 📋") { pasteInvite() }
                    actionTile("Скачать backup") { showBackupExport = true }
                }
                HStack(spacing: 6) {
                    actionTile("Восстановить backup") { showBackupImporter = true }
                    actionTile("Мой ключ 🔑") { showKeyReveal = true }
                }
                Button(role: .destructive) {
                    showWipeConfirm = true
                } label: {
                    Label("Удалить все данные", systemImage: "trash")
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            Text(shortNpub(app.myNpub))
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private func actionTile(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.footnote)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Paste invite (PWA btn-add-by-link parity)

    /// Accepts a full invite link (`…#invite=npub1…`, `/invite/npub1…`,
    /// `?invite=npub1…`) or a bare npub — same parsing as pwa/app.js.
    private func pasteInvite() {
        let raw = UIPasteboard.general.string ?? ""
        if raw.isEmpty {
            app.statusLine = "Буфер обмена пуст"
            return
        }
        if let peer = Self.extractInviteNpub(from: raw) {
            openChat(with: peer)
        } else {
            app.statusLine = "Не нашла npub1… в вставленном тексте"
        }
    }

    /// Mirrors pwa/app.js extractInviteNpub() + btn-add-by-link regexes.
    static func extractInviteNpub(from raw: String) -> String? {
        if let m = raw.range(of: #"invite[=/\\](npub1[a-z0-9]+)"#,
                             options: .regularExpression, range: raw.startIndex..<raw.endIndex) {
            let hit = String(raw[m])
            if let npub = hit.range(of: #"npub1[a-z0-9]+"#,
                                    options: .regularExpression, range: hit.startIndex..<hit.endIndex) {
                return String(hit[npub])
            }
        }
        if let m = raw.range(of: #"\bnpub1[a-z0-9]{20,}\b"#,
                             options: .regularExpression, range: raw.startIndex..<raw.endIndex) {
            return String(raw[m])
        }
        return nil
    }

    private func openChat(with peer: String) {
        // Guard (lesson 2026-11-05): pasting YOUR OWN invite link creates a
        // self-chat — messages go to self, the push fires back at the sender,
        // and the intended peer hears nothing. The PWA has the same trap.
        if peer == app.myNpub {
            if showNewChat { selfLinkAlert = true }
            else { app.statusLine = "Это ваша собственная ссылка — вставьте ссылку СОБЕСЕДНИКА" }
            return
        }
        app.upsert(peer: peer, body: "", ts: Int(Date().timeIntervalSince1970),
                   direction: .incoming, hash: nil)
        app.statusLine = nil
    }

    // MARK: - Rows

    private var filteredChats: [ChatSummary] {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return app.chats }
        return app.chats.filter {
            $0.peer.localizedCaseInsensitiveContains(q)
                || (app.displayName(for: $0.peer) ?? "").localizedCaseInsensitiveContains(q)
        }
    }

    private func row(_ chat: ChatSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(app.displayName(for: chat.peer) ?? shortNpub(chat.peer))
                .font(.headline)
            Text(chat.lastBody.isEmpty ? "…" : chat.lastBody)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var newChatSheet: some View {
        NavigationStack {
            Form {
                Section("Invite-ссылка или npub собеседника") {
                    TextField("https://murmurchat.org/#invite=npub1… или npub1…",
                              text: $newPeer, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                }
            }
            .navigationTitle("Новый чат")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { showNewChat = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Добавить") {
                        if let peer = Self.extractInviteNpub(from: newPeer) {
                            openChat(with: peer)
                            newPeer = ""
                            showNewChat = false
                        }
                    }
                    .disabled(Self.extractInviteNpub(from: newPeer) == nil)
                }
            }
        }
    }
}

/// PWA never shows a full npub in the list — same rule here.
func shortNpub(_ npub: String) -> String {
    guard npub.count > 16 else { return npub }
    return "\(npub.prefix(10))…\(npub.suffix(6))"
}
