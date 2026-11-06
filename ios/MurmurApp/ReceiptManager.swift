import Foundation

/// PWA receipts.js parity: ✓✓ delivery/read receipts.
///
/// Flow (Bob received Alice's message):
///   incoming message (poll/WS) → queueReceipts(peer, hashes)
///   → debounce 2s → send receipt envelope {v:1,_t:"receipt",msgs:[hashes]}
///     via POST /envelope?to=peer with _kind:"receipt" wire marker.
///
/// Flow (Alice sees ✓✓):
///   incoming receipt envelope → markAcks(hashes) → bubbles re-render ✓✓.
///
/// v160y61 self-heal parity: outgoing without acks older than 90s →
/// receipt_req (rate-limited 1/10min/peer); Bob answers only for hashes
/// he actually receipted before.
final class ReceiptManager {
    static let shared = ReceiptManager()

    private let queue = DispatchQueue(label: "murmur.receipts")
    private var pending: [String: Set<String>] = [:]     // peer -> hashes
    private var timers: [String: DispatchWorkItem] = [:] // peer -> debounce
    private var receipted: Set<String> = []              // "peer|hash" anti-storm
    private var acks: Set<String> = []                   // envelope hashes acked ✓✓
    private var receiptReqLast: [String: Date] = [:]
    private var reqInflight: Set<String> = []

    private let flushDelay: TimeInterval = 2.0
    private let batchCap = 80
    private let reqMinInterval: TimeInterval = 600
    private let reqMinAge: TimeInterval = 90

    private init() {
        loadPersisted()
    }

    // MARK: - Persistence (UserDefaults; PWA uses LS, same posture)

    private func loadPersisted() {
        let d = UserDefaults.standard
        if let arr = d.stringArray(forKey: "murmur.acks.v1") { acks = Set(arr) }
        if let arr = d.array(forKey: "murmur.receipted.v1") as? [String] { receipted = Set(arr) }
    }

    private func persistAcks() {
        let arr = Array(acks).sorted()
        if arr.count > 500 {
            UserDefaults.standard.set(Array(arr.suffix(500)), forKey: "murmur.acks.v1")
        } else {
            UserDefaults.standard.set(arr, forKey: "murmur.acks.v1")
        }
    }

    private func persistReceipted() {
        let arr = Array(receipted).sorted()
        if arr.count > 800 {
            UserDefaults.standard.set(Array(arr.suffix(800)), forKey: "murmur.receipted.v1")
        } else {
            UserDefaults.standard.set(arr, forKey: "murmur.receipted.v1")
        }
    }

    // MARK: - Public state (✓✓ render)

    func isAcked(_ hash: String?) -> Bool {
        guard let hash, !hash.isEmpty else { return false }
        return queue.sync { acks.contains(hash) }
    }

    // MARK: - Bob: queue + flush

    func queueReceipts(peer: String, hashes: [String]) {
        guard !peer.isEmpty, peer != IdentityStore.shared.npub else { return }
        queue.sync {
            let fresh = hashes.filter { !$0.isEmpty && !receipted.contains("\(peer)|\($0)") }
            guard !fresh.isEmpty else { return }
            for h in fresh { receipted.insert("\(peer)|\(h)") }
            var set = pending[peer] ?? []
            for h in fresh { set.insert(h) }
            pending[peer] = set
            persistReceipted()
        }
        scheduleFlush(peer: peer)
    }

    private func scheduleFlush(peer: String) {
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.timers.removeValue(forKey: peer)
            Task { await self.flush(peer: peer) }
        }
        queue.sync { timers[peer] = work }
        DispatchQueue.global().asyncAfter(deadline: .now() + flushDelay, execute: work)
    }

    private func flush(peer: String) async {
        let hashes: [String] = queue.sync {
            guard let set = pending[peer], !set.isEmpty else { return [] }
            let arr = Array(set).prefix(batchCap).map { $0 }
            return arr
        }
        guard !hashes.isEmpty else { return }
        var ok = false
        do {
            try await sendReceiptEnvelope(peer: peer, kind: "receipt", msgs: Array(hashes))
            ok = true
        } catch {
            NSLog("murmur receipt flush failed: \(error)")
        }
        if ok {
            queue.sync {
                if var set = pending[peer] {
                    for h in hashes { set.remove(h) }
                    if set.isEmpty { pending.removeValue(forKey: peer) } else { pending[peer] = set }
                }
            }
        } else {
            scheduleFlush(peer: peer) // retry loop (PWA parity)
        }
    }

    /// v160y61: request missing ✓✓ for our outgoing older than 90s (1/10min/peer).
    func requestMissingReceipts(peer: String, outgoing: [(hash: String?, ts: Int)]) async {
        let now = Date()
        let last = queue.sync { receiptReqLast[peer] }
        if let last, now.timeIntervalSince(last) < reqMinInterval { return }
        let missing = outgoing.compactMap { item -> String? in
            guard let h = item.hash, !h.isEmpty, !isAcked(h) else { return nil }
            guard now.timeIntervalSince1970 - Double(item.ts) >= reqMinAge else { return nil }
            return h
        }
        guard !missing.isEmpty else { return }
        queue.sync {
            receiptReqLast[peer] = now
            reqInflight.insert(peer)
        }
        defer { queue.sync { reqInflight.remove(peer) } }
        _ = try? await sendReceiptEnvelope(peer: peer, kind: "receipt_req", msgs: missing)
    }

    // MARK: - Envelope send/receive

    /// Send a receipt envelope (PWA sendReceiptEnvelope parity): ECIES-encrypted
    /// {v,1,_t:kind,msgs,pad}, wire marker _kind:"receipt", signed from|to|ts|ct.
    func sendReceiptEnvelope(peer: String, kind: String, msgs: [String]) async throws {
        let store = IdentityStore.shared
        guard let npub = store.npub else { throw RelayError.make("no identity") }
        let identity = try store.requireIdentity()

        // Size-fingerprint protection pad (PWA parity: 96–480 hex chars).
        let padLen = 96 + Int.random(in: 0..<385)
        let pad = String(repeating: "0123456789abcdef".map { $0 }.randomElement()!, count: padLen)
        let plain: [String: Any] = ["v": 1, "_t": kind, "msgs": msgs, "pad": pad]
        let plainBytes = try JSONSerialization.data(withJSONObject: plain)
        let sealed = try identity.eciesEncrypt(recipientNpub: peer, plaintext: plainBytes)
        let ct = sealed.base64EncodedString()

        let ts = Int(Date().timeIntervalSince1970)
        let signedPayload = "\(npub)|\(peer)|\(ts)|\(ct)"
        let sig = try store.signEnvelope(payload: Data(signedPayload.utf8))

        let wire: [String: Any] = [
            "from": npub, "to": peer, "ct": ct, "ts": ts,
            "attachments_meta": [],
            "_kind": "receipt",
            "sig": sig,
            "signed_payload": Data(signedPayload.utf8).base64EncodedString(),
        ]
        var comps = URLComponents(string: RelayConfig.defaultBaseURL + "/envelope")!
        comps.queryItems = [.init(name: "to", value: peer)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: wire)
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RelayError.make("receipt POST failed")
        }
    }

    /// Consume an incoming receipt envelope (Alice side).
    /// `plain` is the already-decrypted payload from RelayClient.
    func consume(peer: String, plain: [String: Any]) {
        guard let t = plain["_t"] as? String else { return }
        guard let msgs = plain["msgs"] as? [String] else { return }
        if t == "receipt_req" {
            // Answer only for hashes we actually receipted before (honesty).
            let known = msgs.filter { h in
                queue.sync { receipted.contains("\(peer)|\(h)") }
            }
            if !known.isEmpty {
                queueReceipts(peer: peer, hashes: known)
            }
            return
        }
        if t == "receipt" {
            var changed = false
            queue.sync {
                for h in msgs where !h.isEmpty && !acks.contains(h) {
                    acks.insert(h)
                    changed = true
                }
                if changed { persistAcks() }
            }
        }
    }
}
