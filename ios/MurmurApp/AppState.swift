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
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { self?.typingPeers.remove(from) }
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
            for chat in self.chats where chat.peer != newPeer {
                await self.pollHistory(peer: chat.peer)
            }
        }
    }

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
            // Decrypt OFF the main actor: 12fe19e moved only the JSON decode
            // off-main, but decryptMessage still ran sync Rust ECIES per row
            // on the MainActor — a 100-row poll burst starved the UI again.
            for (row, decOpt) in await relay.decryptRows(rows) {
                // Content guard parity with handleIncoming/loadHistory: skip
                // decryptable-but-empty rows so they can't render as "…" pills.
                guard let dec = decOpt, !dec.isService,
                      !dec.body.isEmpty || !dec.attachments.isEmpty else { continue }
                let direction: ChatMessage.Direction =
                    (row.from_npub == myNpub || row.from_npub == nil) ? .outgoing : .incoming
                upsert(peer: peer, body: dec.displayBody, ts: row.ts ?? 0,
                       direction: direction, hash: row.hash, attachments: dec.attachments)
            }
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
        let snapshot = chats
        let names = contactNames
        Task.detached(priority: .utility) {
            Persistence.save(chats: snapshot, contactNames: names)
        }
    }

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
    }

    private func peerOf(_ row: HistoryRow) -> String? {
        let me = myNpub
        let from = row.from_npub
        if let from, from != me { return from }
        let to = row.to
        if let to, to != me { return to }
        return nil
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
