//! murmur-id CLI — Step 1 minimal viable: generate identity, print npub, save to disk.
//!
//! Usage:
//!   murmur-id new [path]   — generate new identity, save to <path> or default ~/.murmur/identity.bin, print npub
//!   murmur-id show [path]  — print npub of identity at <path> or default
//!
//! Default path: $HOME/.murmur/identity.bin (or $MURMUR_HOME/identity.bin if set).

use murmur_id::Identity;
use rand::rngs::OsRng;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

const DEFAULT_PATH: &str = ".murmur/identity.bin";

fn identity_path() -> PathBuf {
    if let Ok(home) = env::var("MURMUR_HOME") {
        return PathBuf::from(home).join("identity.bin");
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(DEFAULT_PATH);
    }
    PathBuf::from(DEFAULT_PATH)
}

fn cmd_new(path: PathBuf) -> ExitCode {
    let id = Identity::generate(&mut OsRng);
    let bytes = match id.to_bytes() {
        Ok(b) => b,
        Err(e) => {
            eprintln!("serialize error: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("mkdir {parent:?} failed: {e}");
            return ExitCode::FAILURE;
        }
    }
    // 0600 - permissions on a key file should be readable only by owner.
    #[cfg(unix)]
    {
        use std::io::Write;
        let mut f = match fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) => {
                eprintln!("open {path:?} failed: {e}");
                return ExitCode::FAILURE;
            }
        };
        if let Err(e) = f.write_all(&bytes) {
            eprintln!("write {path:?} failed: {e}");
            return ExitCode::FAILURE;
        }
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
            eprintln!("chmod 0o600 {path:?} failed: {e}");
            return ExitCode::FAILURE;
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = fs::write(&path, &bytes) {
            eprintln!("write {path:?} failed: {e}");
            return ExitCode::FAILURE;
        }
    }
    println!("wrote {} bytes to {}", bytes.len(), path.display());
    println!("npub: {}", id.public().npub());
    ExitCode::SUCCESS
}

fn cmd_show(path: PathBuf) -> ExitCode {
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {path:?} failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let id = match Identity::from_bytes(&bytes) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("parse identity failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("npub: {}", id.public().npub());
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let path = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(identity_path);

    match cmd {
        "new" => cmd_new(path),
        "show" => cmd_show(path),
        _ => {
            eprintln!("murmur-id — Step 1 minimal CLI");
            eprintln!("usage:");
            eprintln!("  murmur-id new [path]   generate identity, save to <path> or default, print npub");
            eprintln!("  murmur-id show [path]  print npub of identity at <path> or default");
            ExitCode::from(2)
        }
    }
}
