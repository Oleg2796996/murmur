//! `murmur` CLI — Step 4 MVP.
//!
//! Subcommands:
//! - `init`            — create identity + home_dir
//! - `whoami`          — print own npub
//! - `add-peer <npub>` — register a peer by npub (writes to contacts.toml)
//! - `send <contact> <msg>` — record outgoing envelope (no network in Step 4)
//! - `verify <contact>`     — verify incoming log for `<contact>`
//! - `root <contact>`       — print Merkle root of incoming log
//! - `count <contact>`      — number of entries in incoming log
//! - `listen`               — (feature: iroh) spawn iroh listener
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
        Cmd::AddPeer { alias, npub } => {
            let _ = IdentityPublic::from_npub(&npub).map_err(|e| format!("bad npub: {e}"))?;
            add_peer(&cfg.home_dir, &alias, &npub)?;
            println!("added peer {alias}");
        }
        Cmd::Send { contact, from_file, message } => {
            let m = require_murmur(&cfg)?;
            let peers = load_peers(&cfg.home_dir)?;
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
                for (alias, npub) in peers {
                    println!("{alias} = {npub}");
                }
            }
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

fn load_peers(home_dir: &std::path::Path) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let p = contacts_path(home_dir);
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&p)?;
    let cf: ContactsFile = toml::from_str(&text)?;
    Ok(cf.peers)
}

fn add_peer(home_dir: &std::path::Path, alias: &str, npub: &str) -> Result<(), Box<dyn std::error::Error>> {
    let p = contacts_path(home_dir);
    let mut cf: ContactsFile = if p.exists() {
        toml::from_str(&std::fs::read_to_string(&p)?)?
    } else {
        ContactsFile::default()
    };
    cf.peers.insert(alias.to_string(), npub.to_string());
    std::fs::write(&p, toml::to_string(&cf)?)?;
    Ok(())
}
