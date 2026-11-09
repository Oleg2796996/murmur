import Foundation

/// Local persistence — parity with the PWA's IDB store. The relay erases
/// delivered envelopes ~5 min after fetch (honest relay), so the server is NOT
/// a history archive; the device must keep its own copy or history is lost
/// between launches (bug 2026-11-05, Олег: «внутри чата только новая переписка»).
enum Persistence {
    struct PersistedMessage: Codable {
        var id: String
        var peer: String
        var body: String
        var ts: Int
        var direction: String
        var status: String
        var hash: String?
        var attachmentsJSON: Data?
    }

    struct PersistedChat: Codable {
        var peer: String
        var lastBody: String
        var lastTs: Int
        var messages: [PersistedMessage]
        var lastMimes: [String]?
    }

    struct PersistedState: Codable {
        var chats: [PersistedChat]
        var contactNames: [String: String]
        var savedAt: Int
        /// peer -> unseen count (PWA unreadMap parity); optional for upgrade.
        var unreadMap: [String: Int]? = nil
    }

    static var fileURL: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("murmur-state.json")
    }

    static func load() -> PersistedState? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(PersistedState.self, from: data)
    }

    static func save(chats: [ChatSummary], contactNames: [String: String], unreadMap: [String: Int]) {
        let state = PersistedState(
            chats: chats.map { chat in
                PersistedChat(
                    peer: chat.peer,
                    lastBody: chat.lastBody,
                    lastTs: chat.lastTs,
                    messages: chat.messages.map { m in
                        PersistedMessage(
                            id: m.id, peer: m.peer, body: m.body, ts: m.ts,
                            direction: m.direction.rawValue, status: m.status.rawValue,
                            hash: m.hash,
                            attachmentsJSON: (try? JSONSerialization.data(withJSONObject: m.attachments))
                        )
                    },
                    lastMimes: chat.lastMimes
                )
            },
            contactNames: contactNames,
            savedAt: Int(Date().timeIntervalSince1970),
            unreadMap: unreadMap
        )
        guard let data = try? JSONEncoder().encode(state) else { return }
        // Atomic write; failures are non-fatal (cache, not source of truth).
        try? data.write(to: fileURL, options: .atomic)
    }

    static func restoreChats() -> (chats: [ChatSummary], contactNames: [String: String], unreadMap: [String: Int])? {
        guard let state = load() else { return nil }
        let unread = state.unreadMap ?? [:]
        let chats = state.chats.compactMap { chat -> ChatSummary? in
            var summary = ChatSummary(peer: chat.peer, lastBody: chat.lastBody, lastTs: chat.lastTs,
                                      lastMimes: chat.lastMimes ?? [])
            summary.messages = chat.messages.map { m in
                ChatMessage(
                    id: m.id, peer: m.peer, body: m.body, ts: m.ts,
                    direction: ChatMessage.Direction(rawValue: m.direction) ?? .incoming,
                    status: ChatMessage.Status(rawValue: m.status) ?? .sent,
                    hash: m.hash,
                    attachments: m.attachmentsJSON.flatMap {
                        try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]]
                    } ?? []
                )
            }
            // Keep the thread chronological after restore.
            summary.messages.sort { $0.ts < $1.ts }
            // Drop legacy empty "…" pills (pre-guard rows: no text, no attachments).
            summary.messages.removeAll { $0.body.isEmpty && $0.attachments.isEmpty && $0.direction == .incoming }
            if summary.messages.isEmpty { return nil }
            return summary
        }
        return (chats, state.contactNames, unread)
    }

    static func wipe() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
