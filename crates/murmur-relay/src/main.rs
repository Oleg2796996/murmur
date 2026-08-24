//! `murmur-relay` — WebSocket + iroh-direct relay daemon.

use clap::Parser;
use murmur_relay::{iroh_server, push, PushServer, PendingStore, RelayConfig, SubscriberHub, WsServer, MessageStore};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};
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
    let db_path = cfg.home_dir.join("messages.db");
    let store_db = MessageStore::new(&db_path)
        .map_err(|e| anyhow::anyhow!("failed to init message store: {}", e))?;
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
            .with_static_dir(static_dir.clone())
            .with_pending_hub(pending.clone(), hub.clone()),
    );
    info!(vapid_pub = %vapid.public_b64url(), "VAPID ready");

    // Spawn push HTTP server (handles /push/register_subscribe, /push/unsubscribe, /vapid_public_key, /healthz, /envelope).
    let push_for_serve: Arc<PushServer> = push_server.clone();
    tokio::spawn(async move {
        // `serve` takes self by value, so clone out of the Arc.
        let owned = (*push_for_serve).clone();
        if let Err(e) = owned.serve().await {
            tracing::error!(err=%e, "push HTTP server exited");
        }
    });

    // Spawn iroh-direct listener
    let (node_id, direct_addr) = iroh_server::spawn(pending.clone(), hub.clone(), push_server.clone(), store_db.clone()).await?;
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

    // TTL cleanup: каждые 5 минут удалять просроченные envelope'ы
    // (TTL 24 часа), при удалении отправлять отправителю «undelivered» нотификацию.
    let store_for_ttl = store_db.clone();
    let pending_for_ttl = pending.clone();
    let hub_for_ttl = hub.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(300));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            t.tick().await;
            match store_for_ttl.list_expired_envelopes() {
                Ok(expired) if !expired.is_empty() => {
                    info!(count = expired.len(), "TTL cleanup: processing expired envelopes");
                    for e in &expired {
                        // Получатель так и не зашел в сеть за 24h.
                        // Отправляем уведомление обратно отправителю.
                        // Сначала находим алиас отправителя по его npub.
                        let sender_alias = match store_for_ttl.aliases_for_npub(&e.from_npub) {
                            Ok(mut aliases) if !aliases.is_empty() => aliases.remove(0),
                            _ => {
                                warn!(envelope_hash=%e.envelope_hash, from=%e.from_npub, "no alias for sender, skipping notification");
                                // Все равно удаляем
                                let _ = store_for_ttl.delete_envelope_by_hash(&e.envelope_hash);
                                continue;
                            }
                        };
                        // Создаём системный envelope «undelivered» в сторону отправителя.
                        match store_for_ttl.create_undelivered_notification(
                            e,
                            "system:relay",          // отправитель уведомления — relay
                            &sender_alias,
                        ) {
                            Ok(true) => {
                                info!(
                                    envelope_hash = %e.envelope_hash,
                                    recipient = %sender_alias,
                                    "undelivered notification created"
                                );
                            }
                            Ok(false) => {
                                // дубль (на случай повторного запуска крона)
                            }
                            Err(err) => {
                                warn!(err=%err, "failed to create undelivered notification");
                            }
                        }
                        // Удаляем просроченный envelope.
                        if let Err(err) = store_for_ttl.delete_envelope_by_hash(&e.envelope_hash) {
                            warn!(err=%err, "failed to delete expired envelope");
                        }
                        // Тоже удалить из pending-лога (если там было)
                        if let Ok(entries) = pending_for_ttl.read_all(&e.to_alias) {
                            // (не фильтруем — просто оставляем файл как есть; cleanup по retention не в этом PR)
                            let _ = entries;
                        }
                        // Broadcast в WS для получателя, если онлайн (вдруг вернулся).
                        let fake_entry = murmur_relay::pending::PendingEntry {
                            to_alias: sender_alias.clone(),
                            from_npub: "system:relay".into(),
                            ts: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0),
                            envelope_bytes: vec![],
                            envelope_hash_hex: e.envelope_hash.clone(),
                        };
                        let _ = hub_for_ttl.broadcast(&fake_entry, None);
                    }
                }
                Ok(_) => {
                    // ничего не просрочило
                }
                Err(err) => {
                    warn!(err=%err, "TTL cleanup: list_expired_envelopes failed");
                }
            }
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
    let ws_server = WsServer::new(cfg.clone(), hub.clone(), pending.clone(), store_db.clone());
    ws_server.serve().await?;
    Ok(())
}
