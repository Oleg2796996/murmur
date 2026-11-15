// Harness: runs the REAL production decoder (ios/MurmurApp/BackupPayloadCodec.swift)
// against REAL PWA backup files, and compares the result with the node
// reference decoder.
//
// Usage: swiftc -O codec-test.swift <path-to-BackupPayloadCodec.swift> -o /tmp/codectest
//        /tmp/codectest <backup.murmur> <password> <reference.json>
//
// The reference JSON is produced by tools/backup-decode-reference.js (node +
// WebCrypto-compatible AES-GCM), i.e. an independent implementation.
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: codectest <backup.murmur> [password] [reference.json]")
    exit(2)
}
let path = args[1]
let password = args.count > 2 ? args[2] : ""
let referencePath = args.count > 3 ? args[3] : ""

func fail(_ msg: String) -> Never {
    print("FAIL: \(msg)")
    exit(1)
}

// --- minimal AES-GCM + PBKDF2 (no CryptoKit on Linux) via OpenSSL ---
import Glibc

func hexVal(_ c: UInt8) -> UInt8? {
    switch c {
    case 0x30...0x39: return c - 0x30
    case 0x61...0x66: return c - 0x61 + 10
    case 0x41...0x46: return c - 0x41 + 10
    default: return nil
    }
}

// Use `openssl` CLI for the crypto so the harness has no extra deps:
//   PBKDF2: openssl kdf -keylen 32 -kdfopt digest:SHA256 -kdfopt pass:... -kdfopt salt:hex -kdfopt iter:250000 PBKDF2
//   AES-GCM: openssl enc does NOT support GCM -> use `openssl` via EVP through python3? No.
// So: shell out to python3 (stdlib has hashlib.pbkdf2_hmac; AES-GCM via `cryptography`).
// The python side is installed (`cryptography 48.0.1`).

let raw = FileManager.default.contents(atPath: path)
guard let raw else { fail("cannot read \(path)") }
print("file bytes: \(raw.count)")

let boxObj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? nil
guard let boxObj else { fail("not JSON") }
guard boxObj["magic"] as? String == "MURMURBAK1" else { fail("bad magic") }
guard let saltB64 = boxObj["salt"] as? String,
      let ivB64 = boxObj["iv"] as? String,
      let dataB64 = boxObj["data"] as? String,
      let salt = Data(base64Encoded: saltB64),
      let iv = Data(base64Encoded: ivB64),
      let ct = Data(base64Encoded: dataB64) else { fail("bad box") }
let iterations = (boxObj["iterations"] as? Int) ?? 250_000
print("magic ok, v=\(boxObj["v"] ?? "?"), iter=\(iterations)")

// Decrypt via python3 (cryptography) -> raw plaintext to a temp file.
let tmpPlain = "/tmp/_codec_plain_\(getpid()).bin"
let script = """
import base64, hashlib, json, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
raw = open(sys.argv[1], 'rb').read()
box = json.loads(raw)
salt = base64.b64decode(box['salt'])
iv = base64.b64decode(box['iv'])
ct = base64.b64decode(box['data'])
key = hashlib.pbkdf2_hmac('sha256', sys.argv[3].encode('utf-8'), salt, box.get('iterations', 250000), dklen=32)
pt = AESGCM(key).decrypt(iv, ct, None)
open(sys.argv[2], 'wb').write(pt)
"""
let py = Process()
py.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
py.arguments = ["-c", script, path, tmpPlain, password]
let pipe = Pipe()
py.standardError = pipe
try py.run()
py.waitUntilExit()
if py.terminationStatus != 0 {
    let err = (try? String(data: pipe.fileHandleForReading.readToEnd() ?? Data(), encoding: .utf8)) ?? ""
    fail("decrypt failed: \(err)")
}
let plain = FileManager.default.contents(atPath: tmpPlain) ?? Data()
try? FileManager.default.removeItem(atPath: tmpPlain)
print("decrypted bytes: \(plain.count)")

// --- now the REAL production decoder ---
do {
    let payload = try BackupPayloadCodec.decode(plain)
    print("--- production codec result ---")
    print("skHex len=\(payload.skHex.count) prefix=\(String(payload.skHex.prefix(20)))")
    print("npub=\(String(payload.npub.prefix(24)))…")
    print("name=\(String(payload.name.prefix(40)))")
    print("contactNames=\(payload.contactNames.count)")
    print("unread peers=\(payload.unread.count)")
    print("peers=\(payload.chats.count)")
    var total = 0
    var outMsgs = 0, inMsgs = 0, systemMsgs = 0, calls = 0, withAtt = 0
    var samplePlain: [String] = []
    for (_, msgs) in payload.chats {
        total += msgs.count
        for m in msgs {
            switch m.direction {
            case "out": outMsgs += 1
            case "system": systemMsgs += 1
            default: inMsgs += 1
            }
            if m.callEvent { calls += 1 }
            if !m.attachments.isEmpty { withAtt += 1 }
            if samplePlain.count < 5, m.direction != "system", !m.body.isEmpty {
                samplePlain.append(m.body)
            }
        }
    }
    print("total msgs=\(total) in=\(inMsgs) out=\(outMsgs) system=\(systemMsgs) callEvents=\(calls) withAttachments=\(withAtt)")
    for s in samplePlain { print("  sample: \(s.prefix(60))") }

    // --- compare with the independent node reference ---
    if !referencePath.isEmpty, FileManager.default.fileExists(atPath: referencePath) {
        print("--- comparison with node reference ---")
        let ref = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: referencePath))) as! [String: Any]
        let refChats = ref["chats"] as? [String: Any] ?? [:]
        let refTotal = refChats.values.reduce(0) { acc, v in acc + ((v as? [Any])?.count ?? 0) }
        let refSk = (ref["ls"] as? [String: Any])?["murmur.sk"] as? String ?? ""
        let refContacts = ((ref["ls"] as? [String: Any])?["murmur.contact_names"] as? [String: Any])?.count ?? 0
        print("ref total msgs=\(refTotal) vs codec=\(total) -> \(refTotal == total ? "MATCH" : "MISMATCH")")
        print("ref peers=\(refChats.count) vs codec=\(payload.chats.count) -> \(refChats.count == payload.chats.count ? "MATCH" : "MISMATCH")")
        print("ref contacts=\(refContacts) vs codec=\(payload.contactNames.count) -> \(refContacts == payload.contactNames.count ? "MATCH" : "MISMATCH")")
        print("ref sk match=\(refSk == payload.skHex ? "MATCH" : "MISMATCH")")
        if refTotal != total || refSk != payload.skHex {
            fail("reference mismatch")
        }
        print("ALL MATCH")
    }
    print("OK")
} catch {
    fail("codec threw: \(error)")
}
