//! Endpoint messaging (#8293): the `message_show` / `message_retract` exchange
//! with the Go agent, kept free of Tauri window types so it is unit-tested
//! without a window.
//!
//! Wire contract (mirrors `agent/internal/ipc/message.go`; envelope framing and
//! HMAC are unchanged):
//!   * agent -> helper `message_show`, `message_retract`
//!   * helper -> agent `message_presented` (SAME envelope id as the
//!     `message_show`), then unsolicited `message_ack` / `message_dismissed`
//!     (fresh envelope ids).
//!
//! START-HIDDEN (#8138): a message renders in its own small `message-<id>` card
//! window and NEVER shows the main Assist window. The helper keeps messages in
//! process memory only; the agent replays sticky ones after the helper
//! re-authenticates.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::consent::Outbound;

// The agent->helper types are matched by literal in `client.rs`; these two
// exist for the byte-compat test against `message.go`.
#[allow(dead_code)]
pub const TYPE_MESSAGE_SHOW: &str = "message_show";
#[allow(dead_code)]
pub const TYPE_MESSAGE_RETRACT: &str = "message_retract";
pub const TYPE_MESSAGE_PRESENTED: &str = "message_presented";
pub const TYPE_MESSAGE_ACK: &str = "message_ack";
pub const TYPE_MESSAGE_DISMISSED: &str = "message_dismissed";

/// `message_presented.status` values (mirror `agent/internal/ipc/message.go`);
/// absent means the card is on screen.
pub const PRESENTED_ALREADY_RESOLVED: &str = "already_resolved";
pub const PRESENTED_FAILED: &str = "failed";

pub const REASON_USER: &str = "user";
pub const REASON_EXPIRED: &str = "expired";

/// Content limits. Mirrors `ENDPOINT_MESSAGE_LIMITS` in
/// `packages/shared/src/validators/endpointMessage.ts` (apps/helper does not
/// depend on @breeze/shared); keep the two in step.
pub const TITLE_MAX: usize = 120;
pub const BODY_MAX: usize = 2000;

/// `critical` may take keyboard focus at most once per this window.
pub const FOCUS_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// Bound on the in-memory "already resolved" set.
const RESOLVED_CAP: usize = 1024;

/// A messageId becomes part of a window label and a URL hash: ASCII
/// alphanumerics and `-` only (UUIDs), bounded.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `#rrggbb` only; the accent is applied as a CSS colour.
fn valid_accent(a: &str) -> bool {
    a.len() == 7 && a.starts_with('#') && a[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Window label prefix; the full label is `message-<messageId>`.
pub const WINDOW_LABEL_PREFIX: &str = "message-";

pub fn window_label(message_id: &str) -> String {
    format!("{WINDOW_LABEL_PREFIX}{message_id}")
}

pub fn window_url(message_id: &str) -> String {
    format!("index.html#message/{message_id}")
}

/// Whether `label` is exactly the card window for `message_id`.
pub fn label_matches(label: &str, message_id: &str) -> bool {
    label == window_label(message_id)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branding {
    #[serde(default)]
    pub company_name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub accent: Option<String>,
}

/// The `message_show` payload.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageShow {
    pub message_id: String,
    #[serde(default)]
    pub batch_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub requires_ack: bool,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub branding: Branding,
    #[serde(default)]
    pub replay: bool,
}

/// The `message_retract` payload.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRetract {
    pub message_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

/// What the card window renders. The sender slot comes from `branding`, never
/// from the body.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub message_id: String,
    pub title: String,
    pub body: String,
    pub severity: String,
    pub requires_ack: bool,
    pub expires_at: String,
    pub branding: Branding,
    /// Oversize content: the frontend renders it as plain text.
    pub plain: bool,
}

/// Window flags for a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CardPlan {
    pub always_on_top: bool,
    pub focused: bool,
}

/// An event from a card window (via the Tauri commands).
#[derive(Debug, Clone, PartialEq)]
pub enum MsgEvent {
    /// The user clicked Acknowledge.
    Ack(String),
    /// The card closed without an ack (Close button, or the OS closed it).
    Closed(String),
}

/// `critical` focus rate limit. Pure; the clock is injected.
#[derive(Debug, Default)]
pub struct FocusLimiter {
    last_ms: Option<i64>,
}

impl FocusLimiter {
    /// True (and records the grant) when a focus-taking card is allowed now.
    pub fn try_take(&mut self, now_ms: i64) -> bool {
        match self.last_ms {
            Some(last) if now_ms.saturating_sub(last) < FOCUS_INTERVAL_MS => false,
            _ => {
                self.last_ms = Some(now_ms);
                true
            }
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum ShowAction {
    /// Build the card window, then reply `message_presented`.
    Show { plan: CardPlan, view: MessageView },
    /// Already on screen (duplicate / replay): reply `message_presented`, build nothing.
    AlreadyShown,
    /// Already acked/dismissed/expired in this process: show and reply nothing.
    Suppressed,
    /// Expired before it could be shown: send this and build nothing.
    Reply(Outbound),
    /// Invalid payload; nothing to correlate a reply to.
    Reject(String),
}

#[derive(Debug)]
struct Active {
    expires_ms: i64,
    view: MessageView,
}

/// Messages currently on screen plus the focus limiter. Process memory only.
#[derive(Debug, Default)]
pub struct MessageTracker {
    active: HashMap<String, Active>,
    resolved: HashSet<String>,
    focus: FocusLimiter,
    seq: u64,
}

impl MessageTracker {
    pub fn on_show(&mut self, now_ms: i64, req: &MessageShow) -> ShowAction {
        if !valid_id(&req.message_id) {
            return ShowAction::Reject("invalid messageId".into());
        }
        let severity = match req.severity.as_str() {
            "info" => Severity::Info,
            "warning" => Severity::Warning,
            "critical" => Severity::Critical,
            _ => return ShowAction::Reject("invalid severity".into()),
        };
        let expires_ms = match chrono::DateTime::parse_from_rfc3339(&req.expires_at) {
            Ok(t) => t.timestamp_millis(),
            Err(_) => return ShowAction::Reject("invalid expiresAt".into()),
        };
        if self.active.contains_key(&req.message_id) {
            return ShowAction::AlreadyShown;
        }
        if self.resolved.contains(&req.message_id) {
            return ShowAction::Suppressed;
        }
        if expires_ms <= now_ms {
            self.mark_resolved(&req.message_id);
            return ShowAction::Reply(self.dismissed(&req.message_id, REASON_EXPIRED));
        }

        let always_on_top = severity != Severity::Info || req.requires_ack;
        // Only `critical` can take focus, and only once per FOCUS_INTERVAL_MS.
        let focused = severity == Severity::Critical && self.focus.try_take(now_ms);
        let plain = req.title.chars().count() > TITLE_MAX || req.body.chars().count() > BODY_MAX;
        let mut branding = req.branding.clone();
        if !branding.accent.as_deref().is_some_and(valid_accent) {
            branding.accent = None;
        }
        let view = MessageView {
            message_id: req.message_id.clone(),
            title: req.title.clone(),
            body: req.body.clone(),
            severity: req.severity.clone(),
            requires_ack: req.requires_ack,
            expires_at: req.expires_at.clone(),
            branding,
            plain,
        };
        self.active.insert(
            req.message_id.clone(),
            Active {
                expires_ms,
                view: view.clone(),
            },
        );
        ShowAction::Show {
            plan: CardPlan {
                always_on_top,
                focused,
            },
            view,
        }
    }

    /// The reply to a `message_show`: SAME envelope id as the request.
    pub fn presented(env_id: &str, message_id: &str) -> Outbound {
        Outbound {
            id: env_id.to_string(),
            typ: TYPE_MESSAGE_PRESENTED,
            payload: serde_json::json!({ "messageId": message_id }),
        }
    }

    /// A `message_presented` reply that says why nothing is on screen
    /// (`already_resolved` / `failed`), on the SAME envelope id as the show.
    pub fn presented_with_status(env_id: &str, message_id: &str, status: &str) -> Outbound {
        Outbound {
            id: env_id.to_string(),
            typ: TYPE_MESSAGE_PRESENTED,
            payload: serde_json::json!({ "messageId": message_id, "status": status }),
        }
    }

    /// Frames for every `ShowAction` except `Show` (whose reply depends on
    /// whether the window could be built). The `presented` resolution goes
    /// first so the agent's waiter never falls back to a native toast.
    pub fn replies_for(env_id: &str, message_id: &str, action: ShowAction) -> Vec<Outbound> {
        match action {
            ShowAction::AlreadyShown => vec![Self::presented(env_id, message_id)],
            ShowAction::Suppressed => {
                vec![Self::presented_with_status(env_id, message_id, PRESENTED_ALREADY_RESOLVED)]
            }
            ShowAction::Reply(dismissed) => vec![
                Self::presented_with_status(env_id, message_id, PRESENTED_ALREADY_RESOLVED),
                dismissed,
            ],
            ShowAction::Reject(_) => {
                vec![Self::presented_with_status(env_id, message_id, PRESENTED_FAILED)]
            }
            ShowAction::Show { .. } => Vec::new(),
        }
    }

    /// The window could not be built: forget the message (caller replies `failed`).
    pub fn on_show_failed(&mut self, message_id: &str) {
        self.active.remove(message_id);
    }

    /// `message_retract`: true when it was on screen (caller closes the window).
    pub fn on_retract(&mut self, message_id: &str) -> bool {
        let was = self.active.remove(message_id).is_some();
        if was {
            self.mark_resolved(message_id);
        }
        was
    }

    /// The user acknowledged. At most one `message_ack` per message.
    pub fn on_ack(&mut self, message_id: &str) -> Option<Outbound> {
        self.active.remove(message_id)?;
        self.mark_resolved(message_id);
        Some(Outbound {
            id: self.fresh_id(),
            typ: TYPE_MESSAGE_ACK,
            payload: serde_json::json!({ "messageId": message_id }),
        })
    }

    /// The card closed without an ack. At most one terminal frame per message.
    pub fn on_closed(&mut self, message_id: &str) -> Option<Outbound> {
        self.active.remove(message_id)?;
        self.mark_resolved(message_id);
        Some(self.dismissed(message_id, REASON_USER))
    }

    /// Cards whose `expiresAt` has passed: `(messageId, message_dismissed expired)`.
    pub fn expire_due(&mut self, now_ms: i64) -> Vec<(String, Outbound)> {
        let mut due: Vec<String> = self
            .active
            .iter()
            .filter(|(_, a)| a.expires_ms <= now_ms)
            .map(|(id, _)| id.clone())
            .collect();
        due.sort();
        due.into_iter()
            .map(|id| {
                self.active.remove(&id);
                self.mark_resolved(&id);
                let frame = self.dismissed(&id, REASON_EXPIRED);
                (id, frame)
            })
            .collect()
    }

    /// Forget everything on screen (session ended); returns their ids so the
    /// caller can close the windows. The agent replays sticky messages.
    pub fn clear(&mut self) -> Vec<String> {
        let mut ids: Vec<String> = self.active.drain().map(|(id, _)| id).collect();
        ids.sort();
        ids
    }

    pub fn view(&self, message_id: &str) -> Option<MessageView> {
        self.active.get(message_id).map(|a| a.view.clone())
    }

    fn mark_resolved(&mut self, message_id: &str) {
        if self.resolved.len() >= RESOLVED_CAP {
            self.resolved.clear();
        }
        self.resolved.insert(message_id.to_string());
    }

    /// A unique envelope id for an unsolicited frame.
    fn fresh_id(&mut self) -> String {
        self.seq += 1;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("msg-{nanos:x}-{}", self.seq)
    }

    fn dismissed(&mut self, message_id: &str, reason: &str) -> Outbound {
        Outbound {
            id: self.fresh_id(),
            typ: TYPE_MESSAGE_DISMISSED,
            payload: serde_json::json!({ "messageId": message_id, "reason": reason }),
        }
    }

    #[cfg(test)]
    pub fn is_active(&self, message_id: &str) -> bool {
        self.active.contains_key(message_id)
    }
}

/// Bridge held in Tauri managed state: the tracker (shared by the IPC loop and
/// the card Tauri commands) and the live session's event sender.
#[derive(Default)]
pub struct MessageBridge {
    tracker: Mutex<MessageTracker>,
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<MsgEvent>>>,
}

impl MessageBridge {
    /// Lock the tracker. Never hold the guard across an `.await`.
    pub fn tracker(&self) -> MutexGuard<'_, MessageTracker> {
        self.tracker.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn set_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<MsgEvent>) {
        if let Ok(mut g) = self.sender.lock() {
            *g = Some(tx);
        }
    }
    pub fn clear_sender(&self) {
        if let Ok(mut g) = self.sender.lock() {
            *g = None;
        }
    }
    /// Forward a card event to the live session loop; false when none.
    pub fn submit(&self, event: MsgEvent) -> bool {
        match self.sender.lock() {
            Ok(g) => g.as_ref().is_some_and(|tx| tx.send(event).is_ok()),
            Err(_) => false,
        }
    }
    /// Deliver the user's acknowledgement; Err (so the card can say so and
    /// stay open for a retry) when there is no live session to carry it.
    pub fn submit_ack(&self, message_id: &str) -> Result<(), String> {
        if self.submit(MsgEvent::Ack(message_id.to_string())) {
            Ok(())
        } else {
            Err("Not connected to your IT provider's agent. Try again in a moment.".into())
        }
    }
    pub fn view(&self, message_id: &str) -> Option<MessageView> {
        self.tracker().view(message_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn show_json(sev: &str, ack: bool, exp: &str) -> String {
        format!(
            r##"{{"messageId":"{ID}","batchId":"22222222-2222-4222-8222-222222222222","title":"Reboot","body":"Please **save** work","severity":"{sev}","requiresAck":{ack},"expiresAt":"{exp}","branding":{{"companyName":"Acme IT","displayName":"Acme","accent":"#336699"}},"replay":false}}"##
        )
    }

    fn future() -> String {
        chrono::DateTime::from_timestamp_millis(NOW + 3_600_000).unwrap().to_rfc3339()
    }

    fn show(sev: &str, ack: bool) -> MessageShow {
        serde_json::from_str(&show_json(sev, ack, &future())).unwrap()
    }

    #[test]
    fn parses_the_contract_payload() {
        let m = show("warning", true);
        assert_eq!(m.message_id, ID);
        assert!(m.requires_ack);
        assert!(!m.replay);
        assert_eq!(m.branding.company_name, "Acme IT");
        assert_eq!(m.branding.accent.as_deref(), Some("#336699"));
        let r: MessageRetract = serde_json::from_str(&format!(r#"{{"messageId":"{ID}"}}"#)).unwrap();
        assert_eq!(r.message_id, ID);
    }

    #[test]
    fn type_strings_are_the_contract_literals() {
        assert_eq!(TYPE_MESSAGE_SHOW, "message_show");
        assert_eq!(TYPE_MESSAGE_RETRACT, "message_retract");
        assert_eq!(TYPE_MESSAGE_PRESENTED, "message_presented");
        assert_eq!(TYPE_MESSAGE_ACK, "message_ack");
        assert_eq!(TYPE_MESSAGE_DISMISSED, "message_dismissed");
    }

    #[test]
    fn presented_reuses_the_show_envelope_id() {
        let f = MessageTracker::presented("env-42", ID);
        assert_eq!(f.id, "env-42");
        assert_eq!(f.typ, "message_presented");
        assert_eq!(f.payload, serde_json::json!({ "messageId": ID }));
    }

    #[test]
    fn presented_with_status_reuses_env_id_and_carries_status() {
        let f = MessageTracker::presented_with_status("env-7", ID, PRESENTED_FAILED);
        assert_eq!(f.id, "env-7");
        assert_eq!(f.typ, "message_presented");
        assert_eq!(f.payload, serde_json::json!({ "messageId": ID, "status": "failed" }));
        // The success reply keeps no status key (omitempty on the Go side).
        assert!(MessageTracker::presented("e", ID).payload.get("status").is_none());
        assert_eq!(PRESENTED_ALREADY_RESOLVED, "already_resolved");
    }

    #[test]
    fn suppressed_replies_already_resolved_on_the_show_id() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("warning", true));
        t.on_ack(ID);
        let a = t.on_show(NOW, &show("warning", true));
        let frames = MessageTracker::replies_for("env-1", ID, a);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id, "env-1");
        assert_eq!(frames[0].typ, "message_presented");
        assert_eq!(frames[0].payload["status"], "already_resolved");
    }

    #[test]
    fn rejected_show_replies_failed_without_content() {
        let frames = MessageTracker::replies_for("env-2", ID, ShowAction::Reject("invalid severity".into()));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id, "env-2");
        assert_eq!(frames[0].payload, serde_json::json!({ "messageId": ID, "status": "failed" }));
    }

    #[test]
    fn expired_on_arrival_resolves_the_waiter_then_reports_dismissed() {
        let mut t = MessageTracker::default();
        let m: MessageShow = serde_json::from_str(&show_json("info", false, "2001-01-01T00:00:00Z")).unwrap();
        let a = t.on_show(NOW, &m);
        let frames = MessageTracker::replies_for("env-3", ID, a);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].id, "env-3");
        assert_eq!(frames[0].typ, "message_presented");
        assert_eq!(frames[0].payload["status"], "already_resolved");
        assert_eq!(frames[1].typ, "message_dismissed");
        assert_eq!(frames[1].payload["reason"], "expired");
        assert_ne!(frames[1].id, "env-3");
    }

    #[test]
    fn already_shown_replies_plain_presented() {
        let frames = MessageTracker::replies_for("env-4", ID, ShowAction::AlreadyShown);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].payload.get("status").is_none());
    }

    #[test]
    fn show_arm_replies_failed_when_the_window_cannot_be_built() {
        let client = include_str!("client.rs").split("\nmod tests {").next().unwrap();
        let arm = client.find("\"message_show\" =>").expect("arm");
        let end = client[arm..].find("\"message_retract\" =>").map(|i| i + arm).expect("end");
        let a = &client[arm..end];
        assert!(a.contains("on_show_failed"));
        assert!(a.contains("PRESENTED_FAILED"));
        assert!(a.contains("replies_for"));
    }

    #[test]
    fn ack_and_dismissed_frames_have_fresh_ids_and_contract_payloads() {
        let mut t = MessageTracker::default();
        assert!(matches!(t.on_show(NOW, &show("info", true)), ShowAction::Show { .. }));
        let ack = t.on_ack(ID).expect("ack");
        assert_eq!(ack.typ, "message_ack");
        assert_eq!(ack.payload, serde_json::json!({ "messageId": ID }));
        assert_ne!(ack.id, ID);

        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("info", false));
        let d = t.on_closed(ID).expect("dismissed");
        assert_eq!(d.typ, "message_dismissed");
        assert_eq!(d.payload, serde_json::json!({ "messageId": ID, "reason": "user" }));

        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("info", false));
        let e1 = t.expire_due(NOW + 3_600_001).pop().unwrap().1;
        assert_eq!(e1.typ, "message_dismissed");
        assert_eq!(e1.payload, serde_json::json!({ "messageId": ID, "reason": "expired" }));
        assert_ne!(e1.id, d.id);
        assert_ne!(e1.id, ack.id);
    }

    #[test]
    fn ack_is_sent_at_most_once() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("warning", true));
        assert!(t.on_ack(ID).is_some());
        assert!(t.on_ack(ID).is_none());
        // The window closing after the ack must not add a dismissed frame.
        assert!(t.on_closed(ID).is_none());
    }

    #[test]
    fn duplicate_show_builds_no_second_card() {
        let mut t = MessageTracker::default();
        assert!(matches!(t.on_show(NOW, &show("info", false)), ShowAction::Show { .. }));
        assert_eq!(t.on_show(NOW, &show("info", false)), ShowAction::AlreadyShown);
    }

    #[test]
    fn resolved_message_is_never_reshown() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("warning", true));
        t.on_ack(ID);
        assert_eq!(t.on_show(NOW, &show("warning", true)), ShowAction::Suppressed);
    }

    #[test]
    fn retract_closes_without_sending_anything() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("info", false));
        assert!(t.on_retract(ID));
        assert!(t.on_closed(ID).is_none());
        assert!(!t.on_retract(ID));
        assert!(!t.is_active(ID));
    }

    #[test]
    fn expired_on_arrival_is_not_shown() {
        let mut t = MessageTracker::default();
        let m: MessageShow = serde_json::from_str(&show_json("info", false, "2001-01-01T00:00:00Z")).unwrap();
        match t.on_show(NOW, &m) {
            ShowAction::Reply(f) => {
                assert_eq!(f.typ, "message_dismissed");
                assert_eq!(f.payload["reason"], "expired");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(!t.is_active(ID));
    }

    #[test]
    fn expiry_fires_once_when_due() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("info", false));
        assert!(t.expire_due(NOW + 1000).is_empty());
        let due = t.expire_due(NOW + 3_600_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].0, ID);
        assert!(t.expire_due(NOW + 9_000_000).is_empty());
        assert!(t.on_ack(ID).is_none());
    }

    #[test]
    fn invalid_payloads_are_rejected() {
        let mut t = MessageTracker::default();
        let mut m = show("info", false);
        m.severity = "urgent".into();
        assert!(matches!(t.on_show(NOW, &m), ShowAction::Reject(_)));
        let mut m = show("info", false);
        m.message_id = "../etc".into();
        assert!(matches!(t.on_show(NOW, &m), ShowAction::Reject(_)));
        let mut m = show("info", false);
        m.message_id = String::new();
        assert!(matches!(t.on_show(NOW, &m), ShowAction::Reject(_)));
        let mut m = show("info", false);
        m.expires_at = "tomorrow".into();
        assert!(matches!(t.on_show(NOW, &m), ShowAction::Reject(_)));
    }

    #[test]
    fn oversize_content_is_flagged_plain_and_bad_accent_dropped() {
        let mut t = MessageTracker::default();
        let mut m = show("info", false);
        m.body = "x".repeat(BODY_MAX + 1);
        m.branding.accent = Some("url(javascript:1)".into());
        match t.on_show(NOW, &m) {
            ShowAction::Show { view, .. } => {
                assert!(view.plain);
                assert_eq!(view.branding.accent, None);
            }
            other => panic!("unexpected {other:?}"),
        }
        let mut t = MessageTracker::default();
        let mut m = show("info", false);
        m.title = "t".repeat(TITLE_MAX + 1);
        match t.on_show(NOW, &m) {
            ShowAction::Show { view, .. } => assert!(view.plain),
            other => panic!("unexpected {other:?}"),
        }
        let mut t = MessageTracker::default();
        match t.on_show(NOW, &show("info", false)) {
            ShowAction::Show { view, .. } => {
                assert!(!view.plain);
                assert_eq!(view.branding.accent.as_deref(), Some("#336699"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    fn plan_for(sev: &str, ack: bool, now: i64, t: &mut MessageTracker, id: &str) -> CardPlan {
        let mut m = show(sev, ack);
        m.message_id = id.into();
        match t.on_show(now, &m) {
            ShowAction::Show { plan, .. } => plan,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn info_is_never_topmost_or_focused() {
        let mut t = MessageTracker::default();
        assert_eq!(plan_for("info", false, NOW, &mut t, "a"), CardPlan { always_on_top: false, focused: false });
    }

    #[test]
    fn warning_and_requires_ack_are_topmost_without_focus() {
        let mut t = MessageTracker::default();
        assert_eq!(plan_for("warning", false, NOW, &mut t, "a"), CardPlan { always_on_top: true, focused: false });
        assert_eq!(plan_for("info", true, NOW, &mut t, "b"), CardPlan { always_on_top: true, focused: false });
    }

    #[test]
    fn critical_takes_focus_at_most_once_per_five_minutes() {
        let mut t = MessageTracker::default();
        assert_eq!(plan_for("critical", false, NOW, &mut t, "a"), CardPlan { always_on_top: true, focused: true });
        // Still topmost, but no focus inside the window.
        assert_eq!(plan_for("critical", false, NOW + 60_000, &mut t, "b"), CardPlan { always_on_top: true, focused: false });
        // Non-critical cards neither take nor consume the grant.
        assert!(!plan_for("warning", true, NOW + 61_000, &mut t, "c").focused);
        assert!(plan_for("critical", false, NOW + FOCUS_INTERVAL_MS + 1, &mut t, "d").focused);
    }

    #[test]
    fn focus_limiter_boundaries() {
        let mut l = FocusLimiter::default();
        assert!(l.try_take(1_000));
        assert!(!l.try_take(1_000 + FOCUS_INTERVAL_MS - 1));
        assert!(l.try_take(1_000 + FOCUS_INTERVAL_MS));
    }

    #[test]
    fn clear_forgets_active_cards_but_keeps_the_focus_limit() {
        let mut t = MessageTracker::default();
        plan_for("critical", false, NOW, &mut t, "a");
        assert_eq!(t.clear(), vec!["a".to_string()]);
        assert!(!t.is_active("a"));
        assert!(!plan_for("critical", false, NOW + 1000, &mut t, "b").focused);
    }

    #[test]
    fn view_serialises_camel_case() {
        let mut t = MessageTracker::default();
        t.on_show(NOW, &show("warning", true));
        let v = serde_json::to_value(t.view(ID).unwrap()).unwrap();
        assert_eq!(v["messageId"], ID);
        assert_eq!(v["requiresAck"], true);
        assert_eq!(v["branding"]["companyName"], "Acme IT");
        assert_eq!(v["plain"], false);
    }

    #[test]
    fn window_label_and_url_are_keyed_by_message_id() {
        assert_eq!(window_label("abc"), "message-abc");
        assert_eq!(window_url("abc"), "index.html#message/abc");
        assert!(label_matches("message-abc", "abc"));
        assert!(!label_matches("main", "abc"));
    }

    #[test]
    fn bridge_forwards_events_only_while_a_session_is_live() {
        let b = MessageBridge::default();
        assert!(!b.submit(MsgEvent::Ack(ID.into())));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(b.submit(MsgEvent::Ack(ID.into())));
        assert_eq!(rx.try_recv().unwrap(), MsgEvent::Ack(ID.into()));
        b.clear_sender();
        assert!(!b.submit(MsgEvent::Closed(ID.into())));
    }

    #[test]
    fn ack_without_a_live_session_is_an_error_and_sends_nothing() {
        let b = MessageBridge::default();
        let err = b.submit_ack(ID).unwrap_err();
        assert!(!err.is_empty());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        b.set_sender(tx);
        assert!(b.submit_ack(ID).is_ok());
        assert_eq!(rx.try_recv().unwrap(), MsgEvent::Ack(ID.into()));
    }

    #[test]
    fn message_ack_command_only_closes_after_a_successful_submit() {
        let lib = include_str!("../lib.rs");
        let start = lib.find("fn message_ack(").expect("message_ack");
        let end = lib[start..].find("\n}\n").map(|i| i + start).expect("end");
        let body = &lib[start..end];
        let submit = body.find("submit_ack").expect("uses submit_ack");
        let close = body.find("window.close()").expect("closes");
        assert!(body.contains("?"), "submit error must propagate");
        assert!(submit < close);
    }

    // #8138 start-hidden: a message builds only its own card window, from the
    // `message_show` arm; nothing on that path reaches the main window.
    #[test]
    fn message_show_never_touches_the_main_window() {
        let prod_of = |s: &'static str| s.split("\nmod tests {").next().unwrap();
        let client = prod_of(include_str!("client.rs"));
        let desktop = prod_of(include_str!("desktop.rs"));
        let me = prod_of(include_str!("message.rs"));

        let arm = client.find("\"message_show\" =>").expect("message_show arm");
        let next = client[arm..].find("\"message_retract\" =>").map(|i| i + arm).expect("retract arm");
        let show_arm = &client[arm..next];
        assert!(show_arm.contains("show_message_window"));
        assert!(!show_arm.contains("\"main\""));
        assert!(!show_arm.contains("show_window"));

        let start = desktop.find("pub fn show_message_window").expect("show_message_window");
        let end = desktop[start..].find("\n}\n").map(|i| i + start).expect("fn end");
        let body = &desktop[start..end];
        assert!(!body.contains("\"main\""));
        assert!(!body.contains("show_window"));
        assert!(body.contains("WebviewWindowBuilder::new"));

        assert!(!me.contains("\"main\""));
    }
}
