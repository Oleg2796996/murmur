//! WebSocket server: accepts framed binary `WsMessage`s.

use crate::config::RelayConfig;
use crate::pending::PendingStore;
use crate::storage::MessageStore;
use crate::subscriber::SubscriberHub;
use futures::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

#[derive(Clone)]
pub struct WsServer {
    cfg: RelayConfig,
    hub: SubscriberHub,
    pending: PendingStore,
    store_db: MessageStore,
    pub conn_id: Arc<AtomicUsize>,
}

impl WsServer {
    pub fn new(cfg: RelayConfig, hub: SubscriberHub, pending: PendingStore, store_db: MessageStore) -> Self {
        Self {
            cfg,
            hub,
            pending,
            store_db,
            conn_id: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn serve(&self) -> anyhow::Result<()> {
        let listener = TcpListener::bind(&self.cfg.ws_bind).await?;
        let local = listener.local_addr()?;
        info!(addr = %local, "ws listening");
        loop {
            let (stream, peer) = listener.accept().await?;
            let id = self.conn_id.fetch_add(1, Ordering::SeqCst);
            let label = format!("ws-{}", id);
            let s = self.clone();
            tokio::spawn(async move {
                if let Err(e) = s.handle_connection(stream, peer, label).await {
                    warn!(peer = %peer, "ws connection error: {e:#}");
                }
            });
        }
    }

    async fn handle_connection(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
        label: String,
    ) -> anyhow::Result<()> {
        debug!(%peer, %label, "ws open");
        let ws = tokio_tungstenite::accept_async(stream).await?;
        let (mut ws_tx, mut ws_rx) = ws.split();

        let mut rx_list: Vec<(String, async_channel::Receiver<crate::push::PushPayload>)> = Vec::new();

        loop {
            tokio::select! {
                ws_in = ws_rx.next() => {
                    match ws_in {
                        Some(Ok(Message::Text(txt))) => {
                            // Web clients send JSON over Text frames.
                            let parsed: serde_json::Value = match serde_json::from_str(&txt) {
                                Ok(v) => v,
                                Err(e) => {
                                    send_err(&mut ws_tx, &format!("bad json: {e}")).await?;
                                    continue;
                                }
                            };
                            let ty = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match ty {
                                "subscribe" => {
                                    let alias = match parsed.get("alias").and_then(|v| v.as_str()) {
                                        Some(a) => a.to_string(),
                                        None => {
                                            send_err(&mut ws_tx, "missing alias").await?;
                                            continue;
                                        }
                                    };
                                    // Register the alias in the message store.
                                    let npub = parsed.get("npub").and_then(|v| v.as_str()).map(|s| s.to_string());
                                    if let Some(ref n) = npub {
                                        if let Err(e) = self.store_db.register_alias(&alias, n) {
                                            warn!(err=%e, alias=%alias, "failed to register alias in store");
                                        }
                                    }
                                    let backlog = self.pending.read_all(&alias).map(|v| v.len()).unwrap_or(0);
                                    let rx = self.hub.subscribe_payload(&alias, &label, 16);
                                    rx_list.push((alias.clone(), rx));
                                    let resp = serde_json::json!({
                                        "type": "subscribed",
                                        "alias": alias,
                                        "backlog": backlog,
                                    });
                                    ws_tx.send(Message::Text(resp.to_string())).await?;
                                }
                                "ping" => {
                                    let pong = serde_json::json!({ "type": "pong" });
                                    ws_tx.send(Message::Text(pong.to_string())).await?;
                                }
                                _ => {
                                    send_err(&mut ws_tx, "unknown type").await?;
                                }
                            }
                        }
                        Some(Ok(Message::Binary(b))) => {
                            // Legacy postcard path — accepted but ignored for now.
                            // Browser clients should use Text frames (JSON).
                            // We still reply with a text-mode error so the connection stays sane.
                            let _ = b;
                            send_err(&mut ws_tx, "binary frames unsupported; use text/JSON").await?;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            debug!(%peer, %label, "ws closed");
                            return Ok(());
                        }
                        Some(Ok(other)) => {
                            debug!(?label, "ignoring ws frame: {other:?}");
                        }
                        Some(Err(e)) => {
                            error!(?label, "ws err: {e}");
                            return Err(e.into());
                        }
                    }
                }
                outbound = poll_receivers_payload(&mut rx_list) => {
                    if let Some(payload) = outbound {
                        let msg = serde_json::json!({
                            "type": "push",
                            "payload": payload.to_json_value(),
                        });
                        ws_tx.send(Message::Text(msg.to_string())).await?;
                    }
                }
            }
        }
    }
}

/// Helper: send a typed error frame to the client.
async fn send_err(
    ws_tx: &mut futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
    msg: &str,
) -> anyhow::Result<()> {
    let body = serde_json::json!({ "type": "error", "message": msg }).to_string();
    ws_tx.send(Message::Text(body)).await?;
    Ok(())
}

/// Poll all payload receivers in `rx_list`. Returns first available payload.
async fn poll_receivers_payload(
    rx_list: &mut Vec<(String, async_channel::Receiver<crate::push::PushPayload>)>,
) -> Option<crate::push::PushPayload> {
    if rx_list.is_empty() {
        std::future::pending::<()>().await;
        return None;
    }
    loop {
        // Remove already-closed receivers.
        rx_list.retain(|(_, rx)| !rx.is_closed());
        if rx_list.is_empty() {
            std::future::pending::<()>().await;
            return None;
        }
        let mut futs = Vec::with_capacity(rx_list.len());
        for (_alias, rx) in rx_list.iter() {
            let rx = rx.clone();
            futs.push(Box::pin(async move { rx.recv().await.ok() }));
        }
        let (res, _idx, rest) = futures::future::select_all(futs).await;
        drop(rest);
        if res.is_some() {
            return res;
        }
        // All receivers returned None — loop again.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pending::PendingEntry;
    use tokio_tungstenite::tungstenite::Message;

    #[tokio::test]
    async fn ws_server_subscribe_and_receive() {
        let dir = tempdir_home();
        let cfg = RelayConfig {
            name: "t".into(),
            home_dir: dir.clone(),
            ws_bind: "127.0.0.1:0".into(),
            iroh_bind: "0.0.0.0:0".into(),
            push_bind: "127.0.0.1:0".into(),
            vapid_subject: "mailto:t@murmur.local".into(),
            static_dir: None,
        };
        let hub = SubscriberHub::new();
        let pending = PendingStore::new(&dir).unwrap();
        let store_db = MessageStore::new(&dir.join("db")).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let s = WsServer::new(cfg, hub.clone(), pending.clone(), store_db);
        let conn_id_a = s.conn_id.clone();
        tokio::spawn(async move {
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                let id = conn_id_a.fetch_add(1, Ordering::SeqCst);
                let label = format!("ws-{}", id);
                let sc = s.clone();
                tokio::spawn(async move {
                    let _ = sc.handle_connection(stream, peer, label).await;
                });
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let url = format!("ws://{addr}");
        let (mut client_tx, mut client_rx) = tokio_tungstenite::connect_async(&url).await.unwrap().0.split();

        // Send a JSON subscribe over Text frame (browser-style).
        client_tx.send(Message::Text(r#"{"type":"subscribe","alias":"oleg-hp"}"#.into())).await.unwrap();

        let ack = client_rx.next().await.unwrap().unwrap();
        match ack {
            Message::Text(txt) => {
                let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
                assert_eq!(v["type"], "subscribed");
                assert_eq!(v["alias"], "oleg-hp");
                assert_eq!(v["backlog"], 0);
            }
            _ => panic!("not text"),
        }

        let entry = PendingEntry {
            to_alias: "oleg-hp".into(),
            from_npub: "npub1alice".into(),
            ts: 1,
            envelope_bytes: vec![1, 2, 3],
            envelope_hash_hex: "h".into(),
        };
        pending.append(&entry).unwrap();
        let n = hub.broadcast(&entry);
        assert_eq!(n, 1);

        let pushed = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client_rx.next(),
        ).await.unwrap().unwrap().unwrap();
        match pushed {
            Message::Text(txt) => {
                let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
                assert_eq!(v["type"], "push");
                assert_eq!(v["payload"]["envelope_hash_hex"], "h");
                assert_eq!(v["payload"]["from_npub"], "npub1alice");
            }
            _ => panic!("not text"),
        }
    }

    fn tempdir_home() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("murmur-relay-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
