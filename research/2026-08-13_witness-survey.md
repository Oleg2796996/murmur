# Witness Survey — murmur MVP-03 (and beyond)

**Author:** Matilda (research agent for murmur project)
**Date:** 2026-08-13
**Status:** Working draft, not peer-reviewed
**Scope:** What minimal trusted-third-party (TTP) does murmur need for **dispute resolution**
(proof that a message existed at a specific time), and what is the lightest-weight option?

---

## TL;DR

For murmur, the witness problem has three layers:

1. **Identity witness** — proof that an identity was created at a specific time. Solved
   by the identity's own signed timestamp in its first message + gossip propagation.
2. **Message witness** — proof that a specific message existed at a specific time.
   Solved by **OpenTimestamps** (Bitcoin-anchored) or **Nostr event** as a "free" option.
3. **Dispute witness** — third-party attribution of "this is what was said and when". This
   requires a richer witness — multiple parties or a published log.

**Recommendation:** Use **OpenTimestamps as the primary witness** for MVP-01.
It is the lightest TTP that doesn't require running our own infrastructure, and it's
**stateless**: the calendar server sees only the hash, not the message.

**For MVP-03+** (when dispute resolution becomes a real feature), add a **Nostr-events
witness** as a fallback / redundancy layer. Nostr relays are public, anonymous, and
load-balanced; nothing pre-meditated can be taken down because millions of them exist.

**For MVP-04+** (multi-device sync), we add a **device-to-device witness** via the gossip
protocol — no TTP needed.

---

## 1. What is the witness problem in murmur?

A "witness" in murmur is any party that can cryptographically attest that a piece of
data existed at a specific time. The honest answer is: **most of murmur should NOT
need a witness**. The append-only log per contact is locally verifiable. The CRDT
state is deterministically mergeable. The gossip fanout is self-healing.

Where witnesses become necessary:

- **Dispute resolution** — "I sent you this message on X date, you say you never got it."
  The witness can prove the message existed at X.
- **Legal evidence** — for journalists, lawyers, activists. They need a third-party
  proof-of-existence that holds up in court.
- **Cross-device ordering** — "Was this message from before or after I switched phones?"
  Mainly a CRDT problem, but a witness removes ambiguity.

**Critical constraint:** the witness must be **stateless** (sees only the hash) and
**non-censorable** (cannot be DMCA'd or shut down by a single party).

---

## 2. OpenTimestamps: the Bitcoin-anchored option

**How it works:**

1. Client takes the hash of the data it wants to timestamp.
2. Sends to a **calendar server** (free, public, run by volunteers).
3. Calendar server aggregates many hashes into a Merkle tree and submits the root to
   Bitcoin via a regular transaction.
4. Once the transaction is confirmed (usually 1 hour for indistinct, ~1 day for strong),
   the client gets back a **receipt** that contains:
   - The path from their hash to the Merkle root.
   - The Bitcoin transaction ID.
   - The Bitcoin block number.
5. Anyone can verify the receipt by checking the Bitcoin blockchain.

**What does the calendar server see?**
- Only the hash.
- It does NOT see the message contents.
- It does NOT see who sent it (unless the client authenticates, which they don't have to).

**What does the calendar server know?**
- "Someone timestamped this hash at this time."
- It can correlate timing patterns if many clients hit it from the same IP, but
  those correlations are weak (Tor is a simple defense).

**Threat model:**
- Calendar server can refuse service (we need multiple, or run our own).
- Calendar server can be subpoenaed, but it has no useful data to give.
- A global observer can correlate requests but cannot tie hashes to people without
  additional side channels.

**Cost:** zero. Calendar servers are free. The Bitcoin transaction fees are paid by
the calendar operator (or we bundle with other users' hashes).

**Confirmation time:** ~1 hour for indistinct, ~1 day for strong (Bitcoin block time).

**Murmur usage pattern:**

- Periodically (e.g., once per hour), collect all message hashes from the last hour.
- Compute a Merkle root.
- Submit to OpenTimestamps.
- Store the resulting receipt alongside the local log.
- This is fully **asynchronous** — doesn't block message delivery.

**Why this is the right answer for MVP-01:**

- ✅ Stateless witness (no contents seen).
- ✅ Free.
- ✅ Permissionless (anyone can run a calendar).
- ✅ Replicated across thousands of public Bitcoin nodes.
- ✅ Asynchronous (doesn't add latency).
- ✅ Add-only (cannot be rewritten).

**Caveats:**

- ⚠️ 1 hour to ~1 day confirmation latency. Not for "real-time" witness.
- ⚠️ Requires submitting to a calendar — small metadata leak (timing, IP).
- ⚠️ Requires Bitcoin full-node verification or trusted block explorer.

---

## 3. Nostr events: the censorship-resistant option

**What Nostr is:**

Nostr is a simple protocol: every "event" is a JSON object signed by an ed25519 key.
Events are published to **relays** (free, public, anonymous). Each event has a kind,
a timestamp, and arbitrary content (JSON-encoded).

**What Nostr events can be used for in murmur:**

A Nostr event with `kind=40000` (custom, app-specific) and `content` =
`<murmur-message-hash>` is a "witness that this hash existed at this time".

**Properties:**

- ✅ Many public relays (relay.tools, nostr.wine, etc.) — no single point of failure.
- ✅ Anonymous (no identity required to publish).
- ✅ Free.
- ✅ Censorship-resistant (no central authority).
- ✅ Real-time (events propagate in seconds).
- ❌ No strong "proof of work" — relay can lie about timestamp.
- ❌ No Bitcoin-like anchoring — weaker than OTS for "indisputable" claims.

**Why it's a useful complement to OpenTimestamps:**

- OpenTimestamps: strong, indisputable, but slow.
- Nostr: weak, fast, abundant.

**For murmur:** Nostr is useful for **redundancy** (multiple witnesses) and for
**high-frequency anchoring** (one Nostr event per message, no batching needed).
But it should NOT be the primary witness for legal-grade proof.

---

## 4. Custom P2P witness: trust-based attribution

**Idea:** instead of a global public witness, use the **gossip protocol** itself.
A murmur node that has seen a message can publish a "witness statement":

```
witness {
  msg_hash: <hash>,
  seen_at: <unix_ts>,
  seen_by: <node_id>,
  seen_by_signature: <sig>
}
```

This witness is propagated via gossip. Any node can verify it.

**Properties:**

- ✅ No TTP required.
- ✅ Asynchronous.
- ✅ Free.
- ✅ Many witnesses (each of N recipients can publish).
- ❌ Witnesses can lie (they can claim "seen at X" when actually seen at Y).
- ❌ Without a global time anchor, clocks drift between witnesses.

**Mitigation:** witnesses that are also OTS-anchored become strong. So the pattern is:
**P2P gossip for redundancy, OpenTimestamps for indisputability.**

---

## 5. Comparison table

| Witness | Stateless | Latency | Cost | Strength | Use case |
|---|---|---|---|---|---|
| **OpenTimestamps** | ✅ (hash only) | 1h–1d | free | strong (Bitcoin) | legal, dispute resolution |
| **Nostr events** | ✅ (event only) | seconds | free | weak (relay-trusted) | real-time, redundancy |
| **P2P gossip** | ✅ (no third party) | seconds | free | weak (witness-trusted) | redundancy, gossip sync |
| **Self-signed** | ✅ | 0 | free | weak (only proves self-timestamp) | local ordering |
| **NTP-based** | ❌ | 0 | free | none (operator-trusted) | -- do not use -- |

---

## 6. Recommendation for murmur

**Tier 1 (MVP-01):** OpenTimestamps as the primary witness layer.

- Background job: every 1 hour, collect message hashes, build Merkle root, submit to OTS.
- Store OTS receipt alongside the log.
- Verification: any third party can take the log + OTS receipt and verify.

**Tier 2 (MVP-03):** Nostr events as redundancy / fast witness.

- For each significant message, publish a Nostr event with the hash.
- Use this for "real-time" witness when OTS confirmation is too slow.

**Tier 3 (MVP-04+):** P2P gossip witness.

- Each node that has seen a message publishes a witness statement.
- Aggregated into the log as "this message was seen by N independent nodes."

**DO NOT use:** NTP-based witness. The whole point of murmur is to not have
centralized time authorities. NTP is centrally controlled.

---

## 7. Implementation sketch for MVP-01

```rust
// crates/murmur-log/src/witness.rs

struct WitnessScheduler {
    pending_hashes: VecDeque<[u8; 32]>,
    last_submit: Instant,
    submit_interval: Duration, // 1 hour
}

impl WitnessScheduler {
    async fn tick(&mut self) {
        if self.last_submit.elapsed() < self.submit_interval {
            return;
        }
        let hashes: Vec<_> = self.pending_hashes.drain(..).collect();
        if hashes.is_empty() {
            return;
        }
        let merkle_root = merkle_root(&hashes);
        // Submit to OpenTimestamps calendar server
        let receipt = ots::submit(&merkle_root).await?;
        // Store receipt for later verification
        self.store.insert(merkle_root, receipt);
    }
}
```

**Spam prevention:** limit to 1 OTS submission per hour per node. The Merkle root
can cover thousands of messages.

**Privacy:** no client identity is exposed. The OTS calendar sees only the hash and
the IP. (Use Tor for the OTS submission to mitigate IP correlation.)

**Sources:**

- OpenTimestamps: https://opentimestamps.org/
- OpenTimestamps announcement: https://petertodd.org/2016/opentimestamps-announcement
- OpenTimestamps Rust client: https://github.com/opentimestamps/opentimestamps-client
- Nostr protocol: https://github.com/nostr-protocol/nostr
- Nostr event kinds: https://github.com/nostr-protocol/nips/blob/master/01.md

---

## 8. Confidence

- **High confidence:** OpenTimestamps is the right primary witness. It is mature,
  free, stateless, and unintrusive.
- **Medium confidence:** Nostr as a fallback. Nostr is newer, but the protocol is
  stable and the relay ecosystem is vast.
- **Low confidence:** The threshold for "significant message" — what gets
  a Nostr event vs. what only gets OTS batching. This needs UX testing.

**Next step:** implement `crates/murmur-log/src/witness.rs` as part of MVP-01.
