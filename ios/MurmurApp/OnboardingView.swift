import SwiftUI
import UniformTypeIdentifiers

/// First-run flow: create / import `.murmur` backup.
/// Styled with the app theme (PWA palette, ChatListView.swift MurmurTheme).
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState
    @State private var password = ""
    @State private var showBackupImporter = false
    @State private var errorText: String?
    @State private var busy = false

    /// The app forces the dark PWA palette; colorScheme env follows it.
    var body: some View {
        NavigationStack {
            ZStack {
                MurmurTheme.bg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("MurMur")
                                .font(.largeTitle.bold())
                                .foregroundStyle(MurmurTheme.text)
                            Text("Приватный мессенджер. Сообщения шифруются на устройстве.")
                                .font(.footnote)
                                .foregroundStyle(MurmurTheme.textMuted)
                        }
                        .padding(.top, 8)

                        // MARK: - New identity
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Новая идентичность")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(MurmurTheme.textMuted)
                            Button {
                                createIdentity()
                            } label: {
                                Label("Создать", systemImage: "plus.circle.fill")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(MurmurTheme.accent)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(16)
                                    .background(MurmurTheme.panel)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .disabled(busy)
                        }

                        // MARK: - Import .murmur backup
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Импорт файла .murmur")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(MurmurTheme.textMuted)
                            HStack(spacing: 0) {
                                SecureField("Пароль бэкапа", text: $password)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .foregroundStyle(MurmurTheme.text)
                                    .tint(MurmurTheme.accent)
                                    .padding(16)
                            }
                            .background(MurmurTheme.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                            Button {
                                showBackupImporter = true
                            } label: {
                                Label("Выбрать файл", systemImage: "doc")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(password.isEmpty ? MurmurTheme.textMuted : MurmurTheme.accent)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(16)
                                    .background(MurmurTheme.panel)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .disabled(busy || password.isEmpty)
                        }

                        if let errorText {
                            Text(errorText)
                                .font(.footnote)
                                .foregroundStyle(MurmurTheme.danger)
                        }

                        if busy {
                            HStack {
                                Spacer()
                                ProgressView().tint(MurmurTheme.accent)
                                Spacer()
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Вход")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .preferredColorScheme(.dark)
            .fileImporter(
                isPresented: $showBackupImporter,
                // .item keeps .murmur selectable (it has no registered UTType);
                // content-type filters grey it out on device.
                allowedContentTypes: [.item],
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

    private func importBackup(_ result: Result<[URL], Error>) {
        busy = true; errorText = nil
        DispatchQueue.main.async {
            defer { busy = false }
            do {
                guard let url = try result.get().first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                let info = try IdentityStore.shared.importBackup(data: data, password: password)
                await MainActor.run { app.applyBackupIdentity(info) }
                app.didAuthenticate()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}
