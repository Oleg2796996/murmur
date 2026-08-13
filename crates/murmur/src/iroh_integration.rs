//! iroh bridge: spawn a listener that persists incoming envelopes into the
//! `Murmur` instance's incoming log. Single-peer MVP: one listener = one
//! expected sender.

use super::{MurmurError, Murmur};
use futures_lite::io::AsyncWriteExt;
use iroh::net::endpoint::Endpoint;
use iroh::net::NodeId;
use iroh::node::MemNode;
use murmur_id::IdentityPublic;
use murmur_transport::iroh_transport::{spawn_memory_node, ALPN};
use murmur_transport::Envelope;
use std::sync::Arc;

pub type IrohResult<T> = std::result::Result<T, anyhow::Error>;

/// Spawn an iroh listener that accepts envelopes from `expected_sender`
/// and persists payloads to `<murmur_home>/incoming/<from_contact>.log`.
///
/// Returns the live `MemNode` handle for inspection (e.g. to print node id
/// or shut down).
pub async fn listen(
    murmur: Arc<Murmur>,
    expected_sender: IdentityPublic,
    from_contact: String,
) -> IrohResult<MemNode> {
    let on_envelope = move |env: Envelope| {
        // Build the entry: payload + timestamp (now).
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

    let node = spawn_memory_node(expected_sender, on_envelope).await?;
    Ok(node)
}

/// Send an envelope to `target_node_id` using a plain iroh endpoint
/// (the sender doesn't need its own murmur ALPN). Returns after the
/// receiver acks.
pub async fn send_envelope_via_endpoint(
    sender_endpoint: &Endpoint,
    target_node_id: NodeId,
    envelope: &Envelope,
) -> IrohResult<()> {
    let bytes = postcard::to_stdvec(envelope)?;
    let conn = sender_endpoint
        .connect_by_node_id(target_node_id, ALPN)
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
