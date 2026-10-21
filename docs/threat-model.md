# MurMur Threat Model (Draft)

Project: MurMur — private end-to-end encrypted messenger (PWA)
Site: https://murmurchat.org
Code: https://github.com/Oleg2796996/murmur (MIT license)
Status of this document: draft, written by the project authors, not an external audit. Date: 2026-10-21.

MurMur is an installable progressive web app (PWA) for iPhone and Android that does not require an app store. There is no phone-number or email registration: your identity is a cryptographic key (npub). Messages and calls are end-to-end encrypted. A relay server written in Rust, operated in Europe, passes encrypted envelopes between users; it cannot read plaintext, and it stores encrypted messages only for a limited time (deleted after delivery, and after a TTL if never delivered). Users can export and import local backup files (.murmur).

This document says plainly what MurMur protects, what it does not, who the adversaries are, and what is still missing. No marketing.

---

## 1. What we protect

**Message content.** Messages are end-to-end encrypted between the sender's and recipient's devices. The relay and anyone observing traffic between you and the relay see only ciphertext.

**Call audio and video.** Calls are end-to-end encrypted the same way. The relay is not in a position to decode call media.

**No plaintext at rest on the server.** The relay never holds readable message content. Stored messages are encrypted envelopes that are deleted after delivery, and additionally expire after a time-to-live if the recipient never picks them up. If the server disk is copied, what is on it is ciphertext with limited lifetime, not a message archive.

**Identity not tied to real-world identity.** There is no registration with a phone number or email. Your account is a cryptographic key (npub). Nothing in the account creation flow itself asks who you are. (See section 2 for what this does and does not imply in practice.)

**No app store gatekeeping.** The PWA installs directly from the website on iPhone and Android. There is no third-party store review between a code change and your device — see section 3 for both sides of that.

---

## 2. What we cannot protect

We would rather list this fully than sound better than we are.

**Metadata the relay sees.** The relay cannot read messages, but it sees:
- your IP address (and the recipient's) whenever you connect;
- which npub keys are talking to which npub keys, and when;
- encrypted envelope sizes and the timing/pattern of delivery.

Connection metadata is enough to correlate accounts with networks and, in some cases, with people. If hiding *that you communicate* matters to you as much as hiding *what* you communicate, MurMur alone does not provide that.

**Traffic analysis.** Beyond the relay, a network observer on your path (ISP, Wi-Fi operator, national firewall) sees that you talk to one server, how much, and when. Encrypted payload sizes and timing patterns can leak structure (e.g., that a call happened, roughly how long it lasted). We do not currently ship padding, cover traffic, or timing obfuscation.

**Compromised endpoint.** End-to-end encryption ends at your device and browser. If the phone or the browser you use is compromised — malware, a stolen unlocked phone, an exploited browser — the attacker reads plaintext regardless of anything MurMur does. No messenger can fix a hostile endpoint.

**Malicious browser extensions.** A browser extension with access to the page can read or alter what MurMur displays and what you type before encryption or after decryption. This is a real and underappreciated risk for any browser-based app, PWA or not. Only install extensions you trust, ideally none in the browser profile you use for sensitive conversations.

**Key loss.** There is no account recovery. If you lose your key and have no .murmur backup file, your account and your ability to read anything addressed to it are gone. That is the cost of an identity that is a key rather than a login. Export a backup and store it somewhere safe — the backup itself is now the most sensitive file you own.

**Man in the middle at first contact.** MurMur has no finished out-of-band key verification story yet. This means we cannot currently give you a simple, reliable procedure (like comparing safety codes or scanning a QR code in person) to confirm that the key you think belongs to your contact really is theirs. A network-level attacker who can intercept the initial key exchange between two people connecting for the first time may be able to insert themselves without either side noticing. We are being explicit that this is a gap and that we are not certain of every corner of it; the honest summary is: **until verification exists, treat first contact with a new contact as unverified.** Verifying a contact through a second, independent channel (another secure channel, or in person) reduces this risk; we cannot yet point you to a built-in feature that does it for you. The current behavior is documented in code.

**Relay denial of service.** The relay operator cannot read your messages but can refuse to serve you: block your IP, drop your envelopes, or shut the endpoint down. Currently there is a single relay and it is not federated, so the operator is a single point of availability failure. Availability is not an encrypted property.

**State-level adversary with endpoint access.** To be direct: a well-funded attacker who gets code execution on your device, or who can compel the browser/platform vendor to tamper with what is served or updated, wins. No end-to-end encryption protects against that. MurMur's design goals simply do not include defeating an attacker who controls your endpoint.

---

## 3. Threat actors considered

**Passive network observer.** Sees ciphertext, connection endpoints, sizes, timing. Cannot read content. Can infer communication patterns and possibly identify participants by correlating IP addresses with other data. Partially mitigated by HTTPS; not mitigated for metadata.

**Relay operator.** Sees all envelope metadata (section 2), cannot read content, can deny service, could attempt to serve tampered application code — see section 4 for why the browser's HTTPS model is the main thing standing against that, and why it is not a complete answer. The relay code is open source; the *deployment* is run by a single operator in Europe today.

**Server seizure.** If the relay hardware is seized or the disk copied, investigators get: ciphertext of undelivered/recent messages (deleted after delivery + TTL limits the window), IP addresses and connection logs to the extent the server keeps them (retention documented in code), and the running relay code. No message archive in plaintext exists to hand over. Identity linkage must come from traffic metadata, not from the server's contents.

**App-store absence.** Being outside the app stores cuts both ways, and we say both:
- *Faster updates:* changes ship from the website as soon as they are ready, on both iPhone and Android, with no review queue.
- *No vetting layer:* nobody independent reviews updates before they reach users. App stores, whatever their flaws, add a (weak, imperfect) external check. MurMur has that check only in the form of its open source repository — which helps only if someone actually reads the code.
- Users should also be aware that PWA updates arrive via the browser without an install-time prompt the way a store update has; the protections and limits of that are covered in section 4.

**State-level adversary.** Capabilities: endpoint compromise (the decisive one), legal compulsion of the relay operator, network-level interception including at first contact, traffic analysis at national scale, and pressure on browser/platform vendors. Honest assessment: against such an adversary, MurMur protects message *content* against passive capture and server seizure, but does not protect metadata, does not yet protect first-contact key exchange, and cannot protect a compromised device. We do not claim otherwise.

---

## 4. Trust assumptions

For MurMur to work as described, you are trusting the following. Naming your assumptions is part of an honest threat model.

**The browser's crypto stack.** Cryptographic operations run on WebCrypto as implemented by your browser (Safari, Chrome, Firefox, etc.). We do not implement primitives ourselves; correctness and safety of the primitives are the browser vendor's responsibility, and so is their trustworthiness. A broken or backdoored browser crypto layer defeats the design.

**Code served over HTTPS on every load.** As a PWA, MurMur's code reaches your browser over HTTPS from the web origin, with a service worker providing caching so the app also works offline after first install. Understand what this means: an update to the application code is delivered by the same infrastructure that serves the site. Whoever controls the domain and the server (or can get a fraudulent certificate for the domain — e.g., a certificate authority compelled or compromised) can serve modified application code. HTTPS and the browser's existing protections are the guardrails; they are real but they are not cryptographic proof that the code you are running is the code in the public repository. Reproducible builds, which would let anyone check that the served code matches the source, are **not yet implemented** (section 5).

**The relay operator.** Currently a single operator in Europe, running an open-source Rust relay. Trusted for availability and correct forwarding, explicitly **not** trusted for confidentiality of content. Not trusted for metadata protection — the operator sees it, as described in section 2.

**The open source code.** The client and relay are MIT-licensed and public. Open source is a necessary condition for verifiability, not a substitute for verification: it matters only insofar as people read it, builds are reproducible (not yet), and what is deployed matches what is published (not yet provable). We state this as a limitation, not a feature.

**Your own key handling.** The security of everything above reduces to your private key and your .murmur backups. If those leak, all protections for your account end.

---

## 5. What is not yet done

Missing work, labeled as such. None of this is done today; all of it is future work.

- **External security audit.** MurMur has **not** been audited by any independent security firm. It is a young project built by a small team. Until an audit exists, treat the cryptography and implementation as unaudited and use it accordingly. This is the single biggest open item.
- **Out-of-band key verification.** No completed safety-number / QR-verification flow between contacts (see section 2). First contact is currently unverifiable by the app itself.
- **Multi-relay federation.** One relay, one operator. Federation would remove the single point of availability and reduce concentration of metadata in one place. Not implemented.
- **Reproducible builds.** No published way to verify that the code served by the website is bit-for-bit the code in the public repository. Until then, matching the deployment to the source is a matter of trust, not proof.
- **Metadata resistance.** No padding, cover traffic, or timing obfuscation; relay sees IP addresses and traffic patterns (section 2). Not on the roadmap as a near-term item.
- **Published data-retention specification.** Exact log retention on the relay is documented in code rather than in a standalone public policy document.

---

*This draft is written by the project team. It contains no independent verification of any claim. The most important sentence in it is in section 5: there has been no external audit.*
