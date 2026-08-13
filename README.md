# murmur

> Privacy-first decentralized messenger. No trusted servers. No metadata leakage.

## Vision

A messenger that doesn't repeat what already exists. Where:

- **No single server** is a point of trust.
- **Metadata is private** — who talks to whom, when, and how much, stays between you and your contacts.
- **Censorship resistance** is a byproduct, not the goal (RKN can be bypassed with VPN — we focus on the harder problem).

## What murmur is NOT

- ❌ Yet another Matrix/Signal fork with "federation" as a no-server claim.
- ❌ A blockchain/crypto project — we don't need a global ledger for chat.
- ❌ A wrapper around Tor — Tor hides IP, but timing patterns stay visible.

## What murmur IS

A **fully client-driven P2P messenger** with three architectural innovations:

1. **Lightweight mixnet on devices** — every user's phone acts as a small mix-node for 2-3 contacts, providing drop-and-cover traffic analysis protection without dedicated infrastructure.
2. **Cold-storage on friends' devices** — encrypted history chunks replicated to 2-3 trusted contact devices, with TTL. No backup servers.
3. **Locally verifiable history** — append-only log with Merkle anchoring, optionally witnessed by public timestamp services (not required for operation).

## Architecture (high-level)

```
[Identity Layer]
  └─ ed25519 long-term + per-message X3DH-style session keys
  
[Transport Layer]
  └─ iroh (Rust P2P, QUIC, NAT traversal)
  └─ mixnet overlay — drop+cover (3 latency profiles: direct / private / paranoid)
  
[Storage Layer]
  ├─ Local append-only log (per contact, SHA3 chain)
  ├─ CRDT for multi-device sync
  └─ Cold-storage fanout — 3 random contacts, TTL=30d, encrypted
  
[Trust Layer]
  └─ Web-of-Trust (PGP-style trust events in local log)
  └─ PoW on identity bootstrap (not per message)
  └─ Local rate-limit per identity
  
[Recovery Layer]
  └─ Social recovery: N-of-M Shamir fragments across trusted contacts
```

## UX budget

We optimize UX alongside privacy. The "budget" is enforced as a constant:

| Metric | Target | Hard limit |
|---|---|---|
| Local send/receive latency (online) | < 1.5 s | 3 s |
| Offline delivery | < 30 s | 2 min |
| Cold start | < 4 s | 8 s |
| Background battery drain | < 3 %/h | 8 %/h |
| Mobile data (no media) | < 50 MB/day | 200 MB/day |
| Onboarding new contact | < 4 clicks | 6 clicks |

If a privacy feature breaks this budget, we either redesign it or expose it as a user-selectable profile (not a default).

## Three privacy profiles

Users pick their trade-off:

- **`direct`** — no padding, sub-1.5s latency. Default for 80% of conversations.
- **`private`** — 5–10s padding, medium cover traffic. For sensitive topics.
- **`paranoid`** — 30s+ padding, max cover traffic. For journalists, activists, lawyers.

## Status

- **2026-08-13:** Project bootstrapped. Initial research underway (3 parallel subagents).
- **Next:** MVP-01 — Identity + iroh transport + local log.

## License

MIT.
