import SwiftUI

/// Root state: identity presence, relay client, chat list.
@MainActor
final class AppState: ObservableObject {
    @Published var authenticated = false
    @Published var myNpub: String = ""
    @Published var chats: [ChatSummary] = []
    @Published var errorText: String?

    let relay = RelayClient()

    init() {
        if IdentityStore.shared.restoreFromKeychain() {
            authenticated = true
            myNpub = IdentityStore.shared.npub ?? ""
        }
        relay.onEnvelope = { [weak self] row in
            Task { @MainActor in self?.handleIncoming(row) }
        }
    }

    func didAuthenticate() {
        authenticated = true
        myNpub = IdentityStore.shared.npub ?? ""
        connect()
    }

    func connect() {
        guard authenticated else { return }
        relay.connect()
    }

    private func handleIncoming(_ row: HistoryRow) {
        guard let peer = peerOf(row) else { return }
        let body = relay.decrypt(row: row) ?? "🔒"
        let ts = row.ts ?? Int(Date().timeIntervalSince1970)
        upsert(peer: peer, body: body, ts: ts, direction: .incoming, hash: row.hash)
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
