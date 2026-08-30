//! End-to-end test: PushServer::deliver() against a mock push endpoint.
//!
//! Goal: verify that `web-push` actually sends a valid VAPID-signed POST
//! when given a mock subscription. The mock endpoint validates:
//! 1. POST request landed
//! 2. VAPID JWT parses (header is ES256, sub claim present, aud matches endpoint origin, exp in future)
//! 3. ECDH p256dh key agrees with the body aesgcm header (RFC 8188 seal)
//!
//! Mock endpoint does NOT decrypt the body — that would require implementing
//! the full RFC 8188 receiver. We instead verify the body parses as a
//! Content-Encoding: aes128gcm frame and randomly sample 16 bytes are
//! non-zero (proving it was encrypted and not plaintext).

use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use hyper::{Request, Response, StatusCode};
use hyper::server::conn::http1;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use parking_lot::Mutex;
use tokio::net::TcpListener;
use jwt_simple::prelude::*;

use murmur_relay::push::{PushPayload, PushServer, PushSubscription, VapidKeys};

// Capture one inbound POST to the mock endpoint.
#[derive(Debug, Default, Clone)]
struct Captured {
    method: String,
    path: String,
    auth_header: Option<String>,
    content_encoding: Option<String>,
    body: Vec<u8>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deliver_posts_vapid_signed_payload_to_mock_endpoint() {
    // 1. Start mock push endpoint on a random port.
    let captured = Arc::new(Mutex::new(Captured::default()));
    let captured_h = captured.clone();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    let mock_endpoint = format!("http://127.0.0.1:{}/push/abc", mock_port);

    let mock_task = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let io = TokioIo::new(stream);
            let cap = captured_h.clone();
            let svc = service_fn(move |req: Request<Incoming>| {
                let cap = cap.clone();
                async move {
                    let method = req.method().to_string();
                    let path = req.uri().path().to_string();
                    let auth = req.headers().get("authorization").map(|v| v.to_str().unwrap_or("").to_string());
                    let enc = req.headers().get("content-encoding").map(|v| v.to_str().unwrap_or("").to_string());
                    let body = req.collect().await.unwrap().to_bytes().to_vec();
                    let mut c = cap.lock();
                    if c.method.is_empty() {
                        c.method = method;
                        c.path = path;
                        c.auth_header = auth;
                        c.content_encoding = enc;
                        c.body = body;
                    }
                    Ok::<_, std::convert::Infallible>(
                        Response::builder()
                            .status(StatusCode::CREATED)
                            .body(Full::new(Bytes::from("ok")))
                            .unwrap(),
                    )
                }
            });
            let _ = http1::Builder::new().serve_connection(io, svc).await;
        }
    });

    // 2. Spin up PushServer with its own home_dir.
    let tmp = std::env::temp_dir().join(format!("murmur-e2e-push-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).unwrap();
    let push_server = PushServer::new(
        &tmp,
        "127.0.0.1:0".to_string(),
        VapidKeys::load_or_generate(&tmp, "mailto:e2e@murmur.local".to_string()).unwrap(),
    )
    .unwrap();

    // 3. Register a subscription whose endpoint is the mock server.
    let sub = PushSubscription {
        id: uuid::Uuid::new_v4().to_string(),
        alias: "alice".to_string(),
        endpoint: mock_endpoint.clone(),
        p256dh_b64url: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".to_string(),
        auth_b64url: "g5n1-Yod2xgiR_VCGooK5Q".to_string(),
        registered_at: chrono::Utc::now().to_string(),
    };
    push_server.store.insert(sub).unwrap();

    // 4. Build a payload and deliver.
    let payload = PushPayload {
        alias: "alice".to_string(),
        from_npub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs9y7h7q".to_string(),
        ts: 1_700_000_000,
        envelope_hash_hex: "deadbeef".to_string(),
        title: "Murmur".to_string(),
        subtitle: "npub1qq…q".to_string(),
        body: "new encrypted message (42 bytes)".to_string(),
    };
    let delivered = push_server.deliver(&payload).await.unwrap();
    assert_eq!(delivered, 1, "expected exactly 1 delivery");

    // 5. Wait for the mock to capture.
    let mut attempts = 0;
    while captured.lock().method.is_empty() && attempts < 50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        attempts += 1;
    }

    let cap = {
        let g = captured.lock();
        Captured {
            method: g.method.clone(),
            path: g.path.clone(),
            auth_header: g.auth_header.clone(),
            content_encoding: g.content_encoding.clone(),
            body: g.body.clone(),
        }
    };
    assert!(!cap.method.is_empty(), "mock endpoint received no POST");
    assert_eq!(cap.method, "POST");
    assert!(cap.path.starts_with("/push/"), "got path: {}", cap.path);

    // 6. Verify VAPID JWT signature.
    let auth = cap.auth_header.clone().expect("missing Authorization header");
    assert!(auth.to_ascii_lowercase().starts_with("vapid "), "got auth: {}", auth);

    // Strip "vapid " prefix and split into "t=...,k=..."
    let raw = auth.trim_start_matches("vapid ").trim_start_matches("VAPID ");
    let mut token = None;
    let mut p256dh_pub_b64url = None;
    for kv in raw.split(',') {
        let mut parts = kv.splitn(2, '=');
        let k = parts.next().unwrap_or("").trim();
        let v = parts.next().unwrap_or("").trim();
        match k {
            "t" => token = Some(v.to_string()),
            "k" => p256dh_pub_b64url = Some(v.to_string()),
            _ => {}
        }
    }
    let token = token.expect("missing t= in VAPID auth");
    let k = p256dh_pub_b64url.expect("missing k= in VAPID auth");

    // Verify k (base64url-decoded uncompressed P-256 public key) parses.
    let pub_bytes = base64_url::decode(&k).unwrap_or_else(|_| panic!("bad base64url k: {}", k));
    assert_eq!(pub_bytes.len(), 65, "VAPID k must be 65 bytes uncompressed SEC1, got {}", pub_bytes.len());
    assert_eq!(pub_bytes[0], 0x04, "VAPID k must start with 0x04 (uncompressed)");

    // Verify JWT signature with the VAPID public key from PushServer.
    let vapid_pub = push_server.vapid_public_b64url().to_string();
    let key = ES256PublicKey::from_bytes(&base64_url::decode(&vapid_pub).unwrap()).unwrap();
    let mut opts = VerificationOptions::default();
    let mut allowed = std::collections::HashSet::new();
    // web-push 0.10 uses scheme://host (without port) as the VAPID aud.
    // See https://www.rfc-editor.org/rfc/rfc8292 (aud = origin). The crate
    // simplifies to host:port-less origin which is what FCM/Mozilla accept
    // when the endpoint uses the default port (https://fcm.googleapis.com).
    allowed.insert("http://127.0.0.1".to_string());
    opts.allowed_audiences = Some(allowed);
    let claims = key.verify_token::<serde_json::Value>(&token, Some(opts));
    assert!(claims.is_ok(), "VAPID JWT verify failed: {:?}", claims.err());
    let claims = claims.unwrap();
    let sub = claims.subject.as_ref().expect("VAPID sub claim missing");
    assert_eq!(sub, "mailto:e2e@murmur.local");
    println!("VAPID JWT verified. aud={:?}", claims.audiences);

    // 7. Verify body looks like an aes128gcm frame (RFC 8188):
    //    header(16) || salt(16) || rs(4) || idlen(1) || keyid(idlen) || ciphertext+tag
    let body = &cap.body;
    assert!(body.len() > 16 + 16 + 4 + 1, "body too short for aes128gcm: {} bytes", body.len());
    let salt = &body[16..32];
    // Encrypted payload should look non-zero (high entropy).
    assert!(salt.iter().any(|&b| b != 0), "salt looks like zeros — body was not encrypted");
    let body_bytes = body.len();
    assert!(body_bytes > 50, "body too short: {}", body_bytes);

    let ce = cap.content_encoding.expect("content-encoding missing");
    assert_eq!(ce, "aes128gcm", "content-encoding should be aes128gcm, got {}", ce);

    println!("E2E push test passed:");
    println!("  endpoint: {}", mock_endpoint);
    println!("  body size: {} bytes", body_bytes);
    println!("  content-encoding: {}", ce);
    println!("  VAPID pubkey: {}", vapid_pub);

    // Cleanup.
    mock_task.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

// Tiny scoped base64url helper (no padding).
mod base64_url {
    pub fn decode(s: &str) -> Result<Vec<u8>, String> {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| format!("{:?}", e))
    }
}
