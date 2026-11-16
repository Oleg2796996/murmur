import Foundation

/// PURE-LOGIC chat restore — no SwiftUI, no UIKit, no CryptoKit.
///
/// 2026-11-16 (Олег: «Восстановилось как-то странно. Не все чаты отображаются
/// и названий нет»): the restore path lived inside `AppState` (a @MainActor
/// ObservableObject) and could only be exercised on a real device. That made
/// every restore bug cost a full Xcode rebuild round-trip.
///
/// This file extracts the merge rules into pure functions so they can be run
/// on the HP machine against REAL PWA backup files (same trick as
/// `BackupPayloadCodec`): merge the backup payload into the device state,
/// dedup against what is already there, and report what happened.
///
/// WHY THE OLD BEHAVIOUR LOST DATA
/// ---------------------------------
/// The pre-v160z28 import called the Rust parser `murmur_backup_parse`, which
/// returns ONLY the identity (sk / npub / name / contact_names). The whole
/// chat history and the unread counters were dropped on the floor — the file
/// opened "successfully" and the chat list stayed (almost) empty, which looks
/// exactly like data loss to the user.
///
/// WHY THE DEDUP KEY IS NOT THE MESSAGE ID
/// --------------------------------------
///   * live iOS messages  → id = envelope hash (or "peer-ts")
///   * restored PWA rows  → id = the PWA `_sig` (= from + ts)
/// Comparing them by id would NEVER match → every message present both in
/// the backup and on the server would be rendered TWICE. The stable identity
/// of a MurMur message is the envelope hash; without it the
/// (peer, ts, direction) triple is the next best key.
enum ChatRestore {

    // MARK: - Result of a restore

    /// What the restore actually did — surfaced to the user in the UI so a
    /// silent partial restore is impossible (Олег: «восстановилось странно»).
    struct Report: Equatable {
        /// Number of peers (chats) that ended up in the list.
        var chats: Int = 0
        /// Messages that were NEW (not already on the device).
        var addedMessages: Int = 0
        /// Messages that were already present (deduped away).
        var duplicateMessages: Int = 0
        /// Contact names that landed in the address book.
        var contactNames: Int = 0
        /// Peers that were skipped (own npub, system:relay).
        var skippedPeers: Int = 0
        /// True when the backup's identity differs from the device identity.
        var identityChanged: Bool = false

        /// One-line summary for the status bar / alert.
        var summary: String {
            var parts = ["чатов: \(chats)", "сообщений: \(addedMessages)"]
            if duplicateMessages > 0 { parts.append("дублей пропущено: \(duplicateMessages)") }
            parts.append("имён: \(contactNames)")
            return parts.joined(separator: " · ")
        }
    }

    // MARK: - Identity keys (dedup)

    /// Identity keys of one message, used to detect "the same message" across
    /// two different id schemes (live iOS vs restored from a PWA backup).
    ///
    ///   * `h:<hash>` — the envelope hash. This is the TRUE identity of a
    ///     MurMur message and is present on both sides for every message that
    ///     came through the relay.
    ///   * `t:<peer>:<ts>:<dir>` — the fallback for messages without a hash
    ///     (optimistic sends, call events). The direction keeps an outgoing
    ///     and an incoming message with the same ts apart.
    ///
    /// The PWA `_sig` (from + ts) is deliberately NOT used as a key: it
    /// contains the sender npub, so the same message seen from the two sides
    /// of a conversation would produce different strings.
    static func dedupKeys(peer: String, ts: Int,
                          direction: ChatMessage.Direction,
                          hash: String?) -> Set<String> {
        var keys = Set<String>()
        if let hash, !hash.isEmpty {
            keys.insert("h:\(hash)")
        }
        keys.insert("t:\(peer):\(ts):\(direction.rawValue)")
        return keys
    }

    // MARK: - Merge

    /// The merged state + the report — the caller assigns the three maps back
    /// to its @Published properties (one `objectWillChange` per assignment).
    struct Outcome {
        var chats: [ChatSummary]
        var contactNames: [String: String]
        var unreadByPeer: [String: Int]
        var report: Report
    }

    /// Merges a decoded backup payload into the device state.
    ///
    /// - Parameters:
    ///   - payload: the decoded backup (identity, contact names, chats, unread).
    ///   - chats: the device's current chats.
    ///   - contactNames: the device's current contact names.
    ///   - unreadByPeer: the device's unread counters.
    ///   - deviceNpub: the npub currently on the device (nil = fresh install).
    /// - Returns: the merged state and a report describing exactly what happened.
    static func merge(payload: BackupPayloadCodec.Payload,
                      chats: [ChatSummary],
                      contactNames: [String: String],
                      unreadByPeer: [String: Int],
                      deviceNpub: String?) -> Outcome {
        // The backup carries its own identity. If it differs from the one on
    /// the device, the old chats belong to a DIFFERENT person — mixing
    /// them would show another account's history under our own npub.
    let backupNpub = payload.npub
    var chats = chats
    var contactNames = contactNames
    var unreadByPeer = unreadByPeer
    var report = Report()

    if let deviceNpub, !deviceNpub.isEmpty, !backupNpub.isEmpty,
       deviceNpub != backupNpub {
        report.identityChanged = true
        // Start from a clean slate: the device's old chats and names
        // belong to the previous identity.
        chats.removeAll()
        contactNames.removeAll()
        unreadByPeer.removeAll()
    }
    let myNpub = backupNpub.isEmpty ? (deviceNpub ?? "") : backupNpub

    // Contact names (excluding our own npub and the system pseudo-peer).
    if !payload.contactNames.isEmpty {
        for (k, v) in payload.contactNames where k != myNpub && k != "system:relay" {
            contactNames[k] = v
            report.contactNames += 1
        }
    }

    // Chat history.
    for (peer, msgs) in payload.chats where peer != "system:relay" && peer != myNpub {
        mergeChat(peer: peer, messages: msgs, chats: &chats, report: &report)
    }

    // Unread counters — only for peers we actually restored, otherwise the
    // badge would count messages the user cannot see.
    if !payload.unread.isEmpty {
        let restoredPeers = Set(payload.chats.keys).subtracting(["system:relay", myNpub])
        for (peer, count) in payload.unread
        where count > 0 && restoredPeers.contains(peer) {
            unreadByPeer[peer] = count
        }
    }

    // Newest chat first (PWA list parity).
    chats.sort { $0.lastTs > $1.lastTs }

    report.chats = chats.count
    return Outcome(chats: chats, contactNames: contactNames,
                    unreadByPeer: unreadByPeer, report: report)
    }

    /// Merge one peer's messages into an existing (or new) chat.
    ///
    /// Keeps whatever the device already knows: the relay erases delivered
    /// envelopes within minutes, so the LOCAL copy is the only archive. A
    /// restored message that is not on the device yet is appended; one that
    /// already exists is left alone.
    private static func mergeChat(peer: String,
                                  messages: [BackupPayloadCodec.Message],
                                  chats: inout [ChatSummary],
                                  report: inout Report) {
        guard !messages.isEmpty else { return }
        var summary = chats.first(where: { $0.peer == peer })
            ?? ChatSummary(peer: peer, lastBody: "", lastTs: 0, lastMimes: [])

        var seen = Set<String>()
        for existing in summary.messages {
            seen.formUnion(dedupKeys(peer: peer, ts: existing.ts,
                                    direction: existing.direction,
                                    hash: existing.hash))
        }

        var added = 0
        for m in messages {
            let restoredDirection: ChatMessage.Direction = m.direction == "out" ? .outgoing : .incoming
            let keys = dedupKeys(peer: peer, ts: m.ts,
                                 direction: restoredDirection,
                                 hash: m.hash)
            guard seen.isDisjoint(with: keys) else {
                report.duplicateMessages += 1
                continue
            }
            seen.formUnion(keys)
            var msg = ChatMessage(
                id: m.id,
                peer: peer,
                body: m.body,
                ts: m.ts,
                // PWA marks call events as direction "system" (rendered
                // neutral, centred). iOS has no system direction — the
                // call-event row is rendered centred by ChatView regardless
                // of direction, so `.incoming` is the right carrier.
                direction: restoredDirection,
                status: .sent,
                hash: m.hash,
                attachments: m.attachments
            )
            if m.callEvent {
                msg.makeCallEvent(status: m.callStatus ?? "completed",
                                  direction: m.callDirection ?? "in",
                                  duration: m.callDuration)
            }
            summary.messages.append(msg)
            added += 1
        }
        report.addedMessages += added
        guard added > 0 else { return }

        summary.messages.sort { $0.ts < $1.ts }
        summary.messages.removeDuplicates()
        // Preview = newest message (PWA list parity).
        if let newest = summary.messages.last {
            summary.lastTs = newest.ts
            if newest.callEvent {
                summary.lastBody = ChatMessage.callPreview(status: newest.callStatus ?? "completed",
                                                          direction: newest.callDirection ?? "in",
                                                          duration: newest.callDuration)
            } else {
                summary.lastBody = newest.body
            }
            summary.lastMimes = newest.attachments.compactMap { $0["mime"] as? String }
        }
        if let i = chats.firstIndex(where: { $0.peer == peer }) {
            chats[i] = summary
        } else {
            chats.append(summary)
        }
    }
}
