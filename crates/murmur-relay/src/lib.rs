//! murmur-relay: a small WebSocket + iroh-direct relay.
//!
//! ## Architecture
//!
//! ```text
//! ┌──────────────┐  iroh direct UDP   ┌─────────────────┐  WebSocket  ┌────────────┐
//! │ murmur       │  ─────────────────►│                 │  ─────────► │ ws-client  │
//! │ sender (HP)  │   envelope bytes   │  murmur-relay   │  frames     │ (CLI/PWA)  │
//! └──────────────┘                    │  (VPS)          │             └────────────┘
//!                                     │                 │
//!                                     │  - iroh ALPN    │
//!                                     │  - ws listener  │
//!                                     │  - pending[]    │
//!                                     │  - subscribers  │
//!                                     └─────────────────┘
//! ```
//!
//! The relay is a **dumb pipe**: it accepts signed envelopes, persists them
//! to a per-contact pending list, and pushes them to subscribed WS clients.
//! It cannot decrypt or forge messages (envelopes are signed by sender).
//!
//! ## Privacy
//!
//! - VPS sees: envelope bytes (signed ciphertext), sender pubkey, recipient alias.
//! - VPS does NOT see: message plaintext (it's inside the envelope payload).
//! - VPS does NOT need to be trusted for metadata privacy — see README.

pub mod config;
pub mod pending;
pub mod subscriber;
pub mod ws_server;
pub mod iroh_server;

pub use config::RelayConfig;
pub use pending::{PendingStore, PendingEntry};
pub use subscriber::{SubscriberHub, WsMessage};
pub use ws_server::WsServer;
