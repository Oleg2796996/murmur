import Foundation
import UIKit
import UserNotifications
import PushKit

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
///
/// v160z25 (Олег 2026-11-11 «наивный звонок как обычный»): PushKit-токен
/// (kind="voip") регистрируется отдельно; voip-push будит приложение даже
/// на заблокированном экране → CallKitProvider.reportIncoming → системная
/// карточка звонка.
final class PushManager: NSObject, UNUserNotificationCenterDelegate, PKPushRegistryDelegate {
    static let shared = PushManager()

    private var deviceToken: Data?
    private var registeredNpub: String?
    /// v160z25: отдельный PushKit (voip) токен — Apple выдаёт другой токен
    /// на PushKit-регистрацию, регистрируем его с kind="voip".
    private var voipToken: Data?
    private var voipRegisteredNpub: String?

    private var voipRegistry: PKPushRegistry?

    // MARK: - Startup

    /// v160z25: ранняя PushKit-регистрация из AppDelegate.didFinishLaunching
    /// (до построения SwiftUI) — иначе voip-push в убитое приложение теряется.
    func bootstrapPushKit() {
        guard voipRegistry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
    }

    /// Call once after identity is available (onboarding or launch).
    func bootstrap(app: AppState) {
        bootstrapPushKit() // idempotent
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
        // v160z25: voip-токен тоже перерегистрируем при смене identity
        // (например, восстановление аккаунта из backup).
        if let npub = IdentityStore.shared.npub, npub != voipRegisteredNpub {
            registerVoipTokenOnRelay(npub: npub)
        }
    }

    // MARK: - Device token

    func setDeviceToken(_ token: Data) {
        deviceToken = token
        let hex = token.map { String(format: "%02x", $0) }.joined()
        NSLog("murmur APNs device token: \(hex.prefix(16))…")
        if let npub = IdentityStore.shared.npub {
            registeredNpub = npub
            registerTokenOnRelay(npub: npub)
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
        let identity = try? IdentityStore.shared.requireIdentity()
        let payload = Data("apns-register".utf8)
        // Sign on main-adjacent serial crypto path, send from background.
        Task { @MainActor in
            guard let identity else { return }
            let sig = try? await IdentityStore.shared.cryptoSignEnvelopeAsync(identity, senderNpub: npub, payload: payload)
            guard let sig else { NSLog("murmur apns register: sign failed"); return }
            await Self.postRegistration(hex: hex, npub: npub, sig: sig)
        }
    }

    private static func postRegistration(hex: String, npub: String, sig: String, kind: String = "alert") async {
        guard let url = URL(string: RelayConfig.defaultBaseURL + "/apns/register") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        let body: [String: Any] = [
            "npub": npub,
            "token": hex,
            "kind": kind,
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
}

extension Notification.Name {
    static let murmurPushWake = Notification.Name("murmurPushWake")
}

// MARK: - UNUserNotificationCenterDelegate (v160z27c: alert-push звонка)

extension PushManager {
    /// Показ баннера при свернутом/убитом приложении (foreground-present).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let dict = notification.request.content.userInfo
        if dict["kind"] as? String == "incoming_call" {
            NSLog("murmur push: incoming_call alert in foreground — overlay уже покажет UI")
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.banner, .sound])
        }
    }

    /// Тап по баннеру / кнопки Принять (MURMUR_ACCEPT) и Отклонить (MURMUR_DECLINE).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let dict = response.notification.request.content.userInfo
        guard dict["kind"] as? String == "incoming_call",
              let from = dict["from"] as? String else {
            // Обычный message-push: будим приложение (существующий путь).
            NotificationCenter.default.post(name: .murmurPushWake, object: nil)
            completionHandler()
            return
        }
        let mode = dict["mode"] as? String ?? "audio"
        let video = mode == "video"
        NSLog("murmur push: incoming_call alert action=\(response.actionIdentifier) from=\(from.prefix(12))")
        let npub = IdentityStore.shared.npub
        Task { @MainActor in
            switch response.actionIdentifier {
            case "MURMUR_DECLINE", UNNotificationDismissActionIdentifier:
                // Отклонить: bye пиру БЕЗ поднятия UI. call_signal ходит только
                // по WS — при убитом приложении сокета нет, пир сам сбросит
                // по 60с таймауту (как при неответе).
                NSLog("murmur push: decline from alert — caller will timeout")
                completionHandler()
            case "MURMUR_ACCEPT", UNNotificationDefaultActionIdentifier:
                // v160z27d (Олег 13.11 «рингтон без ответа Apple»): тап/Принять
                // ПОДНИМАЕТ живое приложение → reportIncoming из ЖИВОГО
                // приложения НЕ блокируется iOS (блокируется только вызов из
                // voip-wake убитого приложения) → нативная CallKit-карточка
                // с РИНГТОНОМ и вибрацией, entitlement не нужен.
                if let npub {
                    CallManager.shared.handleIncomingPush(from: from, video: video)
                    NotificationCenter.default.post(name: .murmurPushWake, object: nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        let shown = CallKitProvider.shared.reportIncoming(from: from, video: video)
                        NSLog("murmur push: callkit card from alert-tap shown=\(shown)")
                    }
                }
                completionHandler()
            default:
                completionHandler()
            }
        }
    }

    /// Одноразовый bye без установленного WS-соединения (убитое приложение,
    /// кнопка «Отклонить» на баннере). POST на релей подписанным конвертом —
    /// тот же механизм, что /apns/register.
    static func sendByeOneShot(from npub: String, to peer: String) async {
        // call_signal ходит только по WS (ephemeral), HTTP-пути для него нет.
        // Простейший надёжный вариант: подписать envelope-фрейм нельзя без WS,
        // поэтому просто НЕ отправляем bye — пир сам повесит трубку по 60с
        // таймауту (как при отсутствии ответа). Логируем намерение.
        NSLog("murmur push: decline from alert (no WS) — caller will timeout")
    }
}

// MARK: - PKPushRegistryDelegate (v160z25: VoIP pushes / CallKit)

extension PushManager {
    /// v160z25: входящий VoIP push — ОБЯЗАТЕЛЬНЫЙ обработчик (Apple крашит
    /// приложение, если PushKit-деливери не обработан немедленно).
    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: () -> Void) {
        completion()
        handleVoipPush(payload)
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = credentials.token
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        NSLog("murmur pushkit: voip token=\(hex.prefix(16))…")
        if let npub = IdentityStore.shared.npub {
            voipRegisteredNpub = npub
            registerVoipTokenOnRelay(npub: npub)
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        // Токен сменился — при следующем didUpdate перерегистрируем.
    }

    /// Регистрация voip-токена на ролее (kind="voip", релей шлёт на него
    /// deliver_call_voip при входящем звонке).
    func registerVoipTokenOnRelay(npub: String) {
        guard let token = voipToken else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let identity = try? IdentityStore.shared.requireIdentity()
        let payload = Data("apns-register".utf8)
        Task { @MainActor in
            guard let identity else { return }
            let sig = try? await IdentityStore.shared.cryptoSignEnvelopeAsync(identity, senderNpub: npub, payload: payload)
            guard let sig else { NSLog("murmur pushkit register: sign failed"); return }
            await Self.postRegistration(hex: hex, npub: npub, sig: sig, kind: "voip")
        }
    }

    /// Входящий voip-push (заблокированный экран / убитое приложение).
    /// Apple: обработка ДОЛЖНА быть немедленной — reportNewIncomingCall
    /// обязан вызваться синхронно после wake, иначе iOS рапортует crash.
    /// Payload релея: {aps: {}, kind: "incoming_call", from, mode}.
    func handleVoipPush(_ payload: PKPushPayload) {
        NSLog("murmur pushkit: voip payload received")
        guard payload.type == .voIP else { return }
        let dict = payload.dictionaryPayload ?? [:]
        guard dict["kind"] as? String == "incoming_call",
              let from = dict["from"] as? String else {
            NSLog("murmur pushkit: unknown voip payload, ignoring")
            return
        }
        let mode = dict["mode"] as? String ?? "audio"
        let video = mode == "video"
        NSLog("murmur pushkit: incoming_call from=\(from.prefix(12)) mode=\(mode)")
        Task { @MainActor in
            // v160z27 (Олег 13.11 «наивный звонок»): CallKit-карточка — ВСЕГДА,
            // как у Telegram: и на заблокированном экране, и при открытом app.
            // reportNewIncomingCall вызывается СИНХРОННО сразу после wake (Apple
            // крашит приложение, если PushKit-деливери не был обработан
            // немедленно и не поднял звонок — требование iOS 13+).
            //
            // История: v160z26e показывал карточку только в фоне (боролись с
            // «звонок сам сбрасывается» через timedOutPerforming). Но: а) фон-only
            // не даёт системного меню при открытом app (Олег хочет как в
            // Telegram), б) с v160z27 CallOverlay ПОВЕРХ карточки при активном
            // app (двойной UI допустим: overlay закрывает карточку через
            // reportCallEnded при accept/decline — CallManager.accept() это
            // уже делает).
            NSLog("murmur pushkit: app state for callkit card: \(UIApplication.shared.applicationState == .active ? "foreground (overlay on top)" : "background/locked → card")")
            let cardShown = CallKitProvider.shared.reportIncoming(from: from, video: video)
            NSLog("murmur pushkit: callkit card shown=\(cardShown)")
            // CallManager: показать входящий (phase поднимает fullScreenCover —
            // при открытом app overlay поверх системной карточки; при accept
            // overlay закрывает карточку reportCallEnded).
            CallManager.shared.handleIncomingPush(from: from, video: video)
        }
    }
}
