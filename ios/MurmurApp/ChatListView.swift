import SwiftUI

/// Chat list — visual parity with the PWA sidebar (spec: UI parity).
struct ChatListView: View {
    @EnvironmentObject private var app: AppState
    @State private var newPeer = ""
    @State private var showNewChat = false

    var body: some View {
        NavigationStack {
            List {
                if app.chats.isEmpty {
                    ContentUnavailableView(
                        "Пока нет чатов",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Добавьте контакт по npub, чтобы начать переписку.")
                    )
                }
                ForEach(app.chats) { chat in
                    NavigationLink {
                        ChatView(peer: chat.peer)
                    } label: {
                        row(chat)
                    }
                }
            }
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
            .sheet(isPresented: $showNewChat) {
                newChatSheet
            }
            .safeAreaInset(edge: .bottom) {
                Text(shortNpub(app.myNpub))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
        }
    }

    private func row(_ chat: ChatSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(shortNpub(chat.peer))
                .font(.headline)
            Text(chat.lastBody)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var newChatSheet: some View {
        NavigationStack {
            Form {
                Section("npub собеседника") {
                    TextField("npub1…", text: $newPeer, axis: .vertical)
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
                        let peer = newPeer.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard peer.hasPrefix("npub1") else { return }
                        app.upsert(peer: peer, body: "", ts: Int(Date().timeIntervalSince1970),
                                   direction: .incoming, hash: nil)
                        newPeer = ""
                        showNewChat = false
                    }
                    .disabled(!newPeer.trimmingCharacters(in: .whitespaces).hasPrefix("npub1"))
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
