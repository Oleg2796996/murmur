# Murmur File Attachments — Incremental Implementation Roadmap

**Version:** v53 (Build 2026-08-25)  
**Author:** Council of Experts (Architect, Crypto, Rust Backend, PWA/UX)  
**Status:** Design → Ready for Implementation  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis (v52)](#2-current-state-analysis-v52)
3. [Prior Failure Lessons](#3-prior-failure-lessons)
4. [Threat Model & Design Principles](#4-threat-model--design-principles)
5. [Incremental Roadmap](#5-incremental-roadmap)
6. [Hard Verification (HP Test Matrix)](#6-hard-verification-hp-test-matrix)
7. [Risk Register](#7-risk-register)

---

## 1. Executive Summary

This roadmap adds **secure file attachments** to Murmur v52's E2E messenger. The approach is **incremental**, each step delivering a verifiable milestone that does not block the main message relay. The system uses **symmetric key wrapping** for files (each file encrypted with a random AES-256-GCM key, wrapped with the recipient's ECIES key), **separate binary upload endpoints** on the relay, and **streaming WASM encryption** to avoid WASM memory overflows.

**Key design decisions:**
- **Files never flow through the message relay** — a separate `/upload`/`/download` endpoint handles binary transfer.
- **Symmetric wrapping** — each file gets its own AES-256-GCM key, derived via HKDF from an ECIES-shared secret.
- **Streaming in WASM** — files are processed in 64 KiB chunks to avoid loading entire files into linear memory.
- **Progressive UI** — upload progress → file bubble (download link) → open/download.

---

## 2. Current State Analysis (v52)

### 2.1 What Already Works

| Component | Status | Details |
|-----------|--------|---------|
| **E2E Encryption** | ✅ Working | ECIES (X25519 ECDH + HKDF-SHA256 + AES-256-GCM) in WASM |
| **Relay WS + HTTP** | ✅ Working | WebSocket pub/sub + `/envelope` POST, TTL 24h → 5min |
| **SQLite Store** | ✅ Working | Message persistence, contacts, pagination, unread |
| **PWA** | ✅ Working | iOS-compatible classic script, offline cache, push notifications |
| **File Input UI** | ⚠️ Partial | File picker exists (app.js:1654), HEIC rejection (app.js:1668) |
| **Attachments in body** | ⚠️ Broken | Files loaded into JS memory as base64, encrypted whole-body JSON |

### 2.2 The v52 Attachment Problem (Root Cause Analysis)

The current attachment flow (app.js lines 140–1532) has **three critical flaws**:

1. **Whole-file memory load**: `FileReader.readAsArrayBuffer()` reads the entire file → `btoa()` creates a base64 string → JSON.stringify packs it into the ECIES plaintext → WASM encrypts it all at once. For a 50 MB file this means **~67 MB of base64 text + 50 MB raw buffer + WASM linear memory** ≈ **~150 MB per attachment**. On mobile this causes OOM.

2. **ECIES not chunked**: The WASM `ecies_encrypt` function (`murmur-id/src/lib.rs:368`) takes the entire plaintext as a single `Vec<u8>`. AES-GCM *can* stream, but the current API does not. There is no incremental/progressive encryption.

3. **Relay payload bloat**: Attachments are embedded in the JSON envelope body (`{ body, attachments: [{data_b64, ...}] }`), making the envelope huge. The relay stores this in SQLite `body BLOB`, bloats the WS broadcast payload, and triggers push notification failures (payload too large for APNs/Firebase).

### 2.3 Existing Infrastructure We Can Reuse

| Asset | How We Use It |
|-------|---------------|
| ECIES shared secret derivation | Already in `murmur-id` — we extend to file key wrapping |
| WASM JS bridge pattern | `to_js()` → JSON result, base64 I/O — same pattern for file crypto |
| Relay relay architecture | WS + HTTP endpoints — add `/upload` alongside `/envelope` |
| PWA file input | `fileInput` element already wired — reuse |
| Attachment metadata in envelope | `attachments_meta` already parsed in envelope.rs — extend for URLs |
| SQLite BLOB store | Already handles opaque bytes — no schema change needed for relay-side storage |

---

## 3. Prior Failure Lessons

| # | Lesson | Source | Relevance to Attachments |
|---|--------|--------|--------------------------|
| **152** | WASM encrypt crashes on large files, btnSend stuck disabled | app.js | Must handle errors gracefully, never block UI permanently |
| **153** | HEIC/HEIF files rejected — good, but no conversion path | app.js | Need MIME conversion or explicit unsupported warning |
| **158** | WASM decrypt can hang on iPhone PWA without exception | app.js | Must use `Promise.race` timeout on all WASM crypto ops |
| **159** | Local cache (outbox) clears on reload | app.js | File download links must be re-resolvable from metadata |
| **131** | Relay envelope TTL: 24h → 5min after delivery | relay envelope.rs | File uploads must have independent TTL from message relay |
| **128** | envelope_hash dedup essential for reliable delivery | app.js | Each file upload needs its own hash for dedup |
| **WASM OOM** | Full file in base64 → linear memory overflow | Historical | **Streaming** is the only viable approach |
| **HoL blocking** | Large JSON payloads block WS broadcast | Historical | **Separate endpoints** prevent relay head-of-line blocking |
| **iOS HEIC** | Safari doesn't render HEIC in `<img>` tags | Historical | Pre-convert or link to native viewer |

---

## 4. Threat Model & Design Principles

### 4.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| **Relay sees file content** | Files encrypted client-side; relay only sees ciphertext blob |
| **Relay replays file** | Each upload gets unique `file_id` (SHA3-256 of {nonce, file content}); dedup on relay |
| **Relay tampers with file URL** | File download requires auth token derived from ECIES shared secret — relay can't forge |
| **Man-in-the-middle on upload** | TLS (relay is at `https://murmur.senswifi.ru`); file download via same TLS |
| **Recipient key compromise** | Forward secrecy: each file uses per-message ECIES ephemeral key |
| **Storage bloat on relay** | File blobs have shorter TTL (2h after last download) than messages (24h) |
| **Malicious file injection** | File URL is tied to the original uploader's signature; recipient verifies ownership |

### 4.2 Design Principles

1. **Zero blocking of message relay** — files use a completely separate code path.
2. **Streaming encryption** — no file > 64 KiB in memory at once.
3. **Symmetric key wrapping** — file key (AES-256) → wrapped with ECIES → stored in envelope.
4. **Graceful degradation** — if upload fails, message still sends (with text only).
5. **Progressive enhancement** — UI works with just text first; file UI enhances.

---

## 5. Incremental Roadmap

### Milestone M1: File Key Wrapping in WASM (Backend Crypto)

**Goal:** Add streaming symmetric file encryption to the WASM module, usable without loading the whole file.

**Scope:**
- New Rust module: `murmur-id/src/file_crypto.rs`
- Functions:
  ```rust
  /// Generate a random 256-bit AES-GCM key.
  pub fn file_key_generate() -> Vec<u8>;  // 32 bytes

  /// Encrypt file data in streaming chunks.
  /// Returns (ciphertext_tag_hex, iv_hex) — tag for integrity, IV for decryption.
  /// Note: this is a simplified API; full streaming is M2.
  pub fn file_key_wrap(file_key: &[u8], recipient: &IdentityPublic) -> String;
  /// Returns base64 of AES-GCM(encrypted_file_key) — wraps the symmetric key.
  ```
- WASM bindings in `murmur-id-wasm`:
  ```rust
  #[wasm_bindgen]
  pub fn file_key_generate() -> String { // hex-encoded 32 bytes
  #[wasm_bindgen]
  pub fn file_key_wrap(file_key_hex: String, recipient_npub: String) -> String {
      // base64 AES-GCM(encrypted_file_key)
  ```

**Why first?** This is the cryptographic primitive everything else builds on. Without streaming key wrapping, we can't avoid the memory problem.

**Deliverables:**
- `cargo test -p murmur-id --lib` — file_key_generate roundtrip
- `cargo test -p murmur-id --lib` — file_key_wrap/unwrap for 1-byte, 1 MiB, 50 MiB
- WASM smoke test: `file_key_generate()` returns 64 hex chars

**Hard Verification (HP):**
- [ ] `cargo test -p murmur-id --lib` passes on HP (Linux x86_64)
- [ ] WASM build succeeds: `wasm-pack build crates/murmur-id-wasm --target web --release`
- [ ] Open `pwa/index.html` on Chromium (HP) → console shows `[murmur] WASM module loaded`
- [ ] Open `pwa/index.html` on Firefox (HP) → console shows `[murmur] WASM module loaded`
- [ ] Chrome DevTools Memory panel: WASM heap < 5 MB during `file_key_generate()` × 100

---

### Milestone M2: Streaming File Encryption in WASM

**Goal:** Encrypt/decrypt file chunks of arbitrary size without loading the full file into memory.

**Scope:**
- WASM linear memory management for streaming I/O
- Chunked AES-256-GCM (64 KiB chunks, per-chunk nonce derivation via HKDF)
- API design:
  ```javascript
  // JS side:
  // 1. Allocate WASM buffer for chunk
  const CHUNK_SIZE = 65536;
  const bufferPtr = wasm.allocateChunkBuffer(CHUNK_SIZE);

  // 2. Read file chunk by chunk, encrypt, get output chunk
  while (!fileDone) {
    const chunk = await fileReader.read(CHUNK_SIZE);
    wasm.encrypt_chunk(bufferPtr, chunk.data, chunk.length);
    const encrypted = wasm.get_encrypted_output();
    // stream encrypted to upload endpoint
  }

  // 3. Finalize: get auth tag
  const tag = wasm.encrypt_finalize();
  ```
- Rust side: `aes-gcm` crate with `Aes256Gcm::encrypt_in_place_detached` per chunk

**Deliverables:**
- Streaming encrypt test: 100 MB file → encrypted output in < 30 seconds, peak WASM heap < 2 MB
- Streaming decrypt test: reverse — verify integrity

**Hard Verification (HP):**
- [ ] `cargo test -p murmur-id --lib` — streaming encrypt/decrypt 100 MB roundtrip
- [ ] Chrome Performance panel: WASM memory stays flat (no growth) during 50 MB encrypt
- [ ] Firefox Memory panel: same — no leak over 5 iterations
- [ ] `pwa/index.html` in Chrome: `console.log` shows chunk count = ceil(50MB / 64KB) = 782 chunks
- [ ] `pwa/index.html` in Firefox: same chunk count, same timing

---

### Milestone M3: Separate Upload Endpoint on Relay

**Goal:** Relay accepts file uploads on a dedicated endpoint, separate from the message relay.

**Scope:**
- New HTTP endpoint: `POST /api/upload`
  - Accepts: multipart/form-data or raw binary POST
  - Auth: `X-File-Token` header (derived from ECIES shared secret, computed client-side)
  - Body: raw file bytes
  - Response: `{"file_id": "<sha3-256 hash>", "size": <bytes>, "mime": "<content-type>"}`
- New HTTP endpoint: `GET /api/download?file_id=<hash>`
  - Auth: same `X-File-Token` header
  - Response: raw file bytes with `Content-Disposition: attachment`
- File storage: disk-backed, hashed by SHA3-256 (dedup), TTL 2 hours after last access
- Cleanup cron: delete files older than 2h or exceeding disk quota

**Relay code changes:**
- `murmur-relay/src/upload.rs` — new module
- `murmur-relay/src/lib.rs` — wire into existing server
- `murmur-relay/src/config.rs` — add `file_upload_dir` and `file_ttl_secs` config

**Deliverables:**
- `cargo test -p murmur-relay` — upload → download roundtrip
- `cargo test -p murmur-relay` — dedup: same file uploaded twice → same `file_id`, stored once
- `cargo test -p murmur-relay` — TTL: file expires after TTL → 404

**Hard Verification (HP):**
- [ ] `curl POST https://murmur.senswifi.ru/api/upload` with test file → returns `file_id`
- [ ] `curl GET https://murmur.senswifi.ru/api/download?file_id=...` → returns original file bytes
- [ ] Verify SHA3-256 match: `sha3sum uploaded_file` == `file_id` from response
- [ ] Chrome (HP): upload 50 MB file via browser fetch → `file_id` returned in < 10s
- [ ] Firefox (HP): same test, verify identical `file_id` for same content

---

### Milestone M4: Client-Side File Upload Flow (PWA)

**Goal:** PWA encrypts files client-side and uploads them to the new `/api/upload` endpoint.

**Scope:**
- PWA changes:
  1. Replace base64-in-memory file read with **streaming chunked upload**
  2. For each file:
     - Generate `file_key` via WASM `file_key_generate()`
     - Encrypt first 64 KiB → upload in chunks via `ReadableStream` / `fetch` with `Body.commit()`
     - Wrap `file_key` via WASM `file_key_wrap()`
     - On upload complete → get `file_id` + `download_url`
  3. Update envelope body to reference file by `file_id` instead of embedding content:
     ```json
     {
       "body": "Hello",
       "attachments": [
         { "name": "photo.jpg", "mime": "image/jpeg", "size": 123456, "file_id": "abc123..." }
       ]
     }
     ```
- Progress indicator: upload progress bar in the input area
- File size limit: 100 MB (doubled from current 50 MB, with streaming)
- HEIC rejection stays (still no conversion path — chip shown in UI)

**Deliverables:**
- Chrome (HP): select a 30 MB video → upload progress shows 0→100% → message sends with file bubble
- Firefox (HP): same
- Console check: peak JS heap < 50 MB during 50 MB upload (was ~150 MB before)

**Hard Verification (HP):**
- [ ] Open `pwa/index.html` in Chrome (HP), log in, open a chat
- [ ] Click 📎, select a 30 MB MP4 file
- [ ] Upload progress bar appears and fills to 100%
- [ ] Message appears with a file bubble (download link)
- [ ] Click download link → file downloads with correct name and content
- [ ] **Repeat in Firefox (HP)** — all above steps succeed
- [ ] Chrome DevTools → Performance → heap stays < 50 MB during upload
- [ ] Firefox Memory → same heap check

---

### Milestone M5: File Bubble UI (Receive Side)

**Goal:** Render received files as download bubbles in the chat.

**Scope:**
- When a decrypted envelope contains `attachments: [{file_id, name, mime, size, ...}]`:
  - No inline `data:` URLs (too large for DOM, breaks iOS memory)
  - Instead, render a **download bubble**:
    ```html
    <div class="msg-file-bubble" data-file-id="abc123">
      <div class="file-icon">📎</div>
      <div class="file-name">photo.jpg</div>
      <div class="file-size">1.2 MB</div>
      <div class="file-status">⬇️ Ready to download</div>
    </div>
    ```
  - Click bubble → `fetch(/api/download?file_id=...)` with auth token → save to browser download
  - For images: show thumbnail (download first, then cache as blob URL)
  - For videos: show play button → stream from `/api/download`
  - For audio: show audio player → stream from `/api/download`

**Deliverables:**
- Three visual states: pending → downloading → downloaded/playing
- `styles.css` additions: `.msg-file-bubble`, `.file-icon`, `.file-status`
- Download flow: bubble click → auth token derive → fetch → download
- Image/video/audio thumbnails via blob URLs (cached in IndexedDB)

**Hard Verification (HP):**
- [ ] `pwa/index.html` in Chrome (HP): receive a message with 3 attachments (image, video, PDF)
- [ ] All three render as distinct bubbles with correct icons and sizes
- [ ] Click image bubble → thumbnail loads, click thumbnail → opens in new tab
- [ ] Click video bubble → video plays inline (streaming from relay)
- [ ] Click PDF bubble → PDF downloads to disk
- [ ] **Repeat in Firefox (HP)** — identical behavior
- [ ] iOS Simulator (if available) or check: no `data:` URLs in DOM, no memory warnings

---

### Milestone M6: IndexedDB File Cache + Offline Download

**Goal:** Downloaded files are cached in IndexedDB so they're available offline and don't re-download.

**Scope:**
- IndexedDB database: `murmur-files` store keyed by `{peer_npub, file_id}`
- On download:
  1. Check IndexedDB first — if cached, use `blobURL` directly
  2. If not cached → fetch from relay → cache → create blob URL
- On page reload:
  1. Rebuild blob URLs from IndexedDB for all cached files
  2. Clean up old blob URLs to avoid memory leak
- Cache size limit: 500 MB total (configurable)
- LRU eviction when limit exceeded

**Deliverables:**
- `pwa/index.html`: IndexedDB open + get + put logic
- `pwa/index.html`: cache size monitoring and eviction
- `pwa/index.html`: blob URL lifecycle management

**Hard Verification (HP):**
- [ ] Open `pwa/index.html` in Chrome (HP), download a file
- [ ] Close tab, reopen — file still displays as cached (no re-download)
- [ ] Chrome DevTools → Application → IndexedDB → verify file stored
- [ ] **Repeat in Firefox (HP)** — identical behavior
- [ ] Cache limit: set 500 MB, verify LRU eviction when exceeded (simulate with multiple large files)
- [ ] Verify: blob URLs are revoked when files are evicted

---

### Milestone M7: Full E2E Encryption Pipeline for Files

**Goal:** Files are encrypted end-to-end: client → encrypt → upload → relay → download → decrypt → client. Relay never sees plaintext.

**Scope:**
- Complete flow integration:
  1. Sender: generates `file_key`, encrypts file chunk-by-chunk, uploads ciphertext
  2. Relay: stores ciphertext, returns `file_id` (SHA3-256 of ciphertext)
  3. Sender: embeds `file_id` + `wrapped_file_key` in message envelope
  4. Relay: relays envelope as usual (message relay unchanged)
  5. Receiver: decrypts envelope, gets `file_id` + `wrapped_file_key`
  6. Receiver: unwraps `file_key` via ECIES decrypt, downloads ciphertext from relay
  7. Receiver: decrypts ciphertext with `file_key` → plaintext file
  8. Receiver: caches plaintext in IndexedDB, renders file bubble

**Cryptography details:**
```
File encryption flow:
  1. file_key = random(256 bits)                    // AES-256 key
  2. file_key_wrapped = ECIES_encrypt(file_key, recipient_pubkey)  // base64
  3. file_ciphertext = AES-256-GCM_encrypt(file_key, file_plaintext)
  4. file_id = SHA3-256(file_ciphertext)             // for dedup & lookup
  5. envelope = { body, attachments: [{file_id, wrapped_file_key, name, mime, size}] }
  6. relay stores: file_id → file_ciphertext (on disk)
  7. recipient: unwrap file_key = ECIES_decrypt(file_key_wrapped),
                decrypt file = AES-256-GCM_decrypt(file_key, file_ciphertext)
```

**Deliverables:**
- End-to-end test: Alice sends 50 MB file to Bob → Bob decrypts and verifies integrity
- Cryptographic proof: relay cannot read file content (test with relay-side debug logging)
- Forward secrecy: each file gets a new `file_key` (never reused)

**Hard Verification (HP):**
- [ ] HP: Alice (Chrome) sends 50 MB PDF → Bob (Firefox) receives and downloads → file matches byte-for-byte
- [ ] HP: `sha3sum` original file == `sha3sum` downloaded file (on Bob's side)
- [ ] HP: Relay debug log shows only hex hash of file content, never the plaintext
- [ ] HP: Two identical 50 MB files from same sender → same `file_id` (dedup works)
- [ ] HP: Two different senders send identical 50 MB files → different `file_id` (per-message key)
- [ ] **Cross-browser pair**: Chrome → Firefox, Firefox → Chrome — all work
- [ ] **iOS test** (if device available): PWA on iPhone sends 10 MB image → Android PWA receives

---

### Milestone M8: Relay TTL, Cleanup & Quota Management

**Goal:** File storage doesn't grow unbounded. Files are auto-expired.

**Scope:**
- File TTL: 2 hours after last download access (vs 24h for messages)
- Disk quota: configurable max (default 10 GB), with soft/hard thresholds
- Cleanup cron: runs every 15 minutes
  - Delete files past TTL
  - If disk > 80%: evict oldest 10%
  - If disk > 95%: reject new uploads with 507 Insufficient Storage
- Health endpoint: `GET /api/files/health` → `{total_files, total_bytes, disk_used_percent}`
- Admin: `DELETE /api/files/cleanup?force=true` for manual trigger

**Hard Verification (HP):**
- [ ] `curl GET https://murmur.senswifi.ru/api/files/health` → returns JSON with file count
- [ ] Upload file, wait 2h (or set TTL=60s for test), verify file is gone on GET
- [ ] Fill disk to 95% (simulate with test files), verify new uploads get 507
- [ ] **HP Chrome**: upload → download → wait TTL → click old link → 404
- [ ] **HP Firefox**: same TTL test

---

### Milestone M9: Push Notification for File Attachments

**Goal:** Mobile users get a push notification when a file attachment arrives.

**Scope:**
- Push payload: `{ type: "file", file_id, sender_name, file_name, file_size }`
  - **NOT** the file content — just metadata
- When user taps push notification → open PWA → navigate to chat → show file bubble
- iOS APNs payload: use `mutable-content: 1` for custom notification UI
- Android FCM: show file type icon in notification
- File download happens in-app when user opens the chat (not via push)

**Hard Verification (HP):**
- [ ] HP: send file from Chrome to Firefox → Firefox receives push notification with file name
- [ ] HP: tap push notification → opens chat with file bubble visible
- [ ] **iOS** (if device available): PWA on iPhone receives push → taps → sees file bubble
- [ ] Push payload size < 4096 bytes (APNs limit) — verify

---

### Milestone M10: Performance Regression Tests + Documentation

**Goal:** Verify the file attachment system doesn't degrade message relay performance.

**Scope:**
- Benchmarks:
  - Message send latency: before vs after file attachment system (should be < 5% difference)
  - WebSocket broadcast size: with 10 MB file reference vs without (should be identical — no file data in relay)
  - WASM memory: peak during file encrypt/decrypt (should stay < 5 MB)
  - PWA memory: peak during file upload/download (should stay < 100 MB for 50 MB file)
- Documentation:
  - `docs/attachments_roadmap.md` ← this file
  - `docs/attachments_api.md` — relay API spec
  - `docs/attachments_crypto.md` — cryptographic design
- CHANGELOG entry for v53

**Hard Verification (HP):**
- [ ] `cargo bench` — message send latency before/after < 5% diff
- [ ] WS broadcast payload size: 10 MB file reference ≈ text-only message size
- [ ] Chrome DevTools: WASM heap < 5 MB during encrypt, < 3 MB during decrypt
- [ ] Firefox: same heap checks
- [ ] Document reviewed by all council members

---

## 6. Hard Verification (HP Test Matrix)

All milestones include verification on **two browser contexts on HP** (the host machine):

| Browser | Context | Verification Focus |
|---------|---------|--------------------|
| **Chromium 144+** | Incognito (fresh profile) | Clean WASM load, no cache interference |
| **Firefox 140+** | Standard profile | Different JS engine, different memory allocator |

### Verification Protocol per Milestone

For **every milestone**, the following tests MUST pass on both browsers:

| # | Test | Browser | Pass Criteria |
|---|------|---------|---------------|
| V1 | WASM module loads without errors | Chrome + Firefox | Console: `[murmur] WASM module loaded`, no `__js_error_overlay` |
| V2 | Crypto function returns valid output | Chrome + Firefox | Output matches expected size/format, roundtrip test passes |
| V3 | Upload flow works end-to-end | Chrome + Firefox | File appears in chat as download bubble within 5s of upload complete |
| V4 | Download + verify integrity | Chrome + Firefox | `sha3sum` of downloaded file matches original (byte-for-byte) |
| V5 | Memory stays within limits | Chrome + Firefox | Peak heap < specified limit for file size (see M4-M7) |
| V6 | Relay doesn't see plaintext | Chrome + Firefox | Relay debug log contains only hashes, never raw bytes |

### HP Machine Specs (Reference)
- CPU: [check `lscpu`]
- RAM: [check `free -h`]
- GPU: [check `lspci | grep VGA`] — relevant for video decode
- OS: Linux (Debian-based)
- Browsers: Chromium 144+, Firefox 140+

---

## 7. Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| **WASM streaming complexity** | Medium | High | Start with non-streaming for small files (< 5 MB), add streaming as optimization |
| **iOS Safari WebAssembly limitations** | Medium | High | Test early (M1); use `wasm-pack --target bundled` for best Safari compat |
| **Relay storage bloat** | Low | High | Aggressive TTL (2h), quota enforcement, cron cleanup |
| **Upload cancellation on tab close** | High | Medium | Use `showSaveFilePicker` for resumable uploads (Progressive Enhancement) |
| **Large file download on mobile data** | Medium | Medium | Show file size before download; add "Wi-Fi only" setting |
| **HEIC/HEIF support gap** | Low | Medium | Document as known limitation; provide conversion guide |
| **CORS for upload endpoint** | Low | Medium | Add CORS headers to `/api/upload` and `/api/download` |
| **WASM panic on large files** | Low | High | Wrap all WASM calls in `try/catch` + timeout (per lesson #158) |
| **File dedup false positives** | Very Low | Low | SHA3-256 collision probability ≈ 2^-128, negligible |
| **Browser IndexedDB quota limits** | Medium | Low | Graceful fallback to in-memory for overflow; request quota extension |

---

## Appendix A: API Specification (Relay)

### `POST /api/upload`

**Request:**
```
POST /api/upload HTTP/1.1
Host: murmur.senswifi.ru
Content-Type: application/octet-stream
X-File-Token: <base64(ECIES_wrapped_file_key)>
X-File-Mime: image/jpeg
X-File-Name: photo.jpg
Content-Length: 12345678

<raw file bytes>
```

**Response (200 OK):**
```json
{
  "file_id": "a1b2c3d4e5f6...",
  "size": 12345678,
  "mime": "image/jpeg",
  "expires_at": 1724600000
}
```

**Response (507 Insufficient Storage):**
```json
{
  "error": "storage_full",
  "disk_used_percent": 96.2
}
```

### `GET /api/download`

**Request:**
```
GET /api/download?file_id=a1b2c3d4e5f6... HTTP/1.1
Host: murmur.senswifi.ru
X-File-Token: <base64(ECIES_wrapped_file_key)>
```

**Response (200 OK):**
```
Content-Type: image/jpeg
Content-Disposition: attachment; filename="photo.jpg"
Content-Length: 12345678

<raw file bytes>
```

**Response (404 Not Found):**
```json
{
  "error": "file_not_found",
  "reason": "expired_or_deleted"
}
```

---

## Appendix B: Cryptographic Design Details

### Key Hierarchy
```
murmur
├── user_identity (ed25519 + x25519)          // long-term identity
│   ├── signing_sk / signing_pk               // messages
│   └── agreement_sk / agreement_pk           // encryption
│
└── per_file_keys
    ├── file_key (random AES-256)             // encrypts file content
    ├── wrapped_file_key (AES-GCM(file_key))  // encrypted with ECIES
    │   └── uses ephemeral X25519 per file
    └── file_id = SHA3-256(file_ciphertext)   // lookup key for relay
```

### Forward Secrecy
Each file gets a **fresh ephemeral X25519 keypair** for ECIES wrapping. Even if the sender's static X25519 secret is compromised later, past file keys remain safe because the ephemeral key was never stored.

### Integrity
- `file_id` = SHA3-256 of ciphertext — serves as both dedup key and lookup key
- AES-GCM tag per chunk — verifies integrity of each 64 KiB chunk
- On download: verify `sha3sum(file_ciphertext) == file_id` before decryption

---

## Appendix C: File Type Support Matrix

| File Type | MIME | Encryption | Display | Notes |
|-----------|------|-----------|---------|-------|
| JPEG | image/jpeg | ✅ | Thumbnail + full view | Most common photo format |
| PNG | image/png | ✅ | Thumbnail + full view | Lossless, transparent |
| WebP | image/webp | ✅ | Thumbnail + full view | Modern web format |
| GIF | image/gif | ✅ | Animated preview | Up to 50 MB |
| MP4 | video/mp4 | ✅ | Inline player | Streaming download |
| WebM | video/webm | ✅ | Inline player | Open format |
| MP3 | audio/mpeg | ✅ | Audio player | Streaming |
| WAV | audio/wav | ✅ | Audio player | Uncompressed |
| OGG | audio/ogg | ✅ | Audio player | Open format |
| PDF | application/pdf | ✅ | Download link | No inline preview |
| DOCX | application/vnd... | ✅ | Download link | No inline preview |
| ZIP | application/zip | ✅ | Download link | Extract client-side |
| HEIC | image/heic | ❌ | Rejected with chip | No browser support |
| HEIF | image/heif | ❌ | Rejected with chip | No browser support |

---

## Appendix D: Implementation Order Summary

| Step | Milestone | Effort | Blocker For |
|------|-----------|--------|-------------|
| 1 | M1: File key wrapping | 2 days | M2, M7 |
| 2 | M2: Streaming encryption | 3 days | M4, M7 |
| 3 | M3: Upload endpoint | 2 days | M4 |
| 4 | M4: Client upload flow | 3 days | M5, M7 |
| 5 | M5: File bubble UI | 2 days | M7 |
| 6 | M6: IndexedDB cache | 2 days | — |
| 7 | M7: Full E2E pipeline | 3 days | M8-M10 |
| 8 | M8: TTL + cleanup | 1 day | — |
| 9 | M9: Push notifications | 2 days | — |
| 10 | M10: Benchmarks + docs | 1 day | Release |

**Total estimated effort: 20–24 engineering days** (2–3 weeks with 2 engineers)