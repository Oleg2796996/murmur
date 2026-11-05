import SwiftUI

@main
struct MurmurApp: App {
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
            }
        }
    }
}
