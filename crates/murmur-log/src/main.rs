//! murmur-log CLI
//!
//! Subcommands:
//!   append <contact> <message>     Append a message to the log
//!   verify <contact>               Verify chain integrity
//!   root <contact>                 Print Merkle root
//!   count <contact>                Print entry count
//!
//! All commands take `--dir <PATH>` (default: $MURMUR_HOME or ./murmur-data).

use clap::{Parser, Subcommand};
use murmur_log::{Entry, Log};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(name = "murmur-log", version, about = "Append-only log with Merkle anchoring")]
struct Cli {
    /// Base directory for log files
    #[arg(long, env = "MURMUR_HOME", default_value = "./murmur-data")]
    dir: PathBuf,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Append a UTF-8 message to the log
    Append {
        contact: String,
        message: String,
        /// UNIX timestamp override (default: now)
        #[arg(long)]
        timestamp: Option<u64>,
    },
    /// Verify chain integrity
    Verify { contact: String },
    /// Print Merkle root (hex)
    Root { contact: String },
    /// Print entry count
    Count { contact: String },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(msg) => {
            if !msg.is_empty() {
                println!("{}", msg);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {}", e);
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<String, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&cli.dir)?;
    match cli.cmd {
        Cmd::Append { contact, message, timestamp } => {
            let mut log = Log::open(&cli.dir, &contact)?;
            let seq = log.len() as u64;
            let ts = timestamp.unwrap_or_else(now_unix);
            let prev = if log.is_empty() {
                [0u8; 32]
            } else {
                // Re-derive prev from current chain head: we need to compute
                // the last entry's hash. Cheap way: append a zero-hash entry is
                // forbidden, so we just track via a sentinel — instead, just
                // use the chain head exposed by the next entry's prev_hash.
                // For MVP we recompute by re-opening and reading the last entry.
                read_last_hash(&cli.dir, &contact)?
            };
            let entry = Entry::new(seq, ts, message.into_bytes(), prev)?;
            let hash = log.append(&entry)?;
            Ok(format!("appended seq={} hash={}", seq, hex_lower(&hash)))
        }
        Cmd::Verify { contact } => {
            let log = Log::open(&cli.dir, &contact)?;
            log.verify()?;
            Ok(format!("ok ({} entries)", log.len()))
        }
        Cmd::Root { contact } => {
            let log = Log::open(&cli.dir, &contact)?;
            let root = log.merkle_root()?;
            Ok(hex_lower(root.as_bytes()).to_string())
        }
        Cmd::Count { contact } => {
            let log = Log::open(&cli.dir, &contact)?;
            Ok(format!("{}", log.len()))
        }
    }
}

fn read_last_hash(dir: &std::path::Path, contact: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    // Open a fresh Log (it rebuilds the chain in memory), then read its merkle
    // root of a single-leaf tree would not be the last hash. Instead, we expose
    // the chain head via a dedicated helper. For MVP we use the entry file: the
    // last entry's hash IS what we want, and merkle_root with 1 leaf == that hash.
    // Open a fresh Log (it rebuilds the chain in memory) so we can read the
    // final entry off disk. We discard it after extracting the hash.
    let _log = Log::open(dir, contact)?;
    // merkle_root of n entries != last hash; we need a different approach.
    // Workaround: re-read the last entry from disk.
    use std::io::{Read, BufReader};
    let path = dir.join(format!("{}.log", contact));
    let file = std::fs::File::open(&path)?;
    let mut reader = BufReader::new(file);
    let mut last_entry: Option<Entry> = None;
    loop {
        let mut len_buf = [0u8; 4];
        match reader.read_exact(&mut len_buf) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        reader.read_exact(&mut payload)?;
        let entry: Entry = postcard::from_bytes(&payload)?;
        last_entry = Some(entry);
    }
    match last_entry {
        Some(e) => Ok(e.hash()),
        None => Ok([0u8; 32]),
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}