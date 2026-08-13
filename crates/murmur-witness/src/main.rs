//! `murmur-witness` CLI — Step 5 MVP.
//!
//! Subcommands:
//! - `submit <contact>` — submit the contact's incoming Merkle root to OTS
//! - `status <contact>` — print last-attempt status
//! - `pending`           — list contacts that have a pending failure
//! - `prove <contact>`   — (TODO) verify on-disk `.ots` against Bitcoin

use clap::{Parser, Subcommand};
use murmur_log::Log;
use murmur_witness::Witness;

#[derive(Parser, Debug)]
#[command(name = "murmur-witness", version, about = "OTS witness layer for murmur")]
struct Cli {
    /// Murmur home directory (where contacts live and logs are stored).
    #[arg(long, env = "MURMUR_HOME", default_value = "./murmur-data")]
    home: std::path::PathBuf,

    /// Contact name (matches murmur-log file). Required for per-contact subcommands.
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Submit the Merkle root of the contact's incoming log to OTS.
    Submit { contact: String },
    /// Print witness status for a contact.
    Status { contact: String },
    /// List contacts with a pending (failed) witness attempt.
    Pending,
    /// (TODO) Verify the latest `.ots` against Bitcoin. Not implemented yet.
    Prove { contact: String },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    std::fs::create_dir_all(&cli.home)?;

    match cli.cmd {
        Cmd::Submit { contact } => {
            let witness = Witness::new(&cli.home, &contact)?;
            let log = Log::open(cli.home.join("incoming"), &contact)?;
            let root = match log.merkle_root() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("cannot compute merkle root: {e}");
                    std::process::exit(1);
                }
            };
            match witness.submit(&root)? {
                murmur_witness::SubmitOutcome::Ok { ots_path, digest_hex, calendar_url } => {
                    println!("ok: digest={digest_hex} via {calendar_url}");
                    println!("saved: {}", ots_path.display());
                }
                murmur_witness::SubmitOutcome::Pending { pending_path, digest_hex, error } => {
                    eprintln!("pending: digest={digest_hex}");
                    eprintln!("error: {error}");
                    eprintln!("saved: {}", pending_path.display());
                    std::process::exit(2);
                }
            }
        }
        Cmd::Status { contact } => {
            let witness = Witness::new(&cli.home, &contact)?;
            let s = witness.status()?;
            if let Some(m) = &s.meta {
                println!("contact:    {}", m.contact);
                println!("digest:     {}", m.digest_hex);
                println!("calendar:   {}", m.calendar_url);
                println!("last_ok:    {}", m.ok_ts);
                println!("attempts:   {}", m.attempts);
                if let Some(e) = &m.last_error {
                    println!("last_error: {e}");
                }
                if let Some(p) = &s.ots_path {
                    println!("ots_file:   {}", p.display());
                }
            } else {
                println!("no successful submit yet for contact {contact}");
            }
            if let Some(p) = &s.pending {
                println!("---");
                println!("PENDING:    {} at {}", p.started_ts, p.error);
                println!("attempted:  {:?}", p.attempted_calendar);
            }
        }
        Cmd::Pending => {
            let pending_dir = cli.home.join("witness").join("pending");
            std::fs::create_dir_all(&pending_dir)?;
            let mut count = 0;
            for entry in std::fs::read_dir(&pending_dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
                    count += 1;
                    let bytes = std::fs::read(entry.path())?;
                    let rec: murmur_witness::status::PendingRecord = serde_json::from_slice(&bytes)?;
                    println!("{} — {} ({})", rec.contact, rec.error, rec.started_ts);
                }
            }
            if count == 0 {
                println!("(no pending witnesses)");
            }
        }
        Cmd::Prove { contact: _ } => {
            eprintln!("prove is not implemented in MVP-01");
            std::process::exit(1);
        }
    }
    Ok(())
}
