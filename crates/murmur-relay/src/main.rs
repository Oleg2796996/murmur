//! `murmur-relay` — WebSocket + iroh-direct relay daemon.

use clap::Parser;
use murmur_relay::{iroh_server, push, PendingStore, RelayConfig, SubscriberHub, WsServer};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "murmur-relay", version, about = "murmur relay server")]
struct Cli {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,iroh=warn")))
        .init();

    let cli = Cli::parse();
    let cfg = RelayConfig::resolve(cli.config.as_deref())?
        .ok_or("no config found: pass --config, set $MURMUR_RELAY_CONFIG, or create ./murmur-relay.toml")?;

    info!(name = %cfg.name, home = %cfg.home_dir.display(), ws = %cfg.ws_bind, "starting murmur-relay");

    std::fs::create_dir_all(&cfg.home_dir)?;
    let pending = PendingStore::new(&cfg.home_dir)?;
    let hub = SubscriberHub::new();

    // VAPID keys + push server (HTTP for push subscriptions + delivery).
    let vapid = push::VapidKeys::load_or_generate(&cfg.home_dir, cfg.vapid_subject.clone())?;
    // If static_dir is set, serve PWA files alongside the push API.
    // If not set, default to `<home_dir>/pwa` if it exists.
    let static_dir = cfg.static_dir.clone().or_else(|| {
        let candidate = cfg.home_dir.join("pwa");
        if candidate.is_dir() { Some(candidate) } else { None }
    });
    if let Some(ref dir) = static_dir {
        info!(static_dir = %dir.display(), "PWA static dir enabled");
    }
    let push_server = Arc::new(
        push::PushServer::new(&cfg.home_dir, cfg.push_bind.clone(), vapid.clone())?
            .with_static_dir(static_dir.clone()),
    );
    info!(vapid_pub = %vapid.public_b64url(), "VAPID ready");

    // Spawn push HTTP server (handles /push/register_subscribe, /push/unsubscribe, /vapid_public_key, /healthz).
    let push_for_serve = push_server.clone();
    tokio::spawn(async move {
        if let Err(e) = push_for_serve.serve().await {
            tracing::error!(err=%e, "push HTTP server exited");
        }
    });

    // Spawn iroh-direct listener
    let (node_id, direct_addr) = iroh_server::spawn(pending.clone(), hub.clone(), push_server.clone()).await?;
    let share_link = murmur_transport::iroh_transport::build_share_string(&node_id, direct_addr);
    println!("iroh listening on {}", direct_addr);
    println!("iroh share-link: {}", share_link);

    // Print subscriber count every 30s for observability.
    let hub_for_log = hub.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            t.tick().await;
            info!(subscribers = hub_for_log.count(), "hub stats");
        }
    });

    // Trap SIGINT / SIGTERM
    tokio::spawn(async move {
        let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(_e) => return,
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("received SIGINT, exiting");
            }
            _ = sigterm.recv() => {
                info!("received SIGTERM, exiting");
            }
        }
        std::process::exit(0);
    });

    // Spawn WS server (this runs forever)
    let ws_server = WsServer::new(cfg.clone(), hub.clone(), pending.clone());
    ws_server.serve().await?;
    Ok(())
}
