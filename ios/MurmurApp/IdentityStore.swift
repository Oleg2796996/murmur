import Foundation
import MurmurKit  // generated uniffi bindings

/// Wraps the Rust identity so the secret key never lives in Swift memory
/// (spec section 2). All crypto is delegated to `murmur-uniffi`, which is the
/// same Rust code the PWA runs as WASM — so wire formats are bit-compatible.
final class IdentityStore {
    static let shared = IdentityStore()

    private let keychainAccount = "murmur.sk"
    private var identity: MurmurIdentity?

    var npub: String? { identity?.npub() }

    /// Loads the identity from Keychain if present.
    @discardableResult
    func restoreFromKeychain() -> Bool {
        guard let sk = Keychain.read(account: keychainAccount) else { return false }
        do {
            identity = try MurmurIdentity.restoreHex(skHex: sk)
            return true
        } catch {
            NSLog("murmur: keychain identity failed to restore: \(error)")
            return false
        }
    }

    /// Creates a brand-new identity and persists it to Keychain.
    func createNew() throws -> String {
        let id = MurmurIdentity.generate()
        let sk = try id.exportSkHex()
        try Keychain.write(account: keychainAccount, value: sk)
        identity = id
        return id.npub()
    }

    /// Imports an identity from the PWA's `murmur.sk` hex string.
    func importHex(_ skHex: String) throws -> String {
        let trimmed = skHex.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = try MurmurIdentity.restoreHex(skHex: trimmed)
        try Keychain.write(account: keychainAccount, value: trimmed)
        identity = id
        return id.npub()
    }

    /// Imports a `.murmur` backup file (PBKDF2 + AES-GCM, parsed in Rust).
    func importBackup(data: Data, password: String) throws -> BackupIdentity {
        let info = try murmurBackupParse(raw: data, password: password)
        _ = try importHex(info.skHex)
        return info
    }

    func requireIdentity() throws -> MurmurIdentity {
        guard let identity else { throw RelayError.make("no identity loaded") }
        return identity
    }

    /// Signs the canonical envelope payload and returns lowercase hex,
    /// identical to the PWA WASM `sign_envelope`.
    func signEnvelope(payload: Data) throws -> String {
        let id = try requireIdentity()
        let npub = id.npub()
        return try id.signEnvelopeHex(senderNpub: npub, payload: payload)
    }

    /// `murmur-auth-v1` token used for /api/history and /api/contacts
    /// (matches pwa/app.js apiAuthParams()).
    func authQuery(now: Date = Date()) throws -> String {
        let id = try requireIdentity()
        let ts = Int(now.timeIntervalSince1970)
        let msg = "murmur-auth-v1|\(id.npub())|\(ts)"
        let sig = id.signHex(msg: Data(msg.utf8))
        return "&_ts=\(ts)&_sig=\(sig.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sig)"
    }
}

/// Minimal Keychain wrapper. `AfterFirstUnlock` so background push handling
/// can read the key (spec section 1).
enum Keychain {
    private static let service = "org.murmurchat.identity"

    static func write(account: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw RelayError.make("cannot encode key")
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw RelayError.make("keychain write failed: \(status)")
        }
    }

    static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}
