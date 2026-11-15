import Foundation

/// PURE-LOGIC part of the `.murmur` backup codec — no UIKit, no CryptoKit.
///
/// 2026-11-14: this file exists so the decoder can be exercised on the HP
/// machine against REAL PWA backup files (the app target is iOS-only, and the
/// crypto part is covered by the Rust parser `murmur_backup_parse`, which
/// decrypts the same bytes with the same KDF).
///
/// The payload shape comes from `pwa/backup.js`:
///   { ls:{...}, kv:{...}, chats:{ peer:[msg,...] }, identity:{npub,name},
///     createdAt:ms }
enum BackupPayloadCodec {

    /// One chat message in the PWA's cached-message shape.
    struct Message {
        var id: String
        var peer: String
        var body: String
        var ts: Int
        /// "in" | "out" | "system"
        var direction: String
        var hash: String?
        var attachments: [[String: Any]]
        var callEvent: Bool
        var callStatus: String?
        var callDirection: String?
        var callDuration: Int
    }

    /// A decoded backup.
    struct Payload {
        var skHex: String
        var npub: String
        var name: String
        var contactNames: [String: String]
        /// peer -> messages (chronological).
        var chats: [String: [Message]]
        /// peer -> unseen incoming count (PWA `murmur_unread_v1`).
        var unread: [String: Int]
    }

    enum CodecError: LocalizedError {
        case corrupted
        case noIdentity
        var errorDescription: String? {
            switch self {
            case .corrupted: return "Файл backup повреждён"
            case .noIdentity: return "В backup нет ключа идентичности"
            }
        }
    }

    /// Decodes the DECRYPTED JSON body of a backup into a `Payload`.
    static func decode(_ body: Data) throws -> Payload {
        guard let root = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            throw CodecError.corrupted
        }
        let ls = root["ls"] as? [String: Any] ?? [:]
        let kv = root["kv"] as? [String: Any] ?? [:]
        let chatsRaw = root["chats"] as? [String: Any] ?? [:]
        let identity = root["identity"] as? [String: Any] ?? [:]

        // Identity: `ls["murmur.sk"]` is canonical; some writers only put it
        // into `kv` (the PWA mirrors LS -> IDB).
        let skHex = (ls["murmur.sk"] as? String)
            ?? (kv["murmur.sk"] as? String)
            ?? ""
        guard !skHex.isEmpty else { throw CodecError.noIdentity }

        let npub = (ls["murmur.npub"] as? String)
            ?? (kv["murmur.npub"] as? String)
            ?? (identity["npub"] as? String)
            ?? ""
        let name = (ls["murmur.name"] as? String)
            ?? (kv["murmur.name"] as? String)
            ?? (identity["name"] as? String)
            ?? ""

        // Contact names: LS first, KV as fallback.
        var contactNames: [String: String] = [:]
        if let cn = (ls["murmur.contact_names"] ?? kv["murmur.contact_names"]) as? [String: Any] {
            for (k, v) in cn {
                if let s = v as? String { contactNames[k] = s }
                else if let n = v as? NSNumber { contactNames[k] = n.stringValue }
            }
        }

        // Unread counters.
        var unread: [String: Int] = [:]
        if let u = (ls["murmur_unread_v1"] ?? kv["murmur_unread_v1"]) as? [String: Any] {
            for (k, v) in u {
                let n = (v as? NSNumber)?.intValue ?? 0
                if n > 0 { unread[k] = n }
            }
        }

        // Chat history.
        var chats: [String: [Message]] = [:]
        for (peer, value) in chatsRaw {
            guard let arr = value as? [[String: Any]] else { continue }
            var msgs: [Message] = []
            msgs.reserveCapacity(arr.count)
            for raw in arr {
                if let m = decodeMessage(raw, peer: peer) { msgs.append(m) }
            }
            msgs.sort { $0.ts < $1.ts }
            if !msgs.isEmpty { chats[peer] = msgs }
        }

        return Payload(skHex: skHex, npub: npub, name: name,
                       contactNames: contactNames, chats: chats, unread: unread)
    }

    /// Maps one PWA cached message onto `Message`.
    static func decodeMessage(_ m: [String: Any], peer: String) -> Message? {
        let ts = (m["ts"] as? NSNumber)?.intValue ?? 0
        let direction = m["direction"] as? String ?? "in"
        let body = m["body"] as? String ?? ""
        let hash = m["_hash"] as? String
        // PWA dedup/render key: `_sig` (or from+ts). Keep the same key so the
        // iOS thread matches the PWA thread row-for-row.
        let sig = m["_sig"] as? String
        let from = m["from"] as? String ?? ""
        let id = sig ?? (from.isEmpty ? "\(peer)-\(ts)" : "\(from)\(ts)")

        var attachments: [[String: Any]] = []
        if let meta = m["attachments_meta"] as? [[String: Any]], !meta.isEmpty {
            attachments = meta
        } else if let plain = m["attachments"] as? [[String: Any]], !plain.isEmpty {
            // ct-side attachments carry only {name, mime, size, poster_data_url};
            // without the meta triple the blob cannot be fetched — but the chip
            // still shows the file name, so keep them.
            attachments = plain
        }

        let callEvent = (m["callEvent"] as? Bool) ?? false
        let callStatus = m["callStatus"] as? String
        let callDirection = m["callDirection"] as? String
        // PWA stores the duration in SECONDS (float). iOS works in whole
        // seconds — round down so a 12.5 s call shows "00:12".
        let callDuration = Int(((m["callDuration"] as? NSNumber)?.doubleValue) ?? 0)

        return Message(id: id, peer: peer, body: body, ts: ts, direction: direction,
                       hash: hash, attachments: attachments,
                       callEvent: callEvent, callStatus: callStatus,
                       callDirection: callDirection, callDuration: callDuration)
    }
}
