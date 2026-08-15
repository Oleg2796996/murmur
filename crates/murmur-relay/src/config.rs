//! Relay server configuration.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    /// Public name shown in logs (e.g. "vps-murmur-relay").
    pub name: String,
    /// Where to persist pending envelopes (per-contact logs).
    pub home_dir: PathBuf,
    /// WebSocket bind address. Default `0.0.0.0:8443`.
    #[serde(default = "default_ws_bind")]
    pub ws_bind: String,
    /// iroh bind mode. Default "random_port" (uses bind_random_port).
    #[serde(default = "default_iroh_bind")]
    pub iroh_bind: String,
    /// HTTP bind for push registration + delivery. Default `0.0.0.0:8444`.
    #[serde(default = "default_push_bind")]
    pub push_bind: String,
    /// VAPID subject — typically "mailto:admin@example.com".
    /// Used to identify the relay to push services (FCM / Mozilla / Apple).
    #[serde(default = "default_vapid_subject")]
    pub vapid_subject: String,
}

fn default_ws_bind() -> String {
    "0.0.0.0:8443".to_string()
}

fn default_iroh_bind() -> String {
    "0.0.0.0:0".to_string() // random port
}

fn default_push_bind() -> String {
    "0.0.0.0:8444".to_string()
}

fn default_vapid_subject() -> String {
    "mailto:admin@murmur.local".to_string()
}

impl RelayConfig {
    pub fn resolve(explicit: Option<&std::path::Path>) -> Result<Option<Self>, ConfigError> {
        let candidates: Vec<PathBuf> = match explicit {
            Some(p) => vec![p.to_path_buf()],
            None => {
                let mut v = Vec::new();
                if let Ok(env_p) = std::env::var("MURMUR_RELAY_CONFIG") {
                    v.push(PathBuf::from(env_p));
                }
                v.push(PathBuf::from("murmur-relay.toml"));
                v
            }
        };
        for cand in &candidates {
            if cand.exists() {
                let text = std::fs::read_to_string(cand)?;
                let cfg: Self = toml::from_str(&text)?;
                return Ok(Some(cfg));
            }
        }
        Ok(None)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("read config: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse config: {0}")]
    Parse(#[from] toml::de::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal() {
        let text = r#"
            name = "vps"
            home_dir = "/var/lib/murmur-relay"
        "#;
        let cfg: RelayConfig = toml::from_str(text).unwrap();
        assert_eq!(cfg.name, "vps");
        assert_eq!(cfg.ws_bind, default_ws_bind());
    }

    #[test]
    fn parses_full() {
        let text = r#"
            name = "vps"
            home_dir = "/var/lib/murmur-relay"
            ws_bind = "127.0.0.1:9001"
            iroh_bind = "0.0.0.0:53440"
        "#;
        let cfg: RelayConfig = toml::from_str(text).unwrap();
        assert_eq!(cfg.ws_bind, "127.0.0.1:9001");
    }
}
