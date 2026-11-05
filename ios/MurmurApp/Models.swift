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

/// One row from `GET /api/history` or a WS push.
///
/// Two shapes exist (matching the relay code and pwa/app.js):
/// - History rows: {from, to, body_base64, sig_base64, ts, direction,
///   envelope_hash, attachments} where body_base64 = base64 of the full
///   envelope JSON {from, to, ct, ts, sig}.
/// - WS push payload: {alias, from_npub, ts, envelope_hash_hex, title,
///   subtitle, body, badge, kind} — METADATA ONLY, no ct. The PWA reacts by
///   polling /api/history for the peer; we do the same.
struct HistoryRow {
    var from_npub: String?
    var to: String?
    var ct: String?
    var ts: Int?
    var hash: String?
    /// base64 of the envelope JSON — history rows carry the body here.
    var bodyBase64: String?

    /// Unwraps body_base64 -> inner envelope ct (pwa decryptEnvelopeForRender
    /// branch 2). Returns self with ct filled in.
    func withUnwrappedBody() -> HistoryRow {
        if ct != nil { return self }
        guard let b64 = bodyBase64, let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let innerCt = obj["ct"] as? String else { return self }
        var copy = self
        copy.ct = innerCt
        return copy
    }
}

/// Decode helper for the raw /api/history JSON.
extension HistoryRow: Decodable {
    private enum Keys: String, CodingKey {
        case from_npub, from, to, to_alias, ct
        case ts, sig, hash, envelope_hash, envelope_hash_hex
        case body_base64, ws_envelope_b64
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(
            from_npub: try c.decodeIfPresent(String.self, forKey: .from_npub)
                ?? c.decodeIfPresent(String.self, forKey: .from),
            to: try c.decodeIfPresent(String.self, forKey: .to)
                ?? c.decodeIfPresent(String.self, forKey: .to_alias),
            ct: try c.decodeIfPresent(String.self, forKey: .ct),
            ts: try c.decodeIfPresent(Int.self, forKey: .ts),
            hash: try c.decodeIfPresent(String.self, forKey: .envelope_hash)
                ?? c.decodeIfPresent(String.self, forKey: .envelope_hash_hex)
                ?? c.decodeIfPresent(String.self, forKey: .hash),
            bodyBase64: try c.decodeIfPresent(String.self, forKey: .body_base64)
        )
    }
}
