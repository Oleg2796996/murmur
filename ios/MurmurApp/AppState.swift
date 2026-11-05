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
        loadContactNames()
        relay.onEnvelope = { [weak self] row in
            Task { @MainActor in self?.handleIncoming(row) }
        }
        // WS push = metadata only (like the PWA) -> re-poll history.
        relay.onPushMetadata = { [weak self] row in
            Task { @MainActor in self?.handlePushMetadata(row) }
        }
    }

    /// WS push for possibly-UNKNOWN peer: create the chat first, then poll.
    /// (Bug 2026-11-05: pollAllPeers only polled existing chats, so the first
    /// message from a new peer never surfaced.)
    func handlePushMetadata(_ row: HistoryRow?) {
        var newPeer: String?
        if let from = row?.from_npub, from != myNpub,
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
        guard !peer.isEmpty else { return }
        do {
            let rows = try await relay.history(peer: peer)
            for row in rows {
                guard let dec = relay.decryptMessage(row: row), !dec.isService else { continue }
                let direction: ChatMessage.Direction =
                    (row.from_npub == myNpub || row.from_npub == nil) ? .outgoing : .incoming
                upsert(peer: peer, body: dec.displayBody, ts: row.ts ?? 0,
                       direction: direction, hash: row.hash)
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
        authenticated = false
        myNpub = ""
    }

    /// PWA parity: 🗑 delete chat — removes messages and the contact entry.
    func deleteChat(peer: String) {
        chats.removeAll { $0.peer == peer }
        contactNames.removeValue(forKey: peer)
    }

    func setDisplayName(_ name: String, for peer: String) {
        contactNames[peer] = name
    }

    private func handleIncoming(_ row: HistoryRow) {
        guard let peer = peerOf(row) else { return }
        // Service envelopes (✓✓ receipts) are swallowed, not rendered.
        guard let dec = relay.decryptMessage(row: row), !dec.isService,
              !dec.body.isEmpty || !dec.attachments.isEmpty else { return }
        let ts = row.ts ?? Int(Date().timeIntervalSince1970)
        upsert(peer: peer, body: dec.displayBody, ts: ts, direction: .incoming, hash: row.hash)
    }

    private func peerOf(_ row: HistoryRow) -> String? {
        let me = myNpub
        let from = row.from_npub
        if let from, from != me { return from }
        let to = row.to
        if let to, to != me { return to }
        return nil
    }

    func upsert(peer: String, body: String, ts: Int, direction: ChatMessage.Direction, hash: String?) {
        if let i = chats.firstIndex(where: { $0.peer == peer }) {
            chats[i].lastBody = body
            chats[i].lastTs = ts
            chats[i].messages.append(
                ChatMessage(id: hash ?? "\(peer)-\(ts)", peer: peer, body: body,
                            ts: ts, direction: direction, status: .sent, hash: hash)
            )
            chats[i].messages.removeDuplicates()
            chats.sort { $0.lastTs > $1.lastTs }
        } else {
            var summary = ChatSummary(peer: peer, lastBody: body, lastTs: ts)
            summary.messages = [ChatMessage(id: hash ?? "\(peer)-\(ts)", peer: peer,
                                            body: body, ts: ts, direction: direction,
                                            status: .sent, hash: hash)]
            chats.append(summary)
            chats.sort { $0.lastTs > $1.lastTs }
        }
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
    }
}

struct ChatSummary: Identifiable {
    var id: String { peer }
    let peer: String
    var lastBody: String
    var lastTs: Int
    var messages: [ChatMessage] = []
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
