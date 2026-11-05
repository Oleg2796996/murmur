import Foundation

/// HTTP + WebSocket transport to the relay.
///
/// Endpoints and payload shapes mirror `pwa/app.js`:
///   history: GET  /api/history?npub=..&peer=..&limit=..&_ts=..&_sig=..
///   send:    POST /envelope?to=<npub>
///   ws:      wss://<host>/ws  -> {"type":"subscribe","alias":..,"npub":..}
final class RelayClient {
    private(set) var baseURL: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    /// Reconnect backoff, same constants as the PWA.
    private let reconnectBase: TimeInterval = 1
    private let reconnectMax: TimeInterval = 60
    private var reconnectDelay: TimeInterval = 1
    private var shouldReconnect = false

    var onEnvelope: ((HistoryRow) -> Void)?
    /// WS push arrived (metadata only) — app should poll /api/history.
    var onPushMetadata: (() -> Void)?
    var onConnected: (() -> Void)?

    init(baseURL: String = RelayConfig.defaultBaseURL) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: cfg)
    }

    // MARK: - HTTP

    func history(peer: String, limit: Int = 100) async throws -> [HistoryRow] {
        let store = IdentityStore.shared
        guard let npub = store.npub else { throw RelayError.make("no identity") }
        let auth = try store.authQuery()
        var comps = URLComponents(string: baseURL + "/api/history")!
        comps.queryItems = [
            .init(name: "npub", value: npub),
            .init(name: "peer", value: peer),
            .init(name: "limit", value: String(limit)),
            .init(name: "visible", value: "1"),
            .init(name: "_t", value: String(Int(Date().timeIntervalSince1970 * 1000))),
        ]
        // auth params are appended raw (they already carry "&_ts=..&_sig=..")
        guard let url = URL(string: comps.string! + auth) else {
            throw RelayError.make("bad history url")
        }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        try Self.checkHTTP(resp, data)
        // History rows carry the envelope under body_base64 (base64 of the
        // envelope JSON with ct inside) — unwrap so decrypt() sees ct.
        return try JSONDecoder().decode(HistoryResponse.self, from: data)
            .messages.map { $0.withUnwrappedBody() }
    }

    /// Builds and sends one encrypted envelope. Returns the relay-assigned hash.
    func send(peer: String, plaintext: String) async throws -> String? {
        let store = IdentityStore.shared
        let identity = try store.requireIdentity()
        guard let npub = store.npub else { throw RelayError.make("no identity") }

        // 1. Encrypt for the recipient (same Rust ECIES as the PWA).
        let sealed = try identity.eciesEncrypt(
            recipientNpub: peer,
            plaintext: Data(plaintext.utf8)
        )
        let ct = sealed.base64EncodedString()

        // 2. Sign `from|to|ts|ct` exactly like pwa/app.js.
        let ts = Int(Date().timeIntervalSince1970)
        let signedPayload = "\(npub)|\(peer)|\(ts)|\(ct)"
        let payloadBytes = Data(signedPayload.utf8)
        let sig = try store.signEnvelope(payload: payloadBytes)

        var env = WireEnvelope(
            from: npub,
            to: peer,
            ct: ct,
            ts: ts,
            sig: sig,
            signed_payload: payloadBytes.base64EncodedString()
        )
        env.sig = sig

        var comps = URLComponents(string: baseURL + "/envelope")!
        comps.queryItems = [.init(name: "to", value: peer)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(env)

        let (data, resp) = try await session.data(for: req)
        try Self.checkHTTP(resp, data)
        return try? JSONDecoder().decode(EnvelopeAck.self, from: data).hash
    }

    /// Decrypts an incoming history row. Returns nil if it is not for us or
    /// cannot be decrypted (wrong key / foreign envelope).
    func decrypt(row: HistoryRow) -> String? {
        guard let ct = row.ct, let data = Data(base64Encoded: ct) else { return nil }
        guard let identity = try? IdentityStore.shared.requireIdentity() else { return nil }
        guard let pt = try? identity.eciesDecrypt(sealed: data) else { return nil }
        // Body may be a JSON payload {body, reply_to, attachments} or raw text.
        if let obj = try? JSONSerialization.jsonObject(with: pt) as? [String: Any],
           let body = obj["body"] as? String {
            return body
        }
        return String(data: pt, encoding: .utf8)
    }

    // MARK: - WebSocket

    func connect() {
        guard let url = RelayConfig.webSocketURL(base: baseURL),
              let npub = IdentityStore.shared.npub else { return }
        shouldReconnect = true
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        sendSubscribe(t, npub: npub)
        receiveLoop(t)
    }

    private func sendSubscribe(_ t: URLSessionWebSocketTask, npub: String) {
        let payload: [String: Any] = ["type": "subscribe", "alias": npub, "npub": npub]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        t.send(.string(text)) { err in
            if let err { NSLog("murmur ws subscribe failed: \(err)") }
        }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                NSLog("murmur ws closed: \(err)")
                self.scheduleReconnect()
            case .success(let message):
                if case .string(let text) = message {
                    self.handleIncoming(text)
                }
                self.onConnected?()
                self.reconnectDelay = self.reconnectBase
                self.receiveLoop(t)
            }
        }
    }

    private func handleIncoming(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // Relay wraps deliveries as {"type":"push","payload":{...}}; typing and
        // call signaling arrive bare (same as pwa/app.js onmessage).
        let envelope = (obj["payload"] as? [String: Any]) ?? obj
        guard let ts = envelope["ts"] as? Int else { return }
        // WS push is METADATA-ONLY (from_npub/ts/envelope_hash_hex, no ct —
        // same as the PWA sees). Two paths:
        //  - receipts/ws_envelope_b64 (service envelopes): decoded via
        //    withUnwrappedBody, mostly contentless;
        //  - normal messages: the PWA answers the push by polling
        //    /api/history — we fire onPushMetadata so AppState re-polls.
        var row = HistoryRow(
            from_npub: envelope["from"] as? String ?? envelope["from_npub"] as? String,
            to: envelope["to"] as? String,
            ct: envelope["ct"] as? String,
            ts: ts,
            hash: envelope["hash"] as? String ?? envelope["envelope_hash_hex"] as? String,
            bodyBase64: envelope["body_base64"] as? String
        )
        row = row.withUnwrappedBody()
        if row.ct != nil {
            onEnvelope?(row)
        } else {
            onPushMetadata?()
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, reconnectMax)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.shouldReconnect else { return }
            self.connect()
        }
    }

    func disconnect() {
        shouldReconnect = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private static func checkHTTP(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw RelayError.make("HTTP \(http.statusCode): \(body.prefix(200))")
        }
    }
}

private struct HistoryResponse: Decodable {
    let messages: [HistoryRow]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (try? c.decode([HistoryRow].self, forKey: .messages)) ?? []
    }
    enum CodingKeys: String, CodingKey { case messages }
}

extension RelayClient {
    /// PWA parity: POST /api/register_alias {alias, npub} — fire and forget.
    func registerAlias(alias: String, npub: String) {
        guard let url = URL(string: baseURL + "/api/register_alias") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        let payload: [String: Any] = ["alias": alias, "npub": npub]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        req.httpBody = body
        session.dataTask(with: req) { _, resp, err in
            if let err {
                NSLog("murmur register_alias failed: \(err)")
            } else if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                NSLog("murmur register_alias HTTP \(http.statusCode)")
            }
        }.resume()
    }
}
