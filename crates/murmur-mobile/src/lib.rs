//! murmur-mobile — Tauri 2.x shell for murmur.
//!
//! This crate wraps murmur core (murmur-id / murmur-log / murmur-transport)
//! and exposes them as Tauri commands callable from the webview frontend.
//!
//! Step 9a — scaffolding only. Mobile builds (iOS/Android) require:
//!   - iOS: macOS with Xcode + `cargo tauri ios init`
//!   - Android: Android SDK + `cargo tauri android init`
//!
//! On Linux desktop, building requires libwebkit2gtk-4.1-dev + libgtk-3-dev.
//! Tests run with `--no-default-features` to skip these.

use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Shared state held by Tauri runtime.
pub struct AppState {
    pub identity: Mutex<Option<murmur_id::Identity>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            identity: Mutex::new(None),
        }
    }
}

/// Result envelope for commands.
#[derive(Debug, Serialize, Deserialize)]
pub struct CmdResult<T: Serialize> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> CmdResult<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }
    pub fn err(e: impl std::fmt::Display) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(e.to_string()),
        }
    }
}

#[cfg(feature = "tauri-runtime")]
mod tauri_layer {
    use super::*;
    use std::sync::Arc;

    /// Generate a new murmur identity (npub1...).
    #[tauri::command]
    pub async fn identity_new(
        state: tauri::State<'_, Arc<AppState>>,
    ) -> CmdResult<murmur_id::IdentityPublic> {
        let id = murmur_id::Identity::generate(&mut OsRng);
        let pub_id = id.public();
        *state.identity.lock().await = Some(id);
        CmdResult::ok(pub_id)
    }

    /// Return the currently loaded identity's npub (or error).
    #[tauri::command]
    pub async fn identity_npub(
        state: tauri::State<'_, Arc<AppState>>,
    ) -> CmdResult<String> {
        let guard = state.identity.lock().await;
        match guard.as_ref() {
            Some(id) => CmdResult::ok(id.public().npub()),
            None => CmdResult::err("no identity loaded"),
        }
    }

    /// Echo — used as a sanity ping for the IPC bridge.
    #[tauri::command]
    pub async fn ping(msg: String) -> CmdResult<String> {
        CmdResult::ok(format!("pong: {msg}"))
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        let state = Arc::new(AppState::default());
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
            )
            .init();

        tauri::Builder::default()
            .manage(state)
            .invoke_handler(tauri::generate_handler![
                identity_new,
                identity_npub,
                ping
            ])
            .setup(|_app| {
                tracing::info!(tauri_version = tauri::VERSION, "murmur-mobile starting");
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_layer::run;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_generate_unique_npubs() {
        let a = murmur_id::Identity::generate(&mut OsRng);
        let b = murmur_id::Identity::generate(&mut OsRng);
        assert_ne!(a.public().npub(), b.public().npub());
    }

    #[test]
    fn cmd_result_ok_and_err() {
        let ok: CmdResult<i32> = CmdResult::ok(42);
        assert!(ok.ok);
        assert_eq!(ok.data, Some(42));
        let err: CmdResult<i32> = CmdResult::err("boom");
        assert!(!err.ok);
        assert_eq!(err.error.as_deref(), Some("boom"));
    }
}