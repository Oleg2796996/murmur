import SwiftUI

/// Renders one attachment chip: images inline (after decrypt), other files
/// as a tappable chip that opens a share/preview sheet.
/// Parity with pwa/render-attachments.js fetchBlob + AES decrypt path.
struct AttachmentChip: View {
    let att: [String: Any]
    /// outgoing chips use the `s` wrapped key, incoming use `r`
    let outgoing: Bool

    @State private var image: UIImage?
    @State private var loading = false
    @State private var failed = false
    @State private var openURL: URL?

    private var mime: String { att["mime"] as? String ?? "application/octet-stream" }
    private var isImage: Bool { mime.hasPrefix("image/") }
    private var name: String { att["name"] as? String ?? "file" }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("расшифровка…")
                }
                .padding(10)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if failed {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                    Button("повторить") { Task { await load() } }
                }
                .font(.footnote)
                .padding(10)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                Button {
                    openURL = URL(string: "murmur-attach://open")
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: iconFor(mime))
                        Text(name).lineLimit(1)
                    }
                    .padding(10)
                    .background(Color(.secondarySystemBackground))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .sheet(item: $openURL) { _ in
                    AttachPreviewSheet(att: att, outgoing: outgoing, name: name)
                }
            }
        }
        .task { if isImage { await load() } }
    }

    private func load() async {
        loading = true; failed = false
        defer { loading = false }
        do {
            let (plain, _) = try await AttachmentManager.downloadAndDecrypt(
                att: att, selfKey: outgoing)
            if let img = UIImage(data: plain) {
                image = img
            } else {
                failed = true
            }
        } catch {
            failed = true
        }
    }

    private func iconFor(_ mime: String) -> String {
        if mime.hasPrefix("video/") { return "video" }
        if mime.hasPrefix("audio/") { return "waveform" }
        return "paperclip"
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// Full-screen preview for non-image files (QuickLook-like via share sheet).
struct AttachPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let att: [String: Any]
    let outgoing: Bool
    let name: String

    @State private var fileURL: URL?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if let fileURL {
                    ShareLink(item: fileURL) {
                        Label("Открыть / Поделиться", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    Text(name).font(.footnote).foregroundStyle(.secondary)
                } else if let errorText {
                    Text(errorText).foregroundStyle(.red).font(.footnote)
                } else {
                    ProgressView("скачивание…")
                }
                Spacer()
            }
            .padding()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { dismiss() }
                }
            }
            .task { await download() }
        }
    }

    private func download() async {
        do {
            let (plain, _) = try await AttachmentManager.downloadAndDecrypt(
                att: att, selfKey: outgoing)
            let dir = FileManager.default.temporaryDirectory
            let url = dir.appendingPathComponent(name)
            try plain.write(to: url)
            fileURL = url
        } catch {
            errorText = error.localizedDescription
        }
    }
}
