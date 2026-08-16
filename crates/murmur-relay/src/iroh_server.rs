//! iroh-direct server half: accept envelopes from any client via iroh ALPN.
//!
//! ## Routing
//!
//! The `murmur::send-iroh` CLI prepends a length-prefixed UTF-8 **recipient
//! alias** to the envelope payload before sending. The relay splits this
//! prefix, uses the alias for routing (PendingStore, SubscriberHub), and
//! stores the raw envelope bytes for the subscriber.
//!
//! Layout on the wire (over iroh ALPN):
//! ``text
//! 4 bytes BE: alias_len
//! alias_len bytes UTF-8
//! N bytes: postcard(Envelope)
//! ``
//!
//! ## Auth
//!
//! Each envelope carries the sender's ed25519 signature. The relay
//! verifies it against `Envelope::sender_npub` (must match the embedded
//! public key). Invalid → drop with a warn log.

use crate::pending::PendingStore;
use crate::push::PushServer;
use crate::subscriber::SubscriberHub;
use murmur_transport::Envelope;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::warn;

/// Spawn the iroh listener half of the relay.
///
/// Returns `(node_id, first_direct_addr)` for printing a share-link.
pub async fn spawn(
    pending: PendingStore,
    hub: SubscriberHub,
    push: Arc<PushServer>,
) -> anyhow::Result<(iroh::net::NodeId, SocketAddr)> {
    let pending = Arc::new(pending);
    let hub = Arc::new(hub);

    let on_envelope_raw = move |bytes: Vec<u8>| {
        let pending = pending.clone();
        let hub = hub.clone();
        let push = push.clone();

        // Parse frame: alias_len(4 BE) || alias || envelope
        if bytes.len() < 4 {
            warn!("dropping: frame too short");
            return;
        }
        let alias_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        if bytes.len() < 4 + alias_len {
            warn!("dropping: alias overflows frame");
            return;
        }
        let alias = match std::str::from_utf8(&bytes[4..4 + alias_len]) {
            Ok(s) => s.to_string(),
            Err(e) => {
                warn!(err=%e, "dropping: alias not utf-8");
                return;
            }
        };
        let env_bytes = bytes[4 + alias_len..].to_vec();

        if let Err(e) = crate::envelope::accept_envelope(alias.clone(), env_bytes, &pending, &hub, Some(&push)) {
            warn!(alias=%alias, err=%e, "dropping envelope");
        }
    };

    // spawn_relay_node passes raw bytes; we need our own acceptor that splits frame.
    let node = spawn_raw_relay_node(on_envelope_raw).await?;
    let node_id = node.node_id();
    let addrs = node.local_endpoint_addresses().await?;
    let first = addrs
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no local endpoint addresses"))?;
    std::mem::forget(node);
    Ok((node_id, first))
}

/// Like `spawn_relay_node` but passes raw bytes (no Envelope parsing at transport).
async fn spawn_raw_relay_node<F>(
    on_bytes: F,
) -> std::result::Result<iroh::node::MemNode, anyhow::Error>
where
    F: Fn(Vec<u8>) + Send + Sync + 'static,
{
    use iroh::net::relay::RelayMode;
    use iroh::node::{DiscoveryConfig, Node};
    use std::sync::Arc;
    let acceptor = Arc::new(RawBytesAcceptor { on_bytes });
    let node = Node::memory()
        .bind_random_port()
        .relay_mode(RelayMode::Disabled)
        .node_discovery(DiscoveryConfig::None)
        .build()
        .await?
        .accept(murmur_transport::iroh_transport::ALPN.to_vec(), acceptor)
        .spawn()
        .await?;
    Ok(node)
}

struct RawBytesAcceptor<F: Fn(Vec<u8>) + Send + Sync + 'static> {
    on_bytes: F,
}

impl<F: Fn(Vec<u8>) + Send + Sync + 'static> std::fmt::Debug for RawBytesAcceptor<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawBytesAcceptor").finish_non_exhaustive()
    }
}

impl<F: Fn(Vec<u8>) + Send + Sync + 'static> iroh::node::ProtocolHandler for RawBytesAcceptor<F> {
    fn accept(
        self: Arc<Self>,
        connecting: iroh::net::endpoint::Connecting,
    ) -> futures_lite::future::Boxed<std::result::Result<(), anyhow::Error>> {
        Box::pin(async move {
            let conn = connecting.await?;
            let (mut send, mut recv) = conn.accept_bi().await?;
            let bytes = recv.read_to_end(64 * 1024).await?;
            (self.on_bytes)(bytes);
            send.finish()?;
            send.stopped().await?;
            Ok(())
        })
    }
}
