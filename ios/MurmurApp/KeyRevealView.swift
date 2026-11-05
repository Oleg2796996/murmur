import SwiftUI

/// "Мой ключ" — parity with the PWA key-reveal overlay (btnShowKey):
/// shows the sk hex with a copy button and a warning.
struct KeyRevealView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var skHex = ""
    @State private var copied = false

    var body: some View {
        VStack(spacing: 14) {
            Text("Твой ключ (секрет!)")
                .font(.headline)
            Text("Вставь его на другом устройстве / в PWA через «Импортировать ключ». Никому не показывай.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Text(skHex)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))

            Button {
                UIPasteboard.general.string = skHex
                copied = true
            } label: {
                Label(copied ? "Скопировано ✓" : "Скопировать",
                      systemImage: copied ? "checkmark" : "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button("Закрыть") { dismiss() }
                .buttonStyle(.borderless)
        }
        .padding(18)
        .onAppear {
            skHex = IdentityStore.shared.exportSkHex() ?? ""
        }
    }
}
