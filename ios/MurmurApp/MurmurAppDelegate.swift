import UIKit
import UserNotifications
import AVFoundation

/// Receives APNs token callbacks. UIKit wires this up automatically when the
/// app entitlements declare `remote-notification` + `voip` background modes.
final class MurmurAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Request permission for incoming call alerts (optional: silent push rings).
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
        application.registerForRemoteNotifications()

        // v160z25: PushKit-регистрацию стартуем В didFinishLaunching —
        // voip-push должен быть доставлен даже в убитое приложение ДО того,
        // как SwiftUI построит MurmurApp.onAppear. Поздняя регистрация =
        // пропущенный звонок на заблокированном экране.
        PushManager.shared.bootstrapPushKit()

        // Incoming call notification category (silent push -> custom handler).
        let accept = UNNotificationAction(identifier: "MURMUR_ACCEPT", title: "Принять", options: .foreground)
        let decline = UNNotificationAction(identifier: "MURMUR_DECLINE", title: "Отклонить", options: .destructive)
        let category = UNNotificationCategory(identifier: "MURMUR_CALL",
                                              actions: [accept, decline],
                                              intentIdentifiers: [],
                                              options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])

        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        NSLog("murmur apns: voip token=\(hex)")
        PushManager.shared.setDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("murmur apns: register failed \(error.localizedDescription)")
    }

    // APNs delivery of a call_signal frame is done as a silent push
    // (type: "voip", no alert/sound) -> the relay wakes and forwards
    // onCallSignal -> CallManager (cold peer rings).
}
