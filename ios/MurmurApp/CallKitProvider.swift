import Foundation
import CallKit
import AVFoundation

/// v160z25 (Олег 2026-11-11 «наивный звонок на iOS как обычный звонок»):
/// системный экран звонка на заблокированном экране через CallKit.
///
/// Flow: PushKit (PushManager) будит приложение voip-push'ем →
/// `reportIncoming(from:mode:)` показывает системную карточку звонка →
/// юзер жмёт Accept (или на Android-кнопку наушников/автоответ в машине) →
/// CXProviderDelegate.answerCall → CallManager.accept() (WebRTC уходит в
/// CallOverlay как раньше). Decline/end → bye пиру.
///
/// CallOverlay остаётся UI разговора: при accept мы открываем его через
/// CallManager.phase = .incoming (fullScreenCover уже подписан).
@MainActor
final class CallKitProvider: NSObject, ObservableObject {
    static let shared = CallKitProvider()

    private var provider: CXProvider?
    private let callController = CXCallController()
    /// UUID текущего системного звонка (для reportCallEnded).
    private var activeCallUUID: UUID?
    /// peer текущего звонка (для answer/decline в CallManager).
    private var activePeer: String?

    override private init() {
        super.init()
    }

    /// Одноразовая инициализация (вызвать на старте приложения).
    func bootstrap() {
        guard provider == nil else { return }
        let config = CXProviderConfiguration(localizedName: "MurMur")
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.includesCallsInRecents = true
        config.supportedHandleTypes = [.generic]
        let p = CXProvider(configuration: config)
        p.setDelegate(self, queue: nil)
        provider = p
    }

    /// Показать системную карточку входящего звонка (из PushKit wake).
    /// Returns true если карточка показана.
    @discardableResult
    func reportIncoming(from peer: String, video: Bool) -> Bool {
        bootstrap()
        // v160z27b: offer по WS часто ПРИХОДИТ РАНЬШЕ voip-push (WS в фоне
        // ещё жив секунды-минуты) и ставит phase=.incoming. Это ТОТ ЖЕ
        // звонок — карточка нужна! Лог 13.11 13:49: "offer #1 received" до
        // push'а → guard возвращал false → карточки не было → Мак прозвонил
        // 60с и сбросил. Блокируем только РЕАЛЬНУЮ занятость: исходящий/
        // соединение/входящий от ДРУГОГО пира.
        switch CallManager.shared.phase {
        case .idle:
            break // свободны — показываем
        case .incoming(let pendingPeer, _):
            guard pendingPeer == peer else { return false } // другой звонящий
        case .outgoing, .connecting, .connected:
            return false // реально заняты
        }

        let handle = CXHandle(type: .generic, value: peer)
        let update = CXCallUpdate()
        update.remoteHandle = handle
        update.hasVideo = video
        // Имя контакта: локальная карта (релей имён не знает). AppState не
        // singleton — читаем UserDefaults напрямую (тот же ключ, что пишет AppState).
        var name: String? = nil
        if let data = UserDefaults.standard.data(forKey: "murmur.contact_names"),
           let dict = try? JSONDecoder().decode([String: String].self, from: data) {
            name = dict[peer]
        }
        update.localizedCallerName = name ?? "MurMur"

        let uuid = UUID()
        activeCallUUID = uuid
        activePeer = peer
        provider?.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error {
                NSLog("murmur callkit: reportNewIncomingCall failed: \(error)")
                Task { @MainActor [weak self] in self?.clearActive() }
            }
        }
        return true
    }

    /// Системное завершение звонка (из CallManager.close при hangup/bye).
    func reportCallEnded() {
        guard let uuid = activeCallUUID else { return }
        provider?.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        clearActive()
    }

    private func clearActive() {
        activeCallUUID = nil
        activePeer = nil
    }
}

// MARK: - CXProviderDelegate

extension CallKitProvider: CXProviderDelegate {
    /// Активация аудио-сессии ДО answer (Apple требует для CallKit).
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        NSLog("murmur callkit: didActivate audioSession")
        Task { @MainActor in
            CallManager.shared.activateAudioSession(audioSession)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        NSLog("murmur callkit: didDeactivate audioSession")
        Task { @MainActor in
            CallManager.shared.deactivateAudioSession(audioSession)
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            NSLog("murmur callkit: answer action")
            guard let peer = self.activePeer else {
                action.fail()
                return
            }
            // Если SDP ещё не дошёл — CallManager.accept() сам подождёт offer
            // до 5с (v160z24), затем fallback fresh offer.
            action.fulfill()
            await CallManager.shared.acceptFromCallKit(peer: peer)
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            NSLog("murmur callkit: end call action")
            CallManager.shared.decline()
            self.clearActive()
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        NSLog("murmur callkit: action timed out")
        Task { @MainActor in
            CallManager.shared.decline()
            // v160z27: системная карточка обязана закрыться — иначе висит до
            // перезагрузки (наблюдение 12.11: таймаут закрывал звонок, но карточка
            // оставалась на экране блокировки).
            self.reportCallEnded()
            action.fulfill()
        }
    }

    func providerDidReset(_ provider: CXProvider) {
        NSLog("murmur callkit: providerDidReset")
        Task { @MainActor in
            CallManager.shared.decline()
            self.clearActive()
        }
    }
}
