//! Consent prompt exchange with the Go agent — the protocol state, kept free of
//! Tauri types so it is unit-tested without a window.
//!
//! Version 2 (`CONSENT_PROTOCOL_VERSION`, advertised at auth as
//! `consentProtocolVersion`) mirrors `agent/internal/ipc/message.go`:
//!   1. the agent sends `consent_request` {…, protocolVersion: 2, nonce};
//!   2. once the prompt is rendered and visible, we send `consent_presented`
//!      {nonce} on the request's envelope id — the countdown starts then;
//!   3. we send exactly one terminal `consent_result` {nonce, outcome, detail?}
//!      where outcome is `granted` | `denied` | `presented_expired` |
//!      `unavailable`. An expired countdown is never turned into a decision.
//!
//! A request without a nonce comes from an older (v1) agent: the reply is the
//! legacy `{"decision":"allow"|"deny"}` on a click and nothing on expiry,
//! exactly as before.

use serde::{Deserialize, Serialize};

/// The consent exchange this helper speaks.
pub const CONSENT_PROTOCOL_VERSION: i32 = 2;

pub const OUTCOME_GRANTED: &str = "granted";
pub const OUTCOME_DENIED: &str = "denied";
pub const OUTCOME_PRESENTED_EXPIRED: &str = "presented_expired";
pub const OUTCOME_UNAVAILABLE: &str = "unavailable";

/// `unavailable` detail: another prompt is already on screen.
pub const DETAIL_PROMPT_IN_PROGRESS: &str = "prompt_in_progress";
/// `unavailable` detail: the prompt window could not be created or reached.
pub const DETAIL_WINDOW_FAILED: &str = "window_failed";

/// The `consent_request` payload. JSON keys mirror Go's `ipc.ConsentRequest`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ConsentRequest {
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "technicianName", default)]
    pub technician_name: String,
    #[serde(rename = "technicianEmail", default)]
    pub technician_email: String,
    #[serde(rename = "orgName", default)]
    pub org_name: String,
    #[serde(rename = "timeoutMs", default)]
    pub timeout_ms: i64,
    #[serde(rename = "onTimeout", default)]
    pub on_timeout: String,
    #[serde(rename = "protocolVersion", default)]
    pub protocol_version: i32,
    #[serde(default)]
    pub nonce: String,
}

impl ConsentRequest {
    /// True when the agent asked for the v2 exchange.
    pub fn is_v2(&self) -> bool {
        self.protocol_version >= CONSENT_PROTOCOL_VERSION && !self.nonce.is_empty()
    }
}

/// A frame to write back to the agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Outbound {
    /// Envelope id: always the id of the `consent_request` being answered.
    pub id: String,
    /// `consent_presented` or `consent_result`.
    pub typ: &'static str,
    pub payload: serde_json::Value,
}

/// What the IPC loop should do with an incoming `consent_request`.
#[derive(Debug, PartialEq)]
pub enum RequestAction {
    /// Show (or re-show) the prompt window for this request.
    Show,
    /// Do not show anything; send this reply now.
    Reply(Outbound),
}

/// An event from the prompt window (via the Tauri commands).
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// The prompt for `nonce` is rendered and visible.
    Presented { nonce: String },
    /// The user answered, or the countdown ran out. `decision` is `allow`,
    /// `deny` or `expired`. `nonce` is `None` for a v1 prompt.
    Decision {
        session_id: String,
        nonce: Option<String>,
        decision: String,
    },
}

#[derive(Debug, Clone)]
struct Active {
    env_id: String,
    session_id: String,
    nonce: String,
    v2: bool,
    presented: bool,
}

/// Tracks the one prompt on screen. Owned by the IPC session loop.
#[derive(Debug, Default)]
pub struct ConsentTracker {
    active: Option<Active>,
}

fn result_frame(env_id: &str, nonce: &str, outcome: &str, detail: Option<&str>) -> Outbound {
    let mut payload = serde_json::json!({ "nonce": nonce, "outcome": outcome });
    if let Some(d) = detail {
        payload["detail"] = serde_json::Value::String(d.to_string());
    }
    Outbound {
        id: env_id.to_string(),
        typ: "consent_result",
        payload,
    }
}

impl ConsentTracker {
    /// Whether a prompt is being tracked (tests).
    #[cfg(test)]
    pub fn has_active(&self) -> bool {
        self.active.is_some()
    }

    /// Handle a `consent_request` with envelope id `env_id`.
    ///
    /// A v2 request while another v2 prompt is on screen is refused
    /// (`unavailable` / `prompt_in_progress`) instead of replacing it — its
    /// answer would otherwise be attributed to the wrong request. A v2 prompt
    /// that never confirmed it was shown is stale (the agent only asks again
    /// once it has given up on it) and is replaced. A v1 request keeps the
    /// legacy behavior (it replaces whatever is showing).
    pub fn on_request(&mut self, env_id: &str, req: &ConsentRequest) -> RequestAction {
        if req.is_v2() {
            if let Some(active) = &self.active {
                if active.v2 && active.presented && active.nonce != req.nonce {
                    return RequestAction::Reply(result_frame(
                        env_id,
                        &req.nonce,
                        OUTCOME_UNAVAILABLE,
                        Some(DETAIL_PROMPT_IN_PROGRESS),
                    ));
                }
            }
        }
        self.active = Some(Active {
            env_id: env_id.to_string(),
            session_id: req.session_id.clone(),
            nonce: req.nonce.clone(),
            v2: req.is_v2(),
            presented: false,
        });
        RequestAction::Show
    }

    /// The prompt window could not be created or reached. A v2 prompt is
    /// answered `unavailable`; a v1 prompt stays silent (legacy).
    pub fn on_show_failed(&mut self) -> Option<Outbound> {
        let active = self.active.take()?;
        if !active.v2 {
            return None;
        }
        Some(result_frame(
            &active.env_id,
            &active.nonce,
            OUTCOME_UNAVAILABLE,
            Some(DETAIL_WINDOW_FAILED),
        ))
    }

    /// An event from the prompt window. Returns the frame to send, if any.
    /// Events for a prompt that is no longer active (stale nonce, cancelled)
    /// are dropped.
    pub fn on_ui_event(&mut self, ev: UiEvent) -> Option<Outbound> {
        match ev {
            UiEvent::Presented { nonce } => {
                let active = self.active.as_mut()?;
                if !active.v2 || active.nonce != nonce || active.presented {
                    return None;
                }
                active.presented = true;
                Some(Outbound {
                    id: active.env_id.clone(),
                    typ: "consent_presented",
                    payload: serde_json::json!({ "nonce": nonce }),
                })
            }
            UiEvent::Decision {
                session_id,
                nonce,
                decision,
            } => {
                let active = self.active.as_ref()?;
                if active.v2 {
                    if nonce.as_deref() != Some(active.nonce.as_str()) {
                        return None;
                    }
                    let outcome = match decision.as_str() {
                        "allow" => OUTCOME_GRANTED,
                        "deny" => OUTCOME_DENIED,
                        // Only a prompt confirmed on screen can expire; the
                        // agent refuses a presented_expired it never saw
                        // acknowledged, so say what actually happened.
                        "expired" if active.presented => OUTCOME_PRESENTED_EXPIRED,
                        "expired" => OUTCOME_UNAVAILABLE,
                        // Anything unexpected is not a grant.
                        _ => OUTCOME_DENIED,
                    };
                    let frame = result_frame(&active.env_id, &active.nonce, outcome, None);
                    self.active = None;
                    return Some(frame);
                }
                // v1: a click is answered with the legacy decision on
                // `consent-<sessionId>`; an expiry stays silent.
                if nonce.is_some() || active.session_id != session_id {
                    return None;
                }
                let env_id = active.env_id.clone();
                self.active = None;
                match decision.as_str() {
                    "expired" => None,
                    d => Some(Outbound {
                        id: env_id,
                        typ: "consent_result",
                        payload: serde_json::json!({
                            "decision": if d == "allow" { "allow" } else { "deny" }
                        }),
                    }),
                }
            }
        }
    }

    /// The agent no longer waits for `nonce` (`consent_cancel`). Returns true
    /// when the window should be closed.
    pub fn on_cancel(&mut self, nonce: &str) -> bool {
        match &self.active {
            Some(active) if active.v2 && active.nonce == nonce => {
                self.active = None;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v2(session: &str, nonce: &str) -> ConsentRequest {
        ConsentRequest {
            session_id: session.to_string(),
            technician_name: "Tech".to_string(),
            technician_email: String::new(),
            org_name: String::new(),
            timeout_ms: 30000,
            on_timeout: "proceed".to_string(),
            protocol_version: 2,
            nonce: nonce.to_string(),
        }
    }

    fn v1(session: &str) -> ConsentRequest {
        ConsentRequest {
            protocol_version: 0,
            nonce: String::new(),
            ..v2(session, "")
        }
    }

    fn decision(session: &str, nonce: Option<&str>, d: &str) -> UiEvent {
        UiEvent::Decision {
            session_id: session.to_string(),
            nonce: nonce.map(|n| n.to_string()),
            decision: d.to_string(),
        }
    }

    #[test]
    fn parses_the_agent_request_with_and_without_v2_fields() {
        let req: ConsentRequest = serde_json::from_str(
            r#"{"sessionId":"s","technicianName":"T","timeoutMs":30000,"onTimeout":"block","protocolVersion":2,"nonce":"abc"}"#,
        )
        .unwrap();
        assert!(req.is_v2());
        let old: ConsentRequest = serde_json::from_str(
            r#"{"sessionId":"s","technicianName":"T","timeoutMs":1,"onTimeout":"block"}"#,
        )
        .unwrap();
        assert!(!old.is_v2());
        // A version number without a nonce cannot be correlated: legacy.
        let no_nonce: ConsentRequest =
            serde_json::from_str(r#"{"sessionId":"s","protocolVersion":2}"#).unwrap();
        assert!(!no_nonce.is_v2());
    }

    #[test]
    fn v2_acknowledges_presentation_then_reports_the_click() {
        let mut t = ConsentTracker::default();
        assert_eq!(
            t.on_request("consent-s1", &v2("s1", "n1")),
            RequestAction::Show
        );

        let ack = t
            .on_ui_event(UiEvent::Presented { nonce: "n1".into() })
            .unwrap();
        assert_eq!(ack.id, "consent-s1");
        assert_eq!(ack.typ, "consent_presented");
        assert_eq!(ack.payload, serde_json::json!({"nonce": "n1"}));
        // A second ack for the same prompt is not re-sent.
        assert!(t
            .on_ui_event(UiEvent::Presented { nonce: "n1".into() })
            .is_none());

        let res = t.on_ui_event(decision("s1", Some("n1"), "allow")).unwrap();
        assert_eq!(res.typ, "consent_result");
        assert_eq!(
            res.payload,
            serde_json::json!({"nonce": "n1", "outcome": "granted"})
        );
        assert!(!t.has_active());
    }

    #[test]
    fn v2_expired_countdown_is_reported_as_expired_never_as_a_decision() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v2("s1", "n1"));
        t.on_ui_event(UiEvent::Presented { nonce: "n1".into() });
        let res = t
            .on_ui_event(decision("s1", Some("n1"), "expired"))
            .unwrap();
        assert_eq!(
            res.payload,
            serde_json::json!({"nonce": "n1", "outcome": "presented_expired"})
        );
    }

    #[test]
    fn v2_expiry_without_a_presentation_ack_is_unavailable() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v2("s1", "n1"));
        let res = t
            .on_ui_event(decision("s1", Some("n1"), "expired"))
            .unwrap();
        assert_eq!(res.payload["outcome"], "unavailable");
    }

    #[test]
    fn v2_deny_and_unexpected_values_are_denials() {
        for d in ["deny", "maybe", ""] {
            let mut t = ConsentTracker::default();
            t.on_request("consent-s1", &v2("s1", "n1"));
            let res = t.on_ui_event(decision("s1", Some("n1"), d)).unwrap();
            assert_eq!(res.payload["outcome"], "denied", "decision {d:?}");
        }
    }

    #[test]
    fn v2_replaces_a_prompt_that_never_came_up() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-a", &v2("a", "na"));
        assert_eq!(
            t.on_request("consent-b", &v2("b", "nb")),
            RequestAction::Show
        );
        // The stale prompt's answer goes nowhere; the new one is live.
        assert!(t.on_ui_event(decision("a", Some("na"), "allow")).is_none());
        assert!(t
            .on_ui_event(UiEvent::Presented { nonce: "nb".into() })
            .is_some());
    }

    #[test]
    fn v2_refuses_a_second_prompt_instead_of_replacing_the_first() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-a", &v2("a", "na"));
        t.on_ui_event(UiEvent::Presented { nonce: "na".into() });
        match t.on_request("consent-b", &v2("b", "nb")) {
            RequestAction::Reply(frame) => {
                assert_eq!(frame.id, "consent-b");
                assert_eq!(
                    frame.payload,
                    serde_json::json!({"nonce": "nb", "outcome": "unavailable", "detail": "prompt_in_progress"})
                );
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        // The first prompt is still the one being answered.
        let res = t.on_ui_event(decision("a", Some("na"), "deny")).unwrap();
        assert_eq!(res.id, "consent-a");
    }

    #[test]
    fn stale_or_foreign_answers_are_dropped() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v2("s1", "n1"));
        assert!(t
            .on_ui_event(UiEvent::Presented {
                nonce: "other".into()
            })
            .is_none());
        assert!(t
            .on_ui_event(decision("s1", Some("other"), "allow"))
            .is_none());
        assert!(t.on_ui_event(decision("s1", None, "allow")).is_none());
        assert!(t.has_active());
    }

    #[test]
    fn window_failure_answers_v2_unavailable_and_v1_nothing() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v2("s1", "n1"));
        let res = t.on_show_failed().unwrap();
        assert_eq!(
            res.payload,
            serde_json::json!({"nonce": "n1", "outcome": "unavailable", "detail": "window_failed"})
        );

        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v1("s1"));
        assert!(t.on_show_failed().is_none());
        assert!(!t.has_active());
    }

    #[test]
    fn cancel_closes_only_the_matching_v2_prompt() {
        let mut t = ConsentTracker::default();
        t.on_request("consent-s1", &v2("s1", "n1"));
        assert!(!t.on_cancel("other"));
        assert!(t.on_cancel("n1"));
        // A late answer after the cancel goes nowhere.
        assert!(t.on_ui_event(decision("s1", Some("n1"), "allow")).is_none());
    }

    #[test]
    fn v1_keeps_the_legacy_exchange() {
        let mut t = ConsentTracker::default();
        assert_eq!(t.on_request("consent-s1", &v1("s1")), RequestAction::Show);
        // No presentation ack in v1.
        assert!(t
            .on_ui_event(UiEvent::Presented {
                nonce: String::new()
            })
            .is_none());
        let res = t.on_ui_event(decision("s1", None, "allow")).unwrap();
        assert_eq!(res.id, "consent-s1");
        assert_eq!(res.payload, serde_json::json!({"decision": "allow"}));

        // v1 expiry stays silent (the old agent applies its own timeout).
        t.on_request("consent-s2", &v1("s2"));
        assert!(t.on_ui_event(decision("s2", None, "expired")).is_none());

        // v1 replaces a showing v1 prompt (legacy behavior).
        t.on_request("consent-s3", &v1("s3"));
        assert_eq!(t.on_request("consent-s4", &v1("s4")), RequestAction::Show);
        let res = t.on_ui_event(decision("s4", None, "deny")).unwrap();
        assert_eq!(res.id, "consent-s4");
        assert_eq!(res.payload, serde_json::json!({"decision": "deny"}));
    }
}
