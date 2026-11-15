import Foundation
import CryptoKit
import CommonCrypto

/// Creates and reads PWA-compatible `.murmur` backup files.
///
/// Format is byte-compatible with `pwa/backup.js` (MURMURBAK1):
///   JSON box { magic, v:1, kdf:"PBKDF2-SHA256", iterations:250000,
///              salt:b64(16), iv:b64(12), data:b64(ct||tag) }
/// where the decrypted payload is JSON with `ls["murmur.sk"]` (hex of the
/// postcard IdentitySecret) — the same path `murmur_backup_parse` (Rust) and
/// the PWA restore flow read.
///
/// 2026-11-14 (Олег: «починим, чтобы backup PWA открывался в iOS»): the
/// import path used to restore ONLY the identity — chat history, contact
/// names, unread counters and attachment metadata were dropped on the floor.
/// Now the whole payload is decoded here and handed to `AppState`.
enum BackupManager {
    static let magic = "MURMURBAK1"
    static let version = 1
    static let iterations = 250_000

    // MARK: - Payload model
    //
    // The pure decoding logic lives in `BackupPayloadCodec` (no UIKit, no
    // CryptoKit) so it can be exercised on the HP machine against real PWA
    // backup files. The types below are aliases of it.

    typealias Message = BackupPayloadCodec.Message
    typealias Payload = BackupPayloadCodec.Payload

    // MARK: - Decrypt + parse

    /// Decrypts a `.murmur` file and decodes its payload.
    ///
    /// Runs off the main actor: PBKDF2 at 250k iterations plus AES-GCM over a
    /// multi-MB body takes ~1-3 s on an iPhone — on the main thread that
    /// would freeze the UI (and iOS would kill us for the watchdog timeout).
    static func decodeBackup(data: Data, password: String) throws -> Payload {
        guard let box = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RelayError.make("Файл backup повреждён")
        }
        guard box["magic"] as? String == magic else {
            throw RelayError.make("Неподдерживаемый файл MurMur backup")
        }
        guard let v = box["v"] as? Int, v == version else {
            throw RelayError.make("Неподдерживаемый файл MurMur backup")
        }
        guard let saltB64 = box["salt"] as? String,
              let ivB64 = box["iv"] as? String,
              let dataB64 = box["data"] as? String,
              let salt = Data(base64Encoded: saltB64),
              let iv = Data(base64Encoded: ivB64),
              let ct = Data(base64Encoded: dataB64) else {
            throw RelayError.make("Файл backup повреждён")
        }
        // The PWA always writes 250000; honour the file's own value so a
        // future KDF change does not silently break the import.
        let iterations = (box["iterations"] as? Int) ?? BackupManager.iterations
        let key = deriveKey(password: password, salt: salt, iterations: iterations)
        // WebCrypto AES-GCM layout: ciphertext || 16-byte tag.
        guard ct.count > 16 else { throw RelayError.make("Файл backup повреждён") }
        let body: Data
        do {
            let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv),
                                                ciphertext: ct.dropLast(16),
                                                tag: ct.suffix(16))
            body = try AES.GCM.open(sealed, using: SymmetricKey(data: key))
        } catch {
            throw RelayError.make("Неверный пароль или повреждённый backup")
        }
        return try BackupPayloadCodec.decode(body)
    }

    // MARK: - Export

    /// Builds an encrypted backup. Password must be >= 8 chars (same rule as
    /// pwa/backup.js `encryptPayload`).
    ///
    /// 2026-11-14: the export used to write an EMPTY `chats` object — the
    /// backup carried the identity and nothing else, so a PWA→iOS→PWA round
    /// trip silently lost the whole history. Now the local chat history is
    /// exported in the PWA's own shape (`chats[peer] = [message...]`), which
    /// `pwa/backup.js` `importBackupData` reads back verbatim.
    static func exportBackup(skHex: String, npub: String, name: String,
                             password: String,
                             contactNamesJSON: String = "{}",
                             chats: [String: [ExportMessage]] = [:],
                             unread: [String: Int] = [:],
                             maxTs: [String: Int] = [:]) throws -> Data {
        guard password.count >= 8 else {
            throw RelayError.make("Пароль должен содержать минимум 8 символов")
        }
        let contactObj = (try? JSONSerialization.jsonObject(with: Data(contactNamesJSON.utf8))) ?? [String: Any]()
        var payload: [String: Any] = [
            "ls": [
                "murmur.sk": skHex,
                "murmur.npub": npub,
                "murmur.name": name,
                "murmur.contact_names": contactObj,
            ],
            "kv": [String: Any](),
            "chats": [String: Any](),
            "identity": ["npub": npub, "name": name],
            "createdAt": Int(Date().timeIntervalSince1970 * 1000),
        ]
        // PWA's `ls` mirror (pwa/backup.js LS_KEYS) — the unread map lives in
        // localStorage on the PWA side, so it must land in `ls` as well.
        if !unread.isEmpty {
            var lsDict = payload["ls"] as? [String: Any] ?? [:]
            lsDict["murmur_unread_v1"] = unread
            payload["ls"] = lsDict
        }
        // Chat history in the PWA's cached-message shape.
        if !chats.isEmpty {
            var chatsDict: [String: Any] = [:]
            for (peer, msgs) in chats {
                chatsDict[peer] = msgs.map { $0.jsonObject(peer: peer, myNpub: npub) }
            }
            payload["chats"] = chatsDict
        }
        // v160z28 (2026-11-14): the IDB mirror (`kv`).
        //
        // The PWA keeps its real state in IndexedDB and MIRRORS the localStorage
        // keys there (`pwa/app-store.js` LEGACY_LS_KEYS). On restore the PWA
        // runs `importBackupData`, which DELETES every kv key and writes back
        // only `data.kv` — so with an empty `kv` the PWA would lose:
        //   * murmur.messages_max_ts / murmur_maxts_v1 — the "already shown up to
        //     ts" map (Lesson #127). Without it every reload re-bumps unread for
        //     messages that are already in the restored history.
        //   * murmur.badge_unread — the badge the service worker reads.
        // Writing the same keys into BOTH `ls` and `kv` mirrors what a real PWA
        // backup contains (verified against Oleg's own file: identical keys).
        var kv: [String: Any] = [
            "murmur.sk": skHex,
            "murmur.npub": npub,
            "murmur.name": name,
            "murmur.contact_names": contactObj,
        ]
        if !unread.isEmpty {
            kv["murmur_unread_v1"] = unread
            kv["murmur.badge_unread"] = unread
        }
        if !maxTs.isEmpty {
            kv["murmur_maxts_v1"] = maxTs
            kv["murmur.messages_max_ts"] = maxTs
        }
        payload["kv"] = kv
        // `sortedKeys` — deterministic output: two exports of the same state
        // must be byte-identical (apart from salt/iv), and the kv mirror pairs
        // (`murmur_maxts_v1` / `murmur.messages_max_ts`) must serialize in the
        // same order, otherwise the two maps look different to a diff.
        let plaintext = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])

        let salt = randomBytes(16)
        let iv = randomBytes(12)
        let key = deriveKey(password: password, salt: salt, iterations: iterations)

        // WebCrypto AES-GCM ct layout is ciphertext||tag; mirror it.
        let sealed = try AES.GCM.seal(plaintext,
                                      using: SymmetricKey(data: key),
                                      nonce: AES.GCM.Nonce(data: iv))
        var ct = sealed.ciphertext
        ct.append(sealed.tag)

        let box: [String: Any] = [
            "magic": magic,
            "v": version,
            "kdf": "PBKDF2-SHA256",
            "iterations": iterations,
            "salt": salt.base64EncodedString(),
            "iv": iv.base64EncodedString(),
            "data": ct.base64EncodedString(),
        ]
        return try JSONSerialization.data(withJSONObject: box)
    }

    /// One message in the export shape (PWA-compatible).
    struct ExportMessage {
        var id: String
        var body: String
        var ts: Int
        var direction: String
        var hash: String?
        var attachments: [[String: Any]]
        var callEvent: Bool
        var callStatus: String?
        var callDirection: String?
        var callDuration: Int

        /// Serialized exactly like a PWA cached message, so `pwa/app-store.js`
        /// `importBackupData` → `chats.saveMessages` restores it as-is.
        ///
        /// v160z28 (2026-11-14): the `_sig` MUST be `from + ts` — that is the
        /// key the PWA builds everywhere (`pwa/app.js` loadHistory/renderMessages/
        /// reply lookup: `sigKey = fromNpub + m.ts`). If we wrote our internal
        /// id (a hash) instead, the PWA would not recognise the restored row
        /// as the same message when the relay still has it → the message would
        /// appear TWICE (once from the backup, once from the server).
        ///
        /// `from`/`to` must be present too: they are the fallback key source
        /// (`m.from_npub || m.from`) used by the reply lookup and by the
        /// outbox matcher.
        func jsonObject(peer: String, myNpub: String) -> [String: Any] {
            var obj: [String: Any] = [
                "body": body,
                "ts": ts,
                "direction": direction,
                "isBinary": false,
                "status": direction == "out" ? "sent" : NSNull(),
                "attachments": attachments,
                "attachments_meta": attachments,
                "reply_to": NSNull(),
            ]
            if let hash { obj["_hash"] = hash }
            if callEvent {
                // Call events are device-local (the relay never stores them),
                // so the PWA-native shape is used: `_sig` = "call:<peer>:<ts>:<rand>"
                // and no from/to — exactly what `pwa/app.js` writes locally.
                obj["direction"] = "system"
                obj["_sig"] = "call:\(peer):\(ts):\(abs(id.hashValue))"
                obj["callEvent"] = true
                obj["callStatus"] = callStatus ?? "completed"
                obj["callDirection"] = callDirection ?? "in"
                obj["callDuration"] = callDuration
                return obj
            }
            // Regular message: from = sender, to = recipient.
            let outgoing = direction == "out"
            let from = outgoing ? myNpub : peer
            let to = outgoing ? peer : myNpub
            obj["from"] = from
            obj["to"] = to
            obj["_sig"] = "\(from)\(ts)"
            return obj
        }
    }

    /// Same file name scheme as pwa/backup.js `fileName()`.
    static func fileName() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return "murmur-backup-\(f.string(from: Date())).murmur"
    }

    private static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!)
        }
        return d
    }

    /// PBKDF2-HMAC-SHA256 -> 32-byte key (CommonCrypto), matching
    /// WebCrypto deriveKey({PBKDF2, SHA-256}) used by the PWA.
    static func deriveKey(password: String, salt: Data, iterations: Int = iterations) -> Data {
        var key = Data(repeating: 0, count: 32)
        let pwd = Data(password.utf8)
        let status = key.withUnsafeMutableBytes { keyPtr in
            salt.withUnsafeBytes { saltPtr in
                pwd.withUnsafeBytes { pwdPtr in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwdPtr.baseAddress!.assumingMemoryBound(to: Int8.self), pwd.count,
                        saltPtr.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        keyPtr.baseAddress!.assumingMemoryBound(to: UInt8.self), 32
                    )
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed: \(status)")
        return key
    }
}
