import Foundation
// NOTE: no `import MurmurKit` — the generated uniffi bindings
// (MurmurKit/Generated/murmur_uniffi.swift) are compiled directly into the
// MurmurApp target via project.yml, so all Murmur* types are in the app module.

/// Wraps the Rust identity so the secret key never lives in Swift memory
/// (spec section 2). All crypto is delegated to `murmur-uniffi`, which is the
/// same Rust code the PWA runs as WASM — so wire formats are bit-compatible.
final class IdentityStore {
    static let shared = IdentityStore()

    private let keychainAccount = "murmur.sk"
    // 2026-11-09 EXC_BAD_ACCESS fix: the uniffi MurmurIdentity object was
    // called concurrently from poll batches (Task.detached), attachment
    // chips (.task in LazyVStack), PushManager, ReceiptManager. The
    // generated Swift class is not thread-safe w.r.t. ownership
    // (uniffiClonePointer racing deinit/free). ALL identity access now
    // funnels through this serial queue.
    private let cryptoQueue = DispatchQueue(label: "murmur.identity.crypto")
    private var _identity: MurmurIdentity?
    /// npub is immutable per identity — cache the string so the hot path
    /// (chat list rows, every send) never crosses the queue or the FFI.
    private var _npubCache: String?

    /// Thread-safe snapshot: clone the FFI handle before leaving the queue.
    /// The clone increments the Rust Arc refcount atomically, so the caller
    /// owns a reference that cannot be freed underneath it.
    var identity: MurmurIdentity? {
        cryptoQueue.sync { _identity }
    }

    var npub: String? {
        if let cached = _npubCache { return cached }
        guard let identity else { return nil }
        let v = cryptoQueue.sync { identity.npub() }
        _npubCache = v
        return v
    }

    /// Loads the identity from Keychain if present.
    @discardableResult
    func restoreFromKeychain() -> Bool {
        guard let sk = Keychain.read(account: keychainAccount) else { return false }
        do {
            let id = try MurmurIdentity.restoreHex(skHex: sk)
            cryptoQueue.sync { _identity = id; _npubCache = id.npub() }
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
        cryptoQueue.sync { _identity = id; _npubCache = id.npub() }
        return _npubCache ?? ""
    }

    /// Imports an identity from the PWA's `murmur.sk` hex string.
    func importHex(_ skHex: String) throws -> String {
        let trimmed = skHex.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = try MurmurIdentity.restoreHex(skHex: trimmed)
        try Keychain.write(account: keychainAccount, value: trimmed)
        cryptoQueue.sync { _identity = id; _npubCache = id.npub() }
        return _npubCache ?? ""
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

    // MARK: - Serialized crypto (2026-11-09 EXC_BAD_ACCESS fix)
    //
    // The uniffi-generated MurmurIdentity must not be touched from multiple
    // threads at once (clone-while-free race → EXC_BAD_ACCESS). All
    // ECIES/sign calls funnel through this serial queue.

    /// ECIES-decrypt on the crypto queue (blocking the caller is fine: the
    /// call site is already async background work).
    func cryptoDecrypt(_ identity: MurmurIdentity, sealed: Data) throws -> Data {
        try cryptoQueue.sync { try identity.eciesDecrypt(sealed: sealed) }
    }

    /// ECIES-encrypt on the crypto queue.
    func cryptoEncrypt(_ identity: MurmurIdentity, recipientNpub: String, plaintext: Data) throws -> Data {
        try cryptoQueue.sync { try identity.eciesEncrypt(recipientNpub: recipientNpub, plaintext: plaintext) }
    }

    /// Envelope signing on the crypto queue.
    func cryptoSignEnvelope(_ identity: MurmurIdentity, senderNpub: String, payload: Data) throws -> String {
        try cryptoQueue.sync { try identity.signEnvelopeHex(senderNpub: senderNpub, payload: payload) }
    }

    /// Raw sign on the crypto queue.
    func cryptoSignHex(_ identity: MurmurIdentity, msg: Data) throws -> String {
        try cryptoQueue.sync { try identity.signHex(msg: msg) }
    }

    // MARK: Async wrappers — MUST be used from MainActor call sites.
    // 2026-11-09 second-freeze fix: sync cryptoQueue.sync on the main thread
    // blocked the UI whenever the queue was busy with a decrypt batch.

    func cryptoDecryptAsync(_ identity: MurmurIdentity, sealed: Data) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            try IdentityStore.shared.cryptoQueue.sync { try identity.eciesDecrypt(sealed: sealed) }
        }.value
    }

    func cryptoEncryptAsync(_ identity: MurmurIdentity, recipientNpub: String, plaintext: Data) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            try IdentityStore.shared.cryptoQueue.sync { try identity.eciesEncrypt(recipientNpub: recipientNpub, plaintext: plaintext) }
        }.value
    }

    func cryptoSignEnvelopeAsync(_ identity: MurmurIdentity, senderNpub: String, payload: Data) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            try IdentityStore.shared.cryptoQueue.sync { try identity.signEnvelopeHex(senderNpub: senderNpub, payload: payload) }
        }.value
    }

    /// Auth token computed off-main (async call sites only).
    func authQueryAsync(now: Date = Date()) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            try IdentityStore.shared.authQuery(now: now)
        }.value
    }

    /// Signs the canonical envelope payload and returns lowercase hex,
    /// identical to the PWA WASM `sign_envelope`.
    func signEnvelope(payload: Data) throws -> String {
        let id = try requireIdentity()
        let npub = id.npub()
        return try cryptoQueue.sync { try id.signEnvelopeHex(senderNpub: npub, payload: payload) }
    }

    /// `murmur-auth-v1` token used for /api/history and /api/contacts
    /// (matches pwa/app.js apiAuthParams()).
    func authQuery(now: Date = Date()) throws -> String {
        let id = try requireIdentity()
        let ts = Int(now.timeIntervalSince1970)
        let msg = "murmur-auth-v1|\(id.npub())|\(ts)"
        let sig = try cryptoQueue.sync { try id.signHex(msg: Data(msg.utf8)) }
        return "&_ts=\(ts)&_sig=\(Self.percentEncodeQueryValue(sig))"
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

extension IdentityStore {
    /// Full sk hex export for the "Мой ключ" reveal (PWA parity: btnShowKey).
    func exportSkHex() -> String? {
        // Serialized: exportSkHex is an FFI call and must not race the queue.
        if let identity, let sk = try? cryptoQueue.sync(execute: { try identity.exportSkHex() }) {
            return sk
        }
        return Keychain.read(account: keychainAccount)
    }

    /// Wipes every local trace of the identity (PWA parity: "Удалить все
    /// данные" — localStorage.clear() + IDB wipe).
    func wipeAll() {
        cryptoQueue.sync { _identity = nil; _npubCache = nil }
        Keychain.delete(account: keychainAccount)
    }
}

extension Keychain {
    static func delete(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}

extension IdentityStore {
    /// Percent-encoding for query values (ed25519 hex sig is URL-safe already,
    /// but be explicit — matches pwa encodeURIComponent semantics).
    static func percentEncodeQueryValue(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}
