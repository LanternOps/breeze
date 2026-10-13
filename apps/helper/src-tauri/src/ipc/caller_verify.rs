//! Caller verification (W02): pending-request bridge between the IPC session
//! loop and the `caller-verify-<id>` prompt window.
//!
//! The Go agent sends `caller_verify_request`; the helper shows a number-
//! matching prompt and answers `caller_verify_response` on the same envelope
//! id with `{choice, helperVersion}`. The helper never reports an approval
//! boolean or a principal; the agent decides what the choice means.
//!
//! START-HIDDEN (#8138): this window is a separate webview that may surface
//! ONLY for an active `caller_verify_request` (see `show_prompt_window`'s single call
//! site in `client.rs`). It never touches the main Assist window.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;

/// Window label prefix; the full label is `caller-verify-<verificationId>`.
pub const WINDOW_LABEL_PREFIX: &str = "caller-verify-";
/// Longest text field we accept from the agent (labels are rendered verbatim).
/// Matches the API (`workstationProtocol.ts`, max 320) and the Go agent, so a
/// request the API accepted is never silently dropped here.
const MAX_TEXT_LEN: usize = 320;

pub fn window_label(verification_id: &str) -> String {
    format!("{WINDOW_LABEL_PREFIX}{verification_id}")
}

pub fn window_url(verification_id: &str) -> String {
    format!("index.html#caller-verify/{verification_id}")
}

/// Whether `label` is exactly the caller-verify window for `verification_id`.
pub fn label_matches(label: &str, verification_id: &str) -> bool {
    label == window_label(verification_id)
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn valid_text(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= MAX_TEXT_LEN
}

/// The `caller_verify_request` payload (camelCase on the wire).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub verification_id: String,
    pub username: String,
    pub technician_name: String,
    pub org_name: String,
    pub action_label: String,
    pub target_label: String,
    pub reverse_code: String,
    pub choices: [String; 3],
    pub timeout_ms: u64,
}

impl Request {
    fn validate(&self) -> Result<(), String> {
        let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
        let c = &self.choices;
        let texts = [
            &self.username,
            &self.technician_name,
            &self.org_name,
            &self.action_label,
            &self.target_label,
        ];
        if !(30_000..=300_000).contains(&self.timeout_ms)
            || !valid_id(&self.verification_id)
            || !digits(&self.reverse_code, 4)
            || c.iter().any(|v| !digits(v, 2))
            || c[0] == c[1]
            || c[0] == c[2]
            || c[1] == c[2]
            || !texts.iter().all(|s| valid_text(s))
        {
            return Err("invalid caller request".into());
        }
        Ok(())
    }
}

/// What the React window hydrates from. `deadline_ms` is unix epoch millis.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub request: Request,
    pub deadline_ms: u64,
}

/// A decision ready to be written to the agent on the original envelope id.
#[derive(Debug)]
pub struct Response {
    pub envelope_id: String,
    pub choice: String,
}

struct Pending {
    envelope_id: String,
    view: View,
    deadline: Instant,
}

#[derive(Default)]
struct State {
    sender: Option<mpsc::UnboundedSender<Response>>,
    pending: HashMap<String, Pending>,
}

#[derive(Default)]
pub struct CallerVerifyBridge {
    state: Mutex<State>,
}

impl CallerVerifyBridge {
    /// The state is a plain map + sender; a panic elsewhere while holding the
    /// lock leaves nothing half-written that matters, so recover instead of
    /// letting a poisoned mutex take down the IPC loop.
    fn locked(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Start a session: drops anything pending from a previous one.
    pub fn connect(&self) -> mpsc::UnboundedReceiver<Response> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut state = self.locked();
        state.pending.clear();
        state.sender = Some(tx);
        rx
    }

    pub fn clear(&self) {
        let mut state = self.locked();
        state.pending.clear();
        state.sender = None;
    }

    /// Validate and register a request. The deadline starts now (Rust-owned).
    pub fn insert(&self, envelope_id: String, request: Request) -> Result<(), String> {
        request.validate()?;
        let mut state = self.locked();
        if state.sender.is_none() || state.pending.contains_key(&request.verification_id) {
            return Err("request unavailable".into());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let view = View {
            deadline_ms: now + request.timeout_ms,
            request,
        };
        state.pending.insert(
            view.request.verification_id.clone(),
            Pending {
                envelope_id,
                view,
                deadline,
            },
        );
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<View> {
        self.state
            .lock()
            .ok()?
            .pending
            .get(id)
            .map(|p| p.view.clone())
    }

    /// Single-use. A choice at/after the deadline becomes `timeout`; `not_me`
    /// is always honoured.
    pub fn submit(&self, id: &str, choice: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let pending = state.pending.get(id).ok_or("request unavailable")?;
        if choice != "not_me"
            && choice != "timeout"
            && !pending.view.request.choices.iter().any(|v| v == choice)
        {
            return Err("invalid choice".into());
        }
        let choice = if choice != "not_me" && Instant::now() >= pending.deadline {
            "timeout"
        } else {
            choice
        };
        let response = Response {
            envelope_id: pending.envelope_id.clone(),
            choice: choice.into(),
        };
        state
            .sender
            .as_ref()
            .ok_or("IPC disconnected")?
            .send(response)
            .map_err(|e| e.to_string())?;
        state.pending.remove(id);
        Ok(())
    }

    /// Answer `timeout` for every request past its deadline; returns their ids
    /// so the caller can close the windows. Polled by the IPC loop.
    pub fn expire_due(&self) -> Vec<String> {
        let mut state = self.locked();
        let now = Instant::now();
        let due: Vec<String> = state
            .pending
            .iter()
            .filter(|(_, p)| now >= p.deadline)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &due {
            if let Some(pending) = state.pending.remove(id) {
                if let Some(sender) = &state.sender {
                    let _ = sender.send(Response {
                        envelope_id: pending.envelope_id,
                        choice: "timeout".into(),
                    });
                }
            }
        }
        due
    }
}

/// Close every `caller-verify-*` window (IPC disconnect).
pub fn close_all_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(WINDOW_LABEL_PREFIX) {
            let _ = window.close();
        }
    }
}

/// Close one prompt window if it is open.
pub fn close_window(app: &tauri::AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window(&window_label(id)) {
        let _ = window.close();
    }
}

/// Show the prompt window for an already-inserted request. The ONLY place a
/// caller-verify window is built (#8138: never at launch or from the tray).
pub(super) fn show_prompt_window(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    WebviewWindowBuilder::new(
        app,
        window_label(id),
        WebviewUrl::App(window_url(id).into()),
    )
    .title("Breeze")
    .inner_size(520.0, 680.0)
    .center()
    .decorations(false)
    .always_on_top(true)
    .focused(true)
    .skip_taskbar(true)
    .resizable(false)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        serde_json::from_str(r#"{"verificationId":"11111111-1111-4111-8111-111111111111","username":"alex","technicianName":"Sam","orgName":"Acme","actionLabel":"reset the password","targetLabel":"alex@example.com","reverseCode":"7319","choices":["42","17","86"],"timeoutMs":30000}"#).unwrap()
    }

    #[test]
    fn correlates_and_submits_once() {
        let bridge = CallerVerifyBridge::default();
        let mut rx = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("original-envelope".into(), req).unwrap();
        assert!(bridge.submit(&id, "99").is_err());
        bridge.submit(&id, "not_me").unwrap();
        let response = rx.try_recv().unwrap();
        assert_eq!(response.envelope_id, "original-envelope");
        assert_eq!(response.choice, "not_me");
        assert!(bridge.submit(&id, "42").is_err());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn valid_choice_is_forwarded() {
        let bridge = CallerVerifyBridge::default();
        let mut rx = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("e".into(), req).unwrap();
        bridge.submit(&id, "17").unwrap();
        assert_eq!(rx.try_recv().unwrap().choice, "17");
    }

    #[test]
    fn disconnect_clears_pending_and_sender() {
        let bridge = CallerVerifyBridge::default();
        let _rx = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("e".into(), req).unwrap();
        bridge.clear();
        assert!(bridge.get(&id).is_none());
        assert!(bridge.submit(&id, "42").is_err());
    }

    #[test]
    fn insert_refused_without_session_and_when_duplicate() {
        let bridge = CallerVerifyBridge::default();
        assert!(bridge.insert("e".into(), request()).is_err());
        let _rx = bridge.connect();
        bridge.insert("e".into(), request()).unwrap();
        assert!(bridge.insert("e2".into(), request()).is_err());
    }

    #[test]
    fn rejects_malformed_requests() {
        let bridge = CallerVerifyBridge::default();
        let _rx = bridge.connect();
        let mut bad: Vec<Request> = Vec::new();
        let mut r = request(); r.timeout_ms = 29_999; bad.push(r);
        let mut r = request(); r.timeout_ms = 300_001; bad.push(r);
        let mut r = request(); r.verification_id = "not-a-uuid".into(); bad.push(r);
        let mut r = request(); r.reverse_code = "731".into(); bad.push(r);
        let mut r = request(); r.reverse_code = "73a9".into(); bad.push(r);
        let mut r = request(); r.choices[1] = "42".into(); bad.push(r);
        let mut r = request(); r.choices[2] = "5".into(); bad.push(r);
        let mut r = request(); r.choices[0] = "4x".into(); bad.push(r);
        let mut r = request(); r.technician_name = String::new(); bad.push(r);
        let mut r = request(); r.action_label = "x".repeat(1000); bad.push(r);
        for r in bad {
            assert!(bridge.insert("e".into(), r).is_err());
        }
        assert!(bridge.get("11111111-1111-4111-8111-111111111111").is_none());
    }

    #[test]
    fn wire_payload_must_have_exactly_three_choices() {
        let two = r#"{"verificationId":"11111111-1111-4111-8111-111111111111","username":"a","technicianName":"S","orgName":"A","actionLabel":"x","targetLabel":"y","reverseCode":"7319","choices":["42","17"],"timeoutMs":30000}"#;
        assert!(serde_json::from_str::<Request>(two).is_err());
    }

    #[test]
    fn deadline_passed_turns_choice_into_timeout_but_not_me_is_honoured() {
        let bridge = CallerVerifyBridge::default();
        let mut rx = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("e".into(), req.clone()).unwrap();
        bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline = Instant::now();
        bridge.submit(&id, "42").unwrap();
        assert_eq!(rx.try_recv().unwrap().choice, "timeout");

        bridge.insert("e".into(), req).unwrap();
        bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline = Instant::now();
        bridge.submit(&id, "not_me").unwrap();
        assert_eq!(rx.try_recv().unwrap().choice, "not_me");
    }

    #[test]
    fn deadline_is_owned_by_current_session() {
        let bridge = CallerVerifyBridge::default();
        let mut old = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("old".into(), req.clone()).unwrap();
        bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline = Instant::now();
        bridge.clear();
        let mut current = bridge.connect();
        bridge.insert("new".into(), req).unwrap();
        assert!(bridge.expire_due().is_empty());
        assert!(current.try_recv().is_err());
        assert!(old.try_recv().is_err());
        bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline = Instant::now();
        assert_eq!(bridge.expire_due(), vec![id]);
        let r = current.try_recv().unwrap();
        assert_eq!(r.choice, "timeout");
        assert_eq!(r.envelope_id, "new");
    }

    #[test]
    fn view_serialises_camel_case_with_deadline_ms() {
        let bridge = CallerVerifyBridge::default();
        let _rx = bridge.connect();
        let req = request();
        let id = req.verification_id.clone();
        bridge.insert("e".into(), req).unwrap();
        let v = serde_json::to_value(bridge.get(&id).unwrap()).unwrap();
        assert_eq!(v["request"]["reverseCode"], "7319");
        assert_eq!(v["request"]["choices"], serde_json::json!(["42", "17", "86"]));
        assert!(v["deadlineMs"].as_u64().unwrap() > 1_600_000_000_000);
    }

    #[test]
    fn window_label_and_url_are_keyed_by_verification_id() {
        assert_eq!(window_label("abc"), "caller-verify-abc");
        assert_eq!(window_url("abc"), "index.html#caller-verify/abc");
        assert!(label_matches("caller-verify-abc", "abc"));
        assert!(!label_matches("main", "abc"));
        assert!(!label_matches("caller-verify-abd", "abc"));
    }

    // #8138 start-hidden: the caller-verify window may be constructed only by
    // this module, and `show_prompt_window` may be called only from the
    // `caller_verify_request` arm of the IPC loop -- never at launch, from the
    // tray, or from the main-window show path.
    #[test]
    fn caller_verify_window_surfaces_only_for_an_active_request() {
        // Production code only: every file keeps its tests in `mod tests {`.
        let prod_of = |s: &'static str| s.split("\nmod tests {").next().unwrap();
        let client = prod_of(include_str!("client.rs"));
        let lib = prod_of(include_str!("../lib.rs"));
        let shell = prod_of(include_str!("../app_shell.rs"));
        let desktop = prod_of(include_str!("desktop.rs"));
        let me = include_str!("caller_verify.rs");

        // Only this module builds the window.
        let prod = prod_of(me);
        assert_eq!(prod.matches("WebviewWindowBuilder::new").count(), 1);
        for (name, src) in [("lib.rs", lib), ("app_shell.rs", shell), ("desktop.rs", desktop), ("client.rs", client)] {
            assert!(!src.contains("caller_verify::show_prompt_window") || name == "client.rs", "{name} calls show_prompt_window");
        }
        assert!(!lib.contains("caller_verify::show_prompt_window"));
        assert!(!shell.contains("caller_verify"));
        assert!(!desktop.contains("caller_verify"));

        // client.rs: exactly one call, inside the request arm.
        assert_eq!(client.matches("caller_verify::show_prompt_window").count(), 1);
        let arm = client.find("\"caller_verify_request\" =>").expect("request arm");
        let call = client.find("caller_verify::show_prompt_window").unwrap();
        let next_arm = client[arm..].find("\"banner_show\" =>").map(|i| i + arm).unwrap();
        assert!(arm < call && call < next_arm, "show_prompt_window outside the request arm");

        // Never touches the main window.
        assert!(!prod.contains("get_webview_window(\"main\")"));
    }
}
