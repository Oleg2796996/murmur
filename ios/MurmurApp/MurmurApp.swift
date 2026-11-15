import SwiftUI

@main
struct MurmurApp: App {
    @UIApplicationDelegateAdaptor(MurmurAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var app = AppState()
    /// Global call overlay: incoming/outgoing calls present from anywhere.
    @StateObject private var callManager = CallManager.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if app.authenticated {
                    ChatListView()
                } else {
                    OnboardingView()
                }
            }
            .fullScreenCover(isPresented: Binding(
                get: { callManager.phase != .idle },
                set: { _ in })) {
                CallOverlay()
            }
            .environmentObject(app)
            .onAppear {
                app.connect()
                app.refreshOnLaunch()
                PushManager.shared.bootstrap(app: app)
            }
            .onReceive(NotificationCenter.default.publisher(for: .murmurPushWake)) { _ in
                // Push tap → wake → poll history (same refresh as WS push).
                app.connect()
                app.refreshOnLaunch()
            }
            // Открытие .murmur-файла из «Файлов» (v160z28).
            //
            // ВАЖНО: `UIApplicationDelegate.application(_:open:)` в приложении
            // со scene-lifecycle (UIApplicationSceneManifest + WindowGroup)
            // НЕ вызывается — URL приходит в сцену. Для SwiftUI это
            // `.onOpenURL` на сцене. Поэтому держим URL в статике
            // (AppState.pendingBackupURL) и отдаём его тому, кто его ждёт:
            // чат-листу (когда аккаунт уже есть) или онбордингу (свежая
            // установка — иначе файл из «Файлов» молча потерялся бы).
            .onOpenURL { url in
                NSLog("murmur: onOpenURL \(url.lastPathComponent)")
                AppState.pendingBackupURL = url
                NotificationCenter.default.post(name: .murmurOpenBackupDocument, object: nil)
            }
            .onChange(of: scenePhase) { _, phase in
                // Track foreground state for the unread logic: incoming to
                // the open chat counts toward the badge when not active.
                app.appState = (phase == .active) ? .active : .background
                if phase == .background, let peer = app.openChatPeer {
                    // Re-entering background with a chat open: the last poll
                    // may have been suppressed by openChatPeer — resync.
                    Task { @MainActor in await app.pollHistory(peer: peer) }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                // Back to foreground with the chat open: everything that
                // accumulated while backgrounded is about to be visible in
                // the open feed → clear its unread.
                if let peer = app.openChatPeer {
                    app.markChatRead(peer: peer)
                }
                app.updateBadge()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                // Recompute from the unread map (not total incoming ever).
                app.updateBadge()
            }
        }
    }
}
