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

use super::consent::{
    ConsentRequest, ConsentTracker, Outbound, RequestAction, UiEvent, CONSENT_PROTOCOL_VERSION,
};
use super::chat::{
    ChatAction, ChatBridge, ChatClose, ChatEvent, ChatReplyResult, ChatShow, ChatTracker, PRESENTED_FAILED as CHAT_PRESENTED_FAILED,
};
use super::desktop::{self, ConsentBridge};
use super::message::{
    MessageRetract, MessageShow, MessageTracker, MsgEvent, ShowAction, PRESENTED_FAILED,
};
use super::envelope::{read_frame, write_frame, IpcError, PROTOCOL_VERSION};
use super::prompt::{
    self as prompt, Addressed, ClosedReason, CloseOutcome, Decoded, PromptBridge, PromptClose, PromptRef, PromptShow,
    PromptUpdate, ShowOutcome, UpdateOutcome, ADVERTISED_PROMPT_KINDS, PROMPT_PROTOCOL_VERSION,
};
use super::token::HelperToken;
use super::transport::{
    self_binary_hash, PeerIdentity,
};
use tauri::AppHandle;

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

/// Outcome of a single [`run_session_with_identity`] call. The reconnect driver
/// uses this to decide whether to retry (and how) or to stop permanently.
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
    /// The consent prompt exchange this helper speaks (see `consent.rs`).
    #[serde(rename = "consentProtocolVersion")]
    consent_protocol_version: i32,
    /// This helper renders `message_show` cards (#8293). The agent grants the
    /// `messaging` scope only to an assist helper that says so.
    #[serde(rename = "supportsMessaging")]
    supports_messaging: bool,
    /// This helper renders the endpoint live chat window (#8743). The agent
    /// grants the `chat` scope only to an assist helper that says so.
    #[serde(rename = "supportsChat")]
    supports_chat: bool,
    /// The prompt host envelope version this helper speaks (#10190). The
    /// broker clamps it to its own; absent (an older helper) means 0.
    #[serde(rename = "promptProtocolVersion")]
    prompt_protocol_version: u32,
    /// The `"<kind>@<n>"` prompt kinds this helper draws. W02: none, so the
    /// key is omitted and no `prompt` scope is granted.
    #[serde(rename = "promptKinds", skip_serializing_if = "Vec::is_empty")]
    prompt_kinds: Vec<String>,
    /// This helper's version, reported in the live renderer observation.
    #[serde(rename = "rendererVersion")]
    renderer_version: String,
    /// The OS UI language (raw BCP 47 / POSIX tag; the agent negotiates it
    /// onto the eight prompt locales). Additive (#10190 W03, plan P6); omitted
    /// when the probe found nothing.
    #[serde(rename = "uiLocale", skip_serializing_if = "String::is_empty")]
    ui_locale: String,
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
        consent_protocol_version: CONSENT_PROTOCOL_VERSION,
        supports_messaging: true,
        supports_chat: true,
        prompt_protocol_version: PROMPT_PROTOCOL_VERSION,
        prompt_kinds: ADVERTISED_PROMPT_KINDS.iter().map(|k| k.to_string()).collect(),
        renderer_version: env!("CARGO_PKG_VERSION").to_string(),
        ui_locale: crate::chrome::os_ui_locale().to_string(),
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

/// The `capabilities` frame the helper sends after auth (camelCase on the wire).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    caller_verify: bool,
}

/// Tauri-side hooks the IPC session needs to drive the desktop consent/banner
/// UI. Kept `Option`al so the protocol-level tests can run the session loop with
/// no Tauri app handle (they exercise auth/token/ping paths only).
#[derive(Clone)]
pub struct DesktopCtx {
    pub app: AppHandle,
    pub bridge: std::sync::Arc<ConsentBridge>,
    pub caller_verify: std::sync::Arc<super::caller_verify::CallerVerifyBridge>,
    pub messages: std::sync::Arc<super::message::MessageBridge>,
    pub chat: std::sync::Arc<ChatBridge>,
    pub prompts: std::sync::Arc<PromptBridge>,
}

/// Run a single IPC session over an already-connected `stream` with an explicit
/// identity: auth handshake, then a token-receipt loop until disconnect or error.
///
/// The testable core — generic over any duplex byte stream so tests can drive a
/// fake broker over [`tokio::io::duplex`]. Taking the identity explicitly lets
/// tests avoid relying on process-global state.
pub async fn run_session_with_identity<S>(
    stream: S,
    token: &HelperToken,
    identity: &PeerIdentity,
    desktop_ctx: Option<&DesktopCtx>,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    run_session(stream, token, identity, desktop_ctx, None).await
}

/// [`run_session_with_identity`] with an optional prompt bridge override:
/// tests inject one whose tracker advertises kinds the W02 build does not.
async fn run_session<S>(
    stream: S,
    token: &HelperToken,
    identity: &PeerIdentity,
    desktop_ctx: Option<&DesktopCtx>,
    prompt_override: Option<std::sync::Arc<PromptBridge>>,
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

    // --- Consent bridge ---
    // The `consent_presented` / `submit_consent` Tauri commands run on other
    // tasks; they can't touch this stream directly. They send a UiEvent
    // through this channel, which we drain in the select! below; the
    // ConsentTracker turns it into the frame to write on this socket (same
    // send_seq / session_key).
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();
    if let Some(ctx) = desktop_ctx {
        ctx.bridge.set_sender(event_tx);
    }
    // On any session-loop exit, clear the bridge so a later command on a
    // dead session fails fast instead of writing into the orphaned channel.
    // Caller verification (W02) is offered only to the real Assist app. With
    // no desktop context the receiver is a never-ready placeholder (its sender
    // stays alive in `_caller_idle_tx`, so recv() pends instead of resolving).
    let (_caller_idle_tx, idle_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut caller_rx = match desktop_ctx {
        Some(ctx) => ctx.caller_verify.connect(),
        None => idle_rx,
    };
    // Prompt host (#10190). Without a desktop context (protocol tests) a
    // session-local bridge still answers every prompt_* it cannot draw.
    let prompts: std::sync::Arc<PromptBridge> = match (prompt_override, desktop_ctx) {
        (Some(bridge), _) => bridge,
        (None, Some(ctx)) => ctx.prompts.clone(),
        (None, None) => std::sync::Arc::new(PromptBridge::default()),
    };
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();
    prompts.set_sender(prompt_tx);
    // Constructed before the capabilities write so a failed write still cleans up.
    let _bridge_guard = BridgeClearGuard {
        bridge: desktop_ctx.map(|c| c.bridge.clone()),
        caller: desktop_ctx.map(|c| c.caller_verify.clone()),
        app: desktop_ctx.map(|c| c.app.clone()),
        messages: desktop_ctx.map(|c| c.messages.clone()),
        chat: desktop_ctx.map(|c| c.chat.clone()),
        prompts: Some(prompts.clone()),
    };
    // Endpoint messages (#8293): card events (ack / closed) arrive here.
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel::<MsgEvent>();
    if let Some(ctx) = desktop_ctx {
        ctx.messages.set_sender(msg_tx);
    }
    // Endpoint live chat (#8743): reply frames from the chat window arrive here.
    let (chat_tx, mut chat_rx) = tokio::sync::mpsc::unbounded_channel::<ChatEvent>();
    if let Some(ctx) = desktop_ctx {
        ctx.chat.set_sender(chat_tx);
    }
    let mut caller_tick = tokio::time::interval(Duration::from_millis(250));
    if desktop_ctx.is_some() {
        write_frame(
            &mut stream,
            &session_key,
            &mut send_seq,
            "capabilities",
            "capabilities",
            Some(to_raw_payload(&Capabilities { caller_verify: true })?),
        )
        .await?;
    }
    let mut consent = ConsentTracker::default();

    // --- Receive loop (session key) ---
    loop {
        let res = tokio::select! {
            // An event from the consent window: the prompt is on screen, or
            // the user answered / the countdown ran out.
            Some(event) = event_rx.recv() => {
                if let Some(frame) = consent.on_ui_event(event) {
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
                continue;
            }
            // A message card event: Acknowledge, or closed without one.
            Some(event) = msg_rx.recv() => {
                if let Some(ctx) = desktop_ctx {
                    let frame = match event {
                        MsgEvent::Ack(id) => ctx.messages.tracker().on_ack(&id),
                        MsgEvent::Closed(id) => ctx.messages.tracker().on_closed(&id),
                    };
                    // The entry left the one notification list (#10190 W04).
                    if frame.is_some() {
                        desktop::publish_notification_list(&ctx.app);
                    }
                    if let Some(frame) = frame {
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                }
                continue;
            }
            // A prompt card / list frame (prompt_action, prompt_closed{hidden}),
            // already recorded by the tracker.
            Some(frame) = prompt_rx.recv() => {
                write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                continue;
            }
            // A reply typed in the chat window, already validated and recorded.
            Some(event) = chat_rx.recv() => {
                match event {
                    ChatEvent::Send(frame) => {
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                }
                continue;
            }
            // A caller-verification answer (choice, not_me, or timeout).
            Some(response) = caller_rx.recv() => {
                let payload = serde_json::json!({
                    "choice": response.choice,
                    "helperVersion": env!("CARGO_PKG_VERSION"),
                });
                write_frame(
                    &mut stream,
                    &session_key,
                    &mut send_seq,
                    &response.envelope_id,
                    "caller_verify_response",
                    Some(to_raw_payload(&payload)?),
                )
                .await?;
                continue;
            }
            // Deadline polling is owned by this loop (no detached timers that
            // could outlive a reconnect).
            _ = caller_tick.tick() => {
                if let Some(ctx) = desktop_ctx {
                    for id in ctx.caller_verify.expire_due() {
                        super::caller_verify::close_window(&ctx.app, &id);
                    }
                    // Message cards past `expiresAt` close themselves; the
                    // agent is told `message_dismissed` reason `expired`.
                    // Chat replies with no result after 30 s fail (retryable).
                    let stale = ctx.chat.tracker().expire_pending(now_unix_ms());
                    for id in stale {
                        publish_chat_view(ctx, &id);
                    }
                    let due = ctx.messages.tracker().expire_due(now_unix_ms());
                    if !due.is_empty() {
                        desktop::publish_notification_list(&ctx.app);
                    }
                    for (id, frame) in due {
                        desktop::close_message_window(&ctx.app, &id);
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                    // Prompts: stuck actions are released, lapsed list
                    // entries dropped. Never a deadline: expiry is the agent's.
                    let report = prompts.tracker().expire_due(now_unix_ms());
                    for id in &report.views {
                        desktop::publish_prompt_state(&ctx.app, Some(id));
                    }
                    if report.list_changed && report.views.is_empty() {
                        desktop::publish_prompt_state(&ctx.app, None);
                    }
                }
                continue;
            }
            r = tokio::time::timeout(
                READ_IDLE_TIMEOUT,
                read_frame(&mut stream, &session_key, &mut recv_seq),
            ) => r,
        };

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
            "consent_request" => match parse_payload::<ConsentRequest>(&env.payload) {
                Ok(req) => match consent.on_request(&env.id, &req) {
                    RequestAction::Reply(frame) => {
                        eprintln!("[helper] consent prompt refused: another prompt is on screen");
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                    RequestAction::Show => {
                        let shown = match desktop_ctx {
                            Some(ctx) => desktop::show_consent_window(&ctx.app, &ctx.bridge, &req),
                            None => Err("no desktop context".to_string()),
                        };
                        if let Err(e) = shown {
                            eprintln!("[helper] consent prompt could not be shown: {}", e);
                            if let Some(frame) = consent.on_show_failed() {
                                write_outbound(&mut stream, &session_key, &mut send_seq, frame)
                                    .await?;
                            }
                        }
                    }
                },
                // Nothing we can correlate a reply to; the agent's own
                // deadline reports the prompt as not shown.
                Err(e) => eprintln!("[helper] bad consent_request payload: {}", e),
            },
            "consent_cancel" => {
                // The agent stopped waiting for this prompt; take it down.
                if let Ok(c) = parse_payload::<ConsentCancelPayload>(&env.payload) {
                    if consent.on_cancel(&c.nonce) {
                        if let Some(ctx) = desktop_ctx {
                            desktop::close_consent_window(&ctx.app);
                        }
                    }
                }
            }
            "caller_verify_request" => {
                // Only the real Assist app can show the prompt; anything
                // invalid is ignored (never approved).
                if let Some(ctx) = desktop_ctx {
                    match parse_payload::<super::caller_verify::Request>(&env.payload) {
                        Ok(req) => {
                            let id = req.verification_id.clone();
                            // The answer reuses the request's envelope id,
                            // which the contract fixes to caller-verify-<id>.
                            if env.id != format!("caller-verify-{id}") {
                                eprintln!("[helper] caller_verify_request: envelope id mismatch");
                            } else {
                                match ctx.caller_verify.insert(env.id.clone(), req) {
                                    Ok(super::caller_verify::Admission::Show) => {
                                        if let Err(e) = super::caller_verify::show_prompt_window(&ctx.app, &id) {
                                            eprintln!("[helper] caller verify window could not be shown: {}", e);
                                            let _ = ctx.caller_verify.submit(&id, "timeout");
                                        }
                                    }
                                    // #8668: delivered after its deadline; answered timeout, never shown.
                                    Ok(super::caller_verify::Admission::Expired) => {
                                        eprintln!("[helper] caller_verify_request past its deadline; not shown");
                                    }
                                    Err(e) => eprintln!("[helper] caller_verify_request rejected: {}", e),
                                }
                            }
                        }
                        Err(e) => eprintln!("[helper] bad caller_verify_request payload: {}", e),
                    }
                }
            }
            "message_show" => match parse_payload::<MessageShow>(&env.payload) {
                Ok(req) => {
                    // Never log title/body. The card is its own window; the
                    // main Assist window is never shown for a message (#8138).
                    let action =
                        desktop_ctx.map(|ctx| ctx.messages.tracker().on_show(now_unix_ms(), &req));
                    let frames: Vec<Outbound> = match (action, desktop_ctx) {
                        (Some(ShowAction::Show { plan, view }), Some(ctx)) => {
                            let frames = match desktop::show_message_window(&ctx.app, &plan, &view) {
                                Ok(()) => vec![MessageTracker::presented(&env.id, &req.message_id)],
                                Err(e) => {
                                    eprintln!("[helper] message card could not be shown: {}", e);
                                    ctx.messages.tracker().on_show_failed(&req.message_id);
                                    vec![MessageTracker::presented_with_status(
                                        &env.id,
                                        &req.message_id,
                                        PRESENTED_FAILED,
                                    )]
                                }
                            };
                            // Message cards are in the one notification list
                            // (#10190 W04): a notice to the tab, never a show.
                            desktop::publish_notification_list(&ctx.app);
                            frames
                        }
                        (Some(action), _) => {
                            if let ShowAction::Reject(why) = &action {
                                eprintln!("[helper] message_show rejected: {}", why);
                            }
                            MessageTracker::replies_for(&env.id, &req.message_id, action)
                        }
                        _ => Vec::new(),
                    };
                    for frame in frames {
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                }
                Err(e) => eprintln!("[helper] bad message_show payload: {}", e),
            },
            "message_retract" => {
                if let (Ok(r), Some(ctx)) = (parse_payload::<MessageRetract>(&env.payload), desktop_ctx) {
                    if ctx.messages.tracker().on_retract(&r.message_id) {
                        desktop::close_message_window(&ctx.app, &r.message_id);
                        desktop::publish_notification_list(&ctx.app);
                    }
                }
            }
            // Endpoint live chat (#8743). ONLY this arm may build a chat window
            // (a live chat_open for a conversation with no window: the "incoming
            // call"); replays are restored silently and every later message,
            // close and reply result below can badge/flash but never raise.
            "chat_open" => match parse_payload::<ChatShow>(&env.payload) {
                Ok(show) => {
                    let mut frames: Vec<Outbound> = Vec::new();
                    if let Some(ctx) = desktop_ctx {
                        let win = desktop::chat_win_state(&ctx.app, &show.conversation_id);
                        let action = ctx.chat.tracker().on_open(&show, win);
                        match action {
                            ChatAction::ShowWindow { conversation_id, created } => {
                                match desktop::show_chat_window(&ctx.app, &conversation_id, false) {
                                    Ok(()) => {
                                        publish_chat_view(ctx, &conversation_id);
                                        frames.push(chat_presented(&env.id, &show, ""));
                                    }
                                    Err(e) => {
                                        eprintln!("[helper] chat window could not be shown: {}", e);
                                        ctx.chat.tracker().on_show_failed(&conversation_id, created);
                                        frames.push(chat_presented(&env.id, &show, CHAT_PRESENTED_FAILED));
                                    }
                                }
                            }
                            other => frames.extend(apply_chat_action(ctx, &env.id, &show, other)),
                        }
                    }
                    for frame in frames {
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                }
                Err(e) => {
                    // Unparseable: no conversation to name, but the agent is
                    // waiting on this envelope id; answer so it fails fast.
                    eprintln!("[helper] bad chat_open payload: {}", e);
                    let frame = ChatTracker::presented(&env.id, "", None, CHAT_PRESENTED_FAILED);
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
            },
            "chat_message" => match parse_payload::<ChatShow>(&env.payload) {
                Ok(show) => {
                    let mut frames: Vec<Outbound> = Vec::new();
                    if let Some(ctx) = desktop_ctx {
                        let win = desktop::chat_win_state(&ctx.app, &show.conversation_id);
                        let action = ctx.chat.tracker().on_message(&show, win);
                        frames.extend(apply_chat_action(ctx, &env.id, &show, action));
                    }
                    for frame in frames {
                        write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                    }
                }
                Err(e) => {
                    // Unparseable: no conversation to name, but the agent is
                    // waiting on this envelope id; answer so it fails fast.
                    eprintln!("[helper] bad chat_message payload: {}", e);
                    let frame = ChatTracker::presented(&env.id, "", None, CHAT_PRESENTED_FAILED);
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
            },
            "chat_close" => {
                if let (Ok(c), Some(ctx)) = (parse_payload::<ChatClose>(&env.payload), desktop_ctx) {
                    if ctx.chat.tracker().on_close(&c.conversation_id) {
                        publish_chat_view(ctx, &c.conversation_id);
                    }
                }
            }
            "chat_reply_result" => {
                if let (Ok(r), Some(ctx)) = (parse_payload::<ChatReplyResult>(&env.payload), desktop_ctx) {
                    if ctx.chat.tracker().on_reply_result(&r) {
                        publish_chat_view(ctx, &r.conversation_id);
                    }
                }
            }
            "banner_show" => {
                match parse_payload::<desktop::BannerShowRequest>(&env.payload) {
                    Ok(req) => {
                        if let Some(ctx) = desktop_ctx {
                            desktop::show_banner_window(&ctx.app, &req);
                        }
                    }
                    Err(e) => eprintln!("[helper] bad banner_show payload: {}", e),
                }
            }
            "banner_hide" => {
                if let Some(ctx) = desktop_ctx {
                    desktop::hide_banner_window(&ctx.app);
                }
            }
            // Prompt host (#10190). Rule 4: a prompt_* this helper cannot draw
            // is answered prompt_closed{render_failed}, never dropped. None of
            // these arms (or their handlers) can reach the main window (#8138).
            "prompt_show" => {
                let frames = handle_prompt_show(desktop_ctx, &prompts, &env.id, &env.payload);
                for frame in frames {
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
            }
            "prompt_update" => {
                let frames = handle_prompt_update(desktop_ctx, &prompts, &env.id, &env.payload);
                for frame in frames {
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
            }
            "prompt_close" => {
                let frames = handle_prompt_close(desktop_ctx, &prompts, &env.id, &env.payload);
                for frame in frames {
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
            }
            "prompt_action_result" => handle_prompt_action_result(desktop_ctx, &prompts, &env.id, &env.payload),
            "prompt_branding_sync" => handle_prompt_branding_sync(&prompts, &env.id, &env.payload),
            other if other.starts_with("prompt_") => {
                let frames = handle_prompt_unknown(desktop_ctx, &prompts, other, &env.id, &env.payload);
                for frame in frames {
                    write_outbound(&mut stream, &session_key, &mut send_seq, frame).await?;
                }
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

/// The `consent_cancel` payload.
#[derive(Debug, Deserialize)]
struct ConsentCancelPayload {
    #[serde(default)]
    nonce: String,
}

/// Write one consent frame produced by the [`ConsentTracker`].
async fn write_outbound<S>(
    stream: &mut S,
    session_key: &[u8; 32],
    send_seq: &mut u64,
    frame: Outbound,
) -> Result<(), SessionError>
where
    S: AsyncWrite + Unpin,
{
    let payload = to_raw_payload(&frame.payload)?;
    write_frame(
        stream,
        session_key,
        send_seq,
        &frame.id,
        frame.typ,
        Some(payload),
    )
    .await?;
    Ok(())
}

/// Clears the consent bridge's sender when the session loop exits (normal,
/// error, or panic), so a `submit_consent` call after the socket is gone fails
/// fast rather than queueing into a channel no one reads.
struct BridgeClearGuard {
    bridge: Option<std::sync::Arc<ConsentBridge>>,
    caller: Option<std::sync::Arc<super::caller_verify::CallerVerifyBridge>>,
    app: Option<AppHandle>,
    messages: Option<std::sync::Arc<super::message::MessageBridge>>,
    chat: Option<std::sync::Arc<ChatBridge>>,
    prompts: Option<std::sync::Arc<PromptBridge>>,
}

/// `chat_presented` for a live `chat_open` / `chat_message`: the SAME envelope
/// id as the request. Ids are echoed only when canonical, never raw input.
fn chat_presented(env_id: &str, show: &ChatShow, status: &str) -> Outbound {
    let message_id = show
        .messages
        .first()
        .map(|m| m.message_id.as_str())
        .filter(|m| m.len() == 36 && m.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    let conversation_id = if show.conversation_id.len() == 36 { show.conversation_id.as_str() } else { "" };
    ChatTracker::presented(env_id, conversation_id, message_id, status)
}

/// Push the conversation's current state to its window (if open) and refresh
/// the tray badge. Never shows or focuses anything.
fn publish_chat_view(ctx: &DesktopCtx, conversation_id: &str) {
    if let Some(view) = ctx.chat.view(conversation_id) {
        desktop::emit_chat_update(&ctx.app, &view);
    }
    crate::refresh_chat_tray(&ctx.app);
}

/// Carry out every action except `ShowWindow` (the `chat_open` arm owns
/// that) and return the `chat_presented` reply. Nothing here can show,
/// un-minimise or focus a window: the strongest effect is a taskbar flash on
/// a window that is already on screen.
fn apply_chat_action(ctx: &DesktopCtx, env_id: &str, show: &ChatShow, action: ChatAction) -> Vec<Outbound> {
    match action {
        ChatAction::UpdateAndFlash { conversation_id } => {
            publish_chat_view(ctx, &conversation_id);
            desktop::flash_chat_window(&ctx.app, &conversation_id);
            vec![chat_presented(env_id, show, "")]
        }
        ChatAction::BadgeOnly { conversation_id } | ChatAction::RestoreSilently { conversation_id } => {
            publish_chat_view(ctx, &conversation_id);
            // A replay is fire-and-forget; the agent ignores a stray reply.
            if show.replay { Vec::new() } else { vec![chat_presented(env_id, show, "")] }
        }
        ChatAction::Duplicate { .. } => {
            if show.replay { Vec::new() } else { vec![chat_presented(env_id, show, "")] }
        }
        ChatAction::Reject(why) => {
            eprintln!("[helper] chat frame rejected: {}", why);
            if show.replay { Vec::new() } else { vec![chat_presented(env_id, show, CHAT_PRESENTED_FAILED)] }
        }
        // Only the chat_open arm can build a window.
        ChatAction::ShowWindow { .. } => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Prompt host (#10190)
// ---------------------------------------------------------------------------

/// The raw JSON of an envelope payload, if any.
fn payload_str(payload: &Option<Box<RawValue>>) -> Option<&str> {
    payload.as_ref().map(|p| p.get())
}

/// Take down whatever this helper had for a prompt it just refused, so no card
/// with a lease the agent no longer honours stays on screen.
fn drop_prompt(ctx: Option<&DesktopCtx>, prompts: &PromptBridge, prompt_id: &str) {
    prompts.tracker().forget(prompt_id);
    if let Some(ctx) = ctx {
        desktop::close_prompt_window(&ctx.app, prompt_id);
        desktop::publish_prompt_state(&ctx.app, None);
    }
}

/// `prompt_closed{render_failed, <detail>}` on the inbound envelope id. Logs
/// the ids (never prompt copy).
fn refuse(typ: &str, env_id: &str, r: &PromptRef, detail: &str) -> Outbound {
    eprintln!(
        "[helper] {typ} refused: {detail} (promptId={} rev={} env={})",
        r.prompt_id,
        r.rev,
        log_id(env_id)
    );
    prompt::closed_frame(env_id, r, ClosedReason::RenderFailed, Some(detail))
}

/// An agent-supplied id or type for a log line: bounded and printable.
fn log_id(s: &str) -> String {
    s.chars().take(64).map(|c| if c.is_ascii_graphic() { c } else { '?' }).collect()
}

/// A show / update whose rev is not newer than the one applied (a duplicate or
/// late delivery): dropped, with the ids logged.
fn log_stale(typ: &str, env_id: &str, r: &PromptRef) {
    eprintln!(
        "[helper] {typ} not newer than the applied rev; dropped (promptId={} rev={} env={})",
        r.prompt_id,
        r.rev,
        log_id(env_id)
    );
}

/// A prompt message with no valid promptId / rev / lease: nothing to address
/// a reply to, so it is logged and dropped.
fn log_unaddressable(typ: &str, env_id: &str) {
    eprintln!(
        "[helper] {} without a valid promptId/rev/lease; ignored (env={})",
        log_id(typ),
        log_id(env_id)
    );
}

/// `prompt_show`: the ONLY place a prompt card window is built. The reply
/// (`prompt_presented`, or `prompt_closed{render_failed}`) reuses the show's
/// envelope id, like `message_presented`.
fn handle_prompt_show(
    ctx: Option<&DesktopCtx>,
    prompts: &PromptBridge,
    env_id: &str,
    payload: &Option<Box<RawValue>>,
) -> Vec<Outbound> {
    let show: PromptShow = match prompt::decode(payload_str(payload)) {
        Decoded::Ok(s) => s,
        Decoded::Malformed(r) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            return vec![refuse("prompt_show", env_id, &r, prompt::DETAIL_MALFORMED)];
        }
        Decoded::Unaddressable => {
            log_unaddressable("prompt_show", env_id);
            return Vec::new();
        }
    };
    let r = show.reference();
    let outcome = prompts.tracker().on_show(now_unix_ms(), &show);
    let frame = match outcome {
        ShowOutcome::DropStale => {
            log_stale("prompt_show", env_id, &r);
            return Vec::new();
        }
        ShowOutcome::RenderFailed(detail) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            return vec![refuse("prompt_show", env_id, &r, detail)];
        }
        // List only (list_only, or every visible slot taken): rendered, not on screen.
        ShowOutcome::Render { window: None } => prompt::presented_frame(env_id, &r, false),
        ShowOutcome::Render { window: Some(plan) } => match ctx {
            Some(ctx) => match desktop::show_prompt_window(&ctx.app, &plan) {
                Ok(()) => prompt::presented_frame(env_id, &r, true),
                Err(e) => {
                    eprintln!("[helper] prompt card could not be shown: {}", e);
                    prompts.tracker().on_window_failed(&r.prompt_id);
                    refuse("prompt_show", env_id, &r, prompt::DETAIL_WINDOW_FAILED)
                }
            },
            None => {
                prompts.tracker().on_window_failed(&r.prompt_id);
                refuse("prompt_show", env_id, &r, prompt::DETAIL_WINDOW_FAILED)
            }
        },
        // A newer rev of a prompt already shown: refreshed in place (below).
        ShowOutcome::Replace { card_open } => prompt::presented_frame(env_id, &r, card_open),
    };
    if let Some(ctx) = ctx {
        desktop::publish_prompt_state(&ctx.app, Some(&r.prompt_id));
    }
    vec![frame]
}

/// `prompt_update`: applied in place; a merged state that is no longer valid
/// is refused and its card taken down.
fn handle_prompt_update(
    ctx: Option<&DesktopCtx>,
    prompts: &PromptBridge,
    env_id: &str,
    payload: &Option<Box<RawValue>>,
) -> Vec<Outbound> {
    let update: PromptUpdate = match prompt::decode(payload_str(payload)) {
        Decoded::Ok(u) => u,
        Decoded::Malformed(r) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            return vec![refuse("prompt_update", env_id, &r, prompt::DETAIL_MALFORMED)];
        }
        Decoded::Unaddressable => {
            log_unaddressable("prompt_update", env_id);
            return Vec::new();
        }
    };
    let r = update.reference();
    let outcome = prompts.tracker().on_update(now_unix_ms(), &update);
    match outcome {
        UpdateOutcome::Applied { .. } => {
            if let Some(ctx) = ctx {
                desktop::publish_prompt_state(&ctx.app, Some(&r.prompt_id));
            }
            Vec::new()
        }
        UpdateOutcome::DropStale => {
            log_stale("prompt_update", env_id, &r);
            Vec::new()
        }
        UpdateOutcome::RenderFailed(detail) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            vec![refuse("prompt_update", env_id, &r, detail)]
        }
    }
}

/// `prompt_close`. An unreadable close still takes the card down.
fn handle_prompt_close(
    ctx: Option<&DesktopCtx>,
    prompts: &PromptBridge,
    env_id: &str,
    payload: &Option<Box<RawValue>>,
) -> Vec<Outbound> {
    let close: PromptClose = match prompt::decode(payload_str(payload)) {
        Decoded::Ok(c) => c,
        Decoded::Malformed(r) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            return vec![refuse("prompt_close", env_id, &r, prompt::DETAIL_MALFORMED)];
        }
        Decoded::Unaddressable => {
            log_unaddressable("prompt_close", env_id);
            return Vec::new();
        }
    };
    let outcome = prompts.tracker().on_close(now_unix_ms(), &close);
    match (outcome, ctx) {
        (CloseOutcome::Closed { had_card }, Some(ctx)) => {
            if had_card {
                desktop::close_prompt_window(&ctx.app, &close.prompt_id);
            }
            desktop::publish_prompt_state(&ctx.app, None);
        }
        (CloseOutcome::Closed { .. }, None) => {}
        (other, _) => eprintln!(
            "[helper] prompt_close {:?}; ignored (promptId={} rev={} env={})",
            other,
            close.prompt_id,
            close.rev,
            log_id(env_id)
        ),
    }
    Vec::new()
}

/// `prompt_action_result`, the reply on the `prompt_action` envelope: releases
/// the card's "working" state for the action sent on that envelope only.
fn handle_prompt_action_result(
    ctx: Option<&DesktopCtx>,
    prompts: &PromptBridge,
    env_id: &str,
    payload: &Option<Box<RawValue>>,
) {
    match payload_str(payload).map(serde_json::from_str::<prompt::PromptActionResult>) {
        Some(Ok(result)) => {
            let changed = prompts.tracker().on_action_result(env_id, &result);
            if changed {
                if let Some(ctx) = ctx {
                    desktop::publish_prompt_state(&ctx.app, Some(&result.prompt_id));
                }
            } else {
                eprintln!(
                    "[helper] prompt_action_result matches no action in flight; ignored (promptId={} actionId={} rev={} env={})",
                    log_id(&result.prompt_id),
                    log_id(&result.action_id),
                    result.rev,
                    log_id(env_id)
                );
            }
        }
        _ => eprintln!("[helper] bad prompt_action_result payload; ignored (env={})", log_id(env_id)),
    }
}

/// `prompt_branding_sync`: the MSP identity, kept in memory; the bridge tells
/// the main window and the prompt cards (identity header) and the tray.
/// `cleared: true` drops the identity.
fn handle_prompt_branding_sync(prompts: &PromptBridge, env_id: &str, payload: &Option<Box<RawValue>>) {
    match payload_str(payload).map(serde_json::from_str::<prompt::PromptBrandingSync>) {
        Some(Ok(sync)) => {
            if !prompts.branding_sync(sync) {
                eprintln!("[helper] prompt_branding_sync ignored: incomplete identity (env={})", log_id(env_id));
            }
        }
        _ => eprintln!("[helper] bad prompt_branding_sync payload; ignored (env={})", log_id(env_id)),
    }
}

/// A `prompt_*` type this build does not know. Addressable ones are refused
/// (and anything shown for that prompt taken down); the renderer's own types
/// echoed back are ignored.
fn handle_prompt_unknown(
    ctx: Option<&DesktopCtx>,
    prompts: &PromptBridge,
    typ: &str,
    env_id: &str,
    payload: &Option<Box<RawValue>>,
) -> Vec<Outbound> {
    if prompt::is_renderer_type(typ) {
        eprintln!("[helper] {typ} is renderer-to-agent; ignored (env={})", log_id(env_id));
        return Vec::new();
    }
    match prompt::decode::<PromptRef>(payload_str(payload)) {
        Decoded::Ok(r) => {
            drop_prompt(ctx, prompts, &r.prompt_id);
            vec![refuse(&log_id(typ), env_id, &r, prompt::DETAIL_UNSUPPORTED_TYPE)]
        }
        _ => {
            log_unaddressable(typ, env_id);
            Vec::new()
        }
    }
}

/// Wall-clock milliseconds since the Unix epoch.
pub(crate) fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Drop for BridgeClearGuard {
    fn drop(&mut self) {
        // Message cards die with the session: the helper stores nothing and
        // the agent replays sticky messages after the next auth (#8293).
        if let Some(messages) = &self.messages {
            messages.clear_sender();
            let ids = messages.tracker().clear();
            if let Some(app) = &self.app {
                // Their list entries go too (#10190 W04): nothing outlives
                // the session. Nothing was on screen: leave the tray alone.
                let had_any = !ids.is_empty();
                for id in ids {
                    desktop::close_message_window(app, &id);
                }
                if had_any {
                    desktop::publish_notification_list(app);
                }
            }
        }
        // Chat (#8743): the windows and transcripts survive a reconnect (the
        // agent replays silently), but a reply in flight will never get its
        // result on this dead session: mark it failed so the user can resend.
        if let Some(chat) = &self.chat {
            chat.clear_sender();
            let changed = chat.tracker().fail_pending_replies();
            if let Some(app) = &self.app {
                for id in changed {
                    if let Some(view) = chat.view(&id) {
                        desktop::emit_chat_update(app, &view);
                    }
                }
            }
        }
        // Prompts (#10190) die with the session too: cards close, and an
        // action still waiting for its result is dropped, never replayed on a
        // later session. The agent replays open prompts after the next auth.
        if let Some(prompts) = &self.prompts {
            prompts.clear_sender();
            let had_list = prompts.tracker().list_len(now_unix_ms()) > 0;
            // The identity dies with the session too (the bridge tells the
            // windows); the agent re-syncs it after the next auth.
            let cards = prompts.disconnect();
            if let Some(app) = &self.app {
                // Nothing tracked (always, in W02): leave the tray and the
                // main window untouched.
                if had_list || !cards.is_empty() {
                    for id in cards {
                        desktop::close_prompt_window(app, &id);
                    }
                    desktop::publish_prompt_state(app, None);
                }
            }
        }
        if let Some(bridge) = &self.bridge {
            bridge.clear_sender();
        }
        // Pending caller verifications die with the session; close their
        // windows so a stale prompt cannot be answered on a later session.
        if let Some(caller) = &self.caller {
            caller.clear();
        }
        if let Some(app) = &self.app {
            super::caller_verify::close_all_windows(app);
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
pub async fn run(
    token: HelperToken,
    mut stop: tokio::sync::watch::Receiver<bool>,
    desktop_ctx: DesktopCtx,
) {
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

        // Fail closed: never send anything (including the auth request that
        // carries our identity) to a pipe unless the kernel-verified
        // identity of the process on the other end is the agent broker
        // itself. A pipe of the same name created by another process would
        // otherwise be indistinguishable from the real one at the point of
        // dialing. Unix sockets are not affected — their parent directory is
        // root-owned — so this check is windows-only.
        #[cfg(windows)]
        if let Err(e) = super::transport::verify_server_identity(&stream) {
            eprintln!("[helper] ipc: refusing pipe server ({}): {}", path, e);
            drop(stream);
            if wait_or_stop(&mut stop, backoff).await {
                return;
            }
            backoff = next_backoff(backoff);
            continue;
        }

        let started = std::time::Instant::now();

        // Catch panics so a single bad session can't take down the reconnect
        // task. `catch_unwind` turns a panic inside the session future into an
        // `Err(_)` instead of unwinding through the spawned task. The borrowed
        // state (`&token`, `&identity`) is only read after a panic via the
        // normal reconnect path, so `AssertUnwindSafe` is appropriate here.
        // The future is still `select!`ed against `stop.changed()` so a stop
        // request mid-session is honored promptly.
        use futures_util::FutureExt;
        let session_fut = std::panic::AssertUnwindSafe(run_session_with_identity(
            stream,
            &token,
            &identity,
            Some(&desktop_ctx),
        ))
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
            // A caught panic is treated as a transient failure: log once
            // (never the payload/token — the panic message is not the token,
            // which only lives in HelperToken / the parsed payload), then back
            // off and reconnect. Unlike clean/transient outcomes, a panic does
            // NOT reset the backoff even after a long-running session: a
            // slow-failing panic loop must keep backing off rather than hammer
            // at the floor.
            Some(Err(panic_payload)) => {
                let msg = panic_payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic_payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                eprintln!("[helper] IPC session panicked ({msg}); will reconnect");
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
            run_session_with_identity(client_half, &token_for_session, &id, None).await
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
        // The agent only hands v2 consent prompts to a helper that says it
        // speaks v2.
        assert_eq!(v["consentProtocolVersion"], 2);
        // Endpoint messaging (#8293): the agent grants the `messaging` scope only
        // to an assist helper that advertises this.
        assert_eq!(v["supportsMessaging"], true);
        assert_eq!(v["supportsChat"], true);

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
            run_session_with_identity(client_half, &token, &id, None).await
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
            run_session_with_identity(client_half, &token, &id, None).await
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

    /// A malformed chat_open / chat_message must be answered with
    /// chat_presented status "failed" on the inbound envelope id, so the agent
    /// does not wait out its full timeout and report the wrong cause.
    #[tokio::test]
    async fn test_malformed_chat_payload_replies_presented_failed() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();
        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id, None).await
        });
        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv).await.expect("auth_request");
        let session_key = [9u8; 32];
        let resp = format!(r#"{{"accepted":true,"sessionKey":"{}"}}"#, hex::encode(session_key));
        write_frame(&mut broker_half, &ZERO_KEY, &mut broker_send, &env.id, "auth_response", Some(raw(&resp)))
            .await
            .expect("auth_response");

        for (env_id, typ) in [("open-1", "chat_open"), ("msg-1", "chat_message")] {
            write_frame(
                &mut broker_half,
                &session_key,
                &mut broker_send,
                env_id,
                typ,
                Some(raw(r#"{"conversationId":5,"messages":"nope"}"#)),
            )
            .await
            .expect("write malformed chat frame");
            let reply = read_frame(&mut broker_half, &session_key, &mut broker_recv)
                .await
                .expect("read chat_presented");
            assert_eq!(reply.typ, "chat_presented", "{typ}");
            assert_eq!(reply.id, env_id, "{typ}");
            let p: serde_json::Value = serde_json::from_str(reply.payload.as_ref().unwrap().get()).unwrap();
            assert_eq!(p["status"], "failed", "{typ}");
        }

        write_frame(&mut broker_half, &session_key, &mut broker_send, "bye", "disconnect", None)
            .await
            .expect("disconnect");
        let _ = session.await;
    }

    /// A ping from the broker must be answered with a pong carrying the same id.
    #[tokio::test]
    async fn test_ping_is_ponged() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id, None).await
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

    /// The capabilities frame is camelCase on the wire (frozen contract).
    #[test]
    fn test_capabilities_wire_shape() {
        assert_eq!(
            serde_json::to_value(Capabilities { caller_verify: true }).unwrap(),
            serde_json::json!({"callerVerify": true})
        );
    }

    /// With no desktop context (not the real Assist app) the helper sends no
    /// capabilities frame and ignores caller_verify_request: the very next
    /// frame after a ping is the pong, never a response/capabilities frame.
    #[tokio::test]
    async fn test_caller_verify_request_ignored_without_desktop_context() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();
        let session = tokio::spawn(async move {
            run_session_with_identity(client_half, &token, &id, None).await
        });
        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        let session_key = [9u8; 32];
        let resp = format!(
            r#"{{"accepted":true,"sessionKey":"{}"}}"#,
            hex::encode(session_key)
        );
        write_frame(&mut broker_half, &ZERO_KEY, &mut broker_send, &env.id, "auth_response", Some(raw(&resp)))
            .await
            .expect("write auth_response");
        let req = r#"{"verificationId":"11111111-1111-4111-8111-111111111111","username":"a","technicianName":"S","orgName":"A","actionLabel":"x","targetLabel":"y","reverseCode":"7319","choices":["42","17","86"],"timeoutMs":30000}"#;
        write_frame(
            &mut broker_half,
            &session_key,
            &mut broker_send,
            "caller-verify-11111111-1111-4111-8111-111111111111",
            "caller_verify_request",
            Some(raw(req)),
        )
        .await
        .expect("write request");
        write_frame(&mut broker_half, &session_key, &mut broker_send, "p1", "ping", None)
            .await
            .expect("write ping");
        let pong = read_frame(&mut broker_half, &session_key, &mut broker_recv)
            .await
            .expect("read pong");
        assert_eq!(pong.typ, "pong");
        write_frame(&mut broker_half, &session_key, &mut broker_send, "bye", "disconnect", None)
            .await
            .expect("write disconnect");
        assert!(matches!(session.await.expect("join"), Ok(())));
    }

    /// A v2 consent prompt that cannot be shown (here: no window at all) is
    /// answered `unavailable` for its nonce on the request's envelope id —
    /// never left to the agent's deadline, and never a decision.
    #[tokio::test]
    async fn test_v2_consent_request_without_a_window_is_unavailable() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();

        let session =
            tokio::spawn(
                async move { run_session_with_identity(client_half, &token, &id, None).await },
            );

        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv)
            .await
            .expect("read auth_request");
        let session_key = [5u8; 32];
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

        write_frame(
            &mut broker_half,
            &session_key,
            &mut broker_send,
            "consent-sess-1",
            "consent_request",
            Some(raw(r#"{"sessionId":"sess-1","technicianName":"T","timeoutMs":30000,"onTimeout":"proceed","protocolVersion":2,"nonce":"n-1"}"#)),
        )
        .await
        .expect("write consent_request");

        let reply = read_frame(&mut broker_half, &session_key, &mut broker_recv)
            .await
            .expect("read consent_result");
        assert_eq!(reply.id, "consent-sess-1");
        assert_eq!(reply.typ, "consent_result");
        let v: serde_json::Value =
            serde_json::from_str(reply.payload.as_ref().unwrap().get()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"nonce": "n-1", "outcome": "unavailable", "detail": "window_failed"})
        );

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

    // --- Prompt host (#10190) ---

    /// Handshake a session with no desktop context; returns the broker side.
    async fn prompt_session() -> (
        tokio::task::JoinHandle<Result<(), SessionError>>,
        tokio::io::DuplexStream,
        [u8; 32],
        u64,
        u64,
    ) {
        prompt_session_with(None).await
    }

    /// The same handshake with an injected prompt bridge (e.g. one whose
    /// tracker advertises every kind, which the production build does not).
    async fn prompt_session_with(
        prompts: Option<std::sync::Arc<PromptBridge>>,
    ) -> (
        tokio::task::JoinHandle<Result<(), SessionError>>,
        tokio::io::DuplexStream,
        [u8; 32],
        u64,
        u64,
    ) {
        let (client_half, mut broker_half) = tokio::io::duplex(65536);
        let token = HelperToken::new();
        let id = test_identity();
        let session = tokio::spawn(async move { run_session(client_half, &token, &id, None, prompts).await });
        let mut broker_send = 0u64;
        let mut broker_recv = 0u64;
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut broker_recv).await.expect("auth_request");
        let session_key = [3u8; 32];
        let resp = format!(r#"{{"accepted":true,"sessionKey":"{}"}}"#, hex::encode(session_key));
        write_frame(&mut broker_half, &ZERO_KEY, &mut broker_send, &env.id, "auth_response", Some(raw(&resp)))
            .await
            .expect("auth_response");
        (session, broker_half, session_key, broker_send, broker_recv)
    }

    /// A reply the helper owes: fails fast (never hangs) when it is not sent.
    async fn read_reply(broker: &mut tokio::io::DuplexStream, key: &[u8; 32], recv: &mut u64) -> crate::ipc::envelope::Envelope {
        tokio::time::timeout(Duration::from_secs(5), read_frame(broker, key, recv))
            .await
            .expect("the helper sent no reply within 5 s")
            .expect("read reply")
    }

    const SHOW_NOTICE: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.notice.json");
    const CLOSED_FAILED: &str =
        include_str!("../../../../../packages/shared/src/fixtures/prompt-host/closed.render_failed.json");

    /// Rule 4: a kind this build does not advertise (W04: anything but
    /// notice.info@1), arriving anyway, is answered
    /// `prompt_closed{render_failed, unadvertised_kind}` on the same envelope
    /// id -- never dropped silently.
    #[tokio::test]
    async fn test_prompt_show_without_advertisement_is_answered_render_failed() {
        let (session, mut broker, key, mut send, mut recv) = prompt_session().await;
        let mut restart = serde_json::from_str::<serde_json::Value>(SHOW_NOTICE).unwrap();
        restart["kind"] = serde_json::json!("restart.prompt");
        write_frame(&mut broker, &key, &mut send, "show-1", "prompt_show", Some(raw(&restart.to_string())))
            .await
            .expect("write prompt_show");
        let reply = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!(reply.typ, "prompt_closed");
        assert_eq!(reply.id, "show-1");
        let p: serde_json::Value = serde_json::from_str(reply.payload.as_ref().unwrap().get()).unwrap();
        assert_eq!(p, serde_json::from_str::<serde_json::Value>(CLOSED_FAILED).unwrap());
        write_frame(&mut broker, &key, &mut send, "bye", "disconnect", None).await.expect("disconnect");
        assert!(matches!(session.await.expect("join"), Ok(())));
    }

    /// A prompt_show / prompt_update the helper cannot decode, or an unknown
    /// prompt_* type, is refused with render_failed when it can be addressed.
    /// Unknown non-prompt types (and the renderer's own types) stay silent.
    #[tokio::test]
    async fn test_unrenderable_prompt_messages_are_refused_and_other_types_stay_silent() {
        let (session, mut broker, key, mut send, mut recv) = prompt_session().await;
        let mut bad = serde_json::from_str::<serde_json::Value>(SHOW_NOTICE).unwrap();
        bad["state"] = serde_json::json!("pondering");
        let cases = [
            ("show-bad", "prompt_show", bad.to_string(), "malformed"),
            (
                "upd-1",
                "prompt_update",
                r#"{"promptId":"restart:7","rev":3,"lease":{"rendererSession":"assist-tester-12345","epoch":1}}"#.to_string(),
                "unknown_prompt",
            ),
            (
                "future-1",
                "prompt_focus",
                r#"{"promptId":"restart:7","rev":3,"lease":{"rendererSession":"assist-tester-12345","epoch":1}}"#.to_string(),
                "unsupported_type",
            ),
        ];
        for (env_id, typ, payload, detail) in &cases {
            write_frame(&mut broker, &key, &mut send, env_id, typ, Some(raw(payload))).await.expect("write");
            let reply = read_reply(&mut broker, &key, &mut recv).await;
            assert_eq!(reply.typ, "prompt_closed", "{typ}");
            assert_eq!(reply.id, *env_id, "{typ}");
            let p: serde_json::Value = serde_json::from_str(reply.payload.as_ref().unwrap().get()).unwrap();
            assert_eq!(p["reason"], "render_failed", "{typ}");
            assert_eq!(p["detail"], *detail, "{typ}");
        }
        // Silent: an unknown non-prompt type, the renderer's own type echoed
        // back, an unaddressable prompt_show, a stray close, a stray result.
        for (typ, payload) in [
            ("frobnicate", "{}"),
            ("prompt_closed", r#"{"promptId":"restart:7","rev":3,"lease":{"rendererSession":"x","epoch":1},"reason":"hidden"}"#),
            ("prompt_show", r#"{"promptId":"bad id","rev":1}"#),
            ("prompt_close", r#"{"promptId":"restart:8","rev":1,"lease":{"rendererSession":"x","epoch":1},"reason":"resolved"}"#),
            ("prompt_action_result", r#"{"promptId":"restart:8","actionId":"ok","result":"accepted","rev":2}"#),
            ("prompt_branding_sync", r#"{"cleared":true,"locale":"en"}"#),
        ] {
            write_frame(&mut broker, &key, &mut send, "silent", typ, Some(raw(payload))).await.expect("write");
        }
        write_frame(&mut broker, &key, &mut send, "p1", "ping", None).await.expect("ping");
        let next = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!(next.typ, "pong", "nothing answered the silent frames");
        write_frame(&mut broker, &key, &mut send, "bye", "disconnect", None).await.expect("disconnect");
        assert!(matches!(session.await.expect("join"), Ok(())));
    }

    const SHOW_RESTART: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/show.restart.json");
    const ALL_KINDS: &[&str] = &[
        "notice.info@1",
        "restart.prompt@1",
        "restart.final@1",
        "remote.consent@1",
        "remote.session@1",
        "elevation.request@1",
    ];

    fn advertising_bridge() -> std::sync::Arc<PromptBridge> {
        std::sync::Arc::new(PromptBridge::with_tracker(prompt::PromptTracker::new(ALL_KINDS)))
    }

    /// show.restart as a list-only prompt (no window is needed to render it).
    fn restart_list_only(rev: u64, epoch: u32) -> String {
        let mut v: serde_json::Value = serde_json::from_str(SHOW_RESTART).unwrap();
        v["presentation"] = serde_json::json!("list_only");
        v["rev"] = serde_json::json!(rev);
        v["lease"]["epoch"] = serde_json::json!(epoch);
        v.to_string()
    }

    fn payload_of(env: &crate::ipc::envelope::Envelope) -> serde_json::Value {
        serde_json::from_str(env.payload.as_ref().unwrap().get()).unwrap()
    }

    /// With a kind advertised, the live (non-dormant) paths answer on the wire:
    /// presented on the show's envelope, window_failed without a desktop, an
    /// invalid merged update refused, a close acted on.
    #[tokio::test]
    async fn test_advertised_prompts_are_presented_refused_and_closed() {
        let prompts = advertising_bridge();
        let (session, mut broker, key, mut send, mut recv) = prompt_session_with(Some(prompts.clone())).await;

        write_frame(&mut broker, &key, &mut send, "show-1", "prompt_show", Some(raw(&restart_list_only(1, 1)))).await.unwrap();
        let reply = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!((reply.typ.as_str(), reply.id.as_str()), ("prompt_presented", "show-1"));
        assert_eq!(
            payload_of(&reply),
            serde_json::json!({"promptId":"restart:42","rev":1,"lease":{"rendererSession":"assist-user-4242","epoch":1},"visible":false})
        );

        // A card needs a window; with no desktop it cannot be drawn.
        write_frame(&mut broker, &key, &mut send, "show-2", "prompt_show", Some(raw(SHOW_NOTICE))).await.unwrap();
        let reply = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!((reply.typ.as_str(), reply.id.as_str()), ("prompt_closed", "show-2"));
        assert_eq!(payload_of(&reply)["detail"], "window_failed");

        // An update that leaves the pending decision without its safe default.
        let bad = r#"{"promptId":"restart:42","rev":2,"lease":{"rendererSession":"assist-user-4242","epoch":1},"actions":[{"id":"restart_now","label":"Restart now","role":"proceed"}]}"#;
        write_frame(&mut broker, &key, &mut send, "upd-1", "prompt_update", Some(raw(bad))).await.unwrap();
        let reply = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!((reply.typ.as_str(), reply.id.as_str()), ("prompt_closed", "upd-1"));
        assert_eq!(payload_of(&reply)["detail"], "no_safe_default");
        assert!(prompts.tracker().view("restart:42", now_unix_ms()).is_none());

        // Shown again, then closed by the agent: acted on, nothing sent back.
        write_frame(&mut broker, &key, &mut send, "show-3", "prompt_show", Some(raw(&restart_list_only(3, 1)))).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "prompt_presented");
        assert_eq!(prompts.tracker().list_len(now_unix_ms()), 1);
        let close = r#"{"promptId":"restart:42","rev":3,"lease":{"rendererSession":"assist-user-4242","epoch":1},"reason":"withdrawn"}"#;
        write_frame(&mut broker, &key, &mut send, "close-1", "prompt_close", Some(raw(close))).await.unwrap();
        write_frame(&mut broker, &key, &mut send, "p1", "ping", None).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "pong", "a close gets no reply");
        assert!(prompts.tracker().view("restart:42", now_unix_ms()).is_none());
        assert_eq!(prompts.tracker().list_len(now_unix_ms()), 0);

        write_frame(&mut broker, &key, &mut send, "bye", "disconnect", None).await.unwrap();
        assert!(matches!(session.await.expect("join"), Ok(())));
    }

    /// An action the agent never answered is not written again on the next
    /// session: that session sees only what the agent replays, and the person
    /// acts again on the new lease.
    #[tokio::test]
    async fn test_an_unacknowledged_action_is_not_replayed_on_the_next_session() {
        let prompts = advertising_bridge();
        let (a, mut broker, key, mut send, mut recv) = prompt_session_with(Some(prompts.clone())).await;
        write_frame(&mut broker, &key, &mut send, "show-1", "prompt_show", Some(raw(&restart_list_only(1, 1)))).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "prompt_presented");
        prompts.act(now_unix_ms(), "restart:42", "postpone", prompt::ActionVia::List).expect("sent on session A");
        let action = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!(action.typ, "prompt_action");
        // Session A ends with no prompt_action_result.
        write_frame(&mut broker, &key, &mut send, "bye", "disconnect", None).await.unwrap();
        assert!(matches!(a.await.expect("join"), Ok(())));
        assert!(prompts.tracker().view("restart:42", now_unix_ms()).is_none());
        assert!(prompts.act(now_unix_ms(), "restart:42", "postpone", prompt::ActionVia::List).is_err());

        let (b, mut broker, key, mut send, mut recv) = prompt_session_with(Some(prompts.clone())).await;
        write_frame(&mut broker, &key, &mut send, "p1", "ping", None).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "pong", "nothing replayed onto session B");
        // The agent's replay (new lease) renders; a new click is a new action.
        write_frame(&mut broker, &key, &mut send, "show-2", "prompt_show", Some(raw(&restart_list_only(1, 2)))).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "prompt_presented");
        prompts.act(now_unix_ms(), "restart:42", "postpone", prompt::ActionVia::List).expect("sent on session B");
        let again = read_reply(&mut broker, &key, &mut recv).await;
        assert_eq!(again.typ, "prompt_action");
        assert_ne!(again.id, action.id);
        assert_eq!(payload_of(&again)["lease"]["epoch"], 2);
        // Session A's result arriving late (on its own envelope) releases nothing.
        let late = r#"{"promptId":"restart:42","actionId":"postpone","result":"accepted","rev":2}"#;
        write_frame(&mut broker, &key, &mut send, &action.id, "prompt_action_result", Some(raw(late))).await.unwrap();
        write_frame(&mut broker, &key, &mut send, "p2", "ping", None).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "pong");
        assert_eq!(
            prompts.tracker().view("restart:42", now_unix_ms()).unwrap().pending_action_id.as_deref(),
            Some("postpone")
        );
        // Its own result does.
        write_frame(&mut broker, &key, &mut send, &again.id, "prompt_action_result", Some(raw(late))).await.unwrap();
        write_frame(&mut broker, &key, &mut send, "p3", "ping", None).await.unwrap();
        assert_eq!(read_reply(&mut broker, &key, &mut recv).await.typ, "pong");
        assert_eq!(prompts.tracker().view("restart:42", now_unix_ms()).unwrap().pending_action_id, None);

        write_frame(&mut broker, &key, &mut send, "bye", "disconnect", None).await.unwrap();
        assert!(matches!(b.await.expect("join"), Ok(())));
    }

    /// Auth on the wire: speaks prompt protocol 1, advertises `notice.info@1`
    /// (W04) and nothing else, names its version.
    #[tokio::test]
    async fn test_auth_request_carries_the_prompt_advertisement() {
        let (client_half, mut broker_half) = tokio::io::duplex(8192);
        let token = HelperToken::new();
        let id = test_identity();
        let session = tokio::spawn(async move { run_session_with_identity(client_half, &token, &id, None).await });
        let mut recv = 0u64;
        let env = read_frame(&mut broker_half, &ZERO_KEY, &mut recv).await.expect("auth_request");
        let v: serde_json::Value = serde_json::from_str(env.payload.as_ref().unwrap().get()).unwrap();
        assert_eq!(v["promptProtocolVersion"], 1);
        assert_eq!(v["promptKinds"], serde_json::json!(["notice.info@1"]), "W04 advertises notice.info@1 only");
        assert_eq!(v["rendererVersion"], env!("CARGO_PKG_VERSION"));
        drop(broker_half);
        let _ = session.await;
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

/// The prompt additions to `auth_request` against the shared golden fixtures
/// (not gated on unix: the wire shape is the same on every OS).
#[cfg(test)]
mod prompt_auth_tests {
    use super::*;

    const AUTH_PROMPT_V1: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/auth.prompt_v1.json");
    const AUTH_LEGACY: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/auth.legacy.json");

    /// An `AuthRequest` carrying the fixture's identity and advertisement.
    fn request(kinds: Vec<String>, renderer_version: &str) -> AuthRequest {
        AuthRequest {
            protocol_version: PROTOCOL_VERSION,
            uid: 0,
            sid: "S-1-5-21-1000000000-1000000000-1000000000-1001".into(),
            username: "user".into(),
            session_id: "assist-user-4242".into(),
            display_env: String::new(),
            pid: 4242,
            binary_hash: "0f343b0931126a20f133d67c2b018a3b5b0ebf6b7c1a9d2a3e1f6f6a4c2b7e10".into(),
            win_session_id: 0,
            helper_role: "assist".into(),
            binary_kind: "assist_helper".into(),
            desktop_context: String::new(),
            consent_protocol_version: CONSENT_PROTOCOL_VERSION,
            supports_messaging: true,
            supports_chat: true,
            prompt_protocol_version: super::super::prompt::PROMPT_PROTOCOL_VERSION,
            prompt_kinds: kinds,
            renderer_version: renderer_version.into(),
            ui_locale: String::new(),
        }
    }

    #[test]
    fn prompt_auth_fixtures_match_the_built_request() {
        let fixture: serde_json::Value = serde_json::from_str(AUTH_PROMPT_V1).unwrap();
        let kinds: Vec<String> = fixture["promptKinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        let got = serde_json::to_value(request(kinds, "0.2.0")).unwrap();
        assert_eq!(got, fixture, "AuthRequest serializes the prompt keys exactly as the fixture names them");

        // The additions are purely additive to the legacy request.
        let mut w02 = serde_json::to_value(request(Vec::new(), "0.2.0")).unwrap();
        let obj = w02.as_object_mut().unwrap();
        assert!(!obj.contains_key("promptKinds"), "an empty advertisement is omitted");
        assert_eq!(obj.remove("promptProtocolVersion"), Some(serde_json::json!(1)));
        assert_eq!(obj.remove("rendererVersion"), Some(serde_json::json!("0.2.0")));
        assert_eq!(w02, serde_json::from_str::<serde_json::Value>(AUTH_LEGACY).unwrap());
    }

    #[test]
    fn build_auth_request_advertises_the_w02_prompt_kinds() {
        let id = PeerIdentity { uid: 501, sid: String::new(), username: "tester".into(), pid: 7 };
        let req = build_auth_request(&id);
        assert_eq!(req.prompt_protocol_version, 1);
        let want: Vec<String> = super::super::prompt::ADVERTISED_PROMPT_KINDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(req.prompt_kinds, want);
        assert_eq!(req.renderer_version, env!("CARGO_PKG_VERSION"));
    }

    // #10190 W04 (Task 4.2): this build draws notice cards, so the live
    // authentication advertises exactly `notice.info@1` and nothing else.
    #[test]
    fn advertises_notice_info_v1() {
        let id = PeerIdentity { uid: 501, sid: String::new(), username: "tester".into(), pid: 7 };
        let req = build_auth_request(&id);
        assert_eq!(req.prompt_kinds, vec!["notice.info@1".to_string()]);
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["promptKinds"], serde_json::json!(["notice.info@1"]));
        assert_eq!(json["promptProtocolVersion"], 1);
    }

    #[test]
    fn auth_request_carries_ui_locale() {
        // The built request reports the OS UI language Assist probed.
        let id = PeerIdentity { uid: 501, sid: String::new(), username: "tester".into(), pid: 7 };
        assert_eq!(build_auth_request(&id).ui_locale, crate::chrome::os_ui_locale());

        // On the wire: `uiLocale`, additive, omitted when the probe found nothing.
        let mut req = request(Vec::new(), "0.2.0");
        req.ui_locale = "de-DE".into();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["uiLocale"], "de-DE");
        req.ui_locale = String::new();
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.as_object().unwrap().get("uiLocale").is_none());
    }

    // W03 review: the real handlers drive the identity publish. Removing the
    // publish from the branding-sync handler or from the session-end guard
    // fails here.
    #[test]
    fn branding_sync_handler_and_session_end_publish_the_identity() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        const SET: &str = include_str!("../../../../../packages/shared/src/fixtures/prompt-host/branding_sync.set.json");
        let prompts = std::sync::Arc::new(PromptBridge::default());
        let n = std::sync::Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        prompts.set_identity_notifier(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        let payload = Some(RawValue::from_string(SET.to_string()).unwrap());
        handle_prompt_branding_sync(&prompts, "env-1", &payload);
        assert_eq!(n.load(Ordering::SeqCst), 1, "a stored sync is published");
        assert!(prompts.tracker().identity().is_some());

        let guard = BridgeClearGuard {
            bridge: None,
            caller: None,
            app: None,
            messages: None,
            chat: None,
            prompts: Some(prompts.clone()),
        };
        drop(guard);
        assert_eq!(n.load(Ordering::SeqCst), 2, "session end publishes the dropped identity");
        assert!(prompts.tracker().identity().is_none());
    }
}
