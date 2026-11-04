import SwiftUI

/// First-run flow: create / import by hex / import `.murmur` backup.
/// Mirrors the PWA onboarding options (spec section 5).
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState
    @State private var skHex = ""
    @State private var password = ""
    @State private var showBackupImporter = false
    @State private var errorText: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("MurMur")
                        .font(.largeTitle.bold())
                    Text("Приватный мессенджер. Сообщения шифруются на устройстве.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Новая идентичность") {
                    Button {
                        createIdentity()
                    } label: {
                        Label("Создать", systemImage: "plus.circle")
                    }
                    .disabled(busy)
                }

                Section("Импорт из PWA (murmur.sk)") {
                    TextField("64-байтовый hex ключ", text: $skHex, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                    Button {
                        importHex()
                    } label: {
                        Label("Импортировать ключ", systemImage: "key")
                    }
                    .disabled(busy || skHex.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                Section("Импорт файла .murmur") {
                    SecureField("Пароль бэкапа", text: $password)
                    Button {
                        showBackupImporter = true
                    } label: {
                        Label("Выбрать файл", systemImage: "doc")
                    }
                    .disabled(busy || password.isEmpty)
                }

                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red).font(.footnote)
                    }
                }

                if busy {
                    Section { ProgressView() }
                }
            }
            .navigationTitle("Вход")
            .fileImporter(
                isPresented: $showBackupImporter,
                allowedContentTypes: [.data],
                allowsMultipleSelection: false
            ) { result in
                importBackup(result)
            }
        }
    }

    private func createIdentity() {
        busy = true; errorText = nil
        DispatchQueue.main.async {
            do {
                _ = try IdentityStore.shared.createNew()
                app.didAuthenticate()
            } catch {
                errorText = error.localizedDescription
            }
            busy = false
        }
    }

    private func importHex() {
        busy = true; errorText = nil
        DispatchQueue.main.async {
            do {
                _ = try IdentityStore.shared.importHex(skHex)
                app.didAuthenticate()
            } catch {
                errorText = error.localizedDescription
            }
            busy = false
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
                app.didAuthenticate()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}
