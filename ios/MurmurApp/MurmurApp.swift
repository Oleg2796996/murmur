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
                AppStateHolder.shared.app = app
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
        }
    }
}
