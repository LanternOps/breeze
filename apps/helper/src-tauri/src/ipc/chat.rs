//! Endpoint live chat (#8743, W03 of #8740): the `chat_*` exchange with the Go
//! agent, kept free of Tauri window types so it is unit-tested without a
//! window. Mirrors `message.rs` (endpoint message cards).
//!
//! Wire contract (agent <-> Assist helper, scope `chat`; envelope framing and
//! HMAC unchanged):
//!   * agent -> helper `chat_open`, `chat_message` (live: reply `chat_presented`
//!     on the SAME envelope id; replay: fire-and-forget), `chat_close`,
//!     `chat_reply_result`
//!   * helper -> agent `chat_presented`, then unsolicited `chat_reply`
//!     (fresh envelope id).
//!
//! SURFACING (the whole point of this module): only a LIVE `chat_open` for a
//! conversation without a window may raise a window (an "incoming call").
//! Every later technician message updates + flashes a window that is already
//! on screen, and otherwise only badges the tray. A replay never shows
//! anything. The main Assist window is never touched.
//!
//! State is process memory only; the agent replays open conversations after
//! the helper re-authenticates.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::consent::Outbound;
pub use super::message::Branding;

// The agent->helper types are matched by literal in `client.rs`; these four
// exist for the byte-compat test against `chat.go`.
#[allow(dead_code)]
pub const TYPE_CHAT_OPEN: &str = "chat_open";
#[allow(dead_code)]
pub const TYPE_CHAT_MESSAGE: &str = "chat_message";
#[allow(dead_code)]
pub const TYPE_CHAT_CLOSE: &str = "chat_close";
#[allow(dead_code)]
pub const TYPE_CHAT_REPLY_RESULT: &str = "chat_reply_result";
pub const TYPE_CHAT_REPLY: &str = "chat_reply";
pub const TYPE_CHAT_PRESENTED: &str = "chat_presented";

/// `chat_presented.status`: empty = delivered, `failed` = nothing could be
/// shown or stored.
pub const PRESENTED_FAILED: &str = "failed";

/// Content limits. Mirror `ENDPOINT_CHAT_LIMITS` in
/// `packages/shared/src/validators/endpointChat.ts` and the agent's
/// `chat.go` (apps/helper depends on neither); keep them in step.
pub const BODY_MAX: usize = 2000;
pub const SENDER_MAX: usize = 120;
/// Agent store bounds (contract section 3): mirrored so the helper never
/// holds more than the agent would replay.
pub const MAX_CONVERSATIONS: usize = 8;
pub const MAX_MESSAGES: usize = 50;
/// Unconfirmed replies per conversation (a runaway frontend / dead link).
pub const MAX_PENDING: usize = 10;
/// A reply with no `chat_reply_result` after this long is failed (retryable,
/// same nonce): defence in depth against a stuck "Sending...".
pub const PENDING_TIMEOUT_MS: i64 = 30_000;
/// Bound on the per-conversation seen-id set.
const SEEN_CAP: usize = 1024;

/// Window label prefix; the full label is `chat-<conversationId>`.
pub const WINDOW_LABEL_PREFIX: &str = "chat-";

pub fn window_label(conversation_id: &str) -> String {
    format!("{WINDOW_LABEL_PREFIX}{conversation_id}")
}

pub fn window_url(conversation_id: &str) -> String {
    format!("index.html#chat/{conversation_id}")
}

/// Whether `label` is exactly the chat window for `conversation_id`.
pub fn label_matches(label: &str, conversation_id: &str) -> bool {
    label == window_label(conversation_id)
}

/// Refuse a `chat-*` caller. Called by `message::deny_message_window`, the
/// guard every privileged Tauri command already uses, so adding it here
/// covers all of them (the chat window renders technician-authored text).
pub fn deny_chat_window(label: &str) -> Result<(), String> {
    if label.starts_with(WINDOW_LABEL_PREFIX) {
        return Err("command not available to chat windows".into());
    }
    Ok(())
}

/// Canonical lower-case UUID (8-4-4-4-12). A conversationId becomes part of a
/// window label and a URL hash, so nothing looser is accepted.
fn valid_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

/// `#rrggbb` only; the accent is applied as a CSS colour.
fn valid_accent(a: &str) -> bool {
    a.len() == 7 && a.starts_with('#') && a[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A fresh random UUID v4 for a reply nonce. The nonce is an idempotency key,
/// not a secret, but it must never repeat: 128 bits from std's per-call
/// randomly keyed hasher mixed with the clock and a process counter.
pub(crate) fn new_nonce() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let word = |salt: u64| {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_u128(nanos);
        h.finish()
    };
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&word(1).to_be_bytes());
    bytes[8..].copy_from_slice(&word(2).to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// One message inside `ChatShow.messages`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsgIn {
    pub message_id: String,
    #[serde(default = "default_direction")]
    pub direction: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub sender_name: String,
    #[serde(default)]
    pub sent_at: String,
}

fn default_direction() -> String {
    "to_user".into()
}

/// The `chat_open` / `chat_message` payload (`ChatShow`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatShow {
    pub conversation_id: String,
    /// Fails closed: a frame without the field turns replies off.
    #[serde(default)]
    pub allow_reply: bool,
    #[serde(default)]
    pub branding: Branding,
    #[serde(default)]
    pub messages: Vec<ChatMsgIn>,
    #[serde(default)]
    pub replay: bool,
    #[serde(default)]
    pub closed: bool,
}

/// The `chat_close` payload. `reason` is informational and never displayed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatClose {
    pub conversation_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub reason: String,
}

/// The `chat_reply_result` payload.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReplyResult {
    pub conversation_id: String,
    pub client_nonce: String,
    #[serde(default)]
    pub status: String,
}

/// What the chat window renders for one message. User replies carry
/// `client_nonce` / `status` (`pending` | `sent` | `failed`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageView {
    pub message_id: String,
    pub direction: String,
    pub body: String,
    pub sender_name: String,
    pub sent_at: String,
    pub client_nonce: Option<String>,
    pub status: Option<String>,
    /// A `failed` reply the user may send again (same nonce).
    pub retryable: bool,
}

/// What the chat window renders. The sender slot comes from `branding`, never
/// from a body.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatView {
    pub conversation_id: String,
    pub allow_reply: bool,
    pub closed: bool,
    pub branding: Branding,
    pub unread: u32,
    pub messages: Vec<ChatMessageView>,
}

/// What the real window looks like right now (read from Tauri by the caller;
/// the tracker itself holds no window types).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinState {
    pub exists: bool,
    pub visible: bool,
    pub minimised: bool,
}

impl WinState {
    /// On screen where the user can see it.
    fn raised(&self) -> bool {
        self.exists && self.visible && !self.minimised
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatAction {
    /// Live `chat_open`, no window: build, show and focus it. The one
    /// deliberate interruption. `created` = this frame created the
    /// conversation (undo it if the window cannot be built).
    ShowWindow { conversation_id: String, created: bool },
    /// The window is on screen: refresh it and flash the taskbar.
    UpdateAndFlash { conversation_id: String },
    /// No visible window: tray badge only. Never show/unminimise/focus.
    BadgeOnly { conversation_id: String },
    /// Replay (or a closed conversation): state restored, nothing raised.
    RestoreSilently { conversation_id: String },
    /// Nothing new (duplicate messageId, or the conversation is closed).
    Duplicate { conversation_id: String },
    /// Invalid payload. The reply is `chat_presented` failed.
    Reject(String),
}

/// Why `chat_send_reply` refused; the `Display` text is shown to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyError {
    Unknown,
    Closed,
    RepliesOff,
    Empty,
    TooLong,
    TooManyPending,
    NotRetryable,
}

impl std::fmt::Display for ReplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ReplyError::Unknown => "This chat is no longer available.",
            ReplyError::Closed => "This chat has ended.",
            ReplyError::RepliesOff => "Replies are turned off for this chat.",
            ReplyError::Empty => "Type a message first.",
            ReplyError::TooLong => "That message is too long.",
            ReplyError::TooManyPending => "Wait for your earlier messages to send first.",
            ReplyError::NotRetryable => "That message can't be sent again.",
        })
    }
}

/// A validated reply: the nonce (returned to the frontend) and the
/// `chat_reply` frame to write on the live session.
#[derive(Debug)]
pub struct ReplyPlan {
    pub client_nonce: String,
    pub frame: Outbound,
}

/// What the tray needs: the unread total and which conversation "Open chat"
/// should open.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TraySummary {
    pub total_unread: u32,
    pub target: Option<String>,
    pub has_open: bool,
}

#[derive(Debug)]
struct Conversation {
    allow_reply: bool,
    branding: Branding,
    closed: bool,
    unread: u32,
    messages: Vec<ChatMessageView>,
    seen: HashSet<String>,
    activity: u64,
    /// nonce -> when its `chat_reply` was handed to the session (ms).
    pending_since: HashMap<String, i64>,
}

impl Conversation {
    fn view(&self, id: &str) -> ChatView {
        ChatView {
            conversation_id: id.to_string(),
            allow_reply: self.allow_reply,
            closed: self.closed,
            branding: self.branding.clone(),
            unread: self.unread,
            messages: self.messages.clone(),
        }
    }

    fn push(&mut self, m: ChatMessageView) {
        if self.seen.len() >= SEEN_CAP {
            self.seen.clear();
            self.seen.extend(self.messages.iter().map(|m| m.message_id.clone()));
        }
        self.seen.insert(m.message_id.clone());
        self.messages.push(m);
        if self.messages.len() > MAX_MESSAGES {
            let excess = self.messages.len() - MAX_MESSAGES;
            self.messages.drain(..excess);
        }
    }

    fn pending(&self) -> usize {
        self.messages.iter().filter(|m| m.status.as_deref() == Some("pending")).count()
    }

    /// Pending replies can never be confirmed once the conversation ended.
    fn fail_pending(&mut self, retryable: bool) -> bool {
        let mut any = false;
        for m in self.messages.iter_mut().filter(|m| m.status.as_deref() == Some("pending")) {
            m.status = Some("failed".into());
            m.retryable = retryable;
            any = true;
        }
        any
    }
}

/// Conversations known to this helper plus the unread badge. Process memory only.
#[derive(Debug, Default)]
pub struct ChatTracker {
    convs: HashMap<String, Conversation>,
    seq: u64,
}

fn count_chars(s: &str) -> usize {
    s.chars().count()
}

/// Validate a frame and return its sanitised branding.
fn validate(show: &ChatShow) -> Result<Branding, String> {
    if !valid_uuid(&show.conversation_id) {
        return Err("invalid conversationId".into());
    }
    if show.messages.is_empty() || show.messages.len() > MAX_MESSAGES {
        return Err("invalid message count".into());
    }
    for m in &show.messages {
        if !valid_uuid(&m.message_id) {
            return Err("invalid messageId".into());
        }
        if m.body.trim().is_empty() || count_chars(&m.body) > BODY_MAX {
            return Err("invalid body".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&m.sent_at).is_err() {
            return Err("invalid sentAt".into());
        }
        match m.direction.as_str() {
            "to_user" => {
                let n = count_chars(m.sender_name.trim());
                if n == 0 || n > SENDER_MAX {
                    return Err("invalid senderName".into());
                }
            }
            // Only a replay carries the user's own earlier replies.
            "from_user" if show.replay => {}
            _ => return Err("invalid direction".into()),
        }
    }
    let mut b = show.branding.clone();
    b.company_name = b.company_name.chars().take(SENDER_MAX).collect();
    b.display_name = b.display_name.chars().take(SENDER_MAX).collect();
    if !b.accent.as_deref().is_some_and(valid_accent) {
        b.accent = None;
    }
    Ok(b)
}

impl ChatTracker {
    /// Live or replayed `chat_open`.
    pub fn on_open(&mut self, show: &ChatShow, win: WinState) -> ChatAction {
        self.ingest(show, win, true)
    }

    /// Live or replayed `chat_message` (never raises a window).
    pub fn on_message(&mut self, show: &ChatShow, win: WinState) -> ChatAction {
        self.ingest(show, win, false)
    }

    fn ingest(&mut self, show: &ChatShow, win: WinState, is_open: bool) -> ChatAction {
        let branding = match validate(show) {
            Ok(b) => b,
            Err(why) => return ChatAction::Reject(why),
        };
        let id = show.conversation_id.clone();
        let conversation_id = || id.clone();

        let created = !self.convs.contains_key(&id);
        if created {
            if self.convs.len() >= MAX_CONVERSATIONS && !self.evict_closed() {
                return ChatAction::Reject("too many conversations".into());
            }
            self.convs.insert(
                id.clone(),
                Conversation {
                    allow_reply: show.allow_reply,
                    branding: branding.clone(),
                    closed: false,
                    unread: 0,
                    messages: Vec::new(),
                    seen: HashSet::new(),
                    activity: 0,
                    pending_since: HashMap::new(),
                },
            );
        }
        self.seq += 1;
        let seq = self.seq;
        let conv = self.convs.get_mut(&id).expect("just inserted");
        if conv.closed {
            // A closed conversation is final; late frames change nothing.
            return ChatAction::Duplicate { conversation_id: conversation_id() };
        }
        conv.allow_reply = show.allow_reply;
        conv.branding = branding;
        conv.activity = seq;
        if show.closed {
            conv.closed = true;
            conv.fail_pending(false);
        }

        let mut new_tech = 0u32;
        let mut added = false;
        for m in &show.messages {
            if conv.seen.contains(&m.message_id) {
                continue;
            }
            let from_user = m.direction == "from_user";
            // A replay into a helper that already holds the conversation:
            // its own replies are already here (keyed by nonce), skip the
            // agent's copy rather than showing each one twice.
            if from_user && !created {
                continue;
            }
            conv.push(ChatMessageView {
                message_id: m.message_id.clone(),
                direction: m.direction.clone(),
                body: m.body.clone(),
                sender_name: if from_user { String::new() } else { m.sender_name.trim().to_string() },
                sent_at: m.sent_at.clone(),
                client_nonce: None,
                status: from_user.then(|| "sent".to_string()),
                retryable: false,
            });
            added = true;
            if !from_user {
                new_tech += 1;
            }
        }

        if show.replay || show.closed {
            if !win.raised() {
                conv.unread += new_tech;
            }
            return ChatAction::RestoreSilently { conversation_id: conversation_id() };
        }
        if !added && !created {
            return ChatAction::Duplicate { conversation_id: conversation_id() };
        }
        if is_open && !win.exists {
            conv.unread = 0;
            return ChatAction::ShowWindow { conversation_id: conversation_id(), created };
        }
        if win.raised() {
            ChatAction::UpdateAndFlash { conversation_id: conversation_id() }
        } else {
            conv.unread += new_tech;
            ChatAction::BadgeOnly { conversation_id: conversation_id() }
        }
    }

    /// Drop the oldest closed conversation; false when none is closed.
    fn evict_closed(&mut self) -> bool {
        let victim = self
            .convs
            .iter()
            .filter(|(_, c)| c.closed)
            .min_by_key(|(_, c)| c.activity)
            .map(|(id, _)| id.clone());
        match victim {
            Some(id) => self.convs.remove(&id).is_some(),
            None => false,
        }
    }

    /// The window for a `ShowWindow` could not be built.
    pub fn on_show_failed(&mut self, conversation_id: &str, created: bool) {
        if created {
            self.convs.remove(conversation_id);
        } else if let Some(c) = self.convs.get_mut(conversation_id) {
            c.unread = c.unread.max(1);
        }
    }

    /// `chat_close`: true when the conversation is known (now closed).
    pub fn on_close(&mut self, conversation_id: &str) -> bool {
        match self.convs.get_mut(conversation_id) {
            Some(c) => {
                c.closed = true;
                c.fail_pending(false);
                true
            }
            None => false,
        }
    }

    /// `chat_reply_result`: true when a reply's status changed.
    pub fn on_reply_result(&mut self, res: &ChatReplyResult) -> bool {
        if !matches!(res.status.as_str(), "sent" | "failed" | "rejected" | "closed") {
            return false;
        }
        let Some(conv) = self.convs.get_mut(&res.conversation_id) else {
            return false;
        };
        let Some(m) = conv.messages.iter_mut().find(|m| m.client_nonce.as_deref() == Some(res.client_nonce.as_str()))
        else {
            return false;
        };
        let status = m.status.as_deref().unwrap_or("");
        match res.status.as_str() {
            // A confirmed send also settles a reply a dropped session had failed.
            "sent" if status == "pending" || status == "failed" => {
                m.status = Some("sent".into());
                m.retryable = false;
            }
            "failed" if status == "pending" => {
                m.status = Some("failed".into());
                m.retryable = true;
            }
            "rejected" if status == "pending" => {
                m.status = Some("failed".into());
                m.retryable = false;
            }
            "closed" if status == "pending" => {
                m.status = Some("failed".into());
                m.retryable = false;
                conv.closed = true;
                conv.fail_pending(false);
            }
            _ => return false,
        }
        true
    }

    /// Validate a reply and build the `chat_reply` frame. `retry_nonce`
    /// re-sends a `failed` retryable reply with its ORIGINAL nonce and stored
    /// body (the agent and API dedupe on the nonce, so a retry whose first
    /// attempt actually landed cannot post twice); otherwise a fresh nonce.
    pub fn prepare_reply(
        &mut self,
        conversation_id: &str,
        body: &str,
        retry_nonce: Option<&str>,
    ) -> Result<ReplyPlan, ReplyError> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.prepare_reply_at(conversation_id, body, retry_nonce, now_ms)
    }

    /// [`Self::prepare_reply`] with an injected clock (ms since the epoch).
    pub fn prepare_reply_at(
        &mut self,
        conversation_id: &str,
        body: &str,
        retry_nonce: Option<&str>,
        now_ms: i64,
    ) -> Result<ReplyPlan, ReplyError> {
        self.seq += 1;
        let seq = self.seq;
        let conv = self.convs.get_mut(conversation_id).ok_or(ReplyError::Unknown)?;
        if conv.closed {
            return Err(ReplyError::Closed);
        }
        if !conv.allow_reply {
            return Err(ReplyError::RepliesOff);
        }
        let (nonce, text) = match retry_nonce {
            Some(n) => {
                let m = conv
                    .messages
                    .iter_mut()
                    .find(|m| m.client_nonce.as_deref() == Some(n))
                    .filter(|m| m.status.as_deref() == Some("failed") && m.retryable)
                    .ok_or(ReplyError::NotRetryable)?;
                m.status = Some("pending".into());
                (n.to_string(), m.body.clone())
            }
            None => {
                let text = body.trim();
                if text.is_empty() {
                    return Err(ReplyError::Empty);
                }
                if count_chars(text) > BODY_MAX {
                    return Err(ReplyError::TooLong);
                }
                if conv.pending() >= MAX_PENDING {
                    return Err(ReplyError::TooManyPending);
                }
                let nonce = new_nonce();
                conv.push(ChatMessageView {
                    message_id: nonce.clone(),
                    direction: "from_user".into(),
                    body: text.to_string(),
                    sender_name: String::new(),
                    sent_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    client_nonce: Some(nonce.clone()),
                    status: Some("pending".into()),
                    retryable: false,
                });
                (nonce, text.to_string())
            }
        };
        conv.activity = seq;
        conv.pending_since.insert(nonce.clone(), now_ms);
        let frame = Outbound {
            id: self.fresh_id(),
            typ: TYPE_CHAT_REPLY,
            payload: serde_json::json!({
                "conversationId": conversation_id,
                "clientNonce": nonce,
                "body": text,
            }),
        };
        Ok(ReplyPlan { client_nonce: nonce, frame })
    }

    /// Fail every reply still pending `PENDING_TIMEOUT_MS` after it was sent
    /// (no `chat_reply_result` ever came). They become retryable with the same
    /// nonce. Returns the conversations that changed.
    pub fn expire_pending(&mut self, now_ms: i64) -> Vec<String> {
        let mut changed = Vec::new();
        for (id, c) in self.convs.iter_mut() {
            let mut any = false;
            for m in c.messages.iter_mut().filter(|m| m.status.as_deref() == Some("pending")) {
                let Some(nonce) = m.client_nonce.as_deref() else { continue };
                let since = *c.pending_since.entry(nonce.to_string()).or_insert(now_ms);
                if now_ms.saturating_sub(since) >= PENDING_TIMEOUT_MS {
                    m.status = Some("failed".into());
                    m.retryable = true;
                    any = true;
                }
            }
            if any {
                changed.push(id.clone());
            }
        }
        changed.sort();
        changed
    }

    /// Undo `prepare_reply` for a brand-new reply that could not be sent.
    pub fn discard_reply(&mut self, conversation_id: &str, nonce: &str) {
        if let Some(c) = self.convs.get_mut(conversation_id) {
            c.messages.retain(|m| m.client_nonce.as_deref() != Some(nonce));
            c.seen.remove(nonce);
            c.pending_since.remove(nonce);
        }
    }

    /// The session dropped: no `chat_reply_result` will arrive for replies in
    /// flight. Mark them failed (retryable, same nonce). Returns the
    /// conversations that changed so their windows can refresh.
    pub fn fail_pending_replies(&mut self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .convs
            .iter_mut()
            .filter_map(|(id, c)| c.fail_pending(true).then(|| id.clone()))
            .collect();
        ids.sort();
        ids
    }

    /// The user looked at the conversation. True when the badge changed.
    pub fn mark_read(&mut self, conversation_id: &str) -> bool {
        match self.convs.get_mut(conversation_id) {
            Some(c) if c.unread > 0 => {
                c.unread = 0;
                true
            }
            _ => false,
        }
    }

    pub fn view(&self, conversation_id: &str) -> Option<ChatView> {
        self.convs.get(conversation_id).map(|c| c.view(conversation_id))
    }

    pub fn summary(&self) -> TraySummary {
        let total_unread = self.convs.values().map(|c| c.unread).sum();
        let has_open = self.convs.values().any(|c| !c.closed);
        let with_unread = self
            .convs
            .iter()
            .filter(|(_, c)| c.unread > 0)
            .max_by_key(|(_, c)| (c.unread, c.activity));
        let recent_open = self.convs.iter().filter(|(_, c)| !c.closed).max_by_key(|(_, c)| c.activity);
        let target = with_unread.or(recent_open).map(|(id, _)| id.clone());
        TraySummary { total_unread, target, has_open }
    }

    /// The reply to a live `chat_open` / `chat_message`: SAME envelope id as
    /// the request. `status` is `""` (delivered) or [`PRESENTED_FAILED`].
    pub fn presented(env_id: &str, conversation_id: &str, message_id: Option<&str>, status: &str) -> Outbound {
        let mut payload = serde_json::json!({ "conversationId": conversation_id, "status": status });
        if let Some(m) = message_id {
            payload["messageId"] = serde_json::Value::String(m.to_string());
        }
        Outbound { id: env_id.to_string(), typ: TYPE_CHAT_PRESENTED, payload }
    }

    /// A unique envelope id for an unsolicited frame.
    fn fresh_id(&mut self) -> String {
        self.seq += 1;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("chat-{nanos:x}-{}", self.seq)
    }
}

/// An event from a chat window (via the Tauri commands) for the session loop.
#[derive(Debug)]
pub enum ChatEvent {
    /// Write this `chat_reply` frame.
    Send(Outbound),
}

/// Bridge held in Tauri managed state: the tracker (shared by the IPC loop and
/// the chat Tauri commands) and the live session's event sender.
#[derive(Default)]
pub struct ChatBridge {
    tracker: Mutex<ChatTracker>,
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<ChatEvent>>>,
}

impl ChatBridge {
    /// Lock the tracker. Never hold the guard across an `.await`.
    pub fn tracker(&self) -> MutexGuard<'_, ChatTracker> {
        self.tracker.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn set_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<ChatEvent>) {
        if let Ok(mut g) = self.sender.lock() {
            *g = Some(tx);
        }
    }
    pub fn clear_sender(&self) {
        if let Ok(mut g) = self.sender.lock() {
            *g = None;
        }
    }
    fn submit(&self, event: ChatEvent) -> bool {
        match self.sender.lock() {
            Ok(g) => g.as_ref().is_some_and(|tx| tx.send(event).is_ok()),
            Err(_) => false,
        }
    }
    fn live(&self) -> bool {
        self.sender.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Validate, record as pending and hand the `chat_reply` frame to the
    /// session loop. Returns the nonce. With no live session nothing is
    /// recorded, so the user keeps their draft and can try again.
    pub fn send_reply(
        &self,
        conversation_id: &str,
        body: &str,
        retry_nonce: Option<&str>,
    ) -> Result<String, String> {
        const OFFLINE: &str = "Not connected to your IT provider's agent. Try again in a moment.";
        if !self.live() {
            return Err(OFFLINE.into());
        }
        let mut t = self.tracker();
        let plan = t.prepare_reply(conversation_id, body, retry_nonce).map_err(|e| e.to_string())?;
        if self.submit(ChatEvent::Send(plan.frame)) {
            return Ok(plan.client_nonce);
        }
        // The session went away between the check and the send: roll back.
        if retry_nonce.is_some() {
            t.on_reply_result(&ChatReplyResult {
                conversation_id: conversation_id.to_string(),
                client_nonce: plan.client_nonce,
                status: "failed".into(),
            });
        } else {
            t.discard_reply(conversation_id, &plan.client_nonce);
        }
        Err(OFFLINE.into())
    }

    pub fn view(&self, conversation_id: &str) -> Option<ChatView> {
        self.tracker().view(conversation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const M1: &str = "11111111-1111-4111-8111-111111111111";
    const M2: &str = "22222222-2222-4222-8222-222222222222";
    const M3: &str = "33333333-3333-4333-8333-333333333333";
    const NOW: &str = "2026-10-17T10:00:00Z";

    const NO_WINDOW: WinState = WinState { exists: false, visible: false, minimised: false };
    const RAISED: WinState = WinState { exists: true, visible: true, minimised: false };
    const MINIMISED: WinState = WinState { exists: true, visible: true, minimised: true };
    const HIDDEN: WinState = WinState { exists: true, visible: false, minimised: false };

    fn show_with(conv: &str, msgs: &[(&str, &str)], replay: bool, closed: bool, allow: bool) -> ChatShow {
        let messages: Vec<serde_json::Value> = msgs
            .iter()
            .map(|(id, body)| {
                serde_json::json!({
                    "messageId": id, "direction": "to_user", "body": body,
                    "senderName": "Sam Tech", "sentAt": NOW
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "conversationId": conv,
            "allowReply": allow,
            "branding": { "companyName": "Acme IT", "displayName": "Acme", "accent": "#336699" },
            "messages": messages,
            "replay": replay,
            "closed": closed,
        }))
        .unwrap()
    }

    fn show(msg: &str, body: &str) -> ChatShow {
        show_with(CID, &[(msg, body)], false, false, true)
    }

    fn opened(t: &mut ChatTracker) {
        assert!(matches!(t.on_open(&show(M1, "hello"), NO_WINDOW), ChatAction::ShowWindow { .. }));
    }

    #[test]
    fn parses_the_contract_payload() {
        let s = show(M1, "hi **there**");
        assert_eq!(s.conversation_id, CID);
        assert!(s.allow_reply);
        assert!(!s.replay);
        assert!(!s.closed);
        assert_eq!(s.branding.company_name, "Acme IT");
        assert_eq!(s.messages[0].sender_name, "Sam Tech");
        assert_eq!(s.messages[0].direction, "to_user");
        let c: ChatClose =
            serde_json::from_str(&format!(r#"{{"conversationId":"{CID}","reason":"technician"}}"#)).unwrap();
        assert_eq!(c.conversation_id, CID);
        let r: ChatReplyResult = serde_json::from_str(&format!(
            r#"{{"conversationId":"{CID}","clientNonce":"{M1}","status":"sent"}}"#
        ))
        .unwrap();
        assert_eq!(r.status, "sent");
    }

    #[test]
    fn type_strings_are_the_contract_literals() {
        assert_eq!(TYPE_CHAT_OPEN, "chat_open");
        assert_eq!(TYPE_CHAT_MESSAGE, "chat_message");
        assert_eq!(TYPE_CHAT_CLOSE, "chat_close");
        assert_eq!(TYPE_CHAT_REPLY_RESULT, "chat_reply_result");
        assert_eq!(TYPE_CHAT_REPLY, "chat_reply");
        assert_eq!(TYPE_CHAT_PRESENTED, "chat_presented");
        assert_eq!(PRESENTED_FAILED, "failed");
        assert_eq!(BODY_MAX, 2000);
        assert_eq!(SENDER_MAX, 120);
    }

    #[test]
    fn live_open_without_a_window_shows_the_window() {
        let mut t = ChatTracker::default();
        assert_eq!(
            t.on_open(&show(M1, "hello"), NO_WINDOW),
            ChatAction::ShowWindow { conversation_id: CID.into(), created: true }
        );
        // The window is being shown, so nothing is "unread".
        assert_eq!(t.summary().total_unread, 0);
        let v = t.view(CID).unwrap();
        assert_eq!(v.messages.len(), 1);
        assert_eq!(v.branding.company_name, "Acme IT");
    }

    #[test]
    fn message_with_a_raised_window_updates_and_flashes() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        assert_eq!(
            t.on_message(&show(M2, "second"), RAISED),
            ChatAction::UpdateAndFlash { conversation_id: CID.into() }
        );
        assert_eq!(t.view(CID).unwrap().messages.len(), 2);
        assert_eq!(t.summary().total_unread, 0);
    }

    #[test]
    fn message_without_a_raised_window_is_badge_only_and_never_shows() {
        for win in [MINIMISED, HIDDEN, NO_WINDOW] {
            let mut t = ChatTracker::default();
            opened(&mut t);
            let a = t.on_message(&show(M2, "second"), win);
            assert_eq!(a, ChatAction::BadgeOnly { conversation_id: CID.into() }, "{win:?}");
            assert_eq!(t.summary().total_unread, 1);
            assert_eq!(t.view(CID).unwrap().unread, 1);
            assert_eq!(t.view(CID).unwrap().messages.len(), 2);
        }
    }

    #[test]
    fn a_message_for_an_unknown_conversation_upserts_but_never_shows() {
        // Helper restarted: no state, the technician sends chat_message.
        let mut t = ChatTracker::default();
        let a = t.on_message(&show(M2, "after restart"), NO_WINDOW);
        assert_eq!(a, ChatAction::BadgeOnly { conversation_id: CID.into() });
        assert_eq!(t.summary().total_unread, 1);
    }

    #[test]
    fn live_open_when_the_window_already_exists_never_re_raises_it() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.on_open(&show(M2, "again"), MINIMISED);
        assert_eq!(a, ChatAction::BadgeOnly { conversation_id: CID.into() });
    }

    #[test]
    fn replay_never_shows_a_window() {
        for win in [NO_WINDOW, RAISED, MINIMISED, HIDDEN] {
            let mut t = ChatTracker::default();
            let a = t.on_open(&show_with(CID, &[(M1, "a"), (M2, "b")], true, false, true), win);
            assert!(matches!(a, ChatAction::RestoreSilently { .. }), "{win:?}: {a:?}");
            assert_eq!(t.view(CID).unwrap().messages.len(), 2);
        }
    }

    #[test]
    fn replay_badges_unread_technician_messages_only_when_not_on_screen() {
        let mut t = ChatTracker::default();
        t.on_open(&show_with(CID, &[(M1, "a"), (M2, "b")], true, false, true), NO_WINDOW);
        assert_eq!(t.summary().total_unread, 2);
        let mut t = ChatTracker::default();
        t.on_open(&show_with(CID, &[(M1, "a")], true, false, true), RAISED);
        assert_eq!(t.summary().total_unread, 0);
    }

    #[test]
    fn replay_of_a_known_conversation_does_not_duplicate_or_lose_local_replies() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let plan = t.prepare_reply(CID, "my reply", None).unwrap();
        let mut replay = show_with(CID, &[(M1, "hello")], true, false, true);
        replay.messages.push(
            serde_json::from_value(serde_json::json!({
                "messageId": "99999999-9999-4999-8999-999999999999", "direction": "from_user",
                "body": "my reply", "senderName": "", "sentAt": NOW
            }))
            .unwrap(),
        );
        t.on_open(&replay, NO_WINDOW);
        let v = t.view(CID).unwrap();
        assert_eq!(v.messages.len(), 2, "technician message deduped, local reply kept once");
        assert!(v.messages.iter().any(|m| m.client_nonce.as_deref() == Some(plan.client_nonce.as_str())));
    }

    #[test]
    fn replay_into_a_fresh_helper_restores_user_replies_too() {
        let mut t = ChatTracker::default();
        let mut replay = show_with(CID, &[(M1, "hello")], true, false, true);
        replay.messages.push(
            serde_json::from_value(serde_json::json!({
                "messageId": M2, "direction": "from_user",
                "body": "earlier reply", "senderName": "", "sentAt": NOW
            }))
            .unwrap(),
        );
        t.on_open(&replay, NO_WINDOW);
        let v = t.view(CID).unwrap();
        assert_eq!(v.messages.len(), 2);
        assert_eq!(v.messages[1].direction, "from_user");
        assert_eq!(v.messages[1].status.as_deref(), Some("sent"));
        // Only the technician message is unread.
        assert_eq!(v.unread, 1);
    }

    #[test]
    fn duplicate_message_id_is_ignored() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        assert!(matches!(t.on_message(&show(M2, "x"), MINIMISED), ChatAction::BadgeOnly { .. }));
        assert_eq!(t.on_message(&show(M2, "x"), MINIMISED), ChatAction::Duplicate { conversation_id: CID.into() });
        assert_eq!(t.on_message(&show(M1, "hello"), RAISED), ChatAction::Duplicate { conversation_id: CID.into() });
        assert_eq!(t.view(CID).unwrap().messages.len(), 2);
        assert_eq!(t.summary().total_unread, 1);
    }

    #[test]
    fn close_marks_closed_without_raising_and_blocks_later_messages_and_replies() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        assert!(t.on_close(CID));
        assert!(t.view(CID).unwrap().closed);
        assert_eq!(t.on_message(&show(M2, "late"), RAISED), ChatAction::Duplicate { conversation_id: CID.into() });
        assert_eq!(t.prepare_reply(CID, "hi", None).unwrap_err(), ReplyError::Closed);
        // Idempotent, and unknown conversations are not created.
        assert!(t.on_close(CID));
        assert!(!t.on_close("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    }

    #[test]
    fn closed_replay_restores_a_closed_conversation() {
        let mut t = ChatTracker::default();
        let a = t.on_open(&show_with(CID, &[(M1, "a")], true, true, true), NO_WINDOW);
        assert!(matches!(a, ChatAction::RestoreSilently { .. }));
        assert!(t.view(CID).unwrap().closed);
    }

    #[test]
    fn invalid_payloads_are_rejected() {
        let bad = |s: ChatShow| matches!(ChatTracker::default().on_open(&s, NO_WINDOW), ChatAction::Reject(_));
        assert!(bad(show_with("../etc", &[(M1, "x")], false, false, true)));
        assert!(bad(show_with("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", &[(M1, "x")], false, false, true)));
        assert!(bad(show_with(CID, &[("not-a-uuid", "x")], false, false, true)));
        assert!(bad(show_with(CID, &[(M1, "")], false, false, true)));
        assert!(bad(show_with(CID, &[(M1, &"x".repeat(BODY_MAX + 1))], false, false, true)));
        assert!(bad(show_with(CID, &[], false, false, true)));
        let mut s = show(M1, "x");
        s.messages[0].sender_name = "n".repeat(SENDER_MAX + 1);
        assert!(bad(s));
        let mut s = show(M1, "x");
        s.messages[0].sender_name = "  ".into();
        assert!(bad(s));
        let mut s = show(M1, "x");
        s.messages[0].sent_at = "yesterday".into();
        assert!(bad(s));
        let mut s = show(M1, "x");
        s.messages[0].direction = "sideways".into();
        assert!(bad(s));
        // Exactly at the limits is fine.
        let mut ok = show_with(CID, &[(M1, &"x".repeat(BODY_MAX))], false, false, true);
        ok.messages[0].sender_name = "n".repeat(SENDER_MAX);
        assert!(matches!(ChatTracker::default().on_open(&ok, NO_WINDOW), ChatAction::ShowWindow { .. }));
        // A rejected frame leaves no conversation behind.
        let mut t = ChatTracker::default();
        t.on_open(&show_with(CID, &[(M1, "")], false, false, true), NO_WINDOW);
        assert!(t.view(CID).is_none());
    }

    #[test]
    fn bad_accent_is_dropped_and_good_one_kept() {
        let mut t = ChatTracker::default();
        let mut s = show(M1, "x");
        s.branding.accent = Some("url(javascript:1)".into());
        t.on_open(&s, NO_WINDOW);
        assert_eq!(t.view(CID).unwrap().branding.accent, None);
        let mut t = ChatTracker::default();
        t.on_open(&show(M1, "x"), NO_WINDOW);
        assert_eq!(t.view(CID).unwrap().branding.accent.as_deref(), Some("#336699"));
    }

    #[test]
    fn view_serialises_camel_case_and_marks_directions() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let p = t.prepare_reply(CID, "yo", None).unwrap();
        let v = serde_json::to_value(t.view(CID).unwrap()).unwrap();
        assert_eq!(v["conversationId"], CID);
        assert_eq!(v["allowReply"], true);
        assert_eq!(v["closed"], false);
        assert_eq!(v["branding"]["companyName"], "Acme IT");
        assert_eq!(v["messages"][0]["direction"], "to_user");
        assert_eq!(v["messages"][0]["senderName"], "Sam Tech");
        assert_eq!(v["messages"][1]["direction"], "from_user");
        assert_eq!(v["messages"][1]["status"], "pending");
        assert_eq!(v["messages"][1]["clientNonce"], p.client_nonce);
    }

    fn is_v4_uuid(s: &str) -> bool {
        let b = s.as_bytes();
        s.len() == 36
            && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
            && s.bytes().enumerate().all(|(i, c)| {
                [8, 13, 18, 23].contains(&i) || (c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            })
            && b[14] == b'4'
            && matches!(b[19], b'8' | b'9' | b'a' | b'b')
    }

    #[test]
    fn reply_builds_the_contract_frame_with_a_fresh_v4_nonce_each_time() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply(CID, "  hello there \n", None).unwrap();
        let b = t.prepare_reply(CID, "again", None).unwrap();
        assert!(is_v4_uuid(&a.client_nonce), "{}", a.client_nonce);
        assert!(is_v4_uuid(&b.client_nonce));
        assert_ne!(a.client_nonce, b.client_nonce);
        assert_eq!(a.frame.typ, "chat_reply");
        assert_eq!(
            a.frame.payload,
            serde_json::json!({ "conversationId": CID, "clientNonce": a.client_nonce, "body": "hello there" })
        );
        assert_ne!(a.frame.id, b.frame.id);
        let v = t.view(CID).unwrap();
        assert_eq!(v.messages[1].status.as_deref(), Some("pending"));
        assert_eq!(v.messages[1].body, "hello there");
    }

    #[test]
    fn many_nonces_never_collide() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2000 {
            let n = new_nonce();
            assert!(is_v4_uuid(&n), "{n}");
            assert!(seen.insert(n));
        }
    }

    #[test]
    fn reply_refusals() {
        let mut t = ChatTracker::default();
        assert_eq!(t.prepare_reply(CID, "x", None).unwrap_err(), ReplyError::Unknown);
        opened(&mut t);
        assert_eq!(t.prepare_reply(CID, "   \n", None).unwrap_err(), ReplyError::Empty);
        assert_eq!(t.prepare_reply(CID, &"x".repeat(BODY_MAX + 1), None).unwrap_err(), ReplyError::TooLong);
        assert!(t.prepare_reply(CID, &"x".repeat(BODY_MAX), None).is_ok());

        // Replies turned off by policy.
        let mut off = ChatTracker::default();
        off.on_open(&show_with(CID, &[(M1, "hi")], false, false, false), NO_WINDOW);
        assert_eq!(off.prepare_reply(CID, "x", None).unwrap_err(), ReplyError::RepliesOff);
        // A later frame turning replies off takes effect.
        let mut t = ChatTracker::default();
        opened(&mut t);
        t.on_message(&show_with(CID, &[(M2, "hi")], false, false, false), RAISED);
        assert_eq!(t.prepare_reply(CID, "x", None).unwrap_err(), ReplyError::RepliesOff);
    }

    #[test]
    fn pending_replies_are_bounded() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        for _ in 0..MAX_PENDING {
            t.prepare_reply(CID, "x", None).unwrap();
        }
        assert_eq!(t.prepare_reply(CID, "x", None).unwrap_err(), ReplyError::TooManyPending);
    }

    #[test]
    fn reply_results_update_the_status() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply(CID, "one", None).unwrap();
        let res = |nonce: &str, status: &str| ChatReplyResult {
            conversation_id: CID.into(),
            client_nonce: nonce.into(),
            status: status.into(),
        };
        assert!(t.on_reply_result(&res(&a.client_nonce, "sent")));
        let st = |t: &ChatTracker| t.view(CID).unwrap().messages.last().unwrap().clone();
        assert_eq!(st(&t).status.as_deref(), Some("sent"));

        let b = t.prepare_reply(CID, "two", None).unwrap();
        assert!(t.on_reply_result(&res(&b.client_nonce, "failed")));
        let m = st(&t);
        assert_eq!(m.status.as_deref(), Some("failed"));
        assert!(m.retryable);

        let c = t.prepare_reply(CID, "three", None).unwrap();
        assert!(t.on_reply_result(&res(&c.client_nonce, "rejected")));
        let m = st(&t);
        assert_eq!(m.status.as_deref(), Some("failed"));
        assert!(!m.retryable);

        let d = t.prepare_reply(CID, "four", None).unwrap();
        assert!(t.on_reply_result(&res(&d.client_nonce, "closed")));
        assert!(t.view(CID).unwrap().closed);
        assert_eq!(st(&t).status.as_deref(), Some("failed"));
        assert!(!st(&t).retryable);

        // Unknown nonce / conversation / status are ignored.
        assert!(!t.on_reply_result(&res(M3, "sent")));
        assert!(!t.on_reply_result(&ChatReplyResult {
            conversation_id: M3.into(),
            client_nonce: a.client_nonce.clone(),
            status: "sent".into()
        }));
        assert!(!t.on_reply_result(&res(&a.client_nonce, "weird")));
        // A late "failed" never downgrades a reply already confirmed sent.
        assert!(!t.on_reply_result(&res(&a.client_nonce, "failed")));
        assert_eq!(t.view(CID).unwrap().messages[1].status.as_deref(), Some("sent"));
    }

    #[test]
    fn retry_reuses_the_nonce_only_for_a_failed_retryable_reply() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply(CID, "one", None).unwrap();
        // Pending / sent cannot be retried.
        assert_eq!(t.prepare_reply(CID, "one", Some(&a.client_nonce)).unwrap_err(), ReplyError::NotRetryable);
        let res = |s: &str| ChatReplyResult {
            conversation_id: CID.into(),
            client_nonce: a.client_nonce.clone(),
            status: s.into(),
        };
        t.on_reply_result(&res("failed"));
        let again = t.prepare_reply(CID, "ignored: stored body wins", Some(&a.client_nonce)).unwrap();
        assert_eq!(again.client_nonce, a.client_nonce);
        assert_eq!(again.frame.payload["body"], "one");
        assert_eq!(t.view(CID).unwrap().messages.len(), 2, "retry does not add a bubble");
        assert_eq!(t.view(CID).unwrap().messages[1].status.as_deref(), Some("pending"));
        t.on_reply_result(&res("sent"));
        assert_eq!(t.prepare_reply(CID, "x", Some(&a.client_nonce)).unwrap_err(), ReplyError::NotRetryable);
        // Rejected replies are final.
        let b = t.prepare_reply(CID, "two", None).unwrap();
        t.on_reply_result(&ChatReplyResult {
            conversation_id: CID.into(),
            client_nonce: b.client_nonce.clone(),
            status: "rejected".into(),
        });
        assert_eq!(t.prepare_reply(CID, "x", Some(&b.client_nonce)).unwrap_err(), ReplyError::NotRetryable);
        // Unknown nonce.
        assert_eq!(t.prepare_reply(CID, "x", Some(M3)).unwrap_err(), ReplyError::NotRetryable);
    }

    #[test]
    fn a_pending_reply_with_no_result_fails_retryably_after_the_timeout() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply_at(CID, "one", None, 1_000).unwrap();
        // Not yet.
        assert!(t.expire_pending(1_000 + PENDING_TIMEOUT_MS - 1).is_empty());
        assert_eq!(t.view(CID).unwrap().messages[1].status.as_deref(), Some("pending"));
        // At the timeout it fails, retryable, and the conversation is reported.
        assert_eq!(t.expire_pending(1_000 + PENDING_TIMEOUT_MS), vec![CID.to_string()]);
        let m = t.view(CID).unwrap().messages[1].clone();
        assert_eq!(m.status.as_deref(), Some("failed"));
        assert!(m.retryable);
        // Reported once.
        assert!(t.expire_pending(1_000 + PENDING_TIMEOUT_MS * 5).is_empty());
        // Same-nonce retry restarts the clock.
        let again = t.prepare_reply_at(CID, "x", Some(&a.client_nonce), 100_000).unwrap();
        assert_eq!(again.client_nonce, a.client_nonce);
        assert!(t.expire_pending(100_000 + PENDING_TIMEOUT_MS - 1).is_empty());
        assert_eq!(t.expire_pending(100_000 + PENDING_TIMEOUT_MS).len(), 1);
        // A late "sent" still settles an expired reply.
        let res = ChatReplyResult {
            conversation_id: CID.into(),
            client_nonce: a.client_nonce.clone(),
            status: "sent".into(),
        };
        assert!(t.on_reply_result(&res));
        assert_eq!(t.view(CID).unwrap().messages[1].status.as_deref(), Some("sent"));
    }

    #[test]
    fn a_confirmed_reply_never_expires_and_expiry_frees_the_pending_bound() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply_at(CID, "one", None, 0).unwrap();
        t.on_reply_result(&ChatReplyResult {
            conversation_id: CID.into(),
            client_nonce: a.client_nonce,
            status: "sent".into(),
        });
        assert!(t.expire_pending(PENDING_TIMEOUT_MS * 10).is_empty());
        assert_eq!(t.view(CID).unwrap().messages[1].status.as_deref(), Some("sent"));

        for _ in 0..MAX_PENDING {
            t.prepare_reply_at(CID, "x", None, 5_000).unwrap();
        }
        assert_eq!(t.prepare_reply_at(CID, "x", None, 5_000).unwrap_err(), ReplyError::TooManyPending);
        t.expire_pending(5_000 + PENDING_TIMEOUT_MS);
        // Expired replies are failed, not pending, so the bound no longer blocks.
        assert!(t.prepare_reply_at(CID, "x", None, 5_000 + PENDING_TIMEOUT_MS).is_ok());
    }

    #[test]
    fn discard_reply_rolls_a_pending_reply_back() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply(CID, "one", None).unwrap();
        t.discard_reply(CID, &a.client_nonce);
        assert_eq!(t.view(CID).unwrap().messages.len(), 1);
    }

    #[test]
    fn a_lost_session_fails_pending_replies_so_they_can_be_retried() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        let a = t.prepare_reply(CID, "one", None).unwrap();
        assert_eq!(t.fail_pending_replies(), vec![CID.to_string()]);
        let m = t.view(CID).unwrap().messages[1].clone();
        assert_eq!(m.status.as_deref(), Some("failed"));
        assert!(m.retryable);
        assert!(t.prepare_reply(CID, "x", Some(&a.client_nonce)).is_ok());
        assert_eq!(t.fail_pending_replies().len(), 1);
        let mut empty = ChatTracker::default();
        assert!(empty.fail_pending_replies().is_empty());
    }

    #[test]
    fn mark_read_clears_the_badge() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        t.on_message(&show(M2, "x"), MINIMISED);
        assert_eq!(t.summary().total_unread, 1);
        assert!(t.mark_read(CID));
        assert_eq!(t.summary().total_unread, 0);
        assert!(!t.mark_read(CID), "nothing changed the second time");
        assert!(!t.mark_read("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    }

    #[test]
    fn summary_points_the_tray_at_the_conversation_with_unread_then_the_open_one() {
        let other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let mut t = ChatTracker::default();
        assert_eq!(t.summary(), TraySummary::default());
        t.on_open(&show_with(CID, &[(M1, "a")], false, false, true), NO_WINDOW);
        assert_eq!(t.summary().target.as_deref(), Some(CID));
        t.on_open(&show_with(other, &[(M2, "b")], false, false, true), NO_WINDOW);
        t.on_message(&show_with(CID, &[(M3, "c")], false, false, true), MINIMISED);
        let s = t.summary();
        assert_eq!(s.total_unread, 1);
        assert_eq!(s.target.as_deref(), Some(CID));
        assert!(s.has_open);
        t.on_close(CID);
        t.on_close(other);
        assert!(!t.summary().has_open);
    }

    #[test]
    fn show_failure_forgets_a_conversation_the_frame_created() {
        let mut t = ChatTracker::default();
        let a = t.on_open(&show(M1, "x"), NO_WINDOW);
        assert_eq!(a, ChatAction::ShowWindow { conversation_id: CID.into(), created: true });
        t.on_show_failed(CID, true);
        assert!(t.view(CID).is_none());
        // A pre-existing conversation is kept.
        let mut t = ChatTracker::default();
        t.on_message(&show(M1, "x"), NO_WINDOW);
        t.on_show_failed(CID, false);
        assert!(t.view(CID).is_some());
    }

    #[test]
    fn the_conversation_count_is_bounded_and_closed_ones_are_evicted_first() {
        let mut t = ChatTracker::default();
        let id = |n: usize| format!("{n:08x}-0000-4000-8000-000000000000");
        let mid = |n: usize| format!("{n:08x}-1111-4111-8111-111111111111");
        for n in 0..MAX_CONVERSATIONS {
            let s = show_with(&id(n), &[(&mid(n), "x")], false, false, true);
            assert!(matches!(t.on_message(&s, NO_WINDOW), ChatAction::BadgeOnly { .. }));
        }
        let extra = show_with(&id(99), &[(&mid(99), "x")], false, false, true);
        assert!(matches!(t.on_message(&extra, NO_WINDOW), ChatAction::Reject(_)));
        assert!(t.view(&id(99)).is_none());
        t.on_close(&id(3));
        assert!(matches!(t.on_message(&extra, NO_WINDOW), ChatAction::BadgeOnly { .. }));
        assert!(t.view(&id(3)).is_none(), "the closed conversation made room");
        assert!(t.view(&id(99)).is_some());
    }

    #[test]
    fn transcript_is_capped() {
        let mut t = ChatTracker::default();
        opened(&mut t);
        for n in 0..(MAX_MESSAGES + 10) {
            let mid = format!("{:08x}-2222-4222-8222-222222222222", n + 100);
            t.on_message(&show(&mid, "x"), RAISED);
        }
        assert_eq!(t.view(CID).unwrap().messages.len(), MAX_MESSAGES);
    }

    #[test]
    fn presented_reuses_the_envelope_id() {
        let ok = ChatTracker::presented("env-9", CID, Some(M1), "");
        assert_eq!(ok.id, "env-9");
        assert_eq!(ok.typ, "chat_presented");
        assert_eq!(ok.payload, serde_json::json!({ "conversationId": CID, "messageId": M1, "status": "" }));
        let bad = ChatTracker::presented("env-10", CID, None, PRESENTED_FAILED);
        assert_eq!(bad.id, "env-10");
        assert_eq!(bad.payload, serde_json::json!({ "conversationId": CID, "status": "failed" }));
    }

    #[test]
    fn window_label_and_url_are_keyed_by_conversation_id() {
        assert_eq!(window_label("abc"), "chat-abc");
        assert_eq!(window_url("abc"), "index.html#chat/abc");
        assert!(label_matches("chat-abc", "abc"));
        assert!(!label_matches("chat-abd", "abc"));
        assert!(!label_matches("message-abc", "abc"));
        assert!(!label_matches("main", "abc"));
    }

    #[test]
    fn chat_windows_are_refused_privileged_commands() {
        assert!(crate::ipc::message::deny_message_window("chat-abc").is_err());
        assert!(crate::ipc::message::deny_message_window("chat-").is_err());
        assert!(crate::ipc::message::deny_message_window("message-abc").is_err());
        assert!(crate::ipc::message::deny_message_window("main").is_ok());
        assert!(crate::ipc::message::deny_message_window("chatter").is_ok());
        assert!(deny_chat_window("chat-x").is_err());
    }

    #[test]
    fn bridge_forwards_replies_only_while_a_session_is_live() {
        let b = ChatBridge::default();
        {
            let mut t = b.tracker();
            opened(&mut t);
        }
        // No live session: error, and nothing stays pending.
        assert!(b.send_reply(CID, "hi", None).is_err());
        assert_eq!(b.tracker().view(CID).unwrap().messages.len(), 1);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        let nonce = b.send_reply(CID, "hi", None).unwrap();
        let ChatEvent::Send(frame) = rx.try_recv().unwrap();
        assert_eq!(frame.typ, "chat_reply");
        assert_eq!(frame.payload["clientNonce"], nonce);
        b.clear_sender();
        assert!(b.send_reply(CID, "again", None).is_err());
    }

    // ----- source scans: the chat window must never raise itself or main -----

    fn prod_of(s: &'static str) -> &'static str {
        s.split("\nmod tests {").next().unwrap()
    }

    #[test]
    fn chat_code_never_names_the_main_window() {
        assert!(!prod_of(include_str!("chat.rs")).contains("\"main\""));
        let desktop = prod_of(include_str!("desktop.rs"));
        let start = desktop.find("pub fn show_chat_window").expect("show_chat_window");
        let end = desktop[start..].find("\n}\n").map(|i| i + start).expect("fn end");
        let body = &desktop[start..end];
        assert!(!body.contains("\"main\""));
        assert!(!body.contains("show_window("));
        assert!(body.contains("WebviewWindowBuilder::new"));
        assert!(body.contains("user_initiated"), "raising an existing window is gated on a user action");
    }

    #[test]
    fn show_chat_window_has_exactly_the_two_expected_call_sites() {
        let client = prod_of(include_str!("client.rs"));
        let lib = prod_of(include_str!("../lib.rs"));
        assert_eq!(client.matches("desktop::show_chat_window").count(), 1);
        assert_eq!(lib.matches("show_chat_window").count(), 1);
        // The client's single call is inside the chat_open arm...
        let open = client.find("\"chat_open\" =>").expect("chat_open arm");
        let msg = client.find("\"chat_message\" =>").expect("chat_message arm");
        let call = client.find("desktop::show_chat_window").unwrap();
        assert!(open < call && call < msg);
        // ...and the user-initiated one in lib.rs passes user_initiated = true.
        let at = lib.find("show_chat_window").unwrap();
        assert!(lib[at..at + 200].contains("true"));
        // The live open arm passes false.
        assert!(client[call..call + 200].contains("false"));
    }

    #[test]
    fn inbound_chat_arms_other_than_open_never_show_or_focus_a_window() {
        let client = prod_of(include_str!("client.rs"));
        let msg = client.find("\"chat_message\" =>").expect("chat_message arm");
        let end = client[msg..].find("\"banner_show\" =>").map(|i| i + msg).expect("end");
        let arms = &client[msg..end];
        for forbidden in ["show_chat_window", "set_focus", "unminimize", ".show()", "\"main\"", "show_window("] {
            assert!(!arms.contains(forbidden), "chat_message/close/reply_result arms contain {forbidden}");
        }
        // Every non-ShowWindow action goes through apply_chat_action, which
        // must be equally incapable of raising a window.
        let open = client.find("\"chat_open\" =>").unwrap();
        assert!(client[open..msg].contains("apply_chat_action"));
        let f = client.find("fn apply_chat_action").expect("apply_chat_action");
        let f_end = client[f..].find("\n}\n").map(|i| i + f).expect("fn end");
        let helper = &client[f..f_end];
        for forbidden in ["show_chat_window", "set_focus", "unminimize", ".show()", "\"main\"", "show_window("] {
            assert!(!helper.contains(forbidden), "apply_chat_action contains {forbidden}");
        }
        assert!(helper.contains("RestoreSilently") && helper.contains("flash_chat_window"));
        // The flash is attention only: it cannot show, focus or un-minimise.
        let desktop = prod_of(include_str!("desktop.rs"));
        let d = desktop.find("pub fn flash_chat_window").expect("flash_chat_window");
        let d_end = desktop[d..].find("\n}\n").map(|i| i + d).expect("fn end");
        let flash = &desktop[d..d_end];
        assert!(flash.contains("request_user_attention(Some(tauri::UserAttentionType::Informational))"));
        for forbidden in ["set_focus", "unminimize", ".show()", "\"main\""] {
            assert!(!flash.contains(forbidden), "flash_chat_window contains {forbidden}");
        }
        let e = desktop.find("pub fn emit_chat_update").expect("emit_chat_update");
        let e_end = desktop[e..].find("\n}\n").map(|i| i + e).expect("fn end");
        for forbidden in ["set_focus", "unminimize", ".show()", "\"main\""] {
            assert!(!desktop[e..e_end].contains(forbidden), "emit_chat_update contains {forbidden}");
        }
        // Updates go to the chat window only, never a broadcast.
        assert!(desktop[e..e_end].contains("emit_to("));
    }

    // The helper's constants must equal the Go ones literally (same check the
    // message types get in envelope.rs).
    #[test]
    fn typ_strings_match_the_go_constants() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../agent/internal/ipc/chat.go");
        let go = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
        for (name, value) in [
            ("TypeChatOpen", TYPE_CHAT_OPEN),
            ("TypeChatMessage", TYPE_CHAT_MESSAGE),
            ("TypeChatClose", TYPE_CHAT_CLOSE),
            ("TypeChatReplyResult", TYPE_CHAT_REPLY_RESULT),
            ("TypeChatReply", TYPE_CHAT_REPLY),
            ("TypeChatPresented", TYPE_CHAT_PRESENTED),
        ] {
            let found = go.lines().any(|l| {
                let mut it = l.split_whitespace();
                it.next() == Some(name) && it.next() == Some("=") && it.next() == Some(&format!("\"{value}\""))
            });
            assert!(found, "agent chat.go has no `{name} = \"{value}\"`");
        }
    }

    #[test]
    fn auth_request_advertises_chat_support() {
        let client = prod_of(include_str!("client.rs"));
        assert!(client.contains("supportsChat"));
        assert!(client.contains("supports_chat: true"));
    }
}
