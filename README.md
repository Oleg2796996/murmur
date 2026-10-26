# MurMur

A privacy-first messenger: an installable web app (PWA) with end-to-end encryption for messages and calls, backed by a small relay server written in Rust.

No phone number. No email. No accounts database. Your identity is a cryptographic key.

**Try it:** [open MurMur](https://murmurchat.org) · **Source:** [github.com/Oleg2796996/murmur](https://github.com/Oleg2796996/murmur)

> MurMur is experimental software. It has not undergone an external security audit. Do not use it for high-risk communications without reviewing the code and threat model.

## What it is

MurMur runs in the browser. You install it as a PWA directly from https://murmurchat.org — no App Store, no Google Play:

- **iPhone / iPad:** open the site in Safari → Share → Add to Home Screen.
- **Android / desktop:** open the site in Chrome → install prompt or menu → Install app.

Once installed it behaves like a regular app: its own window/icon, camera and microphone access for calls, and push notifications.

Identity is an `npub` — a public cryptographic key. There is no registration, no phone verification, no email confirmation. The corresponding secret key stays on your device. If you lose it, you lose the account; there is no SMS recovery. Export a backup file (`.murmur`) from the app and keep it somewhere safe.

## Features

- End-to-end encrypted messages.
- End-to-end encrypted calls (camera + microphone) in the browser.
- Push notifications.
- Contacts added via invite links — ordinary `https://` links containing the contact's `npub`.
- Local backup: export/import a `.murmur` file via the backup/restore buttons in the app.
- Installable on iOS, Android, and desktop as a PWA.

## Architecture

```
[PWA (vanilla JS)]          [Relay (Rust, hosted in Europe)]
  npub identity        ⇄      encrypted message storage (TTL after delivery)
  E2EE messages               push notification delivery
  E2EE calls (WebRTC)         minimal metadata visible to the server
  local backup file
```

- **Identity.** Each user is an `npub` key pair. The private key lives on the user's device. Contacts are added by exchanging invite links that contain the sender's `npub`.
- **Encryption.** Messages and calls are end-to-end encrypted between clients. The relay never sees plaintext.
- **Relay.** A Rust server relays messages between clients. It stores messages only in encrypted form and only for a limited time after delivery, then deletes them. The server sees a minimum of metadata — it cannot read message contents.
- **PWA.** The frontend is a vanilla JS progressive web app in `pwa/`, installable directly from the site without any app store.

## Repository layout

Rust workspace (`Cargo.toml`) with crates under `crates/`:

| Crate | Role |
|---|---|
| `murmur` | main binary |
| `murmur-relay` | relay server |
| `murmur-id` | identity (npub) |
| `murmur-id-wasm` | identity bindings for the browser |
| `murmur-log` | logging |
| `murmur-mix` | mixing |
| `murmur-transport` | transport |
| `murmur-cold` | cold storage |
| `murmur-witness` | witnessing |
| `murmur-mobile` | mobile |

Plus `pwa/` — the vanilla JS progressive web app that users actually install.

## Quick start

### For users

1. Open [murmurchat.org](https://murmurchat.org) in Safari (iPhone/iPad) or Chrome (Android/desktop).
2. Add to Home Screen (Safari) or install (Chrome).
3. Create your identity and start chatting.
4. **Export the `.murmur` backup immediately** and store it safely. The private key stays on your device; there is no SMS or email recovery.

### For self-hosters

Build the relay workspace:

```
cargo build --release --workspace
```

Detailed self-hosting documentation is being written and is not ready yet.

## What MurMur is NOT

- No phone-number identity and no email-based registration.
- No accounts database on the server — the relay does not maintain user accounts.
- Not audited. There has been no external security audit yet.
- Not federated. A single operator runs the relay for now.
- No cloud key recovery — losing your key means losing your account.

## Limitations (honest list)

- This is a young project built by a small team.
- No external security audit has been performed.
- The PWA depends on the browser: capabilities (calls, push, storage) vary by browser and platform, and browser updates can change behavior.
- One relay operator at the moment; federation does not exist yet.

## Roadmap

These are future plans, not current features:

- Multi-relay / federation.
- Self-hosting documentation.
- External security audit.

## Links

- Site: https://murmurchat.org
- Blog: https://murmurchat.org/blog/
- Privacy: https://murmurchat.org/privacy

## License

AGPL-3.0-or-later.

If you run a modified MurMur service for users over a network, the AGPL requires you to offer those users the corresponding modified source code. See `LICENSE` for the full terms.
