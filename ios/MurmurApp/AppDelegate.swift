import UIKit

/// Receives APNs token callbacks. UIKit wires this up automatically when the
/// app delegate conforms to UIApplicationDelegate (SwiftUI lifecycle).
final class MurmurAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.setDeviceToken(deviceToken, app: AppStateHolder.shared)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushManager.shared.handleRegistrationFailure(error)
    }
}

/// Bridge so the app delegate can reach the live AppState without a global
/// singleton owning the lifecycle (SwiftUI @StateObject stays authoritative).
final class AppStateHolder {
    static let shared = AppStateHolder()
    weak var app: AppState?
}
