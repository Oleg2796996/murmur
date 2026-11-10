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
    private var localVideoTrack: RTCVideoTrack?
    private var localCapturer: RTCCameraVideoCapturer?
    /// Remote video track — read by CallOverlay for the fullscreen background.
    private(set) var remoteVideoTrack: RTCVideoTrack?

    private var remotePeer: String?
    /// Wired by AppState at init — AppState owns the only RelayClient.
    weak var relayClient: RelayClient?
    private var callMode: String = "audio"          // "audio" | "video"
    /// CallOverlay reads this to decide on the fullscreen video background.
    var activeCallIsVideo: Bool { callMode == "video" }
    private var pendingOffer: (from: String, signal: [String: Any]?)?
    private var pendingRemoteCandidates: [RTCIceCandidate] = []
    private var sentIce: Set<String> = []            // dedup (call53 sentIce parity)
    private var offerRetryTask: Task<Void, Never>?
    private var ringTimeoutTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
    private var callStartedAt: TimeInterval = 0
    private var iceServers: [RTCIceServer] = [
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
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
                    // push:false — the APNs wake already went with offer #1.
                    self.sendOffer(peer, mode: self.callMode, sdp: sdp, push: false)
                }
            }
        }
    }

    // MARK: - Incoming / signaling

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
            // Our peer re-offering mid-call (cold-start glare): handled by
            // answer path below when connecting.
            Task { await answerOffer(from: from, signal: signal) }
        }
    }

    /// Accept button: create PC, apply pending offer SDP, answer.
    func accept() async {
        guard case let .incoming(peer, video) = phase else { return }
        ringTimeoutTask?.cancel()
        do {
            try await setupPeerConnection(peer: peer, video: video)
            guard let signal = pendingOffer?.signal,
                  let sdpDict = signal["sdp"] as? [String: Any],
                  let sdpType = sdpDict["type"] as? String,
                  let sdpText = sdpDict["sdp"] as? String else {
                throw CallError.negotiation("нет SDP во входящем offer")
            }
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
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "answer", "sdp": sdpJSON(answer)], push: false)
            phase = .connecting(peer: peer, video: video)
            stateText = "соединение…"
        } catch {
            fail(errorText: error.localizedDescription)
        }
    }

    private func answerOffer(from: String, signal: [String: Any]) async {
        // Only used in the glare path (we are connecting with this peer and
        // they replaced the connection). Simplified: if we have no remote
        // description yet, treat it as a fresh accept flow.
        guard let pc, pc.remoteDescription == nil else { return }
        do {
            if let sdpDict = signal["sdp"] as? [String: Any],
               let sdpText = sdpDict["sdp"] as? String {
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
                relayClient?.sendCallSignal(to: from, signal: ["kind": "answer", "sdp": sdpJSON(answer)], push: false)
            }
        } catch {
            NSLog("murmur call: glare answer failed: \(error)")
        }
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
        close()
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
        let devices = RTCCameraVideoCapturer.captureDevices()
        guard let back = devices.first(where: { $0.position == .front }) ?? devices.first else { return }
        // Pick a mid-range format ≈ 640×480 for battery/latency (PWA parity).
        let formats = RTCCameraVideoCapturer.supportedFormats(for: back)
        let target = CGSize(width: 640, height: 480)
        let format = formats.min(by: { a, b in
            let d1 = abs(CGFloat(CMVideoFormatDescriptionGetDimensions(a.formatDescription).width) - target.width)
            let d2 = abs(CGFloat(CMVideoFormatDescriptionGetDimensions(b.formatDescription).width) - target.width)
            return d1 < d2
        })!
        let fps = format.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30
        capturer.startCapture(with: back, format: format, fps: Int(min(fps, 30)))
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
        close()
    }

    func decline() {
        if let peer = pendingOffer?.from ?? remotePeer {
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "bye"], push: false)
        }
        close()
    }

    // MARK: - Teardown

    private func close() {
        offerRetryTask?.cancel(); offerRetryTask = nil
        ringTimeoutTask?.cancel(); ringTimeoutTask = nil
        timerTask?.cancel(); timerTask = nil
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
        callStartedAt = 0
        durationSeconds = 0
        micMuted = false
        cameraOff = false
        stateText = ""
        phase = .idle
    }

    private func fail(errorText: String) {
        NSLog("murmur call failed: \(errorText)")
        if let peer = remotePeer {
            relayClient?.sendCallSignal(to: peer, signal: ["kind": "bye"], push: false)
        }
        self.errorText = errorText
        close()
    }

    // MARK: - Helpers

    private func armRingTimeout(from: String) {
        ringTimeoutTask?.cancel()
        ringTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard let self, !Task.isCancelled else { return }
            if case .incoming = self.phase {
                self.relayClient?.sendCallSignal(to: from, signal: ["kind": "bye"], push: false)
                self.close()
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
        ["type": sdp.type, "sdp": sdp.sdp]
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
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        try? session.setActive(true, options: [])
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
            switch newState {
            case .connected, .completed:
                guard case .connecting(let peer, let video) = self.phase else { return }
                self.phase = .connected(peer: peer, video: video)
                self.stateText = "На связи"
                self.startTimer()
            case .failed, .closed, .disconnected:
                if self.phase != .idle { self.close() }
            default:
                break
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // Trickle ICE to the peer (dedup, pwa sentIce parity).
        let key = candidate.sdp
        Task { @MainActor in
            guard !self.sentIce.contains(key) else { return }
            self.sentIce.insert(key)
            if let peer = self.remotePeer {
                let json: [String: Any] = [
                    "candidate": candidate.sdp,
                    "sdpMid": candidate.sdpMid ?? "0",
                    "sdpMLineIndex": candidate.sdpMLineIndex,
                ]
                self.relayClient?.sendCallSignal(to: peer, signal: ["kind": "ice", "candidate": json], push: false)
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
