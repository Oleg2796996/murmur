import SwiftUI
import WebRTC

/// Call screen — SwiftUI port of PWA `call-overlay`. Mirrors phases from
/// CallManager: incoming (accept/decline) / outgoing (cancel) / connecting /
/// connected (mic/camera/fullscreen + hangup).
@MainActor
struct CallOverlay: View {
    @ObservedObject var cm = CallManager.shared
    @Environment(\.dismiss) private var dismiss

    private func prefix(_ npub: String) -> String {
        npub.count > 10 ? "\(npub.prefix(8))…" : npub
    }

    var body: some View {
        ZStack {
            // Remote video full background (video calls) or dark gradient.
            if case .connected = cm.phase, cm.activeCallIsVideo, let track = cm.remoteVideoTrack {
                RemoteVideoView(track: track)
                    .ignoresSafeArea()
                // Self-view PiP (PWA call-local-video parity): top-right,
                // tap flips front/back camera (call54).
                if let local = cm.localVideoTrack {
                    RemoteVideoView(track: local)
                        .frame(width: 110, height: 150)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.white.opacity(0.4), lineWidth: 1))
                        .shadow(radius: 6)
                        .padding(.top, 8)
                        .padding(.trailing, 14)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .onTapGesture { cm.flipCamera() }
                }
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack {
                // Top: peer name + status
                VStack(spacing: 6) {
                    Text(modeLabel())
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                    Text(stateText())
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.85))
                }
                .padding(.top, 60)

                Spacer()

                // Phase-dependent bottom controls (mic/camera live here in
                // connected — do NOT also render callControls() middle row,
                // it duplicated the buttons).
                callBottomControls()
            }

            // Error toast
            if let err = cm.errorText {
                VStack {
                    Spacer()
                    Text(err)
                        .font(.system(size: 14, weight: .medium))
                        .padding()
                        .background(Color.black.opacity(0.8))
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .padding(.bottom, 100)
                }
            }
        }
        .onDisappear {
            // Overlay closed = end any active/pending call (PWA parity:
            // closing the call UI hangs up).
            switch cm.phase {
            case .idle: break
            case .incoming: cm.decline()
            default: cm.hangUp()
            }
        }
    }

    private func modeLabel() -> String {
        switch cm.phase {
        case .incoming(_, let video): return video ? "Видеозвонок" : "Аудиозвонок"
        case .outgoing(_, let video): return video ? "Видеозвонок" : "Аудиозвонок"
        case .connecting: return "На связи"
        case .connected: return "На связи"
        case .idle: return ""
        }
    }

    private func stateText() -> String {
        if cm.durationSeconds > 0 {
            let sec = cm.durationSeconds
            return String(format: "%d:%02d", sec / 60, sec % 60)
        }
        switch cm.phase {
        case .incoming: return "входящий звонок"
        case .outgoing: return "звоним…"
        case .connecting: return "соединение…"
        case .connected: return "На связи"
        case .idle: return ""
        }
    }

    /// True when the current call is connected (controls become active).
    private var ifCaseIsConnected: Double {
        if case .connected = cm.phase { return 1 }
        return 0
    }

    @ViewBuilder
    private func callBottomControls() -> some View {
        switch cm.phase {
        case .incoming:
            // Accept (green) + Decline (red) side by side — both visible
            // BEFORE connection (bug: accept was hidden until connected).
            HStack(spacing: 64) {
                Button(action: onDecline) {
                    ZStack {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 76, height: 76)
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 30))
                            .foregroundColor(.white)
                    }
                }
                Button(action: onAccept) {
                    ZStack {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 76, height: 76)
                        Image(systemName: "phone.fill")
                            .font(.system(size: 30))
                            .foregroundColor(.white)
                    }
                }
            }
            .padding(.bottom, 40)
        case .outgoing:
            Button(action: onHangup) {
                ZStack {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 76, height: 76)
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 30))
                        .foregroundColor(.white)
                }
            }
            .padding(.bottom, 40)
        case .connecting, .connected:
            HStack(spacing: 40) {
                controlButton(system: "mic.fill", active: cm.micMuted) {
                    cm.toggleMic()
                }
                .opacity(ifCaseIsConnected)
                .allowsHitTesting(ifCaseIsConnected == 1)
                Button(action: onHangup) {
                    ZStack {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 76, height: 76)
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 30))
                            .foregroundColor(.white)
                    }
                }
                controlButton(system: "video.fill", active: cm.cameraOff) {
                    cm.toggleCamera()
                }
                .opacity(ifCaseIsConnected)
                .allowsHitTesting(ifCaseIsConnected == 1)
            }
            .padding(.bottom, 40)
        case .idle:
            EmptyView()
        }
    }

    private func controlButton(system: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.25))
                    .frame(width: 68, height: 68)
                // Slashed icon while muted/camera-off (iOS Phone.app parity),
                // not a fill change.
                Image(systemName: active ? slashName(system) : system)
                    .font(.system(size: 24))
                    .foregroundColor(active ? .red : .white)
            }
        }
    }

    private func slashName(_ system: String) -> String {
        switch system {
        case "mic.fill": return "mic.slash.fill"
        case "video.fill": return "video.slash.fill"
        default: return system
        }
    }

    private func onAccept() {
        Task { await cm.accept() }
    }

    private func onDecline() {
        cm.decline()
    }

    private func onHangup() {
        cm.hangUp()
    }
}

/// Renders an RTCVideoTrack via the standard Metal renderer.
struct RemoteVideoView: UIViewRepresentable {
    let track: RTCVideoTrack

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        track.add(view)
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        track.add(uiView)
    }
}
