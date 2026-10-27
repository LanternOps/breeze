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

// ---------------------------------------------------------------------------
// Prompt cards (#10190): placement
// ---------------------------------------------------------------------------

/// A rectangle in logical pixels (a monitor's work area).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A window size in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// A window position (top-left) in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Gap between a card and the work-area edge, and between stacked cards.
pub const CARD_MARGIN: f64 = 16.0;
pub const CARD_GAP: f64 = 12.0;

/// Where card `index` (0 = bottom) goes: bottom-right of the work area,
/// stacked upward, at most [`super::prompt::MAX_VISIBLE_CARDS`] high, and
/// always clamped inside the work area (a small screen or a large card never
/// puts any part of a card off screen or under the taskbar).
pub fn place_card(work_area: Rect, size: Size, index: usize) -> Position {
    let index = index.min(super::prompt::MAX_VISIBLE_CARDS - 1) as f64;
    let x = work_area.x + work_area.width - size.width - CARD_MARGIN;
    let y = work_area.y + work_area.height - CARD_MARGIN - size.height - index * (size.height + CARD_GAP);
    // The top-left bound wins when the card is larger than the work area.
    let max_x = (work_area.x + work_area.width - size.width).max(work_area.x);
    let max_y = (work_area.y + work_area.height - size.height).max(work_area.y);
    Position { x: x.clamp(work_area.x, max_x), y: y.clamp(work_area.y, max_y) }
}

// ---------------------------------------------------------------------------
// Prompt cards (#10190): windows
// ---------------------------------------------------------------------------

/// The event a card window listens for: a [`super::prompt::VersionNotice`]
/// only. The card then pulls its own view (`get_prompt_view`, label-checked).
pub const PROMPT_UPDATED_EVENT: &str = "prompt-updated";
/// The event the Notifications tab listens for: a version notice only. The
/// main window then pulls the list (`get_notification_list`, main only).
pub const PROMPT_LIST_EVENT: &str = "prompt-list-updated";

/// The ONLY place a prompt event is emitted (#10190 W04), and its payload is a
/// [`super::prompt::VersionNotice`] by type. Tauri 2.12 delivers every emit,
/// `emit_to` included, to a JS `listen()` registered without a target (an
/// `Any` listener) in ANY window, so targeting cannot keep a payload out of
/// chat, consent, caller-verify or message windows; a version number reveals
/// nothing. Pinned by `lib.rs` `prompt_events_carry_only_version_notices`.
fn emit_version_notice(app: &AppHandle, label: &str, event: &'static str, notice: super::prompt::VersionNotice) {
    if let Err(e) = app.emit_to(label, event, notice) {
        eprintln!("[helper] failed to emit {}: {}", event, e);
    }
}

const PROMPT_CARD: Size = Size { width: 400.0, height: 300.0 };
/// A `modal` prompt (W06: remote consent): a little larger, centred.
const PROMPT_MODAL: Size = Size { width: 420.0, height: 340.0 };
/// The `indicator` (W06: the remote-session pill), collapsed and expanded.
/// Same width, so growing downward keeps it centred at the top of the screen.
pub const PROMPT_PILL: Size = Size { width: 360.0, height: 56.0 };
pub const PROMPT_PILL_EXPANDED: Size = Size { width: 360.0, height: 340.0 };

/// The window size a prompt's presentation starts at.
pub fn prompt_window_size(presentation: super::prompt::Presentation) -> Size {
    use super::prompt::Presentation;
    match presentation {
        Presentation::Modal => PROMPT_MODAL,
        Presentation::Indicator => PROMPT_PILL,
        Presentation::Card | Presentation::ListOnly => PROMPT_CARD,
    }
}

/// Where a prompt window goes inside `work_area`: a `card` bottom-right in its
/// stack slot, a `modal` centred, the `indicator` centred 12 px below the top
/// edge (where the legacy session banner sat). Always inside the work area.
pub fn place_prompt(work_area: Rect, presentation: super::prompt::Presentation, slot: usize) -> Position {
    use super::prompt::Presentation;
    let size = prompt_window_size(presentation);
    let clamp = |x: f64, y: f64| {
        let max_x = (work_area.x + work_area.width - size.width).max(work_area.x);
        let max_y = (work_area.y + work_area.height - size.height).max(work_area.y);
        Position { x: x.clamp(work_area.x, max_x), y: y.clamp(work_area.y, max_y) }
    };
    let center_x = work_area.x + (work_area.width - size.width) / 2.0;
    match presentation {
        Presentation::Modal => clamp(center_x, work_area.y + (work_area.height - size.height) / 2.0),
        Presentation::Indicator => clamp(center_x, work_area.y + 12.0),
        Presentation::Card | Presentation::ListOnly => place_card(work_area, size, slot),
    }
}

/// Create the card window for a prompt: its own small `prompt-<hash>` webview,
/// NEVER the main Assist window (#8138). Always on top, out of the taskbar and
/// non-activating; `plan.focused` (rate limited, eligible kinds only) is the
/// only way it takes keyboard focus. A `card` is placed bottom-right of the
/// work area of the monitor holding the cursor, stacked by `plan.slot`; a
/// `modal` is centred and the `indicator` pill sits at the top (W06).
///
/// The close box / Alt+F4 is the same as Esc: the safe action on a pending
/// decision (the card stays up), "hide" otherwise.
pub fn show_prompt_window(app: &AppHandle, plan: &super::prompt::WindowPlan) -> Result<(), String> {
    use super::prompt::{ActionVia, DismissEffect, PromptBridge};

    if app.get_webview_window(&plan.label).is_some() {
        // The tracker never plans a second window for one label.
        return Err("a prompt card with this label is already open".into());
    }
    let size = prompt_window_size(plan.presentation);
    let builder = WebviewWindowBuilder::new(app, plan.label.clone(), WebviewUrl::App(plan.url.clone().into()))
        .title("Notification from your IT provider")
        .inner_size(size.width, size.height)
        .decorations(false)
        .always_on_top(true)
        .focused(plan.focused)
        .skip_taskbar(true)
        .resizable(false);
    let builder = match cursor_work_area(app) {
        Some(area) => {
            let p = place_prompt(area, plan.presentation, plan.slot);
            builder.position(p.x, p.y)
        }
        None => builder.center(),
    };
    let win = builder.build().map_err(|e| format!("create prompt window: {}", e))?;

    let handle = app.clone();
    let id = plan.prompt_id.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let Some(bridge) = handle.try_state::<std::sync::Arc<PromptBridge>>() else { return };
            match bridge.dismiss(super::client::now_unix_ms(), &id, ActionVia::Click) {
                // A decision keeps its card while its safe action is on its way.
                Ok(DismissEffect::ActionSent) => api.prevent_close(),
                // ...or when it could not be sent: the bridge recorded why on the
                // prompt (`last_error`, shown on the card) and the person retries.
                Err(e) => {
                    eprintln!("[helper] prompt card close box could not act (promptId={id}): {e}");
                    api.prevent_close();
                }
                Ok(DismissEffect::Hidden) | Ok(DismissEffect::Nothing) => {}
            }
            publish_prompt_state(&handle, Some(&id));
        }
        tauri::WindowEvent::Destroyed => {
            // Reported only when the tracker did not close it itself.
            if let Some(bridge) = handle.try_state::<std::sync::Arc<PromptBridge>>() {
                bridge.window_gone(&id);
            }
            publish_prompt_state(&handle, None);
        }
        _ => {}
    });
    Ok(())
}

/// Grow or shrink the remote-session pill's own window (W06, P7: expanding is
/// renderer-local, never a wire action). The width stays, so the pill stays
/// centred at the top. Never shows, focuses or moves any other window.
pub fn size_prompt_pill(window: &tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    let size = if expanded { PROMPT_PILL_EXPANDED } else { PROMPT_PILL };
    window
        .set_size(tauri::LogicalSize::new(size.width, size.height))
        .map_err(|e| format!("resize the session pill: {e}"))
}

/// Take a prompt's card down (close, refusal, hide, session end). `destroy`
/// rather than `close`, so it is not mistaken for the person's close box.
pub fn close_prompt_window(app: &AppHandle, prompt_id: &str) {
    if let Some(win) = app.get_webview_window(&super::prompt::window_label(prompt_id)) {
        if let Err(e) = win.destroy() {
            eprintln!("[helper] failed to close prompt window: {}", e);
        }
    }
}

/// Tell a prompt's card that its view changed (no-op when it has no card).
/// The card pulls the view itself through `get_prompt_view`.
pub fn emit_prompt_view_notice(app: &AppHandle, prompt_id: &str, notice: super::prompt::VersionNotice) {
    let label = super::prompt::window_label(prompt_id);
    if app.get_webview_window(&label).is_none() {
        return;
    }
    emit_version_notice(app, &label, PROMPT_UPDATED_EVENT, notice);
}

/// Tell the main window's Notifications tab that the list changed; it pulls
/// the list through `get_notification_list`. An event only: this never
/// shows, focuses or un-minimises the main window.
pub fn emit_notification_list_notice(app: &AppHandle, notice: super::prompt::VersionNotice) {
    emit_version_notice(app, "main", PROMPT_LIST_EVENT, notice);
}

/// The list notice for the app's bridges (a default bridge stands in for one
/// that is not managed, which only happens before setup).
fn list_notice(app: &AppHandle) -> super::prompt::VersionNotice {
    let prompts = app.try_state::<std::sync::Arc<super::prompt::PromptBridge>>();
    let messages = app.try_state::<std::sync::Arc<super::message::MessageBridge>>();
    let p = prompts.map(|b| b.tracker().version()).unwrap_or(0);
    let m = messages.map(|b| b.tracker().version()).unwrap_or(0);
    super::prompt::VersionNotice { version: p.saturating_add(m) }
}

/// After any prompt change: notify that prompt's card (if open), the
/// Notifications tab and the tray entry. Never shows or focuses a window.
pub fn publish_prompt_state(app: &AppHandle, prompt_id: Option<&str>) {
    let Some(bridge) = app.try_state::<std::sync::Arc<super::prompt::PromptBridge>>() else { return };
    // Snapshot first; the tracker lock is never held across a window call.
    let notice = bridge.tracker().change_notice();
    if let Some(id) = prompt_id {
        emit_prompt_view_notice(app, id, notice);
    }
    emit_notification_list_notice(app, list_notice(app));
    crate::refresh_tray_menu(app);
}

/// After an endpoint message card came or went (#10190 W04: message cards
/// are in the one notification list): notify the Notifications tab and
/// relabel the tray. Never shows or focuses a window.
pub fn publish_notification_list(app: &AppHandle) {
    emit_notification_list_notice(app, list_notice(app));
    crate::refresh_tray_menu(app);
}

/// The one window that may read the notification list (#10190 W04): `main`,
/// whose Notifications tab shows it. Cards, chat, consent, caller-verify and
/// banner windows may not. Lives here, not in prompt.rs (#8138 guard).
pub fn list_window_allowed(label: &str) -> bool {
    label == "main"
}

/// Windows that may read the MSP identity (#10190 W03): the main window
/// (Notifications tab locale) and prompt cards. Message, chat, consent and
/// other windows may not. Lives here, not in prompt.rs, which never names the
/// main window (#8138 guard).
pub fn identity_window_allowed(label: &str) -> bool {
    label == "main" || label.starts_with(super::prompt::WINDOW_LABEL_PREFIX)
}

/// The event the identity header listens for (main window and prompt cards).
pub const PROMPT_IDENTITY_EVENT: &str = "prompt-identity-updated";

/// After a branding sync (or the session that carried it ending): tell the
/// windows allowed to read the identity that it changed, and relabel the tray
/// in the synced language. An event only: never shows or focuses a window.
///
/// The event is a version notice, never the identity. Tauri delivers every
/// emit (emit_filter and emit_to alike) to a JS listener registered without a
/// target in ANY window, so targeting alone cannot keep the identity out of
/// other windows; the identity is read through `get_prompt_identity`, which
/// checks the caller's label.
pub fn publish_prompt_identity(app: &AppHandle) {
    let Some(bridge) = app.try_state::<std::sync::Arc<super::prompt::PromptBridge>>() else { return };
    let notice = bridge.tracker().identity_notice();
    for label in app.webview_windows().into_keys().filter(|l| identity_window_allowed(l)) {
        emit_version_notice(app, &label, PROMPT_IDENTITY_EVENT, notice);
    }
    crate::refresh_tray_menu(app);
}

/// The logical work area of the monitor holding the cursor (else the primary).
fn cursor_work_area(app: &AppHandle) -> Option<Rect> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let pos = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    Some(Rect { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// Create the small dedicated card window for an endpoint message (#8293).
/// NEVER the main Assist window (#8138): the card is its own
/// `message-<messageId>` webview, so a user who has not opened Assist does not
/// get a large app window.
///
/// Window contract: `message-<id>` / `index.html#message/<id>`, 400x300,
/// bottom-right of the primary monitor, undecorated, `skip_taskbar`.
/// `plan.always_on_top` / `plan.focused` come from the surfacing rules
/// (`info` never focuses; `critical` focus is rate limited).
pub fn show_message_window(
    app: &AppHandle,
    plan: &super::message::CardPlan,
    view: &super::message::MessageView,
) -> Result<(), String> {
    use super::message::{window_label, window_url, MessageBridge, MsgEvent};

    let label = window_label(&view.message_id);
    if app.get_webview_window(&label).is_some() {
        // The tracker already de-duplicates; never build a duplicate label.
        return Ok(());
    }

    const CARD_W: f64 = 400.0;
    const CARD_H: f64 = 300.0;
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(window_url(&view.message_id).into()),
    )
    .title("Message from your IT provider")
    .inner_size(CARD_W, CARD_H)
    .decorations(false)
    .always_on_top(plan.always_on_top)
    .focused(plan.focused)
    .skip_taskbar(true)
    .resizable(false);
    let builder = match primary_bottom_right(app, CARD_W, CARD_H) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    let win = builder
        .build()
        .map_err(|e| format!("create message window: {}", e))?;
    // A card the OS closed (Alt+F4) without Acknowledge/Close is a dismissal;
    // the tracker ignores this when the message was already resolved.
    let handle = app.clone();
    let id = view.message_id.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(bridge) = handle.try_state::<std::sync::Arc<MessageBridge>>() {
                bridge.submit(MsgEvent::Closed(id.clone()));
            }
        }
    });
    Ok(())
}

/// Close one message card (ack, retract, expiry).
pub fn close_message_window(app: &AppHandle, message_id: &str) {
    if let Some(win) = app.get_webview_window(&super::message::window_label(message_id)) {
        if let Err(e) = win.close() {
            eprintln!("[helper] failed to close message window: {}", e);
        }
    }
}

/// The event the chat window listens for; carries the full `ChatView`. Sent
/// only to that window's label, never broadcast.
pub const CHAT_UPDATED_EVENT: &str = "chat-updated";

/// What the real chat window for `conversation_id` looks like right now.
pub fn chat_win_state(app: &AppHandle, conversation_id: &str) -> super::chat::WinState {
    match app.get_webview_window(&super::chat::window_label(conversation_id)) {
        Some(win) => super::chat::WinState {
            exists: true,
            visible: win.is_visible().unwrap_or(false),
            minimised: win.is_minimized().unwrap_or(false),
        },
        None => super::chat::WinState { exists: false, visible: false, minimised: false },
    }
}

/// Create the endpoint live chat window (#8743): `chat-<conversationId>` /
/// `index.html#chat/<id>`, its own webview, NEVER the main Assist window and
/// not the AI chat. This is the deliberate "incoming call" interruption, so
/// it takes focus when built. It is called only from the live `chat_open` arm
/// (`user_initiated = false`) and from the tray's "Open chat" item
/// (`user_initiated = true`). An existing window is left exactly as it is
/// unless the user asked for it: nothing automatic may re-raise it.
pub fn show_chat_window(app: &AppHandle, conversation_id: &str, user_initiated: bool) -> Result<(), String> {
    use super::chat::{window_label, window_url};

    let label = window_label(conversation_id);
    if let Some(existing) = app.get_webview_window(&label) {
        if user_initiated {
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
        }
        return Ok(());
    }

    const CHAT_W: f64 = 380.0;
    const CHAT_H: f64 = 520.0;
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(window_url(conversation_id).into()))
        .title("Chat with your IT provider")
        .inner_size(CHAT_W, CHAT_H)
        .min_inner_size(300.0, 360.0)
        .decorations(true)
        .always_on_top(false)
        .focused(true)
        // In the taskbar so a new message can flash it.
        .skip_taskbar(false)
        .resizable(true);
    let builder = match primary_bottom_right(app, CHAT_W, CHAT_H) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    builder.build().map(|_| ()).map_err(|e| format!("create chat window: {}", e))
}

/// Push the current view to the chat window (no-op when it is not open).
pub fn emit_chat_update(app: &AppHandle, view: &super::chat::ChatView) {
    let label = super::chat::window_label(&view.conversation_id);
    if app.get_webview_window(&label).is_none() {
        return;
    }
    if let Err(e) = app.emit_to(label.as_str(), CHAT_UPDATED_EVENT, view) {
        eprintln!("[helper] failed to emit {}: {}", CHAT_UPDATED_EVENT, e);
    }
}

/// Flash the chat window's taskbar button. Attention only: it neither shows
/// nor focuses nor un-minimises the window.
pub fn flash_chat_window(app: &AppHandle, conversation_id: &str) {
    if let Some(win) = app.get_webview_window(&super::chat::window_label(conversation_id)) {
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// Logical bottom-right coordinates for a `w`x`h` window on the primary monitor.
fn primary_bottom_right(app: &AppHandle, w: f64, h: f64) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    // 16px in from the right, clear of a bottom taskbar (~48px).
    Some((pos.x + size.width - w - 16.0, pos.y + size.height - h - 64.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WA: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 };
    const CARD: Size = Size { width: 380.0, height: 260.0 };

    fn inside(wa: Rect, size: Size, p: Position) -> bool {
        p.x >= wa.x
            && p.y >= wa.y
            && p.x + size.width <= wa.x + wa.width + 1e-9
            && p.y + size.height <= wa.y + wa.height + 1e-9
    }

    #[test]
    fn place_card_clamps_to_work_area() {
        // Bottom-right, inset by the margin.
        let p0 = place_card(WA, CARD, 0);
        assert_eq!(p0, Position { x: 1920.0 - 380.0 - CARD_MARGIN, y: 1040.0 - 260.0 - CARD_MARGIN });
        // Stacked upward with a gap.
        let p1 = place_card(WA, CARD, 1);
        assert_eq!(p1.x, p0.x);
        assert_eq!(p1.y, p0.y - 260.0 - CARD_GAP);
        // At most three high: index 3+ stays on the top slot.
        let p2 = place_card(WA, CARD, 2);
        assert_eq!(place_card(WA, CARD, 3), p2);
        assert_eq!(place_card(WA, CARD, 99), p2);
        // A work area that does not start at 0,0 (second monitor, top/left taskbar).
        let wa = Rect { x: -1280.0, y: 40.0, width: 1280.0, height: 984.0 };
        for i in 0..4 {
            assert!(inside(wa, CARD, place_card(wa, CARD, i)), "index {i}");
        }
        assert_eq!(place_card(wa, CARD, 0).x, -1280.0 + 1280.0 - 380.0 - CARD_MARGIN);
        // A short screen: the stack is clamped inside rather than off the top.
        let short = Rect { x: 0.0, y: 0.0, width: 1024.0, height: 600.0 };
        for i in 0..3 {
            assert!(inside(short, CARD, place_card(short, CARD, i)), "index {i}");
        }
        // A card larger than the work area pins to its top-left corner.
        let tiny = Rect { x: 10.0, y: 20.0, width: 300.0, height: 200.0 };
        assert_eq!(place_card(tiny, CARD, 0), Position { x: 10.0, y: 20.0 });
        assert_eq!(place_card(tiny, CARD, 2), Position { x: 10.0, y: 20.0 });
    }

    // #10190 W06: the consent modal is centred and the session pill sits at
    // the top centre; a card keeps its stack place. All inside the work area.
    #[test]
    fn place_prompt_by_presentation() {
        use crate::ipc::prompt::Presentation;
        let wa = Rect { x: -1280.0, y: 40.0, width: 1280.0, height: 984.0 };
        let modal = place_prompt(wa, Presentation::Modal, 2);
        assert_eq!(modal, Position { x: -1280.0 + (1280.0 - PROMPT_MODAL.width) / 2.0, y: 40.0 + (984.0 - PROMPT_MODAL.height) / 2.0 });
        let pill = place_prompt(wa, Presentation::Indicator, 1);
        assert_eq!(pill, Position { x: -1280.0 + (1280.0 - PROMPT_PILL.width) / 2.0, y: 52.0 });
        assert_eq!(place_prompt(wa, Presentation::Card, 1), place_card(wa, PROMPT_CARD, 1));
        for p in [Presentation::Modal, Presentation::Indicator, Presentation::Card] {
            assert!(inside(wa, prompt_window_size(p), place_prompt(wa, p, 0)), "{p:?}");
            let tiny = Rect { x: 10.0, y: 20.0, width: 200.0, height: 40.0 };
            assert_eq!(place_prompt(tiny, p, 0), Position { x: 10.0, y: 20.0 }, "{p:?}");
        }
        // The expanded pill fits below its collapsed top edge on a 768 px screen.
        let small = Rect { x: 0.0, y: 0.0, width: 1024.0, height: 728.0 };
        let top = place_prompt(small, Presentation::Indicator, 0);
        assert!(inside(small, PROMPT_PILL_EXPANDED, top));
    }
}
