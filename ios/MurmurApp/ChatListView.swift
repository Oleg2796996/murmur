import SwiftUI

/// PWA palette (pwa/styles.css :root — Telegram dark theme).
enum MurmurTheme {
    static let bg = Color(red: 0x17/255, green: 0x21/255, blue: 0x2b/255)      // #17212b
    static let panel = Color(red: 0x0e/255, green: 0x16/255, blue: 0x21/255)   // #0e1621
    static let bubbleOut = Color(red: 0x2b/255, green: 0x52/255, blue: 0x78/255) // #2b5278
    static let text = Color(red: 0xe1/255, green: 0xe9/255, blue: 0xf0/255)    // #e1e9f0
    static let textMuted = Color(red: 0x70/255, green: 0x84/255, blue: 0x99/255) // #708499
    static let accent = Color(red: 0x4f/255, green: 0xa3/255, blue: 0xff/255)  // #4fa3ff
    static let border = Color(red: 0x1f/255, green: 0x2c/255, blue: 0x3a/255)  // #1f2c3a
    static let bubbleIn = Color(red: 0x18/255, green: 0x25/255, blue: 0x33/255) // #182533
    static let danger = Color(red: 0xf0/255, green: 0x6c/255, blue: 0x6c/255)  // #f06c6c
    static let green = Color(red: 0x28/255, green: 0xa7/255, blue: 0x45/255)   // #28a745
    static let gold = Color(red: 0xd6/255, green: 0xa5/255, blue: 0x00/255)    // #d6a500

    /// Avatar colors cycle (PWA: colored circles with the first letter).
    static func avatarColor(_ seed: String) -> Color {
        let palette: [Color] = [
            Color(red: 0x4f/255, green: 0xa3/255, blue: 0xff/255),
            Color(red: 0xe1/255, green: 0x8e/255, blue: 0x5c/255),
            Color(red: 0x8e/255, green: 0x6c/255, blue: 0xf0/255),
            Color(red: 0x4f/255, green: 0xc4/255, blue: 0x8f/255),
            Color(red: 0xf0/255, green: 0xa5/255, blue: 0x4f/255),
            Color(red: 0xf0/255, green: 0x6c/255, blue: 0x9d/255),
        ]
        var h = 0
        for b in seed.utf8 { h = (h &* 31 &+ Int(b)) & 0xFFFF }
        return palette[h % palette.count]
    }
}


/// Glass pill button (2026-11-09, Олег: «кнопки сделай стеклянные»).
/// iOS 26+: native Liquid Glass (.glassEffect). iOS 17–25 fallback:
/// ultraThinMaterial capsule + faint white stroke + soft shadow.
/// Params per design consult: height 32, hPadding 12, footnote 13 semibold,
/// accent text #4fa3ff (≈5:1 on dark glass, encodes "action").
struct GlassPillButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(MurmurTheme.accent)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background {
                    if #available(iOS 26.0, *) {
                        AnyView(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(.clear)
                                .glassEffect(.regular.tint(.white.opacity(0.08)), in: .capsule)
                        )
                    } else {
                        AnyView(
                            Capsule()
                                .fill(.ultraThinMaterial)
                                .overlay(Capsule().stroke(.white.opacity(0.10), lineWidth: 0.5))
                                .shadow(color: .black.opacity(0.25), radius: 4, y: 1)
                        )
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

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
            Group {
                if filteredChats.isEmpty {
                    VStack(spacing: 8) {
                        Text("MurMur")
                            .font(.title2.bold())
                            .foregroundStyle(MurmurTheme.text)
                        Text("Пригласите друга или вставьте полученную ссылку для начала общения")
                            .font(.footnote)
                            .foregroundStyle(MurmurTheme.textMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(filteredChats) { chat in
                                NavigationLink {
                                    ChatView(peer: chat.peer)
                                } label: {
                                    row(chat)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .background(MurmurTheme.bg)
            .searchable(text: $searchText, prompt: "поиск чатов…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(MurmurTheme.panel, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                // 2026-11-09 (Олег, v5): стеклянные капсулы — «Пригласить
                // друга» и «Вставить ссылку» (полные подписи, fixedSize —
                // без сокращений), отдельная компактная стеклянная «…»
                // с backup/удалением. Inline-тайтл обязателен (large title
                // съедает ширину и подписи обрежутся).
                ToolbarItem(placement: .principal) {
                    GlassPillButton(title: "Пригласить друга") { showInvite = true }
                }
                ToolbarItem(placement: .principal) {
                    GlassPillButton(title: "Вставить ссылку") { showNewChat = true }
                }
                ToolbarItem(placement: .principal) {
                    moreMenu
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
        }
    }

    // MARK: - Sidebar footer (PWA parity)

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
        let name = app.displayName(for: chat.peer) ?? shortNpub(chat.peer)
        return HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(MurmurTheme.avatarColor(chat.peer))
                    .frame(width: 40, height: 40)
                Text(String(app.displayName(for: chat.peer)?.first ?? Character(shortNpub(chat.peer).prefix(1).uppercased())))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.system(size: 14, weight: app.unreadCount(for: chat.peer) > 0 ? .bold : .semibold))
                    .foregroundStyle(MurmurTheme.text)
                    .lineLimit(1)
                if app.typingPeers.contains(chat.peer) {
                    Text("печатает…").font(.system(size: 12)).foregroundStyle(MurmurTheme.accent)
                } else {
                    Text(Self.previewText(chat))
                        .font(.system(size: 12, weight: app.unreadCount(for: chat.peer) > 0 ? .semibold : .regular))
                        .foregroundStyle(app.unreadCount(for: chat.peer) > 0 ? MurmurTheme.text : MurmurTheme.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(Self.timeText(chat.lastTs))
                    .font(.system(size: 11))
                    .foregroundStyle(MurmurTheme.textMuted)
                // Unread sticker (PWA parity): hidden when 0.
                if app.unreadCount(for: chat.peer) > 0 {
                    Text("\(min(app.unreadCount(for: chat.peer), 99))\(app.unreadCount(for: chat.peer) > 99 ? "+" : "")")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.red))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(MurmurTheme.bg)
        .overlay(alignment: .bottom) {
            Rectangle().fill(MurmurTheme.border).frame(height: 0.5)
        }
        .contentShape(Rectangle())
    }

    /// PWA chat-item-time: HH:MM (24h) from unix seconds.
    static func timeText(_ ts: Int) -> String {
        let date = ts > 100_000_000_000 ? Date(timeIntervalSince1970: Double(ts) / 1000)
                                        : Date(timeIntervalSince1970: Double(ts))
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// PWA preview parity: «📎 фото · текст», «📎 видео», strip 📎-lines from
    /// the body (they duplicate the attachment label).
    static func previewText(_ chat: ChatSummary) -> String {
        let kindOf: (String) -> String = { mime in
            if mime.hasPrefix("image/") { return "фото" }
            if mime.hasPrefix("video/") { return "видео" }
            if mime.hasPrefix("audio/") { return "аудио" }
            return "файл"
        }
        let attLabel: String?
        if chat.lastMimes.isEmpty {
            attLabel = nil
        } else {
            let base = "📎 " + kindOf(chat.lastMimes[0])
            attLabel = chat.lastMimes.count > 1 ? base + " +" + String(chat.lastMimes.count - 1) : base
        }
        var t = chat.lastBody.trimmingCharacters(in: .whitespacesAndNewlines)
        // Raw envelope / attachment-lines are not useful in the preview.
        if t.hasPrefix("{") { t = "" }
        if !t.isEmpty {
            t = t.components(separatedBy: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("📎") }
                .joined(separator: " ")
                .replacingOccurrences(of: "  ", with: " ")
                .trimmingCharacters(in: .whitespaces)
        }
        if !t.isEmpty {
            return attLabel != nil ? attLabel! + " · " + t : t
        }
        if let attLabel { return attLabel }
        return "…"
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
