import Foundation
import CryptoKit
import CommonCrypto

/// File attachments — full parity with pwa/attachments.js (Variant Б):
///   1. AES-256-GCM encrypt file (random key 32B + iv 12B) → ct||tag
///   2. ECIES-wrap the key twice: r=for recipient, s=for self (Lesson #349)
///      → base64(JSON {r, s})
///   3. POST /api/upload?sha256=<ct-sha>&mime=&name=f-…bin&size=&wrapped_key=
///      body = ciphertext → {blob_id, blob_token}
///   4. Envelope carries attachments_meta [{blob_id, wrapped_key, iv, mime,
///      size, name=f-…bin, sha256, blob_token}]; real names ride INSIDE ct.
enum AttachmentManager {
    struct Prepared {
        let blobID: String
        let sha256: String
        let mime: String
        let size: Int
        let publicName: String   // neutral f-…bin (server-visible)
        let fileName: String     // real name (inside ct only)
        let blobToken: String?
        let wrappedKey: String
        let ivB64: String
    }

    enum AttachmentError: LocalizedError {
        case uploadFailed(Int, String)
        case badResponse
        var errorDescription: String? {
            switch self {
            case .uploadFailed(let code, let msg): return "Upload failed: HTTP \(code) \(msg)"
            case .badResponse: return "Bad upload response"
            }
        }
    }

    /// Encrypt + wrap + upload one file. Max 50 MB (PWA parity).
    static func encryptAndUpload(fileData: Data, fileName: String, mime: String,
                                 peerNpub: String, selfNpub: String) async throws -> Prepared {
        guard fileData.count <= 50 * 1024 * 1024 else {
            throw RelayError.make("Файл больше 50 МБ")
        }

        // 1. AES-256-GCM encrypt (WebCrypto layout: ct||tag)
        let key = SymmetricKey(size: .bits256)
        let keyBytes = key.withUnsafeBytes { Data($0) }
        let iv = randomBytes(12)
        let sealed = try AES.GCM.seal(fileData, using: key, nonce: AES.GCM.Nonce(data: iv))
        var ct = sealed.ciphertext
        ct.append(sealed.tag)

        // 2. Double ECIES wrap {r, s} (pwa attachments.js eciesWrapKey parity)
        let identity = try IdentityStore.shared.requireIdentity()
        let wrapOne: (String) throws -> String = { npub in
            let sealed = try identity.eciesEncrypt(recipientNpub: npub, plaintext: keyBytes)
            return sealed.base64EncodedString()
        }
        let r = try wrapOne(peerNpub)
        let s = (selfNpub == peerNpub) ? r : try wrapOne(selfNpub)
        let wrapJSON = try JSONSerialization.data(withJSONObject: ["r": r, "s": s])
        let wrappedKey = wrapJSON.base64EncodedString()

        // 3. Upload (neutral name, real name never leaves the device)
        let rnd = (0..<4).map { _ in UInt8.random(in: 0...255) }
        let publicName = "f-" + rnd.map { String(format: "%02x", $0) }.joined() + ".bin"
        let ctSHA = Self.sha256Hex(ct)

        var comps = URLComponents(string: RelayConfig.defaultBaseURL + "/api/upload")!
        comps.queryItems = [
            .init(name: "sha256", value: ctSHA),
            .init(name: "mime", value: mime),
            .init(name: "name", value: publicName),
            .init(name: "size", value: String(ct.count)),
            .init(name: "wrapped_key", value: wrappedKey),
        ]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = max(60, Double(ct.count) / 51200 * 2)
        req.httpBody = ct

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AttachmentError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw AttachmentError.uploadFailed(http.statusCode,
                String(data: data, encoding: .utf8) ?? "")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blobID = obj["blob_id"] as? String else { throw AttachmentError.badResponse }

        return Prepared(
            blobID: blobID,
            sha256: (obj["sha256"] as? String) ?? ctSHA,
            mime: mime,
            size: ct.count,
            publicName: publicName,
            fileName: fileName,
            blobToken: obj["blob_token"] as? String,
            wrappedKey: wrappedKey,
            ivB64: iv.base64EncodedString()
        )
    }

    /// Download + decrypt a blob (recipient path: picks `r` from the wrap).
    /// Returns (plaintext, mime).
    static func downloadAndDecrypt(att: [String: Any], selfKey: Bool) async throws -> (Data, String) {
        guard let blobID = att["blob_id"] as? String,
              let wrapped = att["wrapped_key"] as? String,
              let ivB64 = att["iv"] as? String,
              let iv = Data(base64Encoded: ivB64) else {
            throw RelayError.make("attachment meta incomplete")
        }
        var comps = URLComponents(string: RelayConfig.defaultBaseURL + "/api/blob/" + blobID)!
        if let token = att["blob_token"] as? String {
            comps.queryItems = [.init(name: "t", value: token)]
        }
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 120
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RelayError.make("blob download failed")
        }
        // Unwrap: {r, s} or legacy single sealed (pwa eciesUnwrapKey parity)
        let pick = Self.unwrapTarget(wrapped, selfKey: selfKey)
        let identity = try IdentityStore.shared.requireIdentity()
        guard let sealed = Data(base64Encoded: pick) else {
            throw RelayError.make("bad wrapped_key")
        }
        let keyBytes = try identity.eciesDecrypt(sealed: sealed)
        // WebCrypto layout ct||tag
        let box = try AES.GCM.SealedBox(combined: data)
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: keyBytes))
        let mime = (att["mime"] as? String) ?? "application/octet-stream"
        return (plain, mime)
    }

    /// pwa eciesUnwrapKey parity: {r,s} JSON → pick r (incoming) or s (outgoing).
    static func unwrapTarget(_ wrappedB64: String, selfKey: Bool) -> String {
        guard let bin = Data(base64Encoded: wrappedB64),
              let json = try? JSONSerialization.jsonObject(with: bin) as? [String: String] else {
            return wrappedB64 // legacy single sealed
        }
        return selfKey ? (json["s"] ?? json["r"] ?? wrappedB64)
                       : (json["r"] ?? json["s"] ?? wrappedB64)
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func randomBytes(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }
}
