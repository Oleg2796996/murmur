# murmur — Roadmap

## Status (2026-08-13)

**Project:** Privacy-first decentralized messenger
**Repo:** https://github.com/Oleg2796996/murmur
**Maintainer:** Oleg (@Oleg2796996)
**AI co-author:** Matilda

---

## MVP-01 — Identity + P2P Transport + Local Log (2 weeks)

**Goal:** Two CLI clients on different machines can send signed messages to each other, with append-only local log.

**Crates:**
- `murmur-id` — ed25519 keypair generation, X3DH-style prekey bundles, identity export/import
- `murmur-transport` — iroh node, signed message envelopes, end-to-end delivery
- `murmur-log` — append-only log per contact, SHA3 chain, Merkle anchor per day

**Architectural decisions (2026-08-13):**
- **Serialization:** `postcard` for on-disk/on-wire, `toml` for config.
- **Address format:** bech32 (Nostr-style `npub1...`) for human-readable identity hashing.
- **Algorithm:** ed25519 for signatures, X25519 for ECDH (X3DH-style key agreement).

**Step-by-step plan (each step has a gate, no skipping):**

| Step | Crate | Scope | Gate |
|---|---|---|---|
| 1 | `murmur-id` | Identity struct, keypair generation, bech32, postcard serde, CLI `new` | `cargo test -p murmur-id` + CLI prints valid `npub1...` |
| 2 | `murmur-log` | Append-only log per contact, SHA3 chain, Merkle root | `cargo test -p murmur-log` + integrity: 1000 msg verify ✓, tamper 1 byte → verify ✗ |
| 3 | `murmur-transport` | iroh endpoint + signed envelope `SignedEnvelope { payload, signature, sender_npub }`, direct NodeAddr discovery | 2 procs on 2 machines exchange messages, both `cargo test -p murmur-transport` ✓ |
| 4 | integration | `murmur send` writes to local log, `murmur listen` writes to remote log | 10 messages in both logs, hashes match |
| 5 | OTS witness | `murmur-log/src/witness.rs` — background job, hourly batch → Merkle root → OTS calendar | Mock OTS calendar test ✓ |
| 6 | end-to-end | Full CLI: new identity → send → OTS anchor → verify | 2 machines, 10+ messages, OTS proof verifiable on Bitcoin regtest |

**Deliverables:**
- `murmur-id new` — generates identity, prints `npub1...`, saves `~/.murmur/identity.bin`
- `murmur send <npub> <msg>` — sends signed message via iroh
- `murmur listen` — listens for incoming, writes to log
- `murmur log verify` — verifies log integrity
- `murmur log witness` — runs OTS anchoring manually
- Integration test: 2 processes, 1+ message delivery, log persistence across restart
- Benchmark: end-to-end RTT, CPU during receive

---

## MVP-02 — Lightweight Mixnet (drop+cover overlay) (2-3 weeks)

**Goal:** Messages routed through 3-hop mixnet with adaptive privacy profiles.

**Crates:**
- `murmur-mix` — Loopix-style mix nodes, drop-and-cover padding, Poisson delays

**Deliverables:**
- Three profiles: `direct` (no padding), `private` (5-10s), `paranoid` (30s+)
- Metric: distribution of inter-arrival times (privacy gain)
- Metric: CPU/battery drain during profile `private` (mobile simulation)

---

## MVP-03 — Cold-Storage Fanout (2-3 weeks)

**Goal:** Encrypted chat history chunks replicated to 2-3 trusted contact devices.

**Crates:**
- `murmur-cold` — gossip protocol, encrypted blob store, TTL-based deletion

**Deliverables:**
- Config: `fanout_targets` (default 3), `ttl_days` (default 30), `quota_per_contact_mb` (default 1024)
- Recovery flow: missing device re-pulls history from cold-storage nodes
- UI sketch: storage used per contact, opt-in/opt-out for "be a storage node"

---

## MVP-04 — Multi-Device + Social Recovery (1-2 weeks)

**Goal:** User can have phone + laptop, both in sync, with social recovery if both lost.

**Crates:**
- `murmur-id` extension — Shamir N-of-M fragment export
- `murmur-log` extension — CRDT for multi-device

---

## MVP-05 — Anti-Spam + Web-of-Trust (2 weeks)

**Goal:** A new identity can only contact users with trust signal (PoW + WoT).

**Approach:**
- PoW on identity bootstrap (Hashcash-style, ~1 minute of mobile CPU)
- Web-of-Trust events in local log (signed trust statements)
- Trust propagation: 2-hop friend of friend can DM with reduced rate-limit

---

## Anti-MVP (postponed)

- ❌ Group chat > 50 members (out of scope for privacy-centered MVP)
- ❌ Voice/video calls (P2P WebRTC complexity, separate problem)
- ❌ Global user discovery / DHT search (fundamentally incompatible with metadata privacy)

---

## White Paper v1 (parallel to MVP-01..03)

**Target:** 8-12 pages, technical, intended for arxiv submission.
**Sections:**
1. Threat model
2. Why existing solutions fail (privacy metadata)
3. Architecture overview
4. Three innovations (mixnet, cold-storage, witness)
5. UX trade-offs and adaptive profiles
6. Security analysis of each layer
7. Comparison table (vs Briar, Matrix, SSB, Session, Nostr)
8. Roadmap & future work
