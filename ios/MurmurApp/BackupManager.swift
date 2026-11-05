import Foundation
import CryptoKit
import CommonCrypto

/// Creates PWA-compatible `.murmur` backup files.
///
/// Format is byte-compatible with `pwa/backup.js` (MURMURBAK1):
///   JSON box { magic, v:1, kdf:"PBKDF2-SHA256", iterations:250000,
///              salt:b64(16), iv:b64(12), data:b64(ct||tag) }
/// where the decrypted payload is JSON with `ls["murmur.sk"]` (hex of the
/// postcard IdentitySecret) — the same path `murmur_backup_parse` (Rust) and
/// the PWA restore flow read.
enum BackupManager {
    static let magic = "MURMURBAK1"
    static let version = 1
    static let iterations = 250_000

    /// Builds an encrypted backup. Password must be >= 8 chars (same rule as
    /// pwa/backup.js `encryptPayload`).
    static func exportBackup(skHex: String, npub: String, name: String,
                             password: String, contactNamesJSON: String = "{}") throws -> Data {
        guard password.count >= 8 else {
            throw RelayError.make("Пароль должен содержать минимум 8 символов")
        }
        // NOTE: chats are intentionally empty — the relay erases delivered
        // messages within minutes, so the device holds no durable history to
        // export (same posture as a fresh PWA). Identity + contact names are
        // what a `.murmur` file needs to restore a client.
        let contactObj = (try? JSONSerialization.jsonObject(with: Data(contactNamesJSON.utf8))) ?? [String: Any]()
        let payload: [String: Any] = [
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
        let plaintext = try JSONSerialization.data(withJSONObject: payload)

        let salt = randomBytes(16)
        let iv = randomBytes(12)
        let key = deriveKey(password: password, salt: salt)

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
    private static func deriveKey(password: String, salt: Data) -> Data {
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
