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
                UIApplication.shared.applicationIconBadgeNumber = 0
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                // Local badge while backgrounded (APNs pushes add server-side
                // badge once keys are wired; this covers no-push case).
                let unread = app.chats.reduce(0) { $0 + $1.messages.filter { $0.direction == .incoming }.count }
                UIApplication.shared.applicationIconBadgeNumber = min(unread, 99)
            }
        }
    }
}
