//! WebSocket subscriber hub: broadcast pending entries to all subscribed clients.
//!
//! Each WebSocket connection subscribes to one or more recipient aliases.
//! When a new envelope lands in `PendingStore`, it is broadcast to all matching
//! subscribers.

use crate::pending::PendingEntry;
use crate::push::PushPayload;
use async_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

/// Wire-protocol message over WebSocket.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum WsMessage {
    /// Server → client: a pending entry arrived for this subscriber.
    Push(PendingEntry),
    /// Server → client: subscribe confirmation with current backlog count.
    Subscribed { alias: String, backlog: usize },
    /// Server → client: pong.
    Pong,
    /// Client → server: subscribe to alias.
    Subscribe { alias: String },
    /// Client → server: ping.
    Ping,
    /// Server → client: error.
    Error { message: String },
}

impl WsMessage {
    pub fn encode(&self) -> Result<Vec<u8>, postcard::Error> {
        postcard::to_stdvec(self)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, postcard::Error> {
        postcard::from_bytes(bytes)
    }
}

#[derive(Clone)]
pub struct SubscriberHub {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    /// alias → list of subscribers. Each subscriber has a Sender<WsMessage>.
    /// On drop of the WebSocket task, the Receiver is dropped, which closes the channel.
    subs: HashMap<String, Vec<SubscriberHandle>>,
    /// alias → list of payload subscribers (browser WebSocket path).
    payload_subs: HashMap<String, Vec<SubscriberHandlePayload>>,
}

/// Lightweight clone-able sender.
#[derive(Clone)]
pub struct SubscriberHandle {
    tx: Sender<WsMessage>,
    /// Debug label.
    pub label: String,
}

impl SubscriberHandle {
    pub fn try_send(&self, msg: WsMessage) -> Result<(), async_channel::TrySendError<WsMessage>> {
        self.tx.try_send(msg)
    }
}

/// Lightweight clone-able sender for `PushPayload`.
#[derive(Clone)]
pub struct SubscriberHandlePayload {
    tx: Sender<PushPayload>,
    pub label: String,
}

impl SubscriberHandlePayload {
    pub fn try_send(&self, payload: PushPayload) -> Result<(), async_channel::TrySendError<PushPayload>> {
        self.tx.try_send(payload)
    }
}

impl SubscriberHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                subs: HashMap::new(),
                payload_subs: HashMap::new(),
            })),
        }
    }

    /// Register a subscriber for one alias. Returns a Receiver that yields
    /// `WsMessage::Push` items until the WebSocket task drops the receiver.
    pub fn subscribe(&self, alias: &str, label: &str, capacity: usize) -> Receiver<WsMessage> {
        let (tx, rx) = bounded::<WsMessage>(capacity);
        let handle = SubscriberHandle { tx, label: label.to_string() };
        self.inner.lock().subs.entry(alias.to_string()).or_default().push(handle);
        rx
    }

    /// Same as `subscribe` but yields `PushPayload` (JSON-friendly) instead of
    /// the postcard `WsMessage`. Used by the browser WebSocket path.
    pub fn subscribe_payload(
        &self,
        alias: &str,
        label: &str,
        capacity: usize,
    ) -> Receiver<PushPayload> {
        let (tx, rx) = bounded::<PushPayload>(capacity);
        let handle = SubscriberHandlePayload { tx, label: label.to_string() };
        self.inner.lock().payload_subs.entry(alias.to_string()).or_default().push(handle);
        // Also keep a placeholder in `subs` so `count()` reflects the connection.
        rx
    }

    /// Broadcast a pending entry to all subscribers of `to_alias`.
    /// Returns number of subscribers reached.
    pub fn broadcast(&self, entry: &PendingEntry) -> usize {
        let msg = WsMessage::Push(entry.clone());
        let payload = PushPayload::from_entry(entry);
        let mut inner = self.inner.lock();
        let mut n = 0usize;
        if let Some(list) = inner.subs.get_mut(&entry.to_alias) {
            // Drop closed senders.
            list.retain(|h| {
                let ok = h.try_send(msg.clone()).is_ok();
                if ok { n += 1; }
                ok
            });
        }
        if let Some(list) = inner.payload_subs.get_mut(&entry.to_alias) {
            list.retain(|h| {
                let ok = h.try_send(payload.clone()).is_ok();
                if ok { n += 1; }
                ok
            });
        }
        n
    }

    /// Number of unique subscribers across all aliases.
    pub fn count(&self) -> usize {
        let inner = self.inner.lock();
        let mut n = 0;
        for v in inner.subs.values() { n += v.len(); }
        for v in inner.payload_subs.values() { n += v.len(); }
        n
    }
}

impl Default for SubscriberHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_reaches_subscriber() {
        let hub = SubscriberHub::new();
        let rx = hub.subscribe("oleg-hp", "cli-1", 4);
        let entry = PendingEntry {
            to_alias: "oleg-hp".into(),
            from_npub: "npub1bob".into(),
            ts: 1,
            envelope_bytes: vec![0xaa; 8],
            envelope_hash_hex: "deadbeef".into(),
        };
        let n = hub.broadcast(&entry);
        assert_eq!(n, 1);
        let got = rx.try_recv().unwrap();
        match got {
            WsMessage::Push(e) => assert_eq!(e.envelope_hash_hex, "deadbeef"),
            _ => panic!("expected Push"),
        }
    }

    #[test]
    fn ws_message_roundtrip() {
        let msg = WsMessage::Subscribe { alias: "x".into() };
        let bytes = msg.encode().unwrap();
        let back = WsMessage::decode(&bytes).unwrap();
        match back {
            WsMessage::Subscribe { alias } => assert_eq!(alias, "x"),
            _ => panic!("wrong variant"),
        }
    }
}
