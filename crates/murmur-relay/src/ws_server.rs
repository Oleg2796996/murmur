//! WebSocket server: accepts framed binary `WsMessage`s.

use crate::config::RelayConfig;
use crate::pending::PendingStore;
use crate::subscriber::{SubscriberHub, WsMessage};
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
    pub conn_id: Arc<AtomicUsize>,
}

impl WsServer {
    pub fn new(cfg: RelayConfig, hub: SubscriberHub, pending: PendingStore) -> Self {
        Self {
            cfg,
            hub,
            pending,
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

        let mut rx_list: Vec<(String, async_channel::Receiver<WsMessage>)> = Vec::new();

        loop {
            tokio::select! {
                ws_in = ws_rx.next() => {
                    match ws_in {
                        Some(Ok(Message::Binary(b))) => {
                            match WsMessage::decode(&b) {
                                Ok(WsMessage::Subscribe { alias }) => {
                                    let backlog = self.pending.read_all(&alias).map(|v| v.len()).unwrap_or(0);
                                    let rx = self.hub.subscribe(&alias, &label, 16);
                                    rx_list.push((alias.clone(), rx));
                                    let conf = WsMessage::Subscribed { alias, backlog };
                                    let bytes = conf.encode()?;
                                    ws_tx.send(Message::Binary(bytes)).await?;
                                }
                                Ok(WsMessage::Ping) => {
                                    let pong = WsMessage::Pong.encode()?;
                                    ws_tx.send(Message::Binary(pong)).await?;
                                }
                                Ok(other) => {
                                    warn!(?label, "unexpected client msg: {:?}", other);
                                }
                                Err(e) => {
                                    error!(?label, "decode err: {e}");
                                }
                            }
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
                outbound = poll_receivers(&mut rx_list) => {
                    if let Some(msg) = outbound {
                        let bytes = msg.encode()?;
                        ws_tx.send(Message::Binary(bytes)).await?;
                    }
                }
            }
        }
    }
}

/// Poll all receivers in `rx_list`. Returns first available message.
async fn poll_receivers(
    rx_list: &mut Vec<(String, async_channel::Receiver<WsMessage>)>,
) -> Option<WsMessage> {
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
    use crate::subscriber::WsMessage;
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

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let s = WsServer::new(cfg, hub.clone(), pending.clone());
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

        let sub = WsMessage::Subscribe { alias: "oleg-hp".into() };
        client_tx.send(Message::Binary(sub.encode().unwrap())).await.unwrap();

        let ack = client_rx.next().await.unwrap().unwrap();
        match ack {
            Message::Binary(b) => match WsMessage::decode(&b).unwrap() {
                WsMessage::Subscribed { alias, backlog } => {
                    assert_eq!(alias, "oleg-hp");
                    assert_eq!(backlog, 0);
                }
                _ => panic!("not subscribed"),
            },
            _ => panic!("not binary"),
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
            Message::Binary(b) => match WsMessage::decode(&b).unwrap() {
                WsMessage::Push(e) => assert_eq!(e.envelope_hash_hex, "h"),
                _ => panic!("not push"),
            },
            _ => panic!("not binary"),
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
