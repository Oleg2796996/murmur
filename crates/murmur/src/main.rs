//! `murmur` CLI — Step 4 MVP.
//!
//! Subcommands:
//! - `init`            — create identity + home_dir
//! - `whoami`          — print own npub
//! - `add-peer <alias> <npub> [<node_id>@<ip>:<port>]` — register a peer (with optional NodeAddr)
//! - `send <contact> <msg>` — record outgoing envelope (no network, Step 4)
//! - `send-iroh <alias> <msg>` — (feature: iroh) send signed envelope via iroh
//! - `listen`               — (feature: iroh) spawn iroh listener, print share-link, block until SIGINT
//! - `verify <contact>`     — verify incoming log for `<contact>`
//! - `root <contact>`       — print Merkle root of incoming log
//! - `count <contact>`      — number of entries in incoming log
//! - `peers`                — list registered peers
//!
//! Network IO (send/listen) is feature-gated: `cargo run -p murmur --features iroh -- listen`.

use clap::{Parser, Subcommand};
use murmur::config::MurmurConfig;
use murmur_id::IdentityPublic;
use murmur_log::MerkleRoot;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "murmur", version, about = "Decentralized messenger")]
struct Cli {
    /// Path to murmur.toml. $MURMUR_CONFIG or ./murmur.toml if omitted.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Create identity + home_dir (idempotent).
    Init,
    /// Print own npub.
    Whoami,
    /// Register a peer by npub into contacts.toml (alphanumeric alias).
    AddPeer {
        alias: String,
        npub: String,
        /// Optional node_id@ip:port for direct iroh connect (no relay).
        /// Example: `murmur add-peer bob npub1... abc123...@127.0.0.1:5678`
        share: Option<String>,
    },
    /// Build + sign an envelope, record it into the outgoing log for `<contact>`.
    Send {
        contact: String,
        /// Read message bytes from this file instead of CLI arg.
        #[arg(long)]
        from_file: Option<PathBuf>,
        /// Message bytes (ignored if --from-file is set).
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        message: Vec<String>,
    },
    /// Verify the incoming log for `<contact>` end-to-end.
    Verify {
        contact: String,
    },
    /// Print Merkle root of the incoming log for `<contact>`.
    Root {
        contact: String,
    },
    /// Print number of entries in incoming log for `<contact>`.
    Count {
        contact: String,
    },
    /// List registered peers.
    Peers,
    /// (feature: iroh) Spawn an iroh listener, print share-link, block until SIGINT.
    #[cfg(feature = "iroh")]
    Listen {
        /// Alias of the expected sender (must exist in contacts.toml).
        from_contact: String,
    },
    /// (feature: iroh) Send a signed envelope via iroh to a peer whose
    /// `node_id` and direct address are stored in `contacts.toml`.
    #[cfg(feature = "iroh")]
    SendIroh {
        contact: String,
        /// Read message bytes from this file instead of CLI arg.
        #[arg(long)]
        from_file: Option<PathBuf>,
        /// Message bytes (ignored if --from-file is set).
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        message: Vec<String>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let cfg = MurmurConfig::resolve(cli.config.as_deref())?
        .ok_or("no config found: pass --config, set $MURMUR_CONFIG, or create ./murmur.toml")?;
    std::fs::create_dir_all(&cfg.home_dir)?;

    match cli.cmd {
        Cmd::Init => {
            let _ = murmur::Murmur::load_or_create(&cfg.home_dir, &cfg.name)?;
            println!("initialized murmur at {}", cfg.home_dir.display());
        }
        Cmd::Whoami => {
            let m = require_murmur(&cfg)?;
            println!("{}", m.public().npub());
        }
        Cmd::AddPeer { alias, npub, share } => {
            let _ = IdentityPublic::from_npub(&npub).map_err(|e| format!("bad npub: {e}"))?;
            // If a share string was provided, validate by parsing it.
            #[cfg(feature = "iroh")]
            if let Some(s) = &share {
                if parse_share_string(s).is_none() {
                    return Err(format!("bad share string '{s}'; expected <node_id>@<ip>:<port>").into());
                }
            }
            add_peer(&cfg.home_dir, &alias, &npub, share.as_deref())?;
            println!("added peer {alias}");
        }
        Cmd::Send { contact, from_file, message } => {
            let m = require_murmur(&cfg)?;
            let peers = load_peers_npub_only(&cfg.home_dir)?;
            let npub = peers
                .get(&contact)
                .ok_or_else(|| format!("unknown contact '{contact}'; run `murmur add-peer {contact} <npub>` first"))?;
            let payload: Vec<u8> = if let Some(p) = from_file {
                std::fs::read(p)?
            } else {
                message.join(" ").into_bytes()
            };
            let timestamp = unix_now_secs();
            let env = m.build_envelope(npub, &payload)?;
            let hash = m.record_outgoing(&contact, &env, timestamp)?;
            println!("recorded outgoing envelope to {contact}: {}", hex::encode(hash));
        }
        Cmd::Verify { contact } => {
            let m = require_murmur(&cfg)?;
            let log = m.incoming_log(&contact)?;
            log.verify()?;
            println!("ok: incoming log '{contact}' verifies ({} entries)", log.len());
        }
        Cmd::Root { contact } => {
            let m = require_murmur(&cfg)?;
            let log = m.incoming_log(&contact)?;
            let r: MerkleRoot = log
                .merkle_root()
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            println!("{}", hex::encode(r.as_bytes()));
        }
        Cmd::Count { contact } => {
            let m = require_murmur(&cfg)?;
            let log = m.incoming_log(&contact)?;
            println!("{}", log.len());
        }
        Cmd::Peers => {
            let peers = load_peers(&cfg.home_dir)?;
            if peers.is_empty() {
                println!("(no peers)");
            } else {
                for (alias, (npub, share)) in peers {
                    if share.is_empty() {
                        println!("{alias} = {npub}");
                    } else {
                        println!("{alias} = {npub}  ({share})");
                    }
                }
            }
        }
        #[cfg(feature = "iroh")]
        Cmd::Listen { from_contact } => {
            let m = require_murmur(&cfg)?;
            let peers = load_peers(&cfg.home_dir)?;
            let (from_npub, _from_share) = peers
                .get(&from_contact)
                .ok_or_else(|| format!("unknown peer '{from_contact}'; run `murmur add-peer {from_contact} <npub> [<node_id>@<ip>:<port>]` first"))?;
            let from_pub = IdentityPublic::from_npub(from_npub)
                .map_err(|e| format!("bad peer npub: {e}"))?;
            let m_arc = std::sync::Arc::new(m);
            let rt = tokio::runtime::Runtime::new()?;
            let npub = m_arc.public().npub();
            let (_node, node_id, addr) = rt.block_on(async {
                murmur::iroh_integration::listen(m_arc.clone(), from_pub, from_contact.clone()).await
            })?;
            let share = murmur_transport::iroh_transport::build_share_string(&node_id, addr);
            println!("{npub}");
            println!("listening on {addr}");
            println!("share-link: {share}");
            println!("waiting until SIGINT...");
            rt.block_on(async {
                tokio::signal::ctrl_c().await.ok();
            });
            return Ok(());
        }
        #[cfg(feature = "iroh")]
        Cmd::SendIroh { contact, from_file, message } => {
            let m = require_murmur(&cfg)?;
            let peers = load_peers(&cfg.home_dir)?;
            let (to_npub, to_addr) = peers
                .get(&contact)
                .ok_or_else(|| format!("unknown contact '{contact}'"))?
                .clone();
            let _ = to_npub;  // alias for the (npub,share) pair below
            let addr = parse_share_string(&to_addr)
                .ok_or_else(|| format!("peer '{contact}' has no valid node_addr; run `murmur add-peer {contact} <npub> <node_id>@<ip>:<port>` again"))?;
            let payload: Vec<u8> = if let Some(p) = from_file {
                std::fs::read(p)?
            } else {
                message.join(" ").into_bytes()
            };
            let timestamp = unix_now_secs();
            let env = m.build_envelope(&to_npub, &payload)?;
            let hash = m.record_outgoing(&contact, &env, timestamp)?;
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let endpoint = murmur::iroh_integration::spawn_sender_endpoint().await?;
                murmur::iroh_integration::send_envelope_via_endpoint(&endpoint, addr, &env).await
            })?;
            println!("recorded outgoing envelope to {contact}: {}", hex::encode(hash));
        }
    }
    Ok(())
}

fn require_murmur(cfg: &MurmurConfig) -> Result<murmur::Murmur, Box<dyn std::error::Error>> {
    Ok(murmur::Murmur::load(&cfg.home_dir, &cfg.name)?)
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ===== contacts.toml =====
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Default, Serialize, Deserialize)]
struct ContactsFile {
    #[serde(default)]
    peers: BTreeMap<String, String>,
}

fn contacts_path(home_dir: &std::path::Path) -> PathBuf {
    home_dir.join("contacts.toml")
}

fn load_peers(home_dir: &std::path::Path) -> Result<BTreeMap<String, (String, String)>, Box<dyn std::error::Error>> {
    let p = contacts_path(home_dir);
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&p)?;
    let cf: ContactsFile = toml::from_str(&text)?;
    let mut out = BTreeMap::new();
    for (alias, stored) in cf.peers {
        // Format: `<npub>` or `<npub>\n<share>`.
        let mut parts = stored.splitn(2, '\n');
        let npub = parts.next().unwrap_or("").to_string();
        let share = parts.next().unwrap_or("").to_string();
        out.insert(alias, (npub, share));
    }
    Ok(out)
}

#[cfg_attr(not(feature = "iroh"), allow(dead_code))]
fn load_peers_npub_only(home_dir: &std::path::Path) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let p = contacts_path(home_dir);
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&p)?;
    let cf: ContactsFile = toml::from_str(&text)?;
    Ok(cf.peers.into_iter().map(|(a, v)| (a, v.splitn(2, '\n').next().unwrap_or("").to_string())).collect())
}

fn add_peer(home_dir: &std::path::Path, alias: &str, npub: &str, share: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let p = contacts_path(home_dir);
    let mut cf: ContactsFile = if p.exists() {
        toml::from_str(&std::fs::read_to_string(&p)?)?
    } else {
        ContactsFile::default()
    };
    // Store as `<npub>` (no NodeAddr) or `<npub>\n<share>` in the TOML
    // value. We split on the first newline when reading.
    let stored = match share {
        Some(s) => format!("{npub}\n{s}"),
        None => npub.to_string(),
    };
    cf.peers.insert(alias.to_string(), stored);
    std::fs::write(&p, toml::to_string(&cf)?)?;
    Ok(())
}


/// Parse a share-string `<node_id>@<ip>:<port>` into a `NodeAddr`.
/// Note: this needs the `iroh` feature at the type level; we keep the
/// helper gate-free so it compiles regardless.
#[cfg(feature = "iroh")]
fn parse_share_string(s: &str) -> Option<iroh::net::NodeAddr> {
    let (node_id_str, addr_str) = s.split_once('@')?;
    let node_id: iroh::net::NodeId = node_id_str.parse().ok()?;
    let addr: std::net::SocketAddr = addr_str.parse().ok()?;
    Some(murmur::iroh_integration::build_node_addr(node_id, addr))
}

fn to_identity_public(npub: &str) -> Result<IdentityPublic, Box<dyn std::error::Error>> {
    Ok(IdentityPublic::from_npub(npub)?)
}
