import SwiftUI

/// First-run flow: landing with the site pitch + single "Create" button.
/// Import of `.murmur` backups moved out of the first screen (per Oleg,
/// 2026-11-06). Styled with the app theme (PWA palette, MurmurTheme).
///
/// 2026-11-16: added a "Восстановить из backup" button — a FRESH install
/// that was launched by tapping a `.murmur` file in Files had no way to
/// import it: the chat list (which owns the import sheet) is only mounted
/// after the account exists, so the file silently did nothing (Олег:
/// «восстановилось как-то странно»).
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState
    @State private var errorText: String?
    @State private var busy = false
    /// A `.murmur` file opened from Files — handed to the import sheet.
    @State private var pendingImport: BackupFile?
    @State private var showImporter = false
    /// 🌐-смена языка: пересобрать дерево со свежими t(...)-строками.
    @State private var langEpoch = 0

    var body: some View {
        ZStack {
            MurmurTheme.bg.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 24)

                // MARK: - Header
                VStack(alignment: .leading, spacing: 6) {
                    Text("MurMur")
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(MurmurTheme.text)
                    Text(MurmurI18N.t("приватный мессенджер"))
                        .font(.body)
                        .foregroundStyle(MurmurTheme.textMuted)
                }

                // MARK: - Feature list (from murmurchat.org)
                VStack(alignment: .leading, spacing: 14) {
                    feature("lock.shield",
                            "Всё хранится на вашем устройстве — сервер видит только зашифрованные сообщения")
                    feature("sparkles",
                            "Переписка стирается с сервера через минуты после доставки")
                    feature("eyeglasses",
                            "Нам не нужно знать ваши имена, телефоны и почту")
                    feature("hand.raised",
                            "Просьба передать данные? Нам нечего передавать")
                }
                .padding(.top, 28)

                Spacer()

                // MARK: - Restore from backup (2026-11-16)
                // A fresh install launched from a `.murmur` file in Files
                // lands here — offer the import right away.
                if pendingImport != nil || showImporter {
                    Button {
                        showImporter = true
                    } label: {
                        HStack {
                            Spacer()
                            Label(MurmurI18N.t("Восстановить из backup"), systemImage: "arrow.counterclockwise")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(MurmurTheme.accent)
                            Spacer()
                        }
                        .padding(.vertical, 14)
                        .background(MurmurTheme.bubbleIn)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .padding(.bottom, 10)
                    .disabled(busy)
                }

                // MARK: - Create button
                Button {
                    createIdentity()
                } label: {
                    HStack {
                        Spacer()
                        if busy {
                            ProgressView().tint(MurmurTheme.bg)
                        } else {
                            Label(MurmurI18N.t("Создать"), systemImage: "plus.circle.fill")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(MurmurTheme.bg)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 16)
                    .background(MurmurTheme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .disabled(busy)

                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(MurmurTheme.danger)
                        .padding(.top, 12)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.data, .murmurBackup],
                      allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                pendingImport = BackupFile(url: url)
            } else if case .failure(let err) = result {
                errorText = err.localizedDescription
            }
        }
        .sheet(item: $pendingImport) { file in
            BackupImportSheet(initialURL: file.url) { app.didAuthenticate() }
        }
        .onAppear {
            // The app was launched BY the .murmur file (cold start) — the URL
            // waits in `AppState.pendingBackupURL` (posted before this view
            // existed). Pick it up here.
            if let url = AppState.pendingBackupURL {
                AppState.pendingBackupURL = nil
                pendingImport = BackupFile(url: url)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .murmurLanguageChanged)) { _ in
            langEpoch += 1
        }
        .id(langEpoch)
    }

    private func feature(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(MurmurTheme.accent)
                .frame(width: 28)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(MurmurTheme.text)
                .fixedSize(horizontal: false, vertical: true)
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
}
