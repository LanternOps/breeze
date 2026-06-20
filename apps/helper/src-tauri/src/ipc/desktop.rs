//! Desktop consent dialog + session banner: window creation, frontend event
//! emission, and the bridge that carries the user's consent decision from the
//! `submit_consent` Tauri command back to the IPC session loop.
//!
//! The Go agent (`agent/internal/heartbeat/consent_gate.go`) drives this:
//!   - `consent_request` (env id `consent-<sessionId>`, sent via
//!     `SendCommandAndWait`) → we pop up the always-on-top consent window and
//!     wait for the user. The agent expects a `consent_result` response on the
//!     SAME socket with the SAME envelope id; that correlation is done by
//!     `Session.HandleResponse` in `agent/internal/sessionbroker/session.go`
//!     (it routes by `env.ID`). `expectedResponseType("consent_request")` is
//!     `""` (not in the switch), so the response *type* is not validated — but
//!     we still send the canonical `consent_result` type for correctness.
//!   - `banner_show` / `banner_hide` (fire-and-forget `SendNotify`) → we
//!     create / close the small always-on-top session banner window.
//!
//! Tauri types live only in this submodule so the wire-protocol layer
//! (`envelope`, `client`) stays transport-only where it can.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Window label for the consent dialog. The React entry branches on
/// `location.hash === "#consent"` to render `ConsentDialog`.
pub const CONSENT_WINDOW_LABEL: &str = "consent";
/// Window label for the session banner. React renders `SessionBanner` for
/// `location.hash === "#banner"`.
pub const BANNER_WINDOW_LABEL: &str = "session-banner";

/// The `consent_request` payload from the agent. JSON keys mirror Go's
/// `ipc.ConsentRequest` (`agent/internal/ipc/message.go`).
#[derive(Debug, Deserialize)]
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
}

/// The `consent_result` payload sent back to the agent. Matches Go's
/// `ipc.ConsentResult` (`{"decision":"allow"|"deny"}`).
#[derive(Debug, Serialize)]
pub struct ConsentResult {
    pub decision: String,
}

/// The `banner_show` payload from the agent. Mirrors Go's
/// `ipc.BannerShowRequest`.
#[derive(Debug, Deserialize)]
pub struct BannerShowRequest {
    // Present on the wire (the agent keys its banner-show/hide by session), but
    // the helper shows a single banner window so the id isn't needed here.
    #[allow(dead_code)]
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "label", default)]
    pub label: String,
    #[serde(rename = "startedAtUnixMs", default)]
    pub started_at_unix_ms: i64,
}

/// Payload emitted to the consent window's React frontend. Empty agent-supplied
/// strings become `null` so the UI can branch on presence.
#[derive(Debug, Serialize)]
struct ConsentRequestEvent<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    #[serde(rename = "technicianName")]
    technician_name: &'a str,
    #[serde(rename = "technicianEmail")]
    technician_email: Option<&'a str>,
    #[serde(rename = "orgName")]
    org_name: Option<&'a str>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: i64,
    #[serde(rename = "onTimeout")]
    on_timeout: Option<&'a str>,
}

/// Payload emitted to the banner window's React frontend.
#[derive(Debug, Serialize)]
struct BannerShowEvent<'a> {
    label: &'a str,
    #[serde(rename = "startedAt")]
    started_at: i64,
}

fn none_if_empty(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// A consent decision routed from the `submit_consent` Tauri command back to the
/// IPC session loop, which writes the `consent_result` frame over the socket.
#[derive(Debug, Clone)]
pub struct ConsentDecision {
    /// The session this decision answers; the IPC loop maps it to the pending
    /// envelope id `consent-<session_id>`.
    pub session_id: String,
    /// `"allow"` or `"deny"`.
    pub decision: String,
}

/// Bridge held in Tauri managed state. Each live IPC session registers its
/// outbound decision sender here; `submit_consent` looks it up and forwards the
/// user's verdict. A session deregisters on teardown so a stale sender from a
/// dropped connection is never used.
#[derive(Default)]
pub struct ConsentBridge {
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<ConsentDecision>>>,
}

impl ConsentBridge {
    /// Register the active session's decision sender, replacing any previous one
    /// (a reconnect supersedes the old session's bridge).
    pub fn set_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<ConsentDecision>) {
        if let Ok(mut guard) = self.sender.lock() {
            *guard = Some(tx);
        }
    }

    /// Drop the current sender (called when a session ends) so later
    /// `submit_consent` calls fail fast instead of sending into a dead channel.
    pub fn clear_sender(&self) {
        if let Ok(mut guard) = self.sender.lock() {
            *guard = None;
        }
    }

    /// Forward a decision to the live session loop. Returns `false` if there is
    /// no active session (no bridge registered, or the loop's receiver is gone).
    pub fn submit(&self, decision: ConsentDecision) -> bool {
        let guard = match self.sender.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match guard.as_ref() {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }
}

/// Create (or show + refocus) the always-on-top consent window and emit the
/// `consent-request` event the React `ConsentDialog` listens for.
///
/// Window contract (Task 13 React side matches this exactly):
/// `consent` / `index.html#consent`,
/// `inner_size(380,300).center().decorations(false).always_on_top(true)
///  .focused(true).skip_taskbar(true)`.
pub fn show_consent_window(app: &AppHandle, req: &ConsentRequest) {
    if let Some(win) = app.get_webview_window(CONSENT_WINDOW_LABEL) {
        // Already open (e.g. a re-prompt): re-emit and refocus rather than
        // building a duplicate window (Tauri errors on a duplicate label).
        let _ = win.show();
        let _ = win.set_focus();
        emit_consent_request(app, req);
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        CONSENT_WINDOW_LABEL,
        WebviewUrl::App("index.html#consent".into()),
    )
    .title("Remote Session Request")
    .inner_size(380.0, 300.0)
    .center()
    .decorations(false)
    .always_on_top(true)
    .focused(true)
    .skip_taskbar(true)
    .resizable(false);

    match builder.build() {
        Ok(_win) => emit_consent_request(app, req),
        Err(e) => eprintln!("[helper] failed to create consent window: {}", e),
    }
}

fn emit_consent_request(app: &AppHandle, req: &ConsentRequest) {
    let event = ConsentRequestEvent {
        session_id: &req.session_id,
        technician_name: &req.technician_name,
        technician_email: none_if_empty(&req.technician_email),
        org_name: none_if_empty(&req.org_name),
        timeout_ms: req.timeout_ms,
        on_timeout: none_if_empty(&req.on_timeout),
    };
    if let Err(e) = app.emit("consent-request", &event) {
        eprintln!("[helper] failed to emit consent-request: {}", e);
    }
}

/// Close the consent window (after a decision is submitted, or to dismiss it).
pub fn close_consent_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(CONSENT_WINDOW_LABEL) {
        if let Err(e) = win.close() {
            eprintln!("[helper] failed to close consent window: {}", e);
        }
    }
}

/// Create (or show) the small always-on-top, transparent session banner pinned
/// to the top-center of the primary monitor, then emit `banner-show`.
///
/// Window contract: `session-banner` / `index.html#banner`,
/// `inner_size(360,52)`, top-center, `transparent(true).decorations(false)
///  .always_on_top(true).skip_taskbar(true).focused(false)`.
pub fn show_banner_window(app: &AppHandle, req: &BannerShowRequest) {
    if let Some(win) = app.get_webview_window(BANNER_WINDOW_LABEL) {
        let _ = win.show();
        emit_banner_show(app, req);
        return;
    }

    const BANNER_W: f64 = 360.0;
    const BANNER_H: f64 = 52.0;

    let builder = WebviewWindowBuilder::new(
        app,
        BANNER_WINDOW_LABEL,
        WebviewUrl::App("index.html#banner".into()),
    )
    .title("Remote Session Active")
    .inner_size(BANNER_W, BANNER_H)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .resizable(false);

    // `transparent`/`shadow(false)` give the banner its floating pill look.
    // `macos-private-api` is enabled in Cargo.toml + tauri.conf.json so
    // transparency works on macOS too (Helper is self-distributed, not App Store).
    let builder = builder.transparent(true).shadow(false);

    let builder = match primary_top_center(app, BANNER_W, BANNER_H) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    match builder.build() {
        Ok(_win) => emit_banner_show(app, req),
        Err(e) => eprintln!("[helper] failed to create session banner window: {}", e),
    }
}

/// Logical top-center coordinates for a `w`×`h` window on the primary monitor.
/// Returns `None` if the monitor can't be resolved (caller falls back to
/// `.center()`).
fn primary_top_center(app: &AppHandle, w: f64, h: f64) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    // 12px down from the top edge, horizontally centered.
    let x = pos.x + (size.width - w) / 2.0;
    let y = pos.y + 12.0;
    let _ = h; // height not needed for a top-anchored banner.
    Some((x, y))
}

fn emit_banner_show(app: &AppHandle, req: &BannerShowRequest) {
    let event = BannerShowEvent {
        label: &req.label,
        started_at: req.started_at_unix_ms,
    };
    if let Err(e) = app.emit("banner-show", &event) {
        eprintln!("[helper] failed to emit banner-show: {}", e);
    }
}

/// Close the session banner window (on `banner_hide`).
pub fn hide_banner_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(BANNER_WINDOW_LABEL) {
        if let Err(e) = win.close() {
            eprintln!("[helper] failed to close session banner window: {}", e);
        }
    }
}
