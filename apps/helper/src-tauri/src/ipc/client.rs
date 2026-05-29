//! IPC client: auth handshake, token-receipt loop, and reconnect driver.
//!
//! Wire format / HMAC lives in [`super::envelope`] and must match the Go
//! `agent/internal/ipc` broker byte-for-byte. The handshake is HMAC'd with the
//! 32-byte ZERO key; the broker switches to the per-session key only AFTER it
//! sends `auth_response` (see `agent/internal/sessionbroker/broker.go`:
//! `SendTyped(auth_response)` then `conn.SetSessionKey(...)`). So the
//! `auth_response`/`pre_auth_reject` frames themselves are read under the ZERO
//! key, and every frame thereafter under the decoded session key.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncWrite};

use super::envelope::{read_frame, write_frame, IpcError, PROTOCOL_VERSION};
use super::token::HelperToken;
use super::transport::{
    self_binary_hash, PeerIdentity,
};

/// 32 zero bytes: the pre-auth HMAC key. The broker uses the same key until it
/// sends `auth_response`.
const ZERO_KEY: [u8; 32] = [0u8; 32];

/// Keepalive interval: if no frame arrives within this window we send a `ping`
/// to keep the connection alive (mirrors the userhelper keepalive pattern).
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Reconnect backoff floor and ceiling.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// A session that ran at least this long is treated as "healthy" and resets the
/// reconnect backoff to the floor.
const HEALTHY_SESSION: Duration = Duration::from_secs(60);

/// Outcome of a single [`run_session`] call. The reconnect driver uses this to
/// decide whether to retry (and how) or to stop permanently.
#[derive(Debug)]
pub enum SessionError {
    /// The broker permanently rejected us (binary not allowlisted, protocol
    /// mismatch, etc.). Retrying is futile — the driver logs once and stops.
    PermanentReject(String),
    /// A transient failure (transport drop, transient auth reject, protocol
    /// error). The driver backs off and reconnects.
    Transient(IpcError),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::PermanentReject(m) => write!(f, "permanent reject: {}", m),
            SessionError::Transient(e) => write!(f, "transient: {}", e),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<IpcError> for SessionError {
    fn from(e: IpcError) -> Self {
        SessionError::Transient(e)
    }
}

/// The `auth_request` payload. JSON keys mirror the Go `AuthRequest` struct in
/// `agent/internal/ipc/message.go` exactly (lowerCamel).
#[derive(Debug, Serialize)]
struct AuthRequest {
    #[serde(rename = "protocolVersion")]
    protocol_version: i32,
    #[serde(rename = "uid")]
    uid: u32,
    #[serde(rename = "sid", skip_serializing_if = "String::is_empty")]
    sid: String,
    #[serde(rename = "username")]
    username: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "displayEnv")]
    display_env: String,
    #[serde(rename = "pid")]
    pid: i32,
    #[serde(rename = "binaryHash")]
    binary_hash: String,
    #[serde(rename = "winSessionId", skip_serializing_if = "is_zero_u32")]
    win_session_id: u32,
    #[serde(rename = "helperRole")]
    helper_role: String,
    #[serde(rename = "binaryKind")]
    binary_kind: String,
    #[serde(rename = "desktopContext", skip_serializing_if = "String::is_empty")]
    desktop_context: String,
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

/// Subset of the Go `AuthResponse` we care about.
#[derive(Debug, Deserialize)]
struct AuthResponse {
    #[serde(default)]
    accepted: bool,
    #[serde(rename = "sessionKey", default)]
    session_key: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    permanent: bool,
}

/// The Go `PreAuthReject` payload.
#[derive(Debug, Deserialize)]
struct PreAuthReject {
    #[serde(default)]
    code: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    permanent: bool,
}

/// The Go `HelperTokenUpdate` payload (only the token matters here).
#[derive(Debug, Deserialize)]
struct HelperTokenUpdate {
    #[serde(default)]
    token: String,
}

/// Build the assist-role `auth_request` payload for the given identity.
fn build_auth_request(id: &PeerIdentity) -> AuthRequest {
    AuthRequest {
        protocol_version: PROTOCOL_VERSION,
        uid: id.uid,
        sid: id.sid.clone(),
        username: id.username.clone(),
        session_id: format!("assist-{}-{}", id.username, id.pid),
        display_env: String::new(),
        pid: id.pid as i32,
        binary_hash: self_binary_hash(),
        win_session_id: 0,
        helper_role: "assist".to_string(),
        binary_kind: "assist_helper".to_string(),
        desktop_context: String::new(),
    }
}

/// Serialize a serializable value into the exact `Box<RawValue>` the framing
/// layer HMACs over.
fn to_raw_payload<T: Serialize>(value: &T) -> Result<Box<RawValue>, IpcError> {
    let s = serde_json::to_string(value)
        .map_err(|e| IpcError::Protocol(format!("serialize payload: {}", e)))?;
    RawValue::from_string(s).map_err(|e| IpcError::Protocol(format!("raw payload: {}", e)))
}

/// Parse a typed payload out of an envelope's raw payload bytes.
fn parse_payload<T: for<'de> Deserialize<'de>>(
    payload: &Option<Box<RawValue>>,
) -> Result<T, IpcError> {
    let raw = payload
        .as_ref()
        .ok_or_else(|| IpcError::Protocol("missing payload".to_string()))?;
    serde_json::from_str(raw.get())
        .map_err(|e| IpcError::Protocol(format!("parse payload: {}", e)))
}

/// Run a single IPC session over an already-connected `stream`:
/// auth handshake, then a token-receipt loop until disconnect or error.
///
/// The testable core — generic over any duplex byte stream so tests can drive a
/// fake broker over [`tokio::io::duplex`].
pub async fn run_session<S>(stream: S, token: &HelperToken) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let identity = crate::ipc::transport::current_identity()
        .map_err(|e| SessionError::Transient(IpcError::Protocol(format!("identity: {}", e))))?;
    run_session_with_identity(stream, token, &identity).await
}

/// Like [`run_session`] but with an explicit identity. Lets tests avoid relying
/// on process-global state.
pub async fn run_session_with_identity<S>(
    stream: S,
    token: &HelperToken,
    identity: &PeerIdentity,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = stream;
    let mut send_seq = 0u64;
    let mut recv_seq = 0u64;

    // --- Handshake (ZERO key) ---
    let auth_req = build_auth_request(identity);
    let payload = to_raw_payload(&auth_req)?;
    write_frame(
        &mut stream,
        &ZERO_KEY,
        &mut send_seq,
        "auth",
        "auth_request",
        Some(payload),
    )
    .await?;

    // The auth_response / pre_auth_reject is still HMAC'd with the ZERO key:
    // the broker calls SetSessionKey only AFTER sending it.
    let env = read_frame(&mut stream, &ZERO_KEY, &mut recv_seq).await?;
    let session_key: [u8; 32] = match env.typ.as_str() {
        "pre_auth_reject" => {
            let r: PreAuthReject = parse_payload(&env.payload)?;
            let msg = format!("pre_auth_reject code={} reason={}", r.code, r.reason);
            if r.permanent {
                return Err(SessionError::PermanentReject(msg));
            }
            return Err(SessionError::Transient(IpcError::Protocol(msg)));
        }
        "auth_response" => {
            let r: AuthResponse = parse_payload(&env.payload)?;
            if !r.accepted {
                let msg = format!("auth rejected: {}", r.reason);
                if r.permanent {
                    return Err(SessionError::PermanentReject(msg));
                }
                return Err(SessionError::Transient(IpcError::Protocol(msg)));
            }
            let bytes = hex::decode(&r.session_key).map_err(|_| {
                SessionError::Transient(IpcError::Protocol(
                    "auth_response: session key not valid hex".to_string(),
                ))
            })?;
            bytes.try_into().map_err(|_| {
                SessionError::Transient(IpcError::Protocol(
                    "auth_response: session key not 32 bytes".to_string(),
                ))
            })?
        }
        other => {
            return Err(SessionError::Transient(IpcError::Protocol(format!(
                "unexpected handshake frame type: {}",
                other
            ))));
        }
    };

    // --- Receive loop (session key) ---
    loop {
        let res =
            tokio::time::timeout(READ_IDLE_TIMEOUT, read_frame(&mut stream, &session_key, &mut recv_seq))
                .await;

        let env = match res {
            // Idle: send a keepalive ping and keep listening.
            Err(_elapsed) => {
                write_frame(
                    &mut stream,
                    &session_key,
                    &mut send_seq,
                    "keepalive",
                    "ping",
                    None,
                )
                .await?;
                continue;
            }
            Ok(Ok(env)) => env,
            // Transport/protocol error: bubble up so the driver reconnects.
            Ok(Err(e)) => return Err(SessionError::Transient(e)),
        };

        match env.typ.as_str() {
            "helper_token_update" => {
                let upd: HelperTokenUpdate = parse_payload(&env.payload)?;
                token.set(upd.token).await;
                // NEVER log the token value.
                eprintln!("[helper] helper token received via IPC");
            }
            "ping" => {
                write_frame(
                    &mut stream,
                    &session_key,
                    &mut send_seq,
                    &env.id,
                    "pong",
                    None,
                )
                .await?;
            }
            "pong" => { /* ignore */ }
            "disconnect" => {
                // Clean disconnect — caller reconnects.
                return Ok(());
            }
            _ => { /* assist client handles nothing else */ }
        }
    }
}

/// Reconnect driver: connects, runs a session, backs off and retries on
/// transient failure, and stops permanently on a permanent reject. Runs until
/// `stop` flips to `true`.
///
/// The session future is wrapped in `catch_unwind` so a panic inside a single
/// session is caught, logged once, and treated as a transient failure (back off
/// and reconnect) rather than killing the reconnect task.
pub async fn run(token: HelperToken, mut stop: tokio::sync::watch::Receiver<bool>) {
    use super::transport::{connect, current_identity, default_socket_path};

    let mut backoff = BACKOFF_MIN;

    loop {
        if *stop.borrow() {
            return;
        }

        // Resolve identity per connect; if it fails, back off and retry.
        let identity = match current_identity() {
            Ok(id) => id,
            Err(e) => {
                eprintln!("[helper] ipc: failed to resolve identity: {}", e);
                if wait_or_stop(&mut stop, backoff).await {
                    return;
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };

        let path = default_socket_path();
        let stream = match connect(&path).await {
            Ok(s) => s,
            Err(e) => {
                // Agent may simply not be up yet — debug-level, quiet.
                eprintln!("[helper] ipc: connect failed ({}): {}", path, e);
                if wait_or_stop(&mut stop, backoff).await {
                    return;
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };

        let started = std::time::Instant::now();

        // Catch panics so a single bad session can't take down the reconnect
        // task. `catch_unwind` turns a panic inside the session future into an
        // `Err(_)` instead of unwinding through the spawned task. The borrowed
        // state (`&token`, `&identity`) is only read after a panic via the
        // normal reconnect path, so `AssertUnwindSafe` is appropriate here.
        // The future is still `select!`ed against `stop.changed()` so a stop
        // request mid-session is honored promptly.
        use futures_util::FutureExt;
        let session_fut =
            std::panic::AssertUnwindSafe(run_session_with_identity(stream, &token, &identity))
                .catch_unwind();
        let outcome = tokio::select! {
            r = session_fut => Some(r),
            _ = stop.changed() => None,
        };

        match outcome {
            None => {
                // Stop requested mid-session.
                return;
            }
            // A caught panic is treated exactly like a transient failure: log
            // once (never the payload/token), then back off and reconnect.
            Some(Err(_panic)) => {
                eprintln!("[helper] IPC session panicked; will reconnect");
                if started.elapsed() >= HEALTHY_SESSION {
                    backoff = BACKOFF_MIN;
                }
            }
            Some(Ok(Ok(()))) => {
                // Clean disconnect. Reset backoff if the session was healthy.
                if started.elapsed() >= HEALTHY_SESSION {
                    backoff = BACKOFF_MIN;
                }
            }
            Some(Ok(Err(SessionError::PermanentReject(msg)))) => {
                // Retrying a non-allowlisted / permanently-rejected binary is
                // futile. Log once and stop.
                eprintln!(
                    "[helper] ipc: broker permanently rejected this helper ({}); not retrying",
                    msg
                );
                return;
            }
            Some(Ok(Err(SessionError::Transient(e)))) => {
                eprintln!("[helper] ipc: session ended: {}", e);
                if started.elapsed() >= HEALTHY_SESSION {
                    backoff = BACKOFF_MIN;
                }
            }
        }

        if wait_or_stop(&mut stop, backoff).await {
            return;
        }
        backoff = next_backoff(backoff);
    }
}

/// Exponential backoff: double, capped at [`BACKOFF_MAX`].
fn next_backoff(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > BACKOFF_MAX {
        BACKOFF_MAX
    } else {
        doubled
    }
}

/// Sleep for `dur`, but wake early (and return `true`) if `stop` flips to true.
async fn wait_or_stop(stop: &mut tokio::sync::watch::Receiver<bool>, dur: Duration) -> bool {
    if *stop.borrow() {
        return true;
    }
    tokio::select! {
        _ = tokio::time::sleep(dur) => *stop.borrow(),
        res = stop.changed() => {
            // Sender dropped or value changed; treat any "true" as stop.
            res.is_err() || *stop.borrow()
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ipc::envelope::{read_frame, write_frame};

    fn test_identity() -> PeerIdentity {
        PeerIdentity {
            uid: 501,
            sid: String::new(),
            username: "tester".to_string(),
            pid: 12345,
        }
    }

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_string()).expect("valid json")
    }

    /// Full happy path: handshake, accept with a fixed session key, deliver a
    /// helper_token_update, and confirm the token cell is populated.
    #[tokio::test]
    async fn test_handshake_then_token_delivery() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let token_for_session = token.clone();
        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token_for_session, &id).await
        });

        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;

        // 1. Read the auth_request (ZERO key) and assert its shape.
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        assert_eq!(env.typ, "auth_request");
        let payload = env.payload.as_ref().expect("auth_request payload");
        let v: serde_json::Value = serde_json::from_str(payload.get()).unwrap();
        assert_eq!(v["helperRole"], "assist");
        assert_eq!(v["binaryKind"], "assist_helper");
        assert_eq!(v["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(v["sessionId"], "assist-tester-12345");

        // 2. Reply auth_response (still ZERO key) with a fixed session key.
        let session_key = [7u8; 32];
        let key_hex = hex::encode(session_key);
        let resp = format!(
            r#"{{"accepted":true,"sessionKey":"{}","allowedScopes":["assist"]}}"#,
            key_hex
        );
        write_frame(
            &mut broker_half,
            &ZERO_KEY,
            &mut broker_send,
            &env.id,
            "auth_response",
            Some(raw(&resp)),
        )
        .await
        .expect("write auth_response");

        // 3. Deliver helper_token_update under the SESSION key.
        write_frame(
            &mut broker_half,
            &session_key,
            &mut broker_send,
            "tok-1",
            "helper_token_update",
            Some(raw(r#"{"token":"brz_test"}"#)),
        )
        .await
        .expect("write helper_token_update");

        // 4. Poll until the token cell is populated.
        let mut got = None;
        for _ in 0..200 {
            if let Some(t) = token.get().await {
                got = Some(t);
                break;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(got.as_deref(), Some("brz_test"));

        // Dropping broker_half closes the stream; the session read errors out.
        drop(broker_half);
        let res = session.await.expect("join");
        // Transport closed → transient error (EOF) is expected.
        assert!(
            matches!(res, Err(SessionError::Transient(_))),
            "expected transient on close, got {:?}",
            res
        );
    }

    /// A permanent pre_auth_reject must surface as `PermanentReject` so the
    /// reconnect driver stops retrying.
    #[tokio::test]
    async fn test_permanent_reject_stops() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id).await
        });

        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;

        // Read the auth_request.
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        assert_eq!(env.typ, "auth_request");

        // Reply with a permanent pre_auth_reject.
        write_frame(
            &mut broker_half,
            &ZERO_KEY,
            &mut broker_send,
            "rej-1",
            "pre_auth_reject",
            Some(raw(
                r#"{"code":"binary_path_unknown","reason":"unknown binary","permanent":true}"#,
            )),
        )
        .await
        .expect("write pre_auth_reject");

        let res = session.await.expect("join");
        match res {
            Err(SessionError::PermanentReject(msg)) => {
                assert!(msg.contains("binary_path_unknown"), "{}", msg);
            }
            other => panic!("expected PermanentReject, got {:?}", other),
        }
    }

    /// A non-permanent pre_auth_reject must surface as transient (driver retries).
    #[tokio::test]
    async fn test_transient_reject_retries() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id).await
        });

        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;

        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        assert_eq!(env.typ, "auth_request");

        write_frame(
            &mut broker_half,
            &ZERO_KEY,
            &mut broker_send,
            "rej-2",
            "pre_auth_reject",
            Some(raw(r#"{"code":"rate_limited","reason":"slow down"}"#)),
        )
        .await
        .expect("write pre_auth_reject");

        let res = session.await.expect("join");
        assert!(
            matches!(res, Err(SessionError::Transient(_))),
            "expected Transient, got {:?}",
            res
        );
    }

    /// A ping from the broker must be answered with a pong carrying the same id.
    #[tokio::test]
    async fn test_ping_is_ponged() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id).await
        });

        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;

        // Handshake.
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        let session_key = [9u8; 32];
        let resp = format!(
            r#"{{"accepted":true,"sessionKey":"{}"}}"#,
            hex::encode(session_key)
        );
        write_frame(
            &mut broker_half,
            &ZERO_KEY,
            &mut broker_send,
            &env.id,
            "auth_response",
            Some(raw(&resp)),
        )
        .await
        .expect("write auth_response");

        // Send a ping under the session key.
        write_frame(
            &mut broker_half,
            &session_key,
            &mut broker_send,
            "ping-42",
            "ping",
            None,
        )
        .await
        .expect("write ping");

        // Expect a pong with the same id.
        let pong = read_frame(&mut broker_half, &session_key, &mut broker_recv)
            .await
            .expect("read pong");
        assert_eq!(pong.typ, "pong");
        assert_eq!(pong.id, "ping-42");

        // Clean disconnect ends the session.
        write_frame(
            &mut broker_half,
            &session_key,
            &mut broker_send,
            "bye",
            "disconnect",
            None,
        )
        .await
        .expect("write disconnect");

        let res = session.await.expect("join");
        assert!(matches!(res, Ok(())), "expected clean Ok, got {:?}", res);
    }

    // --- Reconnect-driver core ---

    /// `next_backoff` doubles from the floor, caps at `BACKOFF_MAX`, and never
    /// panics/overflows even when called repeatedly at the ceiling.
    #[test]
    fn test_next_backoff_doubles_and_caps() {
        // Doubles from the floor.
        assert_eq!(next_backoff(BACKOFF_MIN), BACKOFF_MIN * 2);
        assert_eq!(next_backoff(Duration::from_secs(2)), Duration::from_secs(4));
        assert_eq!(next_backoff(Duration::from_secs(4)), Duration::from_secs(8));

        // Saturates at the ceiling: a value just below the cap that would
        // double past it lands exactly on BACKOFF_MAX.
        assert_eq!(next_backoff(Duration::from_secs(20)), BACKOFF_MAX);
        assert_eq!(next_backoff(BACKOFF_MAX), BACKOFF_MAX);

        // Repeated calls from the floor converge to the cap and stay there,
        // never panicking from overflow.
        let mut b = BACKOFF_MIN;
        for _ in 0..1000 {
            b = next_backoff(b);
            assert!(b <= BACKOFF_MAX, "backoff exceeded cap: {:?}", b);
        }
        assert_eq!(b, BACKOFF_MAX);

        // Extreme input near Duration::MAX must saturate, not overflow/panic.
        assert_eq!(next_backoff(Duration::MAX), BACKOFF_MAX);
    }

    /// `wait_or_stop` returns promptly (`true`) when the stop watch is already
    /// true, without sleeping.
    #[tokio::test(start_paused = true)]
    async fn test_wait_or_stop_returns_when_already_stopped() {
        let (tx, mut rx) = tokio::sync::watch::channel(true);
        let stopped = wait_or_stop(&mut rx, Duration::from_secs(30)).await;
        assert!(stopped, "expected stop=true to short-circuit");
        drop(tx);
    }

    /// `wait_or_stop` wakes early and returns `true` when stop flips to true
    /// mid-wait — no real wall-clock sleep thanks to paused time.
    #[tokio::test(start_paused = true)]
    async fn test_wait_or_stop_wakes_on_stop_flip() {
        let (tx, mut rx) = tokio::sync::watch::channel(false);

        let waiter = tokio::spawn(async move {
            wait_or_stop(&mut rx, Duration::from_secs(30)).await
        });

        // Let the waiter park on the select, then flip stop to true.
        tokio::task::yield_now().await;
        tx.send(true).expect("send stop");

        let stopped = waiter.await.expect("join");
        assert!(stopped, "expected early wake with stop=true");
    }

    /// `wait_or_stop` waits the full requested duration when stop stays false,
    /// then returns `false`. Verified against the paused clock — advancing time
    /// just short of the duration does not complete it; advancing past does.
    #[tokio::test(start_paused = true)]
    async fn test_wait_or_stop_waits_full_duration() {
        let (_tx, mut rx) = tokio::sync::watch::channel(false);

        let waiter = tokio::spawn(async move {
            wait_or_stop(&mut rx, Duration::from_secs(10)).await
        });

        // Just before the deadline: still pending.
        tokio::time::advance(Duration::from_secs(9)).await;
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished(), "completed before its duration elapsed");

        // Past the deadline: completes, returning false (stop never flipped).
        tokio::time::advance(Duration::from_secs(2)).await;
        let stopped = waiter.await.expect("join");
        assert!(!stopped, "expected false when stop stayed unset");
    }
}
