import Foundation

/// Relay protocol endpoint. Mirrors `pwa/app.js` exactly so PWA and iOS clients
/// are interchangeable on the same relay (spec section 1, compatibility).
enum RelayConfig {
    /// Production relay. Override at runtime via the onboarding screen.
    static let defaultBaseURL = "https://murmurchat.org"

    /// `https://x` -> `wss://x/ws` (same rule as pwa/app.js WS_URL).
    static func webSocketURL(base: String) -> URL? {
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        let ws: String
        if trimmed.hasPrefix("https://") {
            ws = "wss://" + trimmed.dropFirst("https://".count)
        } else if trimmed.hasPrefix("http://") {
            ws = "ws://" + trimmed.dropFirst("http://".count)
        } else {
            ws = "wss://" + trimmed
        }
        return URL(string: ws + "/ws")
    }
}

/// Error surfaced to the UI.
struct RelayError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    static func make(_ m: String) -> RelayError { RelayError(message: m) }
}

/// One message in a 1:1 chat, as stored locally.
struct ChatMessage: Identifiable, Equatable {
    enum Direction: String { case incoming, outgoing }
    enum Status: String { case sending, sent, failed }

    let id: String            // stable key: sig (or npub+ts fallback)
    var peer: String          // npub of the other party
    var body: String
    var ts: Int               // unix seconds
    var direction: Direction
    var status: Status
    /// Server-assigned envelope hash, used for dedup against the echo.
    var hash: String?
}

/// Wire envelope exactly as the relay expects it (`POST /envelope?to=<npub>`).
/// Field set and signature scheme match pwa/app.js; the relay verifies the
/// signature over `from|to|ts|ct` so it can never tamper with `ct`.
struct WireEnvelope: Codable {
    let from: String
    let to: String
    let ct: String            // base64 ECIES sealed envelope
    let ts: Int
    var sig: String           // lowercase hex ed25519
    var signed_payload: String // base64 of the signed bytes (PWA sends this too)
}

/// Response of `POST /envelope`.
struct EnvelopeAck: Decodable {
    let hash: String?
}

/// One row from `GET /api/history`.
struct HistoryRow: Decodable {
    let from_npub: String?
    let to: String?
    let ct: String?
    let ts: Int?
    let sig: String?
    let hash: String?
}
