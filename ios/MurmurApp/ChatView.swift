import SwiftUI
import PhotosUI

/// 1:1 chat. Sending path mirrors pwa/app.js sendMessage():
/// encrypt in Rust -> sign `from|to|ts|ct` -> POST /envelope.
@MainActor
struct ChatView: View {
    @EnvironmentObject private var app: AppState
    let peer: String

    @State private var draft = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showFileImporter = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var cameraImage: UIImage?
    @State private var cameraMovieURL: URL?
    @State private var pickedItem: PhotosPickerItem?
    @State private var attaching = false
    /// True while the message field has keyboard focus — lets the drag
    /// gesture dismiss the keyboard (scrollDismissesKeyboard only works
    /// when the ScrollView itself is focusable-linked on iOS 27).
    @FocusState private var draftFocused: Bool
    /// Bumped on every history apply for this chat — used to force the feed
    /// to the bottom even when the last message id is unchanged (re-poll
    /// dedup) — 2026-11-09 "open at bottom" robustness fix.
    @State private var historyVersion = 0

    private var messages: [ChatMessage] {
        app.chats.first(where: { $0.peer == peer })?.messages ?? []
    }

    var body: some View {
        ZStack {
            MurmurTheme.bg.ignoresSafeArea()
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
                // 2026-11-09 open-at-bottom fix: defaultScrollAnchor pins the
                // feed to the newest message on open (LazyVStack + onAppear
                // scrollTo raced history loading and sometimes landed mid-list).
                .defaultScrollAnchor(.bottom)
                // Swipe down dismisses the keyboard (messenger standard).
                .scrollDismissesKeyboard(.interactively)
                // Belt & suspenders: a plain downward drag anywhere on the
                // feed also ends editing (works even when the scroll gesture
                // is consumed by rubber-banding at the bottom).
                .simultaneousGesture(
                    DragGesture(minimumDistance: 30)
                        .onEnded { value in
                            if value.translation.height > 40 {
                                draftFocused = false
                            }
                        }
                )
                .onAppear {
                    if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                    app.openChatPeer = peer
                    app.markChatRead(peer: peer)
                }
                .onDisappear {
                    if app.openChatPeer == peer { app.openChatPeer = nil }
                }
                .onChange(of: historyVersion) {
                    // Fires on every history apply for this chat (new rows,
                    // re-poll, echo) — the feed always lands on the newest.
                    if let last = messages.last {
                        // Small delay lets LazyVStack materialize the row
                        // before scrolling (bare scrollTo can fire early).
                        Task { @MainActor in
                            try? await Task.sleep(nanoseconds: 80_000_000)
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
                .onChange(of: messages.last?.id) {
                    if let last = messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
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
        }
        .navigationTitle(app.displayName(for: peer) ?? shortNpub(peer))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(MurmurTheme.panel, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
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
                    VStack(alignment: m.direction == .outgoing ? .trailing : .leading, spacing: 4) {
                        ForEach(m.attachments, id: \.blobID) { att in
                            AttachmentChip(att: att, outgoing: m.direction == .outgoing)
                        }
                    }
                } else {
                    let cleanBody = m.attachments.isEmpty ? m.body
                        : m.body.components(separatedBy: "\n")
                            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("📎") }
                            .joined(separator: "\n")
                    // Attachment-carrying message with caption-less body renders
                    // ONLY chips — an empty "…" bubble above them is noise
                    // (screenshot 21:42: blue "…" pill over photo chip).
                    if !cleanBody.isEmpty {
                        Text(cleanBody)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(m.direction == .outgoing ? MurmurTheme.bubbleOut : MurmurTheme.bubbleIn)
                            .foregroundStyle(m.direction == .outgoing ? Color.white : MurmurTheme.text)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    if !m.attachments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(m.attachments, id: \.blobID) { att in
                                AttachmentChip(att: att, outgoing: m.direction == .outgoing)
                            }
                        }
                    }
                }
                HStack(spacing: 2) {
                    Text(Self.timeString(m.ts))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if m.direction == .outgoing {
                        Text(app.isAcked(m.hash) ? "✓✓" : "✓")
                            .font(.caption2)
                            .foregroundStyle(app.isAcked(m.hash) ? MurmurTheme.accent : MurmurTheme.textMuted)
                    }
                }
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
            // Paperclip = attachment menu: фото из галереи / камера / файл.
            Menu {
                Button {
                    showCamera = true
                } label: {
                    Label("Снять фото или видео", systemImage: "camera")
                }
                Button {
                    showPhotoPicker = true
                } label: {
                    Label("Медиатека", systemImage: "photo.on.rectangle")
                }
                Button {
                    showFileImporter = true
                } label: {
                    Label("Файл…", systemImage: "folder")
                }
            } label: {
                Image(systemName: attaching ? "hourglass" : "paperclip")
                    .font(.title3)
                    .foregroundStyle(MurmurTheme.textMuted)
            }
            .disabled(sending || attaching)
            .photosPicker(isPresented: $showPhotoPicker, selection: $pickedItem,
                          matching: .any(of: [.images, .videos]))
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { capture in
                    switch capture {
                    case .photo(let image): cameraImage = image
                    case .movie(let url): cameraMovieURL = url
                    }
                }
                .ignoresSafeArea()
            }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item],
                          allowsMultipleSelection: false) { result in
                Task { await attachAndSend(result) }
            }
            .onChange(of: pickedItem) {
                guard let item = pickedItem else { return }
                pickedItem = nil
                Task { await attachPicked(item) }
            }
            .onChange(of: cameraImage) {
                guard let image = cameraImage else { return }
                cameraImage = nil
                Task { await attachCameraPhoto(image) }
            }
            .onChange(of: cameraMovieURL) {
                guard let url = cameraMovieURL else { return }
                cameraMovieURL = nil
                Task { await sendMovieFile(url, fallbackName: "video") }
            }
            TextField("Сообщение", text: $draft, axis: .vertical)
                .focused($draftFocused)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(MurmurTheme.bubbleIn)
                .foregroundStyle(MurmurTheme.text)
                .tint(MurmurTheme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Button {
                Task { await send() }
            } label: {
                Image(systemName: sending ? "clock" : "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(sending || attaching || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(MurmurTheme.panel)
    }

    /// From media library: photo (jpeg) or video (movie file) — both into the shared pipeline.
    private func attachPicked(_ item: PhotosPickerItem) async {
        do {
            if let movie = try await item.loadTransferable(type: MurmurMovie.self) {
                await sendMovieFile(movie.url, fallbackName: "video")
                return
            }
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            await sendAttachment(data: data,
                                 fileName: "photo-\(Int(Date().timeIntervalSince1970)).jpg",
                                 mime: "image/jpeg")
        } catch {
            await MainActor.run { errorText = error.localizedDescription }
        }
    }

    /// Camera shot: UIImage -> jpeg Data -> shared pipeline.
    private func attachCameraPhoto(_ image: UIImage) async {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        await sendAttachment(data: data,
                             fileName: "camera-\(Int(Date().timeIntervalSince1970)).jpg",
                             mime: "image/jpeg")
    }

    /// Movie file (from camera or media library) -> shared pipeline.
    private func sendMovieFile(_ url: URL, fallbackName: String) async {
        do {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            guard !data.isEmpty else { return }
            let ext = url.pathExtension.lowercased()
            let mime = (ext == "mov") ? "video/quicktime" : "video/mp4"
            let safeExt = (ext == "mov" || ext == "mp4") ? ext : "mp4"
            let name = "\(fallbackName)-\(Int(Date().timeIntervalSince1970)).\(safeExt)"
            await sendAttachment(data: data, fileName: name, mime: mime)
        } catch {
            await MainActor.run { errorText = error.localizedDescription }
        }
    }

    /// Shared attachment send path (used by all three pickers).
    private func sendAttachment(data: Data, fileName: String, mime: String) async {
        await MainActor.run { attaching = true; errorText = nil }
        defer { Task { @MainActor in attaching = false } }
        do {
            let prepared = try await AttachmentManager.encryptAndUpload(
                fileData: data, fileName: fileName, mime: mime,
                peerNpub: peer, selfNpub: app.myNpub)
            let hash = try await app.relay.sendWithAttachments(
                peer: peer, plaintext: draft, prepared: [prepared])
            let body = draft.isEmpty ? "📎 \(fileName)" : draft + "\n📎 " + fileName
            let ts = Int(Date().timeIntervalSince1970)
            var chip: [String: Any] = [
                "blob_id": prepared.blobID, "wrapped_key": prepared.wrappedKey,
                "iv": prepared.ivB64, "mime": prepared.mime, "size": prepared.size,
                "name": prepared.fileName,
            ]
            if let t = prepared.blobToken { chip["blob_token"] = t }
            await MainActor.run {
                app.upsert(peer: peer, body: body, ts: ts, direction: .outgoing,
                           hash: hash, attachments: [chip])
                draft = ""
            }
        } catch {
            await MainActor.run { errorText = error.localizedDescription }
        }
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
            let rows = try await app.relay.history(peer: peer)
            // Decrypt off the MainActor (Rust ECIES per row; on-main decrypt
            // froze the UI on poll bursts — same class of bug as 12fe19e).
            let pairs = await app.relay.decryptRows(rows)
            // Batch-apply in ONE mutation (2026-11-09 lag fix): per-row upsert
            // re-rendered the whole list and re-wrote the store per message.
            let incoming = pairs.compactMap { pair -> (row: HistoryRow, dec: RelayClient.Decrypted)? in
                guard let dec = pair.dec, !dec.isService,
                      !dec.body.isEmpty || !dec.attachments.isEmpty else { return nil }
                return (pair.row, dec)
            }
            if incoming.count > 0 {
                app.applyHistory(peer: peer, incoming: incoming)
                // Force the feed to the bottom after the batch lands
                // (onChange(historyVersion) does the scroll).
                historyVersion += 1
            }
        } catch {
            errorText = error.localizedDescription
        }
        // v160y61 self-heal: our outgoing without ✓✓ older than 90s → receipt_req.
        let outgoing = app.chats.first(where: { $0.peer == peer })?.messages
            .filter { $0.direction == .outgoing }
            .map { (hash: $0.hash, ts: $0.ts) } ?? []
        await ReceiptManager.shared.requestMissingReceipts(peer: peer, outgoing: outgoing)
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

/// PhotosUI has no built-in movie Transferable; this copies the original
/// movie file into our temp space via FileRepresentation (no photo-library
/// permission needed, same model as PHPicker images).
struct MurmurMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("murmur-movie-\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: dest)
            return MurmurMovie(url: dest)
        }
    }
}
