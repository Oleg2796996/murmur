import SwiftUI

@main
struct MurmurApp: App {
    @UIApplicationDelegateAdaptor(MurmurAppDelegate.self) private var appDelegate
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if app.authenticated {
                    ChatListView()
                } else {
                    OnboardingView()
                }
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
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                // 2026-11-09 badge fix: unread now tracked per-peer in
                // AppState.unreadByPeer (cleared by opening the chat). While
                // the app is foreground the icon badge is not visible, and
                // incoming to the OPEN chat is auto-read; for other chats the
                // badge stays truthful via updateBadge().
                app.updateBadge()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                // Recompute from the unread map (not total incoming ever).
                app.updateBadge()
            }
        }
    }
}
