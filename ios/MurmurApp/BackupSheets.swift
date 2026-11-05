import SwiftUI

/// Export sheet — password prompt + share the .murmur file.
/// Mirrors pwa/backup.js createBackup() flow.
struct BackupExportSheet: View {
    @Environment(\.dismiss) private var dismiss
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
                    Text("Файл .murmur содержит вашу личность. Без пароля восстановить его невозможно — сохраните пароль надёжно.")
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
        DispatchQueue.main.async {
            defer { busy = false }
            do {
                guard let sk = IdentityStore.shared.exportSkHex() else {
                    throw RelayError.make("Ключ не найден")
                }
                let data = try BackupManager.exportBackup(
                    skHex: sk,
                    npub: IdentityStore.shared.npub ?? "",
                    name: IdentityStore.shared.npub ?? "",
                    password: password
                )
                let dir = FileManager.default.temporaryDirectory
                let url = dir.appendingPathComponent(BackupManager.fileName())
                try data.write(to: url)
                exportURL = url
                let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                   let root = scene.keyWindow?.rootViewController {
                    var top = root
                    while let p = top.presentedViewController { top = p }
                    top.present(av, animated: true)
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

/// Import sheet — pick a .murmur file, decrypt with password.
/// Identity swap logic mirrors IdentityStore.importBackup (Rust parse).
struct BackupImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onSuccess: (() -> Void)?

    @State private var password = ""
    @State private var showImporter = false
    @State private var errorText: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Файл .murmur") {
                    SecureField("Пароль бэкапа", text: $password)
                    Button {
                        showImporter = true
                    } label: {
                        Label("Выбрать файл", systemImage: "doc")
                    }
                    .disabled(password.isEmpty || busy)
                }
                if busy { ProgressView() }
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
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.data],
                          allowsMultipleSelection: false) { result in
                importBackup(result)
            }
        }
    }

    private func importBackup(_ result: Result<[URL], Error>) {
        busy = true; errorText = nil
        DispatchQueue.main.async {
            defer { busy = false }
            do {
                guard let url = try result.get().first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                _ = try IdentityStore.shared.importBackup(data: data, password: password)
                dismiss()
                onSuccess?()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}
