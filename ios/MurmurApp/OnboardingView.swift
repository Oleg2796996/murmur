import SwiftUI

/// First-run flow: landing with the site pitch + single "Create" button.
/// Import of `.murmur` backups moved out of the first screen (per Oleg,
/// 2026-11-06). Styled with the app theme (PWA palette, MurmurTheme).
struct OnboardingView: View {
    @EnvironmentObject private var app: AppState
    @State private var errorText: String?
    @State private var busy = false

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
                    Text("Приватный мессенджер без номеров, почт и слежки")
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

                // MARK: - Create button
                Button {
                    createIdentity()
                } label: {
                    HStack {
                        Spacer()
                        if busy {
                            ProgressView().tint(MurmurTheme.bg)
                        } else {
                            Label("Создать", systemImage: "plus.circle.fill")
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
