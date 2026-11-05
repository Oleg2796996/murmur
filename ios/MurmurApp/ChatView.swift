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
    @State private var showFileImporter = false
    @State private var attaching = false

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
        HStack(alignment: .bottom, spacing: 6) {
            if m.direction == .outgoing { Spacer(minLength: 40) }
            VStack(alignment: m.direction == .outgoing ? .trailing : .leading, spacing: 2) {
                if m.body.isEmpty && !m.attachments.isEmpty {
                    // attachment-only message: chips outside the colored bubble
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(m.attachments, id: \.blobID) { att in
                            AttachmentChip(att: att, outgoing: m.direction == .outgoing)
                        }
                    }
                } else {
                    let cleanBody = m.attachments.isEmpty ? m.body
                        : m.body.components(separatedBy: "\n")
                            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("📎") }
                            .joined(separator: "\n")
                    Text(cleanBody.isEmpty ? "…" : cleanBody)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(m.direction == .outgoing ? Color.accentColor : Color(.secondarySystemBackground))
                        .foregroundStyle(m.direction == .outgoing ? Color.white : Color.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    if !m.attachments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(m.attachments, id: \.blobID) { att in
                                AttachmentChip(att: att, outgoing: m.direction == .outgoing)
                            }
                        }
                    }
                }
                Text(Self.timeString(m.ts))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if m.direction == .incoming { Spacer(minLength: 40) }
        }
    }

    static func timeString(_ ts: Int) -> String {
        let f = DateFormatter()
        f.dateFormat = (ts > 100_000_000_000) ? "HH:mm:ss" : "HH:mm"
        f.timeZone = .current
        // ts is unix SECONDS (relay stores seconds); if a value looks like ms, treat as ms
        let date = ts > 100_000_000_000 ? Date(timeIntervalSince1970: Double(ts) / 1000)
                                        : Date(timeIntervalSince1970: Double(ts))
        return f.string(from: date)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Button {
                showFileImporter = true
            } label: {
                Image(systemName: attaching ? "hourglass" : "paperclip")
                    .font(.title3)
            }
            .disabled(sending || attaching)
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item],
                          allowsMultipleSelection: false) { result in
                Task { await attachAndSend(result) }
            }
            TextField("Сообщение", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
            Button {
                Task { await send() }
            } label: {
                Image(systemName: sending ? "clock" : "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(sending || attaching || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(12)
        .background(.bar)
    }

    /// pwa attachEncryptAndUpload parity: encrypt+wrap+upload, then envelope
    /// with attachments_meta (neutral names server-side, real names in ct).
    private func attachAndSend(_ result: Result<[URL], Error>) async {
        await MainActor.run { attaching = true; errorText = nil }
        defer { Task { @MainActor in attaching = false } }
        do {
            guard let url = try result.get().first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let name = url.lastPathComponent
            let mime = Self.guessMime(name)
            let prepared = try await AttachmentManager.encryptAndUpload(
                fileData: data, fileName: name, mime: mime,
                peerNpub: peer, selfNpub: app.myNpub)
            let hash = try await app.relay.sendWithAttachments(
                peer: peer, plaintext: draft, prepared: [prepared])
            let body = draft.isEmpty ? "📎 \(name)" : draft + "\n📎 " + name
            let ts = Int(Date().timeIntervalSince1970)
            var chip: [String: Any] = [
                "blob_id": prepared.blobID, "wrapped_key": prepared.wrappedKey,
                "iv": prepared.ivB64, "mime": prepared.mime, "size": prepared.size,
                "name": prepared.fileName,
            ]
            if let t = prepared.blobToken { chip["blob_token"] = t }
            let chips: [[String: Any]] = [chip]
            await MainActor.run {
                app.upsert(peer: peer, body: body, ts: ts, direction: .outgoing,
                           hash: hash, attachments: chips)
                draft = ""
            }
        } catch {
            await MainActor.run { errorText = error.localizedDescription }
        }
    }

    static func guessMime(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "mp3": return "audio/mpeg"
        case "ogg": return "audio/ogg"
        case "wav": return "audio/wav"
        case "mp4": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        default: return "application/octet-stream"
        }
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
                               direction: direction, hash: row.hash,
                               attachments: dec.attachments)
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
