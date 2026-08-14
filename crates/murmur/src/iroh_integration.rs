//! iroh bridge: spawn a listener that persists incoming envelopes into the
//! `Murmur` instance's incoming log. Single-peer MVP: one listener = one
//! expected sender.

use super::{MurmurError, Murmur};
use futures_lite::io::AsyncWriteExt;
use iroh::net::endpoint::Endpoint;
use iroh::net::NodeId;
use iroh::node::MemNode;
use murmur_id::IdentityPublic;
use murmur_transport::iroh_transport::{spawn_persistent_node, ALPN};
use murmur_transport::Envelope;
use std::sync::Arc;

pub type IrohResult<T> = std::result::Result<T, anyhow::Error>;

/// Spawn an iroh **real-network** listener (UDP socket, not loopback) that
/// accepts envelopes from `expected_sender` and persists payloads to
/// `<murmur_home>/incoming/<from_contact>.log`.
///
/// Uses `bind_random_port` + `RelayMode::Disabled` + `DiscoveryConfig::None`
/// so it does NOT contact n0 relays. Callers must supply the node's
/// public direct address (e.g. via Tailscale) for cross-machine connect.
///
/// Returns the live `MemNode` handle plus `(node_id, first bind addr)`
/// for printing a share-link.
pub async fn listen(
    murmur: Arc<Murmur>,
    expected_sender: IdentityPublic,
    from_contact: String,
) -> IrohResult<(MemNode, NodeId, std::net::SocketAddr)> {
    let on_envelope = move |env: Envelope| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let m = murmur.clone();
        let fc = from_contact.clone();
        let es = expected_sender;
        let r: std::result::Result<(), MurmurError> =
            m.receive_from(&fc, &es, &env, ts).map(|_| ());
        if let Err(e) = r {
            eprintln!("[murmur] receive_from failed: {e}");
        }
    };

    let node = spawn_persistent_node(expected_sender, on_envelope).await?;
    let node_id = node.node_id();
    let addrs = node.local_endpoint_addresses().await?;
    let first = addrs
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no local endpoint addresses"))?;
    Ok((node, node_id, first))
}

/// Build a `NodeAddr` for a peer (no relay, single direct address).
pub fn build_node_addr(node_id: NodeId, direct: std::net::SocketAddr) -> iroh::net::NodeAddr {
    iroh::net::NodeAddr::from_parts(node_id, None, vec![direct])
}

/// Send an envelope to `target_node_addr` using a plain iroh endpoint
/// (the sender doesn't need its own murmur ALPN). Returns after the
/// receiver acks.
///
/// `target_node_addr` carries both the node_id and direct addresses
/// (and optionally a relay URL). For cross-machine E2E without relay,
/// construct with `build_node_addr(node_id, "ip:port")`.
pub async fn send_envelope_via_endpoint(
    sender_endpoint: &Endpoint,
    target_node_addr: iroh::net::NodeAddr,
    envelope: &Envelope,
) -> IrohResult<()> {
    let bytes = postcard::to_stdvec(envelope)?;
    let conn = sender_endpoint
        .connect(target_node_addr, ALPN)
        .await?;
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(&bytes).await?;
    send.finish()?;
    let _ack = recv.read_to_end(1).await?;
    Ok(())
}

/// Convenience: spawn a plain iroh node (no ALPN) for use as a sender.
pub async fn spawn_sender_endpoint() -> IrohResult<Endpoint> {
    let node = iroh::node::Node::memory().build().await?.spawn().await?;
    Ok(node.endpoint().clone())
}
