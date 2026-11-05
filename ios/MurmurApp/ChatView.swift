import SwiftUI

/// 1:1 chat. Sending path mirrors pwa/app.js sendMessage():
/// encrypt in Rust -> sign `from|to|ts|ct` -> POST /envelope.
struct ChatView: View {
    @EnvironmentObject private var app: AppState
    let peer: String

    @State private var draft = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var showRename = false
    @State private var renameText = ""

    private var messages: [ChatMessage] {
        app.chats.first(where: { $0.peer == peer })?.messages ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(messages) { m in
                            bubble(m).id(m.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onChange(of: messages.count) {
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
            }

            composer
        }
        .navigationTitle(app.displayName(for: peer) ?? shortNpub(peer))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    renameText = app.displayName(for: peer) ?? ""
                    showRename = true
                } label: {
                    Image(systemName: "pencil")
                }
            }
        }
        .alert("Имя контакта", isPresented: $showRename) {
            TextField("Имя", text: $renameText)
            Button("Сохранить") {
                app.setDisplayName(renameText.trimmingCharacters(in: .whitespaces), for: peer)
            }
            Button("Отмена", role: .cancel) {}
        }
        .task { await loadHistory() }
    }

    private func bubble(_ m: ChatMessage) -> some View {
        HStack {
            if m.direction == .outgoing { Spacer(minLength: 40) }
            Text(m.body.isEmpty ? "…" : m.body)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(m.direction == .outgoing ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(m.direction == .outgoing ? Color.white : Color.primary)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if m.direction == .incoming { Spacer(minLength: 40) }
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Сообщение", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
            Button {
                Task { await send() }
            } label: {
                Image(systemName: sending ? "clock" : "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(12)
        .background(.bar)
    }

    private func loadHistory() async {
        do {
            let rows = try await app.relay.history(peer: peer).map { $0.withUnwrappedBody() }
            for row in rows {
                // Skip undecryptable rows (own outgoing echo — sealed to the
                // peer's key) and service envelopes (✓✓ receipts).
                guard let dec = app.relay.decryptMessage(row: row),
                      !dec.isService, !dec.body.isEmpty || !dec.attachments.isEmpty else { continue }
                let direction: ChatMessage.Direction =
                    (row.from_npub == app.myNpub) ? .outgoing : .incoming
                await MainActor.run {
                    app.upsert(peer: peer, body: dec.displayBody, ts: row.ts ?? 0,
                               direction: direction, hash: row.hash)
                }
            }
        } catch {
            await MainActor.run { errorText = error.localizedDescription }
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await MainActor.run {
            sending = true
            errorText = nil
            draft = ""
        }
        do {
            let hash = try await app.relay.send(peer: peer, plaintext: text)
            let ts = Int(Date().timeIntervalSince1970)
            await MainActor.run {
                app.upsert(peer: peer, body: text, ts: ts, direction: .outgoing, hash: hash)
                sending = false
            }
        } catch {
            await MainActor.run {
                errorText = error.localizedDescription
                sending = false
            }
        }
    }
}
