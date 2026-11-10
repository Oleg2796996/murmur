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
    /// "печатает…" — ephemeral, UI-only.
    var onTyping: ((String) -> Void)?
    /// WS push arrived (metadata only) — app should poll /api/history.
    /// The row carries from_npub/ts/envelope_hash_hex so the app can create
    /// the chat for an unknown peer before polling.
    var onPushMetadata: ((HistoryRow?) -> Void)?
    var onConnected: (() -> Void)?
    /// WebRTC signaling frames ({type:"call_signal", from_npub, signal:{kind,...}}).
    var onCallSignal: ((String, [String: Any]) -> Void)?

    /// APNs token (VOIP channel) -> sent with /api/register_alias so the
    /// server can push call_signal offers to cold peers.
    var pushToken: Data?

    init(baseURL: String = RelayConfig.defaultBaseURL) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: cfg)
    }

    /// Set from AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken.
    /// Registered server-side -> cold peer wakes on call offer.
    func setPushToken(_ token: Data) {
        pushToken = token
        // Register with the relay so pending offers get pushed.
        let store = IdentityStore.shared
        guard let npub = store.npub else { return }
        Task { await registerAlias(npub: npub) }
    }

    private func registerAlias(npub: String) async {
        guard let url = URL(string: baseURL + "/api/register_alias"), let token = pushToken else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        let hex = token.map { String(format: "%02.2hhx", $0) }.joined()
        let payload: [String: Any] = ["alias": npub, "npub": npub, "pushToken": hex]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        req.httpBody = body
        URLSession.shared.dataTask(with: req) { _, resp, err in
            if let err {
                NSLog("murmur register_alias (pushToken) failed: \(err)")
            } else if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                NSLog("murmur register_alias HTTP \(http.statusCode)")
            } else {
                NSLog("murmur register_alias ok npub=\(npub)")
            }
        }.resume()
    }

    // MARK: - HTTP

    /// Default poll depth: 25. History polls fire on every WS push and on every
    /// chat open; each row is a full ECIES decrypt + snapshot diff on-device
    /// (2026-11-09 lag fix). The device keeps its own archive (Persistence),
    /// so a deep server poll is redundant anyway.
    func history(peer: String, limit: Int = 25) async throws -> [HistoryRow] {
        let store = IdentityStore.shared
        guard let npub = store.npub else { throw RelayError.make("no identity") }
        let auth = try await store.authQueryAsync()
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
        // Decode OFF the main actor (poll bursts during typing starved the UI).
        let rows = try await Task.detached {
            try JSONDecoder().decode(HistoryResponse.self, from: data).messages
        }.value
        // History rows carry the envelope under body_base64 (base64 of the
        // envelope JSON with ct inside) — unwrap so decrypt() sees ct.
        return rows.map { $0.withUnwrappedBody() }
    }

    /// GET /api/contacts — peers seen in the TTL window (startup chat list).
    func contacts() async throws -> [(peer: String, lastTs: Int, preview: String)] {
        let store = IdentityStore.shared
        guard let npub = store.npub else { throw RelayError.make("no identity") }
        let auth = try await store.authQueryAsync()
        guard let url = URL(string: baseURL + "/api/contacts?npub=\(npub)&_t=\(Int(Date().timeIntervalSince1970 * 1000))" + auth) else {
            throw RelayError.make("bad contacts url")
        }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        try Self.checkHTTP(resp, data)
        struct ContactsResponse: Decodable {
            struct Row: Decodable {
                let peer: String
                let last_ts: Int?
                let last_message_preview: String?
            }
            let contacts: [Row]
        }
        let parsed = try await Task.detached {
            try JSONDecoder().decode(ContactsResponse.self, from: data)
        }.value
        return parsed.contacts.map {
            (peer: $0.peer, lastTs: $0.last_ts ?? 0, preview: $0.last_message_preview ?? "")
        }
    }

    /// Builds and sends one encrypted envelope. Returns the relay-assigned hash.
    func send(peer: String, plaintext: String) async throws -> String? {
        try await sendEnvelope(peer: peer, plainObj: [
            "body": plaintext, "attachments": [Any](), "reply_to": NSNull(),
        ], serverMeta: [])
    }

    /// Send with attachments: plainObj.attachments carry REAL names (inside ct),
    /// serverMeta carries neutral f-…bin (server-visible) — pwa app.js parity.
    func sendWithAttachments(peer: String, plaintext: String,
                             prepared: [AttachmentManager.Prepared]) async throws -> String? {
        let attachments: [[String: Any]] = prepared.map { p in
            ["name": p.fileName, "mime": p.mime, "size": p.size] as [String: Any]
        }
        let serverMeta: [[String: Any]] = prepared.map { p in
            var m: [String: Any] = [
                "blob_id": p.blobID, "sha256": p.sha256,
                "wrapped_key": p.wrappedKey, "iv": p.ivB64,
                "mime": p.mime, "size": p.size, "name": p.publicName,
            ]
            if let t = p.blobToken { m["blob_token"] = t }
            return m
        }
        return try await sendEnvelope(peer: peer, plainObj: [
            "body": plaintext, "attachments": attachments, "reply_to": NSNull(),
        ], serverMeta: serverMeta)
    }

    private func sendEnvelope(peer: String, plainObj: [String: Any],
                              serverMeta: [[String: Any]]) async throws -> String? {
        let store = IdentityStore.shared
        let identity = try store.requireIdentity()
        guard let npub = store.npub else { throw RelayError.make("no identity") }

        // 1. Encrypt for the recipient (same Rust ECIES as the PWA).
        // Wire format parity: the PWA encrypts JSON {body, reply_to, attachments}
        // and JSON.parses after decrypt — raw text breaks the peer's client
        // ("не удалось расшифровать"). Always send the JSON shape.
        let plainBytes = try JSONSerialization.data(withJSONObject: plainObj)
        let sealed = try await IdentityStore.shared.cryptoEncryptAsync(identity, recipientNpub: peer, plaintext: plainBytes)
        let ct = sealed.base64EncodedString()

        // 2. Sign `from|to|ts|ct` exactly like pwa/app.js.
        let ts = Int(Date().timeIntervalSince1970)
        let signedPayload = "\(npub)|\(peer)|\(ts)|\(ct)"
        let payloadBytes = Data(signedPayload.utf8)
        let sig = try await store.cryptoSignEnvelopeAsync(identity, senderNpub: npub, payload: payloadBytes)

        let env = WireEnvelope(
            from: npub,
            to: peer,
            ct: ct,
            ts: ts,
            sig: sig,
            signed_payload: payloadBytes.base64EncodedString(),
            attachments_meta: serverMeta.isEmpty ? nil : serverMeta
        )

        var comps = URLComponents(string: baseURL + "/envelope")!
        comps.queryItems = [.init(name: "to", value: peer)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try env.jsonData()

        let (data, resp) = try await session.data(for: req)
        try Self.checkHTTP(resp, data)
        return try? JSONDecoder().decode(EnvelopeAck.self, from: data).hash
    }

    /// Decrypts a batch of history rows OFF the main actor. Rust ECIES per
    /// row is pure CPU over immutable inputs (row struct + IdentityStore read)
    /// — safe to run detached; the caller merges results back on MainActor.
    /// (12fe19e moved only JSON decode off-main; decrypt stayed on-main and
    /// still froze the UI on 100-row poll bursts.)
    func decryptRows(_ rows: [HistoryRow]) async -> [(row: HistoryRow, dec: Decrypted?)] {
        guard !rows.isEmpty else { return [] }
        // Snap the identity before detaching: IdentityStore.shared is MainActor-
        // adjacent state; decryptMessage(data-only) below must not race a
        // concurrent importBackup/wipe.
        _ = try? IdentityStore.shared.requireIdentity()
        return await Task.detached(priority: .userInitiated) { [self] in
            rows.map { (row: $0, dec: self.decryptMessage(row: $0)) }
        }.value
    }

    /// Single-row decrypt off the main actor (WS live incoming).
    func decryptRowAsync(row: HistoryRow) async -> Decrypted? {
        await Task.detached(priority: .userInitiated) { [self] in
            self.decryptMessage(row: row)
        }.value
    }

    /// Decrypted payload of an incoming row.
    struct Decrypted {
        var body: String
        /// Merged attachment chips (server refs + envelope meta, with blob_token).
        var attachments: [[String: Any]]
        /// True for service envelopes (✓✓ receipts, group control) — never rendered.
        var isService: Bool

        /// Render body: attachment-only messages get 📎 chips in text
        /// (pwa decryptEnvelopeForRender parity).
        var displayBody: String {
            var out = body
            for a in attachments {
                let name = a["name"] as? String ?? "file"
                let size = a["size"] as? Int ?? 0
                out += (out.isEmpty ? "" : "\n") + "📎 \(name) (\(Self.fmtSize(size)))"
            }
            return out
        }

        static func fmtSize(_ b: Int) -> String {
            b >= 1_048_576 ? String(format: "%.1f MB", Double(b) / 1_048_576)
                : b >= 1024 ? "\(b / 1024) KB" : "\(b) B"
        }
    }

    /// Decrypts an incoming history row. Returns nil if it is not for us or
    /// cannot be decrypted (wrong key / foreign envelope / own outgoing echo —
    /// outgoing ct is sealed to the PEER's key, we cannot open it, same as PWA
    /// which reads own messages from its outbox).
    func decryptMessage(row: HistoryRow) -> Decrypted? {
        if row.kind == "receipt" || row.kind == "group_invite" || row.kind == "group_key" {
            // Receipt envelopes: decrypt the inner payload and feed the
            // receipt pipeline (✓✓ on OUR outgoing). Group control: ignored.
            if row.kind == "receipt", let ct = row.ct, let data = Data(base64Encoded: ct),
               let identity = try? IdentityStore.shared.requireIdentity(),
               let pt = try? IdentityStore.shared.cryptoDecrypt(identity, sealed: data),
               let obj = try? JSONSerialization.jsonObject(with: pt) as? [String: Any],
               let peer = row.from_npub {
                ReceiptManager.shared.consume(peer: peer, plain: obj)
            }
            return Decrypted(body: "", attachments: [], isService: true)
        }
        guard let ct = row.ct, let data = Data(base64Encoded: ct) else { return nil }
        guard let identity = try? IdentityStore.shared.requireIdentity() else { return nil }
        guard let pt = try? IdentityStore.shared.cryptoDecrypt(identity, sealed: data) else { return nil }
        // PWA wire format: JSON {body, reply_to, attachments}; receipts carry
        // _kind:"receipt" (or rt:1) and must be swallowed, not rendered
        // (pwa/receipts.js isReceiptRow parity).
        if let obj = try? JSONSerialization.jsonObject(with: pt) as? [String: Any] {
            // Service envelopes (pwa/receipts.js parity):
            //  - wire-level _kind:"receipt" is OUTSIDE ct (we see it in body_base64
            //    JSON, carried on the row);
            //  - inside ct: {v:1, _t:"receipt"|"receipt_req", msgs:[...], pad}
            //  - group control: _kind:"group_invite"/"group_key".
            let t = obj["_t"] as? String
            if t == "receipt" || t == "receipt_req" {
                return Decrypted(body: "", attachments: [], isService: true)
            }
            let body = obj["body"] as? String ?? ""
            // ct-attachments carry ONLY {name, mime, size, poster_data_url}
            // (pwa/app.js encryptForRecipient) — no blob_id/wrapped_key/iv.
            // Server attachment_refs + envelope attachments_meta carry the
            // download triple. Merge: server/envelope base, ct overlays by
            // index (real name, poster). (Bug d67c396: non-empty ct-atts
            // replaced the merged set entirely -> chips without blob_id.)
            let ctAtts = obj["attachments"] as? [[String: Any]] ?? []
            var chips = row.mergedAttachments()
            if chips.isEmpty { chips = ctAtts }
            for (i, pa) in ctAtts.enumerated() where i < chips.count {
                for (k, v) in pa where !(v is NSNull) { chips[i][k] = v }
            }
            return Decrypted(body: body, attachments: chips, isService: false)
        }
        // Legacy raw text (older iOS builds).
        return Decrypted(body: String(data: pt, encoding: .utf8) ?? "",
                         attachments: [], isService: false)
    }

    /// Legacy string-shape decrypt (kept for tooling/tests).
    func decrypt(row: HistoryRow) -> String? {
        decryptMessage(row: row).map { $0.body }
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

    /// WebRTC signaling over the live WS (pwa call-audio.js doSend parity):
    /// {type:"call_signal", npub: me, to: peer, signal: {...}, push?: false}.
    /// Relay routes it ephemerally to the peer's subscribers; only the initial
    /// offer additionally wakes an offline recipient via APNs/WebPush.
    func sendCallSignal(to peer: String, signal: [String: Any], push: Bool = true) {
        guard let npub = IdentityStore.shared.npub else { return }
        var msg: [String: Any] = [
            "type": "call_signal",
            "npub": npub,
            "to": peer,
            "signal": signal,
        ]
        if !push { msg["push"] = false }
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { err in
            if let err { NSLog("murmur call_signal send failed: \(err)") }
        }
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
        // Ephemeral events (typing, call signaling, control) are NOT message
        // pushes — typing arrives bare {type:"typing", from_npub, ts(ms)} on
        // every keystroke; treating it as a push hammered /api/history.
        let type = (obj["type"] as? String) ?? (envelope["type"] as? String) ?? ""
        if ["typing", "call_signal", "subscribed", "pong", "error"].contains(type) {
            if type == "typing" { onTyping?(envelope["from_npub"] as? String ?? "") }
            if type == "call_signal",
               let from = envelope["from_npub"] as? String,
               let signal = envelope["signal"] as? [String: Any] {
                onCallSignal?(from, signal)
            }
            return
        }
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
        row.kind = (envelope["_kind"] as? String) ?? row.kind
        row = row.withUnwrappedBody()
        if row.ct != nil {
            onEnvelope?(row)
        } else {
            onPushMetadata?(row)
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
