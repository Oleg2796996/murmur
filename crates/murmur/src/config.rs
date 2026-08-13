//! TOML config for the murmur binary.
//!
//! Example `murmur.toml`:
//! ```toml
//! name = "oleg"
//! home_dir = "~/.murmur"
//! ```
//!
//! Resolution order: `--config <path>` → `$MURMUR_CONFIG` → `./murmur.toml`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse error: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("toml serialize error: {0}")]
    TomlSer(#[from] toml::ser::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MurmurConfig {
    pub name: String,
    pub home_dir: PathBuf,
}

impl MurmurConfig {
    /// Try to load config from `path`. Returns `Ok` only if file exists and parses.
    pub fn from_path(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path)?;
        let cfg: Self = toml::from_str(&text)?;
        Ok(cfg)
    }

    /// Resolve config from candidate sources in order: explicit path,
    /// then `$MURMUR_CONFIG`, then `./murmur.toml`. Returns `None` if no
    /// candidate exists.
    pub fn resolve(explicit: Option<&Path>) -> Result<Option<Self>, ConfigError> {
        let candidates: Vec<PathBuf> = match explicit {
            Some(p) => vec![p.to_path_buf()],
            None => {
                let mut v = Vec::new();
                if let Ok(env_p) = std::env::var("MURMUR_CONFIG") {
                    v.push(PathBuf::from(env_p));
                }
                v.push(PathBuf::from("murmur.toml"));
                v
            }
        };
        for cand in &candidates {
            if cand.exists() {
                return Ok(Some(Self::from_path(cand)?));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config() {
        let text = r#"
            name = "oleg"
            home_dir = "/tmp/murmur-test"
        "#;
        let cfg: MurmurConfig = toml::from_str(text).expect("parse");
        assert_eq!(cfg.name, "oleg");
        assert_eq!(cfg.home_dir, std::path::PathBuf::from("/tmp/murmur-test"));
    }

    #[test]
    fn roundtrip_to_toml() {
        let cfg = MurmurConfig {
            name: "oleg".into(),
            home_dir: PathBuf::from("/tmp/murmur-test"),
        };
        let text = toml::to_string(&cfg).expect("serialize");
        let back: MurmurConfig = toml::from_str(&text).expect("deserialize");
        assert_eq!(cfg, back);
    }

    #[test]
    fn missing_file_returns_none() {
        let cfg = MurmurConfig::resolve(Some(std::path::Path::new("/no/such/file.toml")))
            .expect("resolve ok");
        assert!(cfg.is_none());
    }
}
