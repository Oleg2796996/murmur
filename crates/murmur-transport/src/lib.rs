//! murmur-transport — iroh endpoint + signed envelopes for murmur.
//!
//! MVP-01 scope:
//! - `Envelope { payload, signature, sender_npub }` — postcard-serialized,
//!   ed25519-signed, sender-bound (npub is part of the signed bytes).
//! - iroh `Endpoint` with custom protocol `murmur/0` (single ALPN for the MVP).
//! - Direct NodeAddr discovery (no DHT/DNS) — share-link is `npub1...#node_id`.
//!
//! MVP-02+: swap to Tor/Nym dialer via iroh's transport-agnostic Endpoint.

use murmur_id::IdentityPublic;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use thiserror::Error;

/// ALPN string identifying the murmur protocol on iroh connections.
pub const ALPN: &[u8] = b"murmur/0";

/// Domain separator for the envelope signature payload.
/// `signature_input = HASH_DOMAIN || sender_npub || payload`
const HASH_DOMAIN: &[u8; 8] = b"murmur-e";

/// A signed message envelope.
///
/// Wire format: postcard(self). `signature` is a fixed 64-byte ed25519
/// signature, serialized as a `Vec<u8>` with a length invariant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub payload: Vec<u8>,
    pub signature: Vec<u8>,
    pub sender_npub: String,
}

impl Envelope {
    /// Sign `payload` with `sender`'s identity. The signature is over
    /// `HASH_DOMAIN || sender.npub() || payload` — binding both the bytes
    /// and the claimed sender.
    pub fn sign(sender: &murmur_id::Identity, payload: Vec<u8>) -> Result<Self, EnvelopeError> {
        let npub = sender.public().npub();
        let signature = sender.sign(&signature_input(&npub, &payload)).to_vec();
        Ok(Self { payload, signature, sender_npub: npub })
    }

    /// Verify the envelope's signature against `claimed_sender`'s public key.
    ///
    /// Steps:
    /// 1. Parse `sender_npub` → `IdentityPublic`. (Mismatch error if invalid.)
    /// 2. Recompute `signature_input(npub, payload)` and verify ed25519.
    pub fn verify(&self, claimed_sender: &IdentityPublic) -> Result<(), EnvelopeError> {
        let parsed = IdentityPublic::from_npub(&self.sender_npub)?;
        if parsed.signing_pubkey() != claimed_sender.signing_pubkey() {
            return Err(EnvelopeError::NpubMismatch);
        }
        let sig: &[u8; 64] = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| EnvelopeError::InvalidSignature)?;
        let expected_sig = claimed_sender.verify(
            &signature_input(&self.sender_npub, &self.payload),
            sig,
        );
        if !expected_sig {
            return Err(EnvelopeError::InvalidSignature);
        }
        Ok(())
    }
}

/// Compute the bytes that are signed/verified for an envelope.
fn signature_input(npub: &str, payload: &[u8]) -> Vec<u8> {
    let mut hasher = Sha3_256::new();
    hasher.update(HASH_DOMAIN);
    hasher.update((npub.len() as u32).to_le_bytes());
    hasher.update(npub.as_bytes());
    hasher.update((payload.len() as u32).to_le_bytes());
    hasher.update(payload);
    let out = hasher.finalize();
    out.to_vec()
}

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("invalid signature")]
    InvalidSignature,
    #[error("sender npub does not match expected public key")]
    NpubMismatch,
    #[error("identity error: {0}")]
    Identity(#[from] murmur_id::IdentityError),
    #[error("postcard: {0}")]
    Postcard(#[from] postcard::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("transport: {0}")]
    Transport(String),
}

// --- iroh integration (gated behind `iroh` feature; tests don't need it) ---

#[cfg(feature = "iroh")]
pub mod iroh_transport {
    //! iroh-backed accept/connect helpers for `Envelope`.
    //!
    //! Skeleton: spawn an iroh node, register the murmur ALPN, and provide
    //! `send_envelope(node_id, envelope)` / `accept_loop(handler)`.
    //! Full impl in a follow-up commit; the envelope layer is independently
    //! tested above.

    use super::*;
    use iroh::node::{Node, ProtocolHandler};
    use std::sync::Arc;

    /// Handler that accepts bi-stream connections on ALPN, reads a postcard
    /// Envelope, verifies signature against `expected_sender`, and invokes
    /// `on_envelope` for each valid envelope.
    pub struct EnvelopeAcceptor<F: Fn(Envelope) + Send + Sync + 'static> {
        pub expected_sender: IdentityPublic,
        pub on_envelope: F,
    }

    impl<F: Fn(Envelope) + Send + Sync + 'static> std::fmt::Debug for EnvelopeAcceptor<F> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("EnvelopeAcceptor")
                .field("expected_sender", &self.expected_sender.npub())
                .finish_non_exhaustive()
        }
    }

    impl<F: Fn(Envelope) + Send + Sync + 'static> ProtocolHandler for EnvelopeAcceptor<F> {
        fn accept(
            self: Arc<Self>,
            connecting: iroh::net::endpoint::Connecting,
        ) -> futures_lite::future::Boxed<std::result::Result<(), anyhow::Error>> {
            Box::pin(async move {
                let conn = connecting.await?;
                let (mut send, mut recv) = conn.accept_bi().await?;
                let bytes = recv.read_to_end(64 * 1024).await?;
                let env: Envelope = postcard::from_bytes(&bytes)?;
                let parsed = IdentityPublic::from_npub(&env.sender_npub)
                    .map_err(|e| anyhow::anyhow!("invalid npub: {e}"))?;
                if parsed.signing_pubkey() != self.expected_sender.signing_pubkey() {
                    return Err(anyhow::anyhow!(EnvelopeError::NpubMismatch));
                }
                if !self.expected_sender.verify(
                    &signature_input(&env.sender_npub, &env.payload),
                    env.signature
                        .as_slice()
                        .try_into()
                        .map_err(|_| anyhow::anyhow!(EnvelopeError::InvalidSignature))?,
                ) {
                    return Err(anyhow::anyhow!(EnvelopeError::InvalidSignature));
                }
                (self.on_envelope)(env);
                send.finish()?;
                send.stopped().await?;
                Ok(())
            })
        }
    }

    /// Spawn an in-memory iroh node with the murmur ALPN registered.
    pub use super::ALPN;
    pub async fn spawn_memory_node<F: Fn(Envelope) + Send + Sync + 'static>(
        expected_sender: IdentityPublic,
        on_envelope: F,
    ) -> std::result::Result<iroh::node::MemNode, anyhow::Error> {
        let acceptor = Arc::new(EnvelopeAcceptor { expected_sender, on_envelope });
        let node = Node::memory().build().await?.accept(ALPN.to_vec(), acceptor).spawn().await?;
        Ok(node)
    }
}