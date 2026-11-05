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
    static func == (lhs: ChatMessage, rhs: ChatMessage) -> Bool {
        lhs.id == rhs.id && lhs.body == rhs.body && lhs.status == rhs.status
    }
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
    /// Merged attachment chips for rendering (server refs + envelope meta).
    var attachments: [[String: Any]] = []
}

/// Hashable key for ForEach over attachment dicts.
extension Dictionary where Key == String, Value == Any {
    var blobID: String { self["blob_id"] as? String ?? UUID().uuidString }
}

/// Wire envelope exactly as the relay expects it (`POST /envelope?to=<npub>`).
/// Field set and signature scheme match pwa/app.js; the relay verifies the
/// signature over `from|to|ts|ct` so it can never tamper with `ct`.
struct WireEnvelope {
    let from: String
    let to: String
    let ct: String            // base64 ECIES sealed envelope
    let ts: Int
    var sig: String           // lowercase hex ed25519
    var signed_payload: String // base64 of the signed bytes (PWA sends this too)
    /// Neutral blob chips (f-…bin) visible to the relay — real names ride inside ct.
    var attachments_meta: [[String: Any]]?

    func jsonData() throws -> Data {
        var obj: [String: Any] = [
            "from": from, "to": to, "ct": ct, "ts": ts,
            "sig": sig, "signed_payload": signed_payload,
        ]
        if let attachments_meta { obj["attachments_meta"] = attachments_meta }
        return try JSONSerialization.data(withJSONObject: obj)
    }
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
    /// Wire-level marker from the envelope JSON ({"_kind":"receipt",...}).
    var kind: String?
    /// Server-side attachment chips (attachment_refs: blob_id, wrapped_key, iv,
    /// name=f-…bin, mime, size) — NO blob_token here.
    var attachments: [[String: Any]] = []
    /// attachments_meta from the inner wire envelope (body_base64) — carries
    /// blob_token; merged over `attachments` field-by-field.
    var metaFromEnvelope: [[String: Any]] = []

    /// Server meta + envelope meta merged by index (blob_token wins).
    func mergedAttachments() -> [[String: Any]] {
        let n = max(attachments.count, metaFromEnvelope.count)
        guard n > 0 else { return [] }
        var out: [[String: Any]] = []
        for i in 0..<n {
            var m = i < attachments.count ? attachments[i] : [:]
            if i < metaFromEnvelope.count {
                for (k, v) in metaFromEnvelope[i] where !(v is NSNull) {
                    m[k] = v
                }
            }
            out.append(m)
        }
        return out
    }

    /// Unwraps body_base64 -> inner envelope ct (pwa decryptEnvelopeForRender
    /// branch 2). Returns self with ct filled in.
    func withUnwrappedBody() -> HistoryRow {
        if ct != nil { return self }
        guard let b64 = bodyBase64, let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return self }
        var copy = self
        copy.kind = obj["_kind"] as? String
        copy.ct = obj["ct"] as? String
        if let meta = obj["attachments_meta"] as? [[String: Any]] {
            copy.metaFromEnvelope = meta
        }
        return copy
    }
}

/// Decode helper for the raw /api/history JSON.
extension HistoryRow: Decodable {
    private enum Keys: String, CodingKey {
        case from_npub, from, to, to_alias, ct
        case ts, sig, hash, envelope_hash, envelope_hash_hex
        case body_base64, ws_envelope_b64, _kind, attachments
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
            bodyBase64: try c.decodeIfPresent(String.self, forKey: .body_base64),
            kind: try c.decodeIfPresent(String.self, forKey: ._kind)
        )
        // [[String: Any]] is not Decodable — re-decode the row as raw JSON.
        if let container = try? decoder.singleValueContainer(),
           let raw = try? container.decode(FlexibleRow.self),
           let atts = raw.attachments {
            self.attachments = atts.attachmentsArray
        }
    }
}

/// Adapter to pull `attachments` (array of objects) without Codable key constraints.
private struct FlexibleRow: Decodable {
    let attachments: [AttachmentDict]?
}

/// [String: Any] dictionary decoded from JSON (values: String / Int / Double / Bool / NSNull).
struct AttachmentDict: Decodable, ExpressibleByDictionaryLiteral {
    private var storage: [String: Any]
    init(dictionaryLiteral elements: (String, Any)...) {
        storage = Dictionary(uniqueKeysWithValues: elements)
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: JSONKey.self)
        storage = [:]
        for key in c.allKeys {
            if let s = try? c.decode(String.self, forKey: key) { storage[key.stringValue] = s }
            else if let i = try? c.decode(Int.self, forKey: key) { storage[key.stringValue] = i }
            else if let d = try? c.decode(Double.self, forKey: key) { storage[key.stringValue] = d }
            else if let b = try? c.decode(Bool.self, forKey: key) { storage[key.stringValue] = b }
            else { _ = try? c.decode(Empty.self, forKey: key) } // null / nested — skip
        }
    }
    subscript(key: String) -> Any? { storage[key] }
    var asDict: [String: Any] { storage }
    struct JSONKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    struct Empty: Decodable {}
}

extension Array where Element == AttachmentDict {
    var attachmentsArray: [[String: Any]] { map { $0.asDict } }
}
