// End-to-end harness for the REAL shipping backup code on Linux.
//
// It compiles the production files as-is:
//   ios/MurmurApp/BackupManager.swift    (CryptoKit AES-GCM + PBKDF2)
//   ios/MurmurApp/BackupPayloadCodec.swift (pure decoding)
// plus two Linux-only shims (CryptoKit -> swift-crypto, CommonCrypto -> OpenSSL)
// and two tiny stubs for app-only symbols (RelayError, AppState-free parts).
//
// Then it runs the FULL path on a real PWA backup file:
//   file -> decrypt (PBKDF2+AES-GCM) -> decode payload -> compare with the
//   independent node reference; and back: export -> decrypt -> compare.
//
// Usage (from tools/): run via tools/run-backup-e2e.sh
import Foundation
import CryptoKit

// --- app-only symbol stubs ---
// NOTE: `RelayError` is NOT stubbed here — it lives in the shipping
// `ios/MurmurApp/Models.swift`, which is compiled verbatim into this target.
// Declaring it twice made the type lookup ambiguous.

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: e2e <backup.murmur> <password> [reference.json]")
    exit(2)
}
let path = args[1]
let password = args[2]
let referencePath = args.count > 3 ? args[3] : ""

func fail(_ msg: String) -> Never {
    print("FAIL: \(msg)")
    exit(1)
}

let raw = FileManager.default.contents(atPath: path)
guard let raw else { fail("cannot read \(path)") }
print("file bytes: \(raw.count)")

// --- FULL production path: decrypt + decode ---
let t0 = Date()
do {
    let payload = try BackupManager.decodeBackup(data: raw, password: password)
    let dt = Date().timeIntervalSince(t0)
    print(String(format: "decrypt+decode OK in %.2fs", dt))
    print("  skHex len=\(payload.skHex.count) prefix=\(String(payload.skHex.prefix(20)))")
    print("  npub=\(String(payload.npub.prefix(24)))…")
    print("  name=\(String(payload.name.prefix(40)))")
    print("  contactNames=\(payload.contactNames.count)")
    print("  unread peers=\(payload.unread.count)")
    print("  peers=\(payload.chats.count)")
    var total = 0, out = 0, inn = 0, sys = 0, calls = 0, atts = 0
    for (_, msgs) in payload.chats {
        total += msgs.count
        for m in msgs {
            switch m.direction {
            case "out": out += 1
            case "system": sys += 1
            default: inn += 1
            }
            if m.callEvent { calls += 1 }
            if !m.attachments.isEmpty { atts += 1 }
        }
    }
    print("  total msgs=\(total) in=\(inn) out=\(out) system=\(sys) callEvents=\(calls) withAttachments=\(atts)")

    // --- comparison with the independent node reference ---
    if !referencePath.isEmpty, FileManager.default.fileExists(atPath: referencePath) {
        let ref = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: referencePath))) as! [String: Any]
        let refChats = ref["chats"] as? [String: Any] ?? [:]
        let refTotal = refChats.values.reduce(0) { acc, v in acc + ((v as? [Any])?.count ?? 0) }
        let refSk = (ref["ls"] as? [String: Any])?["murmur.sk"] as? String ?? ""
        let refContacts = ((ref["ls"] as? [String: Any])?["murmur.contact_names"] as? [String: Any])?.count ?? 0
        let refCalls = refChats.values.reduce(0) { acc, v in
            acc + ((v as? [Any])?.compactMap { ($0 as? [String: Any])?["callEvent"] as? Bool }.filter { $0 }.count ?? 0)
        }
        print("--- comparison with node reference ---")
        print("  msgs: ref=\(refTotal) swift=\(total) -> \(refTotal == total ? "MATCH" : "MISMATCH")")
        print("  peers: ref=\(refChats.count) swift=\(payload.chats.count) -> \(refChats.count == payload.chats.count ? "MATCH" : "MISMATCH")")
        print("  contacts: ref=\(refContacts) swift=\(payload.contactNames.count) -> \(refContacts == payload.contactNames.count ? "MATCH" : "MISMATCH")")
        print("  callEvents: ref=\(refCalls) swift=\(calls) -> \(refCalls == calls ? "MATCH" : "MISMATCH")")
        print("  sk: -> \(refSk == payload.skHex ? "MATCH" : "MISMATCH")")
        if refTotal != total || refSk != payload.skHex || refCalls != calls {
            fail("reference mismatch")
        }
        print("ALL MATCH")
    }

    // --- round trip: export what we just restored, decrypt it again ---
    print("--- round trip (export -> decrypt -> decode) ---")
    let exportChats = payload.chats.mapValues { msgs in
        msgs.map { m in
            BackupManager.ExportMessage(
                id: m.id, body: m.body, ts: m.ts, direction: m.direction, hash: m.hash,
                attachments: m.attachments, callEvent: m.callEvent,
                callStatus: m.callStatus, callDirection: m.callDirection,
                callDuration: m.callDuration)
        }
    }
    let contactJSON = (try? JSONSerialization.data(withJSONObject: payload.contactNames)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    // The PWA's `murmur_maxts_v1` map: peer -> newest ts already shown.
    var maxTs: [String: Int] = [:]
    for (peer, msgs) in payload.chats {
        if let newest = msgs.map(\.ts).max() { maxTs[peer] = newest }
    }
    let exported = try BackupManager.exportBackup(
        skHex: payload.skHex, npub: payload.npub, name: payload.name, password: password,
        contactNamesJSON: contactJSON, chats: exportChats, unread: payload.unread, maxTs: maxTs)
    print("  exported bytes: \(exported.count)")
    // Save the exported file so the PWA-compat checker (node) can verify the
    // iOS→PWA direction against the PWA's own decrypt/restore rules.
    if let outPath = ProcessInfo.processInfo.environment["E2E_EXPORT_OUT"], !outPath.isEmpty {
        try exported.write(to: URL(fileURLWithPath: outPath))
        print("  exported file written to \(outPath)")
    }
    let round2 = try BackupManager.decodeBackup(data: exported, password: password)
    let msgs2 = round2.chats.values.reduce(0) { $0 + $1.count }
    print("  round-trip peers: \(round2.chats.count) msgs: \(msgs2)")
    if round2.chats.count != payload.chats.count || msgs2 != total {
        fail("round trip lost data: peers \(payload.chats.count)->\(round2.chats.count) msgs \(total)->\(msgs2)")
    }
    if round2.skHex != payload.skHex { fail("round trip changed the identity") }
    if round2.contactNames.count != payload.contactNames.count { fail("round trip lost contact names") }
    print("ROUND TRIP OK")

    // --- wrong password must fail ---
    do {
        _ = try BackupManager.decodeBackup(data: raw, password: "definitely-wrong-password")
        fail("wrong password was accepted!")
    } catch {
        print("--- wrong password correctly rejected ---")
        print("  error: \(error.localizedDescription)")
    }
    print("OK")
} catch {
    fail("production path threw: \(error)")
}
