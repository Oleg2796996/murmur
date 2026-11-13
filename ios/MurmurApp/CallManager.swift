import Foundation
import WebRTC
import AVFoundation

/// 1:1 audio/video calls — Swift port of pwa/call-audio.js.
/// Signaling rides the existing RelayClient WS (`call_signal` frames, relay
/// routes ephemerally; only the initial offer wakes an offline peer).
/// Wire kinds: offer{mode,sdp} / answer{sdp} / ice{candidate} / bye.
/// State machine mirrors the PWA: idle → outgoing/incoming → connecting →
/// connected → closed (+ 60s ring timeout, re-offer every 2s until answer).
@MainActor
final class CallManager: NSObject, ObservableObject {
    static let shared = CallManager()

    // MARK: - Published UI state (overlay binds to these)

    enum Phase: Equatable {
        case idle
        case incoming(peer: String, video: Bool)
        case outgoing(peer: String, video: Bool)
        case connecting(peer: String, video: Bool)
        case connected(peer: String, video: Bool)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var stateText: String = ""      // «звоним…», «На связи»…
    @Published private(set) var durationSeconds: Int = 0
    @Published private(set) var micMuted = false
    @Published private(set) var cameraOff = false
    @Published private(set) var errorText: String?

    // MARK: - WebRTC

    private var pc: RTCPeerConnection?
    private var factory: RTCPeerConnectionFactory?
    private var localAudioTrack: RTCAudioTrack?
    private var localCapturer: RTCCameraVideoCapturer?
    /// Local camera preview — read by CallOverlay PiP (PWA call-local-video).
    private(set) var localVideoTrack: RTCVideoTrack?
    /// Remote video track — read by CallOverlay for the fullscreen background.
    private(set) var remoteVideoTrack: RTCVideoTrack?
    /// Front camera default; tap on PiP flips (call54 parity).
    private(set) var camFacing: String = "user"

    private var remotePeer: String?
    /// Wired by AppState at init — AppState owns the only RelayClient.
    weak var relayClient: RelayClient?
    private var callMode: String = "audio"          // "audio" | "video"
    /// CallOverlay reads this to decide on the fullscreen video background.
    var activeCallIsVideo: Bool { callMode == "video" }
    private var pendingOffer: (from: String, signal: [String: Any]?)?
    private var pendingRemoteCandidates: [RTCIceCandidate] = []
    /// v160z24b: ICE-счётчики для диагностики «соединение…» зависаний.
    /// Видно в Xcode-консоли: сколько кандидатов iOS отправил пиру,
    /// сколько получил от пира, сколько забуферено до setRemoteDescription.
    private var iceSentCount = 0
    private var iceRecvCount = 0
    private var incomingOfferCount = 0
    /// v160z26h: последний отправленный нами answer (SDP) — чтобы переотправить
    /// его на re-offer пира (WS-фрейм мог потеряться → пир вечно ждёт answer).
    private var lastAnswerSDP: [String: Any]?
    /// v160z26h: счётчики типов ICE-кандидатов (host/srflx/prflx/relay) —
    /// диагностика «iPhone собрал только host» (лог 12.11 22:23).
    private var iceHostCount = 0
    private var iceSrflxCount = 0
    private var icePrflxCount = 0
    private var iceRelayCount = 0
    private var sentIce: Set<String> = []            // dedup (call53 sentIce parity)
    private var offerRetryTask: Task<Void, Never>?
    private var ringTimeoutTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
    /// v160z25d: льгота для транзиентного ice:disconnected — PWA закрывает звонок
    /// по pc.connectionState, а iceConnectionState.disconnected часто
    /// восстанавливается (пара переключается на TURN). Мгновенный close(ice 5)
    /// убивал живые звонки (регресс 12.11: connected → disconnected → close).
    private var iceDisconnectGraceTask: Task<Void, Never>?
    private var callStartedAt: TimeInterval = 0
    private var iceServers: [RTCIceServer] = [
        // v160z26h: srflx нужен не меньше relay. Лог 12.11 22:23: iPhone
        // отправил ТОЛЬКО host-кандидаты (192.168.1.68 / 10.227.63.83 /
        // ULA-IPv6) — ни одного srflx, ни одного relay. Google STUN из РФ
        // может не отвечать (блок/таймаут), а coturn на нашем же проде
        // отвечает на STUN-биндинги на 3478 без авторизации. Поэтому
        // STUN-источник — coturn (тот же хост, что и TURN) + Google как
        // запасной. Ни одного srflx = P2P-путь через NAT невозможен.
        RTCIceServer(urlStrings: ["stun:murmurchat.org:3478"]),
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
        // TURN fallback for symmetric NAT / mobile networks — coturn on the
        // prod relay host. P2P stays preferred; TURN is only used when direct
        // ICE fails.
        RTCIceServer(urlStrings: [
            "turn:murmurchat.org:3478?transport=udp",
            "turn:murmurchat.org:3478?transport=tcp"
        ], username: "murmur-prod", credential: "murmurchat"),
        // v160z26i (13.11): turns:5349 УБРАН СНОВА — и это ОКОНЧАТЕЛЬНО.
        // Лог 13.11 ~11:28 (сборка 87847c7): с turns в конфиге iPhone собрал
        // ТОЛЬКО 7 host-кандидатов, 0 srflx, 0 relay; gathering замирает.
        // coturn при этом видит УСПЕШНЫЕ TLS/TCP-аллокации с iPhone (5349) —
        // TCP/TLS до сервера работает, но stasel/WebRTC v137 НЕ эмитит
        // кандидаты, пока в конфиге есть TLS-TURN. Воспроизведено 2-й раз
        // (v160z25g вечер 12.11, v160z26h утро 13.11). Без turns (утро
        // 12.11): srflx + 2 relay (3478 udp+tcp) собирались нормально.
        // История: v160z26f убрал turns по этой же причине; v160z26h вернул
        // (казалось, что виноват фильтр " tcp " — он ТОЖЕ был багом и
        // исправлен, но TLS-TURN-замирание — отдельная, реальная проблема).
        // turns остаётся на PWA-стороне (Safari/WebKit собирает его нормально).
    ]

    override private init() {
        super.init()
        // Signaling is delivered by AppState: it owns the single RelayClient
        // (one WS per identity) and forwards onCallSignal via forwardSignal.
    }

    /// Called by AppState (owns the only RelayClient) to deliver signaling.
    func forwardSignal(from: String, signal: [String: Any]) {
        Task { @MainActor in self.handleSignal(from: from, signal: signal) }
    }

    // MARK: - Outgoing

    func startCall(peer: String, video: Bool) {
        guard phase == .idle else { return }
        callMode = video ? "video" : "audio"
        remotePeer = peer
        phase = .outgoing(peer: peer, video: video)
        stateText = "звоним…"
        errorText = nil
        NSLog("murmur call: outgoing \(video ? "video" : "audio") → \(prefix(peer))")
        Task { await setupAndOffer(peer: peer, video: video) }
    }

    private func setupAndOffer(peer: String, video: Bool) async {
        do {
            try await setupPeerConnection(peer: peer, video: video)
            // Re-offer every 2s until an answer arrives (pwa call53b parity:
            // the callee may be cold-starting from a push).
            let offer = try await makeOffer(video: video)
            try await pc?.setLocalDescription(offer)
            sendOffer(peer, mode: callMode, sdp: localSDP(), push: true)
            startOfferRetry(peer: peer)
        } catch {
            fail(errorText: error.localizedDescription)
        }
    }

    private func makeOffer(video: Bool) async throws -> RTCSessionDescription {
        // Constraints mirror the PWA: audio always; video only in video mode.
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: [
                kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue,
                kRTCMediaConstraintsOfferToReceiveVideo: video ? kRTCMediaConstraintsValueTrue : kRTCMediaConstraintsValueFalse,
            ],
            optionalConstraints: nil)
        guard let pc else { throw CallError.noPeerConnection }
        return try await withCheckedThrowingContinuation { cont in
            pc.offer(for: constraints) { sdp, err in
                if let sdp { cont.resume(returning: sdp) }
                else { cont.resume(throwing: err ?? CallError.negotiation("offer failed")) }
            }
        }
    }

    private func startOfferRetry(peer: String) {
        offerRetryTask?.cancel()
        offerRetryTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled else { return }
                if let pc = self.pc, let sdp = pc.localDescription {
                    // call60: re-offer ONLY while localDescription is actually
                    // an OFFER. After a glare answer the localDescription holds
                    // an ANSWER — sending it labeled "offer" poisons the
                    // peer's signaling state (observed: PWA→iOS ice:checking
                    // then peer bye / dead ICE).
                    guard sdp.type == .offer else { break }
                    // push:false — the APNs wake already went with offer #1.
                    self.sendOffer(peer, mode: self.callMode, sdp: sdp, push: false)
                }
            }
        }
    }

    // MARK: - Incoming / signaling

    /// v160z25: входящий из voip-push (PushKit). Мости́т в обычный handleOffer
    /// логикой «нейтральной карточки» (kind="ring"-паритет PWA): incoming без
    /// SDP, оффер придёт по WS следом (PWA re-offer'ит каждые 2с).
    func handleIncomingPush(from: String, video: Bool) {
        guard case .idle = phase else { return }
        callMode = video ? "video" : "audio"
        pendingOffer = (from, nil)
        phase = .incoming(peer: from, video: video)
        stateText = "входящий звонок"
        armRingTimeout(from: from)
    }

    /// v160z25: accept из системной карточки CallKit (заблокированный экран).
    /// Отличие от accept(): phase может быть .incoming ещё БЕЗ offer —
    /// accept() сам подождёт оффер (v160z24) и answer'ит.
    func acceptFromCallKit(peer: String) async {
        if case .idle = phase {
            // Push поднял карточку, но CallManager ещё не видел signal —
            // создаём incoming-фазу, чтобы accept() работал штатно.
            pendingOffer = (peer, nil)
            phase = .incoming(peer: peer, video: false)
            armRingTimeout(from: peer)
        }
        await accept()
    }

    func handleSignal(from: String, signal: [String: Any]) {
        let kind = signal["kind"] as? String ?? ""
        guard let me = IdentityStore.shared.npub, from != me else { return }

        switch kind {
        case "offer":
            handleOffer(from: from, signal: signal)
        case "answer":
            handleAnswer(from: from, signal: signal)
        case "ice":
            handleIce(from: from, signal: signal)
        case "bye":
            handleBye(from: from)
        case "ring":
            // PWA parity: neutral incoming card before SDP arrives (push path).
            if case .idle = phase {
                pendingOffer = (from, nil)
                phase = .incoming(peer: from, video: false)
                stateText = "входящий звонок"
                armRingTimeout(from: from)
            }
        default:
            break
        }
    }

    private func handleOffer(from: String, signal: [String: Any]) {
        // v160z26f: glare-детектор — если offer'ов больше одного за звонок,
        // PWA re-offer loop доходит до iPhone ПОСЛЕ answer (гипотеза агента:
        // implicit rollback в ObjC-обёртке ломает negotiation). Одного числа
        // в логе хватит для диагноза.
        incomingOfferCount += 1
        NSLog("murmur call: offer #\(incomingOfferCount) received (signaling state: \(pc?.signalingState.rawValue ?? -1))")
        let mode = (signal["mode"] as? String) == "video" ? "video" : "audio"
        callMode = mode
        let video = mode == "video"

        switch phase {
        case .idle, .incoming:
            pendingOffer = (from, signal)
            phase = .incoming(peer: from, video: video)
            stateText = "входящий звонок"
            armRingTimeout(from: from)
        case .connecting, .connected, .outgoing:
            // Glare / re-offer while busy from a DIFFERENT peer → decline.
            guard remotePeer == from else {
                relayClient?.sendCallSignal(to: from, signal: ["kind": "bye"], push: false)
                return
            }
            // call59/call61: same peer re-offering. PERFECT NEGOTIATION
            // (agent-researched): iOS is the INITIATOR = impolite peer —
            // on a colliding offer IGNORE it (and its candidates) and keep
            // waiting for the answer to our own offer. Never rollback,
            // never re-answer: both-answer deadlock = ice:checking forever.
            if case .connected = phase { return }
            if let pc, pc.signalingState != .stable { return } // colliding offer → ignore (impolite)
            // v160z26h (Олег, лог 12.11 22:23): PWA ждёт answer, который
            // потерялся (WS-фрейм answer до Mac не дошёл). PWA шлёт re-offer
            // каждые 2-8с. Раньше мы его игнорировали («уже negotiated»),
            // поэтому Mac ВЕЧНО ждал answer → ice:FAILED (30 offer'ов,
            // 0 применённых answer'ов). Теперь: re-offer от ТОГО ЖЕ пира,
            // когда мы УЖЕ ответили (localDescription = answer) → переотправляем
            // свой answer. Это самопочиняющийся цикл: offer → answer → apply.
            if let pc = pc, pc.remoteDescription != nil, pc.localDescription?.type == .answer {
                NSLog("murmur call: re-offer #\(incomingOfferCount) → resending our answer")
                resendAnswer(to: from)
                return
            }
            if let pc, pc.remoteDescription != nil { return }  // already negotiated
            Task { await answerOffer(from: from, signal: signal) }
        }
    }

    /// Accept button: create PC, apply pending offer SDP, answer.
    func accept() async {
        guard case let .incoming(peer, video) = phase else { return }
        ringTimeoutTask?.cancel()
        // v160z26e: принимаем из ОВЕРЛЕЯ — закрыть системную карточку CallKit,
        // если она успела показаться (race: push при фон-переходе). Иначе
        // висящий CXAction таймаутит → timedOutPerforming → decline → bye пиру.
        CallKitProvider.shared.reportCallEnded()
        // v160z24 (Олег 2026-11-11): push-путь — карточка без SDP. Раньше сразу
        // шлём fresh offer, но PWA в ringing его ИГНОРИРУЕТ (callState !==
        // "connecting" → return) → дедлок «соединение…» на обеих сторонах.
        // Теперь: до 5с ждём приход offer (PWA re-offer'ит каждые 2с), и
        // только если он так и не пришёл — fallback в fresh offer.
        if pendingOffer?.signal == nil || pendingOffer?.from != peer {
            NSLog("murmur call: accept without SDP — waiting up to 5s for caller offer")
            let waited = await waitForOffer(peer: peer, seconds: 5)
            if !waited {
                NSLog("murmur call: no offer in 5s — falling back to fresh offer")
            }
            // v160z24: пока ждали — звонок могли отменить/закрыть (bye, decline).
            guard case .incoming = phase else { return }
            guard pendingOffer?.from == peer else { return }
        }
        // Cold-start push path (PWA call-audio.js parity): the ring card may
        // have no SDP yet — accepting then acts as a fresh outgoing call
        // (we create the offer, callee-turned-caller answers).
        guard let signal = pendingOffer?.signal,
              let sdpDict = signal["sdp"] as? [String: Any],
              let sdpType = sdpDict["type"] as? String,
              let sdpText = sdpDict["sdp"] as? String else {
            NSLog("murmur call: accept without SDP — falling back to fresh offer")
            // call59b: go straight incoming → outgoing WITHOUT passing .idle —
            // the overlay binding (phase != .idle) closes fullScreenCover on
            // .idle, and its onDisappear hangs the call up immediately
            // (observed: ice:checking → ice:closed right after accept).
            pendingOffer = nil
            phase = .outgoing(peer: peer, video: video)
            stateText = "звоним…"
            callMode = video ? "video" : "audio"
            remotePeer = peer
            Task { await setupAndOffer(peer: peer, video: video) }
            return
        }
        do {
            try await setupPeerConnection(peer: peer, video: video)
            let remote = RTCSessionDescription(type: .offer, sdp: sdpText)
            try await pc?.setRemoteDescription(remote)
            for candidate in pendingRemoteCandidates {
                try? await pc?.add(candidate)
            }
            pendingRemoteCandidates.removeAll()
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            let answer = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<RTCSessionDescription, Error>) in
                pc?.answer(for: constraints) { sdp, err in
                    if let sdp { cont.resume(returning: sdp) }
                    else { cont.resume(throwing: err ?? CallError.negotiation("answer failed")) }
                }
            }
            try await pc?.setLocalDescription(answer)
            lastAnswerSDP = sdpJSON(answer)
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "answer", "sdp": sdpJSON(answer)], push: false)
            phase = .connecting(peer: peer, video: video)
            stateText = "соединение…"
        } catch {
            fail(errorText: error.localizedDescription)
        }
    }

    /// v160z24: ждём прихода offer от пира до N секунд (offer уже в пути —
    /// PWA re-offer'ит каждые 2с после wake). Возвращает true если offer пришёл.
    private func waitForOffer(peer: String, seconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if pendingOffer?.from == peer, pendingOffer?.signal != nil { return true }
            // Phase.incoming имеет associated values — сравнение через pattern-match,
            // не через != (Swift: "member 'incoming(peer:video:)' is a function...").
            guard case .incoming = phase else { return false } // отмена/закрытие
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return pendingOffer?.from == peer && pendingOffer?.signal != nil
    }

    private func answerOffer(from: String, signal: [String: Any]) async {
        // Only used in the glare path (we are connecting with this peer and
        // they replaced the connection). Simplified: if we have no remote
        // description yet, treat it as a fresh accept flow.
        offerRetryTask?.cancel() // call60: stop the outgoing re-offer loop —
        // after glare-answer localDescription is an ANSWER; the retry loop
        // would keep sending it as "offer" and poison the peer's state.
        guard let pc, pc.remoteDescription == nil else { return }
        do {
            if let sdpDict = signal["sdp"] as? [String: Any],
               let sdpText = sdpDict["sdp"] as? String {
                // call61: PERFECT NEGOTIATION — we are in have-local-offer
                // (our fallback offer is out, re-offered every 2s). Accepting
                // the peer's offer WITHOUT rollback leaves native libwebrtc in
                // a poisoned state (no implicit rollback in native!) → both
                // sides stuck in ice:checking. Polite side rolls back first.
                if pc.signalingState == .haveLocalOffer {
                    try await pc.setLocalDescription(RTCSessionDescription(type: .rollback, sdp: ""))
                    NSLog("murmur call: glare rollback done → answering peer offer")
                }
                try await pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdpText))
                for candidate in pendingRemoteCandidates { try? await pc.add(candidate) }
                pendingRemoteCandidates.removeAll()
                let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                let answer = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<RTCSessionDescription, Error>) in
                    pc.answer(for: constraints) { sdp, err in
                        if let sdp { cont.resume(returning: sdp) }
                        else { cont.resume(throwing: err ?? CallError.negotiation("answer failed")) }
                    }
                }
                try await pc.setLocalDescription(answer)
                lastAnswerSDP = sdpJSON(answer)
                relayClient?.sendCallSignal(to: from, signal: ["kind": "answer", "sdp": sdpJSON(answer)], push: false)
            }
        } catch {
            NSLog("murmur call: glare answer failed: \(error)")
        }
    }

    /// v160z26h: переотправка нашего answer пиру, который прислал re-offer
    /// (его первый answer-фрейм потерялся). Без этого пир вечно ждал бы
    /// answer → ice:FAILED (наблюдение 12.11 22:23).
    private func resendAnswer(to peer: String) {
        guard let answer = lastAnswerSDP else { return }
        relayClient?.sendCallSignal(to: peer, signal: ["kind": "answer", "sdp": answer], push: false)
    }

    private func handleAnswer(from: String, signal: [String: Any]) {
        guard remotePeer == from else { return }
        offerRetryTask?.cancel()
        guard case .outgoing(_, _) = phase else { return }
        guard let pc else { return }
        guard let sdpDict = signal["sdp"] as? [String: Any],
              let sdpText = sdpDict["sdp"] as? String else { return }
        Task { @MainActor in
            do {
                try await pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdpText))
                for candidate in pendingRemoteCandidates { try? await pc.add(candidate) }
                pendingRemoteCandidates.removeAll()
                if case let .outgoing(peer, video) = phase {
                    phase = .connecting(peer: peer, video: video)
                    stateText = "соединение…"
                }
            } catch {
                fail(errorText: error.localizedDescription)
            }
        }
    }

    private func handleIce(from: String, signal: [String: Any]) {
        guard remotePeer == from || pendingOffer?.from == from else { return }
        guard let cand = signal["candidate"] as? [String: Any],
              let mid = cand["sdpMid"] as? String,
              let index = cand["sdpMLineIndex"] as? Int32,
              let sdp = cand["candidate"] as? String else { return }
        let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: index, sdpMid: mid)
        iceRecvCount += 1
        NSLog("murmur call: ice recv #\(iceRecvCount) \(sdp.prefix(50))")
        if let pc, pc.remoteDescription != nil {
            Task { try? await pc.add(candidate) }
        } else {
            // Callee has no PC while the incoming card is up — buffer
            // trickle candidates (pwa parity).
            pendingRemoteCandidates.append(candidate)
        }
    }

    private func handleBye(from: String) {
        guard remotePeer == from || pendingOffer?.from == from else { return }
        NSLog("murmur call: bye from \(prefix(from))")
        close("bye from peer")
    }

    // MARK: - Peer connection setup

    private func setupPeerConnection(peer: String, video: Bool) async throws {
        if pc == nil {
            try await ensureMediaPermissions(video: video)
            if factory == nil {
                RTCInitializeSSL()
                let encoder = RTCDefaultVideoEncoderFactory()
                let decoder = RTCDefaultVideoDecoderFactory()
                factory = RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
            }
            let config = RTCConfiguration()
            config.iceServers = iceServers
            config.sdpSemantics = .unifiedPlan
            // call58d: gather continuously + all network types — in LTE the
            // direct path is a black hole, only TURN works. Without this the
            // iOS side nominates srflx/host and dies on ice:FAILED even
            // though TURN allocation succeeded (observed 2026-11-10).
            config.continualGatheringPolicy = .gatherContinually
            // v160z24c: candidateNetworkPolicy НЕ трогаем — в ObjC-обёртке libwebrtc
            // (stasel/WebRTC v137) enum RTCCandidateNetworkPolicy имеет только .all,
            // '.default' не существует (Xcode: Type has no member 'default').
            // Мусорные кандидаты режем ФИЛЬТРОМ в didGenerate (ниже).
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            pc = factory?.peerConnection(with: config, constraints: constraints, delegate: self)

            // Audio: send + receive.
            let audioSource = factory?.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            localAudioTrack = factory?.audioTrack(with: audioSource!, trackId: "murmur-a0")
            pc?.add(localAudioTrack!, streamIds: ["murmur"])

            // Video: local camera capture + receive (video mode only adds
            // send; receive transceiver is negotiated by the offer flags).
            if video {
                let videoSource = factory?.videoSource()
                localVideoTrack = factory?.videoTrack(with: videoSource!, trackId: "murmur-v0")
                pc?.add(localVideoTrack!, streamIds: ["murmur"])
                let capturer = RTCCameraVideoCapturer(delegate: videoSource!)
                localCapturer = capturer
                startCamera(capturer)
            }
            pc?.delegate = self
        }
        remotePeer = peer
    }

    private func startCamera(_ capturer: RTCCameraVideoCapturer) {
        camFacing = "user"
        switchCamera(to: .front)
    }

    /// call54 parity: PiP tap flips front ↔ back. The old capturer must be
    /// STOPPED before starting the new one — otherwise the device lock keeps
    /// returning the same camera.
    func flipCamera() {
        guard let capturer = localCapturer else { return }
        camFacing = (camFacing == "user") ? "environment" : "user"
        switchCamera(to: camFacing == "user" ? .front : .back)
        NSLog("murmur call: camflip → \(camFacing)")
    }

    private func switchCamera(to position: AVCaptureDevice.Position) {
        guard let capturer = localCapturer else { return }
        capturer.stopCapture()
        let devices = RTCCameraVideoCapturer.captureDevices()
        guard let device = devices.first(where: { $0.position == position })
                ?? devices.first(where: { $0.position == .front })
                ?? devices.first else { return }
        // Pick a mid-range format ≈ 640×480 for battery/latency (PWA parity).
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let target = CGSize(width: 640, height: 480)
        guard let format = formats.min(by: { a, b in
            let d1 = abs(CGFloat(CMVideoFormatDescriptionGetDimensions(a.formatDescription).width) - target.width)
            let d2 = abs(CGFloat(CMVideoFormatDescriptionGetDimensions(b.formatDescription).width) - target.width)
            return d1 < d2
        }) else { return }
        let fps = format.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30
        capturer.startCapture(with: device, format: format, fps: Int(min(fps, 30)))
    }

    // MARK: - Controls

    func toggleMic() {
        micMuted.toggle()
        localAudioTrack?.isEnabled = !micMuted
    }

    func toggleCamera() {
        cameraOff.toggle()
        localVideoTrack?.isEnabled = !cameraOff
    }

    func hangUp() {
        if let peer = remotePeer {
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "bye"], push: false)
        }
        close("hangup")
    }

    func decline() {
        if let peer = pendingOffer?.from ?? remotePeer {
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "bye"], push: false)
        }
        // v160z27: decline из overlay тоже закрывает системную карточку
        // (карточка теперь показывается ВСЕГДА, а не только в фоне).
        CallKitProvider.shared.reportCallEnded()
        close("decline")
    }

    // MARK: - Teardown

    private func close(_ reason: String = "unspecified") {
        NSLog("murmur call: close(\(reason))")
        offerRetryTask?.cancel(); offerRetryTask = nil
        ringTimeoutTask?.cancel(); ringTimeoutTask = nil
        timerTask?.cancel(); timerTask = nil
        iceDisconnectGraceTask?.cancel(); iceDisconnectGraceTask = nil
        localCapturer?.stopCapture()
        localCapturer = nil
        pc?.close()
        pc = nil
        localAudioTrack = nil
        localVideoTrack = nil
        remoteVideoTrack = nil
        remotePeer = nil
        pendingOffer = nil
        pendingRemoteCandidates.removeAll()
        sentIce.removeAll()
        iceSentCount = 0
        iceRecvCount = 0
        iceHostCount = 0
        iceSrflxCount = 0
        icePrflxCount = 0
        iceRelayCount = 0
        incomingOfferCount = 0
        lastAnswerSDP = nil
        callStartedAt = 0
        durationSeconds = 0
        micMuted = false
        cameraOff = false
        stateText = ""
        phase = .idle
        // v160z25: если звонок шёл через системную карточку CallKit —
        // репортим end, иначе системный UI останется висеть «active».
        CallKitProvider.shared.reportCallEnded()
    }

    /// v160z25: CallKit активирует аудио-сессию ДО answer (didActivate).
    /// WebRTC-треки должны увидеть активную сессию — заглушаем наш
    /// собственный setActive в ensureMediaPermissions, когда CallKit рулит.
    func activateAudioSession(_ session: AVAudioSession) {
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        try? session.setActive(true, options: [])
    }

    func deactivateAudioSession(_ session: AVAudioSession) {
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func fail(errorText: String) {
        NSLog("murmur call failed: \(errorText)")
        if let peer = remotePeer {
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "bye"], push: false)
        }
        self.errorText = errorText
        close("error")
    }

    // MARK: - Helpers

    private func armRingTimeout(from: String) {
        ringTimeoutTask?.cancel()
        ringTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if case .incoming = self.phase {
                self.relayClient?.sendCallSignal(to: from, signal: ["kind": "bye"], push: false)
                self.close("ring timeout")
            }
        }
    }

    private func sendOffer(_ peer: String, mode: String, sdp: RTCSessionDescription, push: Bool) {
        relayClient?.sendCallSignal(to: peer, signal: ["kind": "offer", "mode": mode, "sdp": sdpJSON(sdp)], push: push)
    }

    private func localSDP() -> RTCSessionDescription {
        // localDescription was set just before this call.
        return pc?.localDescription ?? RTCSessionDescription(type: .offer, sdp: "")
    }

    private func sdpJSON(_ sdp: RTCSessionDescription) -> [String: Any] {
        // sdp.type is RTCSdpType (enum) — JSONSerialization crashes on it
        // ("Invalid type in JSON write (__SwiftValue)"); rawValue is the string.
        // Also strip a=extmap-allow-mixed — Safari cannot parse it (TypeError
        // on setRemoteDescription); fix at the source, PWA also sanitizes.
        let cleaned = sdp.sdp
            .components(separatedBy: "\r\n")
            .filter { !$0.hasPrefix("a=extmap-allow-mixed") }
            .joined(separator: "\r\n")
        return ["type": sdp.type.rawValue, "sdp": cleaned]
    }

    private func startTimer() {
        callStartedAt = Date().timeIntervalSince1970
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                self.durationSeconds += 1
            }
        }
    }

    private func ensureMediaPermissions(video: Bool) async throws {
        let audioGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if !audioGranted {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard granted else { throw CallError.permissionDenied("микрофон") }
        }
        if video {
            let videoGranted = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
            if !videoGranted {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard granted else { throw CallError.permissionDenied("камера") }
            }
        }
        // Audio session: playAndRecord so the call audio keeps playing.
        // v160z25: если звонок начат из CallKit — сессия УЖЕ активирована в
        // didActivate; повторный setActive на main-потоке даёт UI-freeze
        // warning (AVAudioSession_iOS.mm:978) и конкурирует с CallKit.
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord || !session.isOtherAudioPlaying {
            try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try? session.setActive(true, options: [])
        }
    }

    private func prefix(_ npub: String) -> String {
        npub.count > 16 ? "\(npub.prefix(10))…" : npub
    }

    enum CallError: LocalizedError {
        case noPeerConnection
        case negotiation(String)
        case permissionDenied(String)

        var errorDescription: String? {
            switch self {
            case .noPeerConnection: return "соединение не установлено"
            case .negotiation(let m): return m
            case .permissionDenied(let what): return "нет доступа к \(what)"
            }
        }
    }
}

// MARK: - RTCPeerConnectionDelegate

extension CallManager: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        Task { @MainActor in
            // Remote video (video mode): grab the first video track.
            if let track = stream.videoTracks.first {
                self.remoteVideoTrack = track
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            // Visible diagnosis on the call screen (call58c): «соединение…»
            // hangs are ICE failures that previously vanished silently.
            let stateNames: [RTCIceConnectionState: String] = [
                .new: "ice:new", .checking: "ice:checking", .connected: "ice:connected",
                .completed: "ice:completed", .failed: "ice:FAILED",
                .disconnected: "ice:disconnected", .closed: "ice:closed"
            ]
            NSLog("murmur call: ICE state \(stateNames[newState] ?? "\(newState.rawValue)")")
            if case .connecting = self.phase, let txt = stateNames[newState] {
                self.stateText = txt
            }
            switch newState {
            case .connected, .completed:
                self.iceDisconnectGraceTask?.cancel()
                self.iceDisconnectGraceTask = nil
                guard case .connecting(let peer, let video) = self.phase else { return }
                self.phase = .connected(peer: peer, video: video)
                self.stateText = "На связи"
                self.startTimer()
            case .failed:
                // failed — терминальное состояние: все пары проверены.
                if self.phase != .idle { self.close("ice failed") }
            case .disconnected:
                // v160z25d: НЕ рвём сразу — даём ICE 10с восстановиться
                // (транзиентный disconnect при смене пары/сети). Если через
                // 10с всё ещё disconnected — закрываем (pwa-паритет:
                // call-audio.js закрывает по connectionState, не по ICE).
                guard self.phase != .idle else { return }
                self.iceDisconnectGraceTask?.cancel()
                self.iceDisconnectGraceTask = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard let self, !Task.isCancelled else { return }
                    if let pc = self.pc, pc.iceConnectionState == .disconnected, self.phase != .idle {
                        self.close("ice disconnected >10s")
                    }
                }
            case .closed:
                if self.phase != .idle { self.close("ice closed") }
            case .checking:
                // v160z24b: расширенная диагностика зависаний в checking —
                // сразу видно: обмен кандидатами шёл или оборвался.
                NSLog("murmur call: ICE checking — sent=\(self.iceSentCount) recv=\(self.iceRecvCount) buffered=\(self.pendingRemoteCandidates.count)")
            default:
                break
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        // v160z26h: логируем ход gathering — было главным вопросом
        // «почему iPhone не собрал ни одного srflx/relay-кандидата».
        Task { @MainActor in
            let names: [RTCIceGatheringState: String] = [
                .new: "new", .gathering: "gathering", .complete: "complete"
            ]
            NSLog("murmur call: ICE gathering → \(names[newState] ?? "\(newState.rawValue)") (host=\(self.iceHostCount) srflx=\(self.iceSrflxCount) relay=\(self.iceRelayCount))")
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // v160z24c: фильтр мусорных кандидатов ДО отправки —
        // tcp (Safari-пир их всё равно не использует) и link-local 169.254.*
        // (пустые интерфейсы симулятора/шин). Меньше кандидатов = быстрее
        // проверка релевантных пар (главный урок зависаний в checking).
        let sdp = candidate.sdp
        // v160z26h (Олег, лог 12.11 22:23): старый фильтр резал ТОЛЬКО
        // link-local, а TCP-кандидаты отбрасывал по " tcp " / "typ tcp" /
        // "tcptype". Но реальные TURN-relay-кандидаты содержат
        // "typ relay" + "tcptype passive" — строка " tcp " в них ЕСТЬ.
        // Значит фильтр выбрасывал ЕДИНСТВЕННЫЙ рабочий путь, когда
        // host/srflx недоступны (Wi-Fi с AP isolation, LTE-чернодырые).
        // На сервере (coturn) iPhone аллокировал TURN по TCP — и эти
        // кандидаты НИКОГДА не доходили до пира (в логе iPhone 0 relay).
        // Теперь режем ТОЛЬКО link-local; TCP-кандидаты пропускаем —
        // ICE сам выберет рабочую пару (P2P предпочтительнее релея).
        if sdp.contains("169.254.") || sdp.contains("169.254 ") { return }
        // Trickle ICE to the peer (dedup, pwa sentIce parity).
        let key = sdp
        Task { @MainActor in
            guard !self.sentIce.contains(key) else { return }
            self.sentIce.insert(key)
            // v160z26h: счётчики по типу кандидата — видно, собрал ли
            // клиент srflx/relay (или только host).
            if sdp.contains("typ relay") { self.iceRelayCount += 1 }
            else if sdp.contains("typ srflx") { self.iceSrflxCount += 1 }
            else if sdp.contains("typ prflx") { self.icePrflxCount += 1 }
            else { self.iceHostCount += 1 }
            if let peer = self.remotePeer {
                let json: [String: Any] = [
                    "candidate": candidate.sdp,
                    "sdpMid": candidate.sdpMid ?? "0",
                    "sdpMLineIndex": Int(candidate.sdpMLineIndex),
                ]
                self.relayClient?.sendCallSignal(to: peer, signal: ["kind": "ice", "candidate": json], push: false)
                    self.iceSentCount += 1
                    NSLog("murmur call: ice sent #\(self.iceSentCount) \(candidate.sdp.prefix(50))")
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
