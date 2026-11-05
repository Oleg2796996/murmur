import SwiftUI
import CoreImage.CIFilterBuiltins

/// "Пригласить друга" — parity with pwa/app.js showInviteQr():
/// invite link `https://<host>/#invite=<npub>` + QR + share sheet + copy.
/// The link format is what extractInviteNpub() in the PWA parses
/// (`#invite=npub1...`), so a friend opening it in any browser / the PWA
/// lands with the chat pre-added.
struct InviteView: View {
    @Environment(\.dismiss) private var dismiss
    let myNpub: String

    @State private var copied = false
    @State private var qrImage: UIImage?

    private var inviteLink: String {
        // Same construction as pwa/app.js btnInvite handler:
        //   `${origin}${pathname}#invite=${npub}` — for the app the origin is
        // the production relay landing.
        "https://murmurchat.org/#invite=\(myNpub)"
    }

    var body: some View {
        VStack(spacing: 14) {
            Text("Пригласить друга")
                .font(.headline)
            Text("Пусть друг наведёт камеру телефона на QR-код или откроет ссылку")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Group {
                if let qrImage {
                    Image(uiImage: qrImage)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 220, height: 220)
                } else {
                    ProgressView().frame(width: 220, height: 220)
                }
            }
            .padding(12)
            .background(Color.white)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            ShareLink(item: shareText) {
                Label("Поделиться", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button {
                UIPasteboard.general.string = inviteLink
                copied = true
            } label: {
                Label(copied ? "Скопировано ✓" : "Скопировать ссылку",
                      systemImage: copied ? "checkmark" : "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Button("Закрыть") { dismiss() }
                .buttonStyle(.borderless)
        }
        .padding(18)
        .onAppear { qrImage = Self.makeQR(inviteLink) }
    }

    /// v158c lesson from the PWA: macOS/iOS share sheets discard bare URLs,
    /// the link must be embedded in the text.
    private var shareText: String {
        "Присоединяйся в приватном мессенджере murmur! \(inviteLink)"
    }

    static func makeQR(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scale to a crisp, camera-scannable size (like the PWA's pixelated GIF).
        let scale = 220.0 / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
