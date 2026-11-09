import SwiftUI

/// Root state: identity presence, relay client, chat list.
@MainActor
final class AppState: ObservableObject {
    @Published var authenticated = false
    @Published var myNpub: String = ""
    @Published var chats: [ChatSummary] = []
    @Published var errorText: String?
    /// Transient sidebar status (paste errors, import notes) — PWA `backup-status`.
    @Published var statusLine: String?
    /// npub currently typing (ephemeral UI state, PWA parity).
    @Published var typingPeers: Set<String> = []

    /// npub -> display name (PWA `murmur.contact_names` parity).
    @Published var contactNames: [String: String] = [:] {
        didSet { persistContactNames() }
    }

    let relay = RelayClient()

    private let contactNamesKey = "murmur.contact_names"

    init() {
        if IdentityStore.shared.restoreFromKeychain() {
            authenticated = true
            myNpub = IdentityStore.shared.npub ?? ""
        }
        // Local history (PWA IDB parity): restore before any network — the
        // relay erases delivered envelopes, the device is the archive.
        if let restored = Persistence.restoreChats() {
            // One-time cleanup: system:relay service rows leaked into persisted
            // chats before the filter existed (undelivered notices).
            chats = restored.chats.filter { $0.peer != "system:relay" }
            contactNames = restored.contactNames
            persist()
        }
        loadContactNames()
        relay.onEnvelope = { [weak self] row in
            Task { @MainActor in self?.handleIncoming(row) }
        }
        // WS push = metadata only (like the PWA) -> re-poll history.
        relay.onPushMetadata = { [weak self] row in
            Task { @MainActor in self?.handlePushMetadata(row) }
        }
        relay.onTyping = { [weak self] from in
            Task { @MainActor in self?.showTyping(from) }
        }
    }

    /// WS push for possibly-UNKNOWN peer: create the chat first, then poll.
    /// (Bug 2026-11-05: pollAllPeers only polled existing chats, so the first
    /// message from a new peer never surfaced.)
    func showTyping(_ from: String) {
        guard !from.isEmpty, from != myNpub else { return }
        typingPeers.insert(from)
        let _ = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            let _ = await MainActor.run { self?.typingPeers.remove(from) }
        }
    }

    func handlePushMetadata(_ row: HistoryRow?) {
        var newPeer: String?
        if let from = row?.from_npub, from != myNpub, from != "system:relay",
           !chats.contains(where: { $0.peer == from }) {
            upsert(peer: from, body: "", ts: row?.ts ?? Int(Date().timeIntervalSince1970),
                   direction: .incoming, hash: row?.hash)
            newPeer = from
        }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            if let newPeer { await self.pollHistory(peer: newPeer) }
            // 2026-11-09 lag fix: poll ONLY peers touched by recent WS pushes.
            // The old loop re-polled EVERY chat on EVERY push — each poll was
            // a 100-row fetch + decrypt + full re-render (now batched, but
            // still N×HTTP for no reason). Pushes carry from_npub; trust it.
            var targets = self.pushTouchedPeers
            if let newPeer { targets.insert(newPeer) }
            if let from = row?.from_npub, from != self.myNpub { targets.insert(from) }
            self.pushTouchedPeers.removeAll()
            for peer in targets where peer != "system:relay" {
                await self.pollHistory(peer: peer)
            }
        }
    }
    /// Peers seen in recent WS pushes (metadata-only) — poll targets.
    private var pushTouchedPeers: Set<String> = []

    /// Debounced history re-poll for all known peers (answer to a WS push).
    private var pollTask: Task<Void, Never>?
    func pollAllPeers() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            // small debounce: pushes can burst
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            for chat in self.chats {
                await self.pollHistory(peer: chat.peer)
            }
        }
    }

    private func pollHistory(peer: String) async {
        guard !peer.isEmpty, peer != "system:relay" else { return }
        do {
            let rows = try await relay.history(peer: peer)
            // Decrypt OFF the main actor (Rust ECIES per row on-main starved
            // the UI — 12fe19e). Apply the whole batch in ONE @Published
            // mutation: per-row upsert caused 100 re-renders + 100 disk
            // writes per poll (2026-11-09 lag fix).
            let pairs = await relay.decryptRows(rows)
            let incoming = pairs.filter { pair in
                guard let dec = pair.dec, !dec.isService,
                      !dec.body.isEmpty || !dec.attachments.isEmpty else { return false }
                return true
            }
            applyHistory(peer: peer, incoming: incoming)
        } catch {
            NSLog("murmur pollHistory failed: \(error)")
        }
    }

    func didAuthenticate() {
        authenticated = true
        myNpub = IdentityStore.shared.npub ?? ""
        statusLine = nil
        registerAlias()
        connect()
        Task { await loadContactList() }
        // Device token may have arrived before the identity did — register now.
        PushManager.shared.registerTokenOnRelay(npub: myNpub)
    }

    /// Apply profile data restored from a .murmur backup (name + contacts).
    func applyBackupIdentity(_ info: BackupIdentity) {
        if !info.name.isEmpty {
            UserDefaults.standard.set(info.name, forKey: "murmur.name")
        }
        if let data = info.contactNamesJson.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
           !obj.isEmpty {
            var merged = contactNames
            for (k, v) in obj where k != myNpub && k != "system:relay" {
                merged[k] = v
            }
            contactNames = merged
        }
    }

    /// Cold-start refresh for a Keychain-restored identity: `didAuthenticate`
    /// only fires after onboarding/backup import, so `loadContactList()` never
    /// ran on a normal launch — the chat list stayed empty until the first
    /// incoming WS push (bug 2026-11-05). PWA parity: contacts load on enter.
    func refreshOnLaunch() {
        guard authenticated else { return }
        Task { await loadContactList() }
    }

    /// Startup chat list: GET /api/contacts (peers in the relay TTL window).
    func loadContactList() async {
        do {
            let contacts = try await relay.contacts()
            for c in contacts where c.peer != myNpub && c.peer != "system:relay" {
                if !chats.contains(where: { $0.peer == c.peer }) {
                    upsert(peer: c.peer, body: "", ts: c.lastTs,
                           direction: .incoming, hash: nil)
                }
            }
        } catch {
            NSLog("murmur contacts load failed: \(error)")
        }
    }

    /// PWA parity: POST /api/register_alias on enter — the relay must know our
    /// alias or history queries and WS delivery find nobody.
    func registerAlias() {
        guard !myNpub.isEmpty else { return }
        relay.registerAlias(alias: myNpub, npub: myNpub)
    }

    func connect() {
        guard authenticated else { return }
        relay.connect()
    }

    /// PWA parity: "Удалить все данные" — wipe identity + chats + contacts.
    func wipeEverything() {
        IdentityStore.shared.wipeAll()
        relay.disconnect()
        chats = []
        contactNames = [:]
        UserDefaults.standard.removeObject(forKey: contactNamesKey)
        Persistence.wipe()
        authenticated = false
        myNpub = ""
    }

    /// Fire-and-forget save after any state change.
    private func persist() {
        // Debounce: coalesce bursts (poll batches, receipt flushes) into one
        // JSON snapshot instead of one write per message (2026-11-09 lag fix:
        // a 100-row poll fired 100 detached encodes of the whole chat store).
        persistTask?.cancel()
        let snapshot = chats
        let names = contactNames
        persistTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            Persistence.save(chats: snapshot, contactNames: names)
        }
    }

    private var persistTask: Task<Void, Never>?

    /// PWA parity: 🗑 delete chat — removes messages and the contact entry.
    func deleteChat(peer: String) {
        chats.removeAll { $0.peer == peer }
        contactNames.removeValue(forKey: peer)
        persist()
    }

    func setDisplayName(_ name: String, for peer: String) {
        contactNames[peer] = name
    }

    private func handleIncoming(_ row: HistoryRow) {
        guard let peer = peerOf(row), peer != "system:relay" else { return }
        // Service envelopes (✓✓ receipts) are swallowed, not rendered.
        guard let dec = relay.decryptMessage(row: row), !dec.isService,
              !dec.body.isEmpty || !dec.attachments.isEmpty else { return }
        let ts = row.ts ?? Int(Date().timeIntervalSince1970)
        upsert(peer: peer, body: dec.displayBody, ts: ts, direction: .incoming,
               hash: row.hash, attachments: dec.attachments)
        // ✓✓ pipeline: received message → ack its envelope hash back to sender.
        if let h = row.hash {
            ReceiptManager.shared.queueReceipts(peer: peer, hashes: [h])
        }
    }

    private func peerOf(_ row: HistoryRow) -> String? {
        let me = myNpub
        let from = row.from_npub
        if let from, from != me { return from }
        let to = row.to
        if let to, to != me { return to }
        return nil
    }

    /// Apply a whole poll batch in one @Published mutation (one objectWillChange,
    /// one re-sort, one persist) — 2026-11-09 lag fix: per-row upsert on a
    /// 100-row poll caused 100 full list re-renders + 100 disk writes.
    /// Skips rows already present (dedup by id) so repeated polls are cheap.
    func applyHistory(peer: String, incoming: [(row: HistoryRow, dec: RelayClient.Decrypted)]) {
        guard !incoming.isEmpty, !myNpub.isEmpty else { return }
        var rows: [(body: String, ts: Int, hash: String?, attachments: [[String: Any]], outgoing: Bool)] = []
        var receipts: [String] = []
        for (row, dec) in incoming {
            let outgoing = (row.from_npub == myNpub || row.from_npub == nil)
            rows.append((dec.displayBody, row.ts ?? 0, row.hash, dec.attachments, outgoing))
            if !outgoing, let h = row.hash { receipts.append(h) }
        }
        applyRows(peer: peer, rows: rows)
        if !receipts.isEmpty {
            ReceiptManager.shared.queueReceipts(peer: peer, hashes: receipts)
        }
    }

    /// Batch core: merge decoded history rows into the chat, mutate @Published
    /// state exactly once.
    private func applyRows(peer: String, rows: [(body: String, ts: Int, hash: String?, attachments: [[String: Any]], outgoing: Bool)]) {
        let existing = chats.first(where: { $0.peer == peer })
        var seen = Set(existing?.messages.map(\.id) ?? [])
        var fresh: [ChatMessage] = []
        for r in rows {
            let id = r.hash ?? "\(peer)-\(r.ts)"
            guard !seen.contains(id) else { continue }
            seen.insert(id)
            fresh.append(ChatMessage(id: id, peer: peer, body: r.body, ts: r.ts,
                                     direction: r.outgoing ? .outgoing : .incoming,
                                     status: .sent,
                                     hash: r.hash, attachments: r.attachments))
        }
        let maxTs = rows.map(\.ts).max() ?? 0
        let lastBody = rows.last(where: { $0.ts == maxTs })?.body ?? ""
        let lastMimes = rows.last(where: { $0.ts == maxTs })?.attachments.compactMap { $0["mime"] as? String } ?? []

        if let i = chats.firstIndex(where: { $0.peer == peer }) {
            if maxTs >= chats[i].lastTs {
                if !lastBody.isEmpty || chats[i].lastBody.isEmpty { chats[i].lastBody = lastBody }
                chats[i].lastTs = max(maxTs, chats[i].lastTs)
                chats[i].lastMimes = lastMimes
            }
            var msgs = chats[i].messages
            msgs.append(contentsOf: fresh)
            msgs.removeDuplicates()
            msgs.sort { $0.ts < $1.ts }
            chats[i].messages = msgs
            chats.sort { $0.lastTs > $1.lastTs }
        } else {
            var summary = ChatSummary(peer: peer, lastBody: lastBody, lastTs: maxTs, lastMimes: lastMimes)
            summary.messages = fresh.sorted { $0.ts < $1.ts }
            chats.append(summary)
            chats.sort { $0.lastTs > $1.lastTs }
        }
        persist()
    }

    func upsert(peer: String, body: String, ts: Int, direction: ChatMessage.Direction,
                hash: String?, attachments: [[String: Any]] = []) {
        let msg = ChatMessage(id: hash ?? "\(peer)-\(ts)", peer: peer, body: body,
                              ts: ts, direction: direction, status: .sent,
                              hash: hash, attachments: attachments)
        if let i = chats.firstIndex(where: { $0.peer == peer }) {
            // History arrives newest-first (ORDER BY ts DESC); lastTs/lastBody
            // must track the NEWEST row, not the last-processed one — after a
            // full re-poll the old code left the preview showing the OLDEST
            // message and mis-sorted the chat list.
            if ts >= chats[i].lastTs {
                if !body.isEmpty || chats[i].lastBody.isEmpty {
                    chats[i].lastBody = body
                }
                chats[i].lastTs = ts
                chats[i].lastMimes = attachments.compactMap { $0["mime"] as? String }
            } else if chats[i].lastBody.isEmpty && !body.isEmpty {
                // Older-than-placeholder rows still fill an empty preview
                // (new chat upserted with ts=now shows "…" forever otherwise).
                chats[i].lastBody = body
                chats[i].lastMimes = attachments.compactMap { $0["mime"] as? String }
            }
            chats[i].messages.append(msg)
            chats[i].messages.removeDuplicates()
            // Chronological thread: history arrives newest-first and optimistic
            // sends append at the end — sort by ts so the feed reads bottom-up.
            chats[i].messages.sort { $0.ts < $1.ts }
            chats.sort { $0.lastTs > $1.lastTs }
        } else {
            var summary = ChatSummary(peer: peer, lastBody: body, lastTs: ts,
                                      lastMimes: attachments.compactMap { $0["mime"] as? String })
            summary.messages = [msg]
            chats.append(summary)
            chats.sort { $0.lastTs > $1.lastTs }
        }
        persist()
    }

    // MARK: - Contact names (murmur.contact_names parity)

    func isAcked(_ hash: String?) -> Bool {
        ReceiptManager.shared.isAcked(hash)
    }

    func displayName(for peer: String) -> String? {
        contactNames[peer]
    }

    private func loadContactNames() {
        guard let data = UserDefaults.standard.data(forKey: contactNamesKey),
              let dict = try? JSONDecoder().decode([String: String].self, from: data) else { return }
        contactNames = dict
    }

    private func persistContactNames() {
        guard let data = try? JSONEncoder().encode(contactNames) else { return }
        UserDefaults.standard.set(data, forKey: contactNamesKey)
        persist()
    }
}

struct ChatSummary: Identifiable {
    var id: String { peer }
    let peer: String
    var lastBody: String
    var lastTs: Int
    var messages: [ChatMessage] = []
    /// mimes of the newest message's attachments (preview label, PWA parity)
    var lastMimes: [String] = []
}

private extension Array where Element == ChatMessage {
    /// Dedup by id, keeping the newest occurrence (relay echo vs optimistic).
    mutating func removeDuplicates() {
        var seen = Set<String>()
        var out: [ChatMessage] = []
        for m in reversed() {
            if seen.insert(m.id).inserted { out.append(m) }
        }
        self = out.reversed()
    }
}
