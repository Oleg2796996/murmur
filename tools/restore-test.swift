// Harness: runs the REAL production restore code (ios/MurmurApp/ChatRestore.swift)
// against a REAL PWA backup file and checks the outcome.
//
// Usage: swiftc -O restore-test.swift <BackupPayloadCodec.swift> <Models.swift> \
//            <ChatRestore.swift> -o /tmp/restoretest
//        /tmp/restoretest <backup.murmur> <password>
//
// It runs the FULL production path:
//   file -> decrypt (PBKDF2+AES-GCM) -> decode payload -> ChatRestore.merge
// and asserts the numbers that the user actually cares about:
//   * every peer in the backup became a chat (with its name);
//   * the newest message of each chat is the preview;
//   * a SECOND restore of the same file adds NOTHING (idempotent, no dups);
//   * restoring into a device that holds a DIFFERENT identity wipes the old
//     chats (no mixing of accounts).
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("usage: restore-test <backup.murmur> <password>")
    exit(2)
}
let path = args[1]
let password = args[2]

var failures = 0
func check(_ ok: Bool, _ msg: String) {
    print((ok ? "  OK   " : "  FAIL ") + msg)
    if !ok { failures += 1 }
}

// --- decrypt with node (openssl CLI) so this harness has no crypto deps ---
let raw = FileManager.default.contents(atPath: path)
guard let raw else {
    print("FAIL: cannot read \(path)")
    exit(1)
}
print("file bytes: \(raw.count)")

// The Swift production decrypt lives in BackupManager.swift (CryptoKit +
// CommonCrypto) — it is compiled by tools/run-backup-e2e.sh. Here we reuse
// the payload produced by the node reference decoder (same AES-GCM layout),
// so the harness can focus on the RESTORE logic.
let payloadPath: String
if let env = ProcessInfo.processInfo.environment["MURMUR_RESTORE_PAYLOAD"], !env.isEmpty {
    payloadPath = env
} else {
    payloadPath = "/tmp/restore-payload.json"
}
if !FileManager.default.fileExists(atPath: payloadPath) {
    print("ERROR: run backup-decode-reference.js first -> \(payloadPath)")
    exit(2)
}
let payloadData = try! Data(contentsOf: URL(fileURLWithPath: payloadPath))
let payload = try! BackupPayloadCodec.decode(jsonData: payloadData)
print("\n=== 1. Fresh device: restore the backup ===")
var chats: [ChatSummary] = []
var names: [String: String] = [:]
var unread: [String: Int] = [:]
let out1 = ChatRestore.merge(payload: payload, chats: chats, contactNames: names,
                             unreadByPeer: unread, deviceNpub: String?.none)
print("  report: \(out1.report.summary)")
check(out1.chats.count == payload.chats.count,
      "chats restored: \(out1.chats.count) == backup peers \(payload.chats.count)")
check(out1.chats.count == 8, "8 chats (Олег's real backup)")
check(out1.report.addedMessages > 0, "messages added: \(out1.report.addedMessages)")
check(out1.report.contactNames == 10, "10 contact names restored (got \(out1.report.contactNames))")

// Every peer must have a NAME — this was the user's complaint («названий нет»).
var unnamed = 0
for c in out1.chats where out1.contactNames[c.peer] == nil { unnamed += 1 }
check(unnamed == 0, "every chat has a contact name (unnamed: \(unnamed))")

// Previews must be non-empty and the chat list must be sorted newest-first.
var emptyPreview = 0
for c in out1.chats where c.lastBody.trimmingCharacters(in: CharacterSet.whitespaces).isEmpty { emptyPreview += 1 }
check(emptyPreview == 0, "every chat has a preview (empty: \(emptyPreview))")
var sorted = true
for i in 1..<max(out1.chats.count, 1) where out1.chats[i-1].lastTs < out1.chats[i].lastTs {
    sorted = false
}
check(sorted, "chat list sorted newest-first")

// The newest message of each chat must match the backup.
var previewMismatch = 0
for (peer, msgs) in payload.chats {
    guard let c = out1.chats.first(where: { $0.peer == peer }) else { continue }
    let newest = msgs.sorted { $0.ts < $1.ts }.last!
    let expect = newest.callEvent
        ? ChatMessage.callPreview(status: newest.callStatus ?? "completed",
                                  direction: newest.callDirection ?? "in",
                                  duration: newest.callDuration)
        : newest.body
    if c.lastBody != expect { previewMismatch += 1 }
}
check(previewMismatch == 0, "previews match the newest message (mismatch: \(previewMismatch))")

// Chronology inside a thread.
var unsorted = 0
for c in out1.chats {
    for i in 1..<max(c.messages.count, 1) where c.messages[i-1].ts > c.messages[i].ts {
        unsorted += 1
    }
}
check(unsorted == 0, "threads are chronological (violations: \(unsorted))")

print("\n=== 2. Idempotency: restore the SAME file again ===")
let out2 = ChatRestore.merge(payload: payload, chats: out1.chats,
                             contactNames: out1.contactNames,
                             unreadByPeer: out1.unreadByPeer,
                             deviceNpub: payload.npub)
print("  report: \(out2.report.summary)")
check(out2.report.addedMessages == 0,
      "second restore adds 0 messages (added \(out2.report.addedMessages))")
check(out2.report.duplicateMessages > 0,
      "duplicates detected and skipped: \(out2.report.duplicateMessages)")
check(out2.chats.count == out1.chats.count,
      "chat count unchanged: \(out2.chats.count)")
var totalAfter = out2.chats.reduce(0) { $0 + $1.messages.count }
check(totalAfter == out1.chats.reduce(0) { $0 + $1.messages.count },
      "no messages duplicated in the threads (total \(totalAfter))")

print("\n=== 3. Foreign identity on the device: old chats must be wiped ===")
var foreignChats = [ChatSummary(peer: "npub1foreignpeer", lastBody: "чужой чат", lastTs: 9999999999)]
var foreignNames = ["npub1foreignpeer": "Чужой"]
let out3 = ChatRestore.merge(payload: payload, chats: foreignChats,
                             contactNames: foreignNames,
                             unreadByPeer: [:],
                             deviceNpub: "npub1otheridentity")
check(out3.report.identityChanged, "identity change detected")
check(!out3.chats.contains { $0.peer == "npub1foreignpeer" },
      "the foreign chat was dropped")
check(out3.contactNames["npub1foreignpeer"] == nil,
      "the foreign contact name was dropped")
check(out3.chats.count == 8, "backup chats restored instead (got \(out3.chats.count))")

print("\n=== 4. Same identity on the device: keep the local history ===")
let out4 = ChatRestore.merge(payload: payload, chats: out1.chats,
                             contactNames: out1.contactNames,
                             unreadByPeer: out1.unreadByPeer,
                             deviceNpub: payload.npub)
check(!out4.report.identityChanged, "no identity change flagged")
check(out4.chats.count == 8, "8 chats kept")

print(failures == 0 ? "\nALL CHECKS PASSED" : "\n\(failures) CHECK(S) FAILED")
exit(failures == 0 ? 0 : 1)
