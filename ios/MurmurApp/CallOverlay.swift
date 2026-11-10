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

                // Controls
                callControls()

                Spacer()

                // Phase-dependent bottom controls:
                // incoming → Accept + Decline; outgoing → Cancel;
                // connected → mic/camera + hangup.
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
                        Image(systemName: "phone.up.fill")
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
            VStack(spacing: 24) {
                if case .connected = cm.phase {
                    HStack(spacing: 56) {
                        controlButton(system: "mic.fill", active: cm.micMuted, color: .white) {
                            cm.toggleMic()
                        }
                        controlButton(system: "camera.fill", active: cm.cameraOff, color: .white) {
                            cm.toggleCamera()
                        }
                    }
                    .opacity(ifCaseIsConnected)
                }
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
            }
            .padding(.bottom, 40)
        case .idle:
            EmptyView()
        }
    }

    private func callControls() -> some View {
        HStack(spacing: 56) {
            controlButton(system: "mic.fill", active: cm.micMuted, color: .white) {
                cm.toggleMic()
            }
            controlButton(system: "camera.fill", active: cm.cameraOff, color: .white) {
                cm.toggleCamera()
            }
        }
        .opacity(ifCaseIsConnected)
        .allowsHitTesting(ifCaseIsConnected == 1)
    }

    private func controlButton(system: String, active: Bool, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(active ? color.opacity(0.5) : color)
                    .frame(width: 68, height: 68)
                Image(systemName: system)
                    .font(.system(size: 26))
                    .foregroundColor(.white)
            }
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
