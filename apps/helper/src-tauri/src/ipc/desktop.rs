//! Desktop consent dialog + session banner: window creation, frontend event
//! emission, and the bridge that carries the prompt window's events (the
//! prompt is on screen; the user's answer) back to the IPC session loop.
//!
//! The Go agent (`agent/internal/heartbeat/consent_gate.go`) drives this:
//!   - `consent_request` (env id `consent-<sessionId>`) → we pop up the
//!     always-on-top consent window. The exchange itself (presentation
//!     acknowledgement, one terminal result, nonce correlation, refusing a
//!     second prompt) lives in [`super::consent`]; this module only owns the
//!     Tauri side.
//!   - `banner_show` / `banner_hide` (fire-and-forget `SendNotify`) → we
//!     create / close the small always-on-top session banner window.
//!
//! Tauri types live only in this submodule so the wire-protocol layer
//! (`envelope`, `client`, `consent`) stays transport-only where it can.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub use super::consent::{ConsentRequest, UiEvent};

/// Window label for the consent dialog. The React entry branches on
/// `location.hash === "#consent"` to render `ConsentDialog`.
pub const CONSENT_WINDOW_LABEL: &str = "consent";
/// Window label for the session banner. React renders `SessionBanner` for
/// `location.hash === "#banner"`.
pub const BANNER_WINDOW_LABEL: &str = "session-banner";

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
    /// Present for a v2 prompt: the window echoes it when it confirms the
    /// prompt is on screen and when it reports the answer.
    nonce: Option<&'a str>,
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

/// Bridge held in Tauri managed state. Each live IPC session registers its
/// event sender here; the `consent_presented` / `submit_consent` Tauri
/// commands forward the prompt window's events through it. A session
/// deregisters on teardown so a stale sender from a dropped connection is
/// never used. It also holds the request currently on screen, so a window
/// that mounts after the `consent-request` event was emitted can still fetch
/// it (`get_consent_request`) instead of rendering blank.
#[derive(Default)]
pub struct ConsentBridge {
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<UiEvent>>>,
    current: Mutex<Option<serde_json::Value>>,
}

impl ConsentBridge {
    /// Register the active session's event sender, replacing any previous one
    /// (a reconnect supersedes the old session's bridge).
    pub fn set_sender(&self, tx: tokio::sync::mpsc::UnboundedSender<UiEvent>) {
        if let Ok(mut guard) = self.sender.lock() {
            *guard = Some(tx);
        }
    }

    /// Drop the current sender (called when a session ends) so later
    /// commands fail fast instead of sending into a dead channel.
    pub fn clear_sender(&self) {
        if let Ok(mut guard) = self.sender.lock() {
            *guard = None;
        }
        self.set_current(None);
    }

    /// Forward a window event to the live session loop. Returns `false` if
    /// there is no active session (no bridge registered, or the loop's
    /// receiver is gone).
    pub fn submit(&self, event: UiEvent) -> bool {
        let guard = match self.sender.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match guard.as_ref() {
            Some(tx) => tx.send(event).is_ok(),
            None => false,
        }
    }

    /// Record (or clear) the request the consent window should display.
    pub fn set_current(&self, event: Option<serde_json::Value>) {
        if let Ok(mut guard) = self.current.lock() {
            *guard = event;
        }
    }

    /// The request the consent window should display, if any.
    pub fn current(&self) -> Option<serde_json::Value> {
        self.current.lock().ok().and_then(|g| g.clone())
    }
}

/// Create (or show + refocus) the always-on-top consent window and emit the
/// `consent-request` event the React `ConsentDialog` listens for.
///
/// Window contract (Task 13 React side matches this exactly):
/// `consent` / `index.html#consent`,
/// `inner_size(380,300).center().decorations(false).always_on_top(true)
///  .focused(true).skip_taskbar(true)`.
pub fn show_consent_window(
    app: &AppHandle,
    bridge: &ConsentBridge,
    req: &ConsentRequest,
) -> Result<(), String> {
    let event = consent_request_event(req);
    let value = serde_json::to_value(&event).map_err(|e| e.to_string())?;
    // Stored before the window exists so a window that mounts late can pull it.
    bridge.set_current(Some(value));

    if let Some(win) = app.get_webview_window(CONSENT_WINDOW_LABEL) {
        // Already open (e.g. a v1 re-prompt): re-emit and refocus rather than
        // building a duplicate window (Tauri errors on a duplicate label).
        let _ = win.show();
        let _ = win.set_focus();
        return app
            .emit("consent-request", &event)
            .map_err(|e| format!("emit consent-request: {}", e));
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
        Ok(_win) => {
            // Best effort: the window also pulls the request on mount, so a
            // missed event only delays it, never loses it.
            if let Err(e) = app.emit("consent-request", &event) {
                eprintln!("[helper] failed to emit consent-request: {}", e);
            }
            Ok(())
        }
        Err(e) => {
            bridge.set_current(None);
            Err(format!("create consent window: {}", e))
        }
    }
}

fn consent_request_event(req: &ConsentRequest) -> ConsentRequestEvent<'_> {
    ConsentRequestEvent {
        session_id: &req.session_id,
        technician_name: &req.technician_name,
        technician_email: none_if_empty(&req.technician_email),
        org_name: none_if_empty(&req.org_name),
        timeout_ms: req.timeout_ms,
        on_timeout: none_if_empty(&req.on_timeout),
        nonce: if req.is_v2() {
            Some(req.nonce.as_str())
        } else {
            None
        },
    }
}

/// Close the consent window (after a decision is submitted, or to dismiss it).
pub fn close_consent_window(app: &AppHandle) {
    if let Some(bridge) = app.try_state::<std::sync::Arc<ConsentBridge>>() {
        bridge.set_current(None);
    }
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
