//! murmur: integration crate stitching together murmur-id + murmur-log +
//! murmur-transport. Provides a high-level API to (a) load or create a
//! per-contact identity, (b) build outgoing envelopes, (c) accept
//! incoming envelopes and persist payloads to per-contact logs.

pub mod config;

#[cfg(feature = "iroh")]
pub mod iroh_integration;

use murmur_id::{Identity, IdentityError, IdentityPublic};
use murmur_log::{Log, LogError};
use murmur_transport::{Envelope, EnvelopeError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MurmurError {
    #[error("identity error: {0}")]
    Identity(#[from] IdentityError),
    #[error("log error: {0}")]
    Log(#[from] LogError),
    #[error("envelope error: {0}")]
    Envelope(#[from] EnvelopeError),
    #[error("config error: {0}")]
    Config(#[from] config::ConfigError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("postcard error: {0}")]
    Postcard(#[from] postcard::Error),
}

/// Identity + I/O for one local user ("self"). One `Murmur` per contact.
pub struct Murmur {
    home_dir: std::path::PathBuf,
    identity: Identity,
    name: String,
}

impl Murmur {
    /// Load (or create) a `Murmur` for the given contact name.
    ///
    /// If `<home_dir>/identity.bin` exists, it is loaded; otherwise a fresh
    /// ed25519+X25519 identity is generated and persisted to disk.
    pub fn load_or_create(home_dir: &std::path::Path, name: &str) -> Result<Self, MurmurError> {
        std::fs::create_dir_all(home_dir)?;
        let id_path = home_dir.join("identity.bin");
        let identity = if id_path.exists() {
            let bytes = std::fs::read(&id_path)?;
            Identity::from_bytes(&bytes)?
        } else {
            let mut rng = rand::thread_rng();
            let id = Identity::generate(&mut rng);
            std::fs::write(&id_path, id.to_bytes()?)?;
            id
        };
        Ok(Self {
            home_dir: home_dir.to_path_buf(),
            identity,
            name: name.to_string(),
        })
    }

    /// Load an existing murmur user from disk; Err if no identity exists yet.
    pub fn load(home_dir: &std::path::Path, name: &str) -> Result<Self, MurmurError> {
        let id_path = home_dir.join("identity.bin");
        let bytes = std::fs::read(&id_path)?;
        let identity = Identity::from_bytes(&bytes)?;
        Ok(Self {
            home_dir: home_dir.to_path_buf(),
            identity,
            name: name.to_string(),
        })
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn public(&self) -> IdentityPublic {
        self.identity.public()
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn home_dir(&self) -> &std::path::Path {
        &self.home_dir
    }

    /// Build an outgoing envelope addressed to `to_npub`.
    ///
    /// The envelope is signed by self; ready to be handed off to a
    /// transport. Persistence (recording into the outgoing log) is a
    /// separate call so callers can choose to record before or after
    /// proving delivery.
    pub fn build_envelope(
        &self,
        _to_npub: &str,
        payload: &[u8],
    ) -> Result<Envelope, MurmurError> {
        let env = Envelope::sign(&self.identity, payload.to_vec())?;
        Ok(env)
    }

    /// Append an envelope to the outgoing log for `to_contact`.
    pub fn record_outgoing(
        &self,
        to_contact: &str,
        envelope: &Envelope,
        timestamp: u64,
    ) -> Result<[u8; 32], MurmurError> {
        let bytes = postcard::to_stdvec(envelope)?;
        let mut log = self.outgoing_log(to_contact)?;
        Ok(log.append_payload(timestamp, bytes)?)
    }

    /// Verify a received envelope and persist its payload into the
    /// incoming log for `from_contact`.
    pub fn receive_from(
        &self,
        from_contact: &str,
        from_pub: &IdentityPublic,
        envelope: &Envelope,
        timestamp: u64,
    ) -> Result<[u8; 32], MurmurError> {
        envelope.verify(from_pub)?;
        let mut log = self.incoming_log(from_contact)?;
        Ok(log.append_payload(timestamp, envelope.payload.clone())?)
    }

    pub fn incoming_log(&self, contact: &str) -> Result<Log, LogError> {
        let dir = self.home_dir.join("incoming");
        std::fs::create_dir_all(&dir)?;
        Log::open(dir, contact)
    }

    pub fn outgoing_log(&self, contact: &str) -> Result<Log, LogError> {
        let dir = self.home_dir.join("outgoing");
        std::fs::create_dir_all(&dir)?;
        Log::open(dir, contact)
    }
}
