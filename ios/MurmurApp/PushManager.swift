import Foundation
import UIKit
import UserNotifications

/// APNs registration + notification handling for the native iOS client.
///
/// Flow:
/// 1. On launch, request notification permission and register for remote
///    notifications (`UIApplication.registerForRemoteNotifications`).
/// 2. The device token lands in `MurmurAppDelegate` → `PushManager.setDeviceToken`.
/// 3. We register the token on the relay: `POST /apns/register` with a
///    proof-of-key signature (`sign_envelope("apns-register")` — same scheme
///    the PWA uses for `push-register`). No content rides the push — the
///    relay only knows "npub X has device token Y".
/// 4. A push simply wakes the app; on wake we poll history (same path as a
///    WS push metadata event).
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    private var deviceToken: Data?
    private var registeredNpub: String?

    // MARK: - Startup

    /// Call once after identity is available (onboarding or launch).
    func bootstrap(app: AppState) {
        UNUserNotificationCenter.current().delegate = self
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error { NSLog("murmur push auth error: \(error)") }
            NSLog("murmur push permission granted=\(granted)")
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        // Re-register if the identity changed since the last registration.
        if let npub = IdentityStore.shared.npub, npub != registeredNpub {
            registerTokenOnRelay(npub: npub)
        }
    }

    // MARK: - Device token

    func setDeviceToken(_ token: Data, app: AppState) {
        deviceToken = token
        let hex = token.map { String(format: "%02x", $0) }.joined()
        NSLog("murmur APNs device token: \(hex.prefix(16))…")
        if let npub = IdentityStore.shared.npub {
            registeredNpub = npub
            Task { await Self.registerToken(hex: hex, npub: npub) }
        }
    }

    func handleRegistrationFailure(_ error: Error) {
        NSLog("murmur APNs registration failed: \(error)")
    }

    /// Register (or re-register) the stored token on the relay.
    func registerTokenOnRelay(npub: String) {
        guard let token = deviceToken else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        registeredNpub = npub
        Task { await Self.registerToken(hex: hex, npub: npub) }
    }

    /// POST /apns/register — proof-of-key: sign "apns-register" with the
    /// identity key (relay verifies the same way as push-register).
    private static func registerToken(hex: String, npub: String) async {
        guard let sig = try? IdentityStore.shared.signEnvelope(payload: Data("apns-register".utf8)) else {
            NSLog("murmur apns register: sign failed")
            return
        }
        guard let url = URL(string: RelayConfig.defaultBaseURL + "/apns/register") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        let body: [String: Any] = [
            "npub": npub,
            "token": hex,
            "kind": "alert",
            "challenge_sig": sig,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            NSLog("murmur apns register status=\(status) resp=\(text.prefix(120))")
        } catch {
            NSLog("murmur apns register failed: \(error)")
        }
    }

    // MARK: - Foreground presentation

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // In foreground the app is live over WS; show a subtle banner only.
        return [.banner, .sound]
    }

    // MARK: - Tap handling

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        // Push tap → wake and poll. The relay stores the envelope with a TTL,
        // so the poll after wake finds the message like any WS push does.
        await MainActor.run {
            NotificationCenter.default.post(name: .murmurPushWake, object: nil)
        }
    }
}

extension Notification.Name {
    static let murmurPushWake = Notification.Name("murmurPushWake")
}
