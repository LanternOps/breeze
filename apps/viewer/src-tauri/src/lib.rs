use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const MAX_DEEP_LINK_BYTES: usize = 4096;
const MAX_SESSION_WINDOWS: usize = 16;
const MAX_ID_PARAM_BYTES: usize = 128;
const MAX_CODE_PARAM_BYTES: usize = 512;
const MAX_API_PARAM_BYTES: usize = 2048;

/// Register this app bundle with macOS Launch Services so the `breeze://`
/// URL scheme always resolves to the current install location (not a stale
/// DMG mount path). This is a no-op on non-macOS platforms.
#[cfg(target_os = "macos")]
fn register_url_scheme() {
    if let Ok(exe) = std::env::current_exe() {
        // Walk up from .app/Contents/MacOS/binary → .app
        if let Some(app_bundle) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            match std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister")
                .arg("-f")
                .arg(app_bundle)
                .output()
            {
                Ok(output) => {
                    if !output.status.success() {
                        eprintln!("lsregister failed with status: {}", output.status);
                    }
                }
                Err(err) => {
                    eprintln!("Failed to run lsregister: {}", err);
                }
            }
        }
    }
}

/// Per-window pending deep link URLs. Key = window label, value = deep link URL.
struct DeepLinkState(Mutex<HashMap<String, String>>);

/// Metadata for an active remote desktop session.
#[derive(Clone, serde::Serialize)]
struct SessionEntry {
    window_label: String,
    hostname: Option<String>,
}

/// Maps session_id → SessionEntry for active sessions.
/// Used to detect duplicate deep links and focus the existing window.
struct SessionMap(Mutex<HashMap<String, SessionEntry>>);

/// Maps device_id → window_label for active sessions.
/// Used to focus an existing window when the same device is connected again.
struct DeviceMap(Mutex<HashMap<String, String>>);

/// Monotonic counter for unique window labels.
struct WindowCounter(Mutex<u32>);

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("Recovering from poisoned mutex: {}", name);
            poisoned.into_inner()
        }
    }
}

fn is_localhost(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

fn validate_api_url(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > MAX_API_PARAM_BYTES {
        return Err("api parameter is missing or too large".to_string());
    }

    let api = Url::parse(raw).map_err(|_| "api parameter is not a valid URL".to_string())?;
    match api.scheme() {
        "https" => Ok(()),
        "http" if api.host_str().is_some_and(is_localhost) => Ok(()),
        _ => Err("api parameter must use https, except localhost development URLs".to_string()),
    }
}

fn require_param(parsed: &Url, name: &str, max_bytes: usize) -> Result<String, String> {
    let value = parsed
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| format!("missing {name} parameter"))?;
    if value.is_empty() || value.len() > max_bytes {
        return Err(format!("{name} parameter is empty or too large"));
    }
    Ok(value)
}

fn parse_breeze_deep_link(url: &str) -> Result<Url, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_DEEP_LINK_BYTES {
        return Err("deep link is empty or too large".to_string());
    }

    let normalized = if let Some(rest) = trimmed.strip_prefix("breeze://") {
        format!("https://breeze/{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("breeze:") {
        format!("https://breeze/{rest}")
    } else {
        return Err("deep link must use the breeze scheme".to_string());
    };

    let parsed = Url::parse(&normalized).map_err(|_| "deep link is not a valid URL".to_string())?;
    if parsed.host_str() != Some("breeze") {
        return Err("deep link host is invalid".to_string());
    }
    Ok(parsed)
}

fn validate_deep_link(url: &str) -> Result<String, String> {
    let parsed = parse_breeze_deep_link(url)?;
    let path = parsed.path().trim_matches('/');

    match path {
        "" | "connect" => {
            require_param(&parsed, "session", MAX_ID_PARAM_BYTES)?;
            require_param(&parsed, "code", MAX_CODE_PARAM_BYTES)?;
            let api = require_param(&parsed, "api", MAX_API_PARAM_BYTES)?;
            validate_api_url(&api)?;
        }
        "vnc" => {
            require_param(&parsed, "tunnel", MAX_ID_PARAM_BYTES)?;
            require_param(&parsed, "device", MAX_ID_PARAM_BYTES)?;
            require_param(&parsed, "code", MAX_CODE_PARAM_BYTES)?;
            let api = require_param(&parsed, "api", MAX_API_PARAM_BYTES)?;
            validate_api_url(&api)?;
        }
        _ => return Err("deep link path is not supported".to_string()),
    }

    Ok(url.trim().to_string())
}

/// Pick the first `breeze:`-scheme argument out of a process argv.
///
/// Used by the single-instance handler: when a second viewer launch forwards its
/// argv to the running instance, this locates the deep link (if any). Returns an
/// owned copy so the caller can move it across the thread hop that defers window
/// creation off the (possibly main-thread) single-instance callback (issue #1409).
fn first_deep_link_arg(argv: &[String]) -> Option<String> {
    argv.iter().find(|arg| arg.starts_with("breeze:")).cloned()
}

fn active_session_window_count(app: &tauri::AppHandle) -> usize {
    let counter = app.state::<WindowCounter>();
    let n = *lock_or_recover(&counter.0, "window_counter");
    (1..=n)
        .filter(|i| {
            let label = format!("session-{}", i);
            app.get_webview_window(&label).is_some()
        })
        .count()
}

/// Extract the `session=` query parameter from a breeze:// deep link URL.
fn extract_session_id(url: &str) -> Option<String> {
    let query_start = match url.find('?') {
        Some(i) => i,
        None => {
            eprintln!("Deep link missing query string");
            return None;
        }
    };
    let query = &url[query_start + 1..];
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("session=") {
            let end = value.find('&').unwrap_or(value.len());
            let id = &value[..end];
            if !id.is_empty() {
                return Some(id.to_string());
            }
            eprintln!("Deep link has empty session parameter");
            return None;
        }
    }
    eprintln!("Deep link missing session parameter");
    None
}

/// Extract the `device=` query parameter from a breeze:// deep link URL.
fn extract_device_id(url: &str) -> Option<String> {
    let query_start = url.find('?')?;
    let query = &url[query_start + 1..];
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("device=") {
            let end = value.find('&').unwrap_or(value.len());
            let id = &value[..end];
            if !id.is_empty() {
                return Some(id.to_string());
            }
            return None;
        }
    }
    None
}

/// Called by the frontend to poll for a pending deep link URL.
/// Returns the URL for the calling window without consuming it (retries safe).
#[tauri::command]
fn get_pending_deep_link(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DeepLinkState>,
) -> Option<String> {
    let map = lock_or_recover(&state.0, "deep_link_state");
    map.get(window.label()).cloned()
}

/// Called by the frontend to clear the pending URL after it has been applied.
#[tauri::command]
fn clear_pending_deep_link(window: tauri::WebviewWindow, state: tauri::State<'_, DeepLinkState>) {
    let mut map = lock_or_recover(&state.0, "deep_link_state");
    map.remove(window.label());
}

/// Called by the frontend when a DesktopViewer connects (session active).
/// `session_id` is the remote session UUID so we can detect duplicate deep links.
#[tauri::command]
fn register_session(
    window: tauri::WebviewWindow,
    session_id: String,
    state: tauri::State<'_, SessionMap>,
) {
    let mut map = lock_or_recover(&state.0, "session_map");
    map.insert(
        session_id,
        SessionEntry {
            window_label: window.label().to_string(),
            hostname: None,
        },
    );
}

/// Called by the frontend on disconnect (session no longer active).
#[tauri::command]
fn unregister_session(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, SessionMap>,
    devices: tauri::State<'_, DeviceMap>,
) {
    let mut session_map = lock_or_recover(&sessions.0, "session_map");
    session_map.retain(|_, entry| entry.window_label != window.label());
    let mut device_map = lock_or_recover(&devices.0, "device_map");
    device_map.retain(|_, label| label != window.label());
}

/// Called by DesktopViewer when the device id is known.
/// Maps device_id → calling window so duplicate connects to the same device focus it.
#[tauri::command]
fn register_device(
    window: tauri::WebviewWindow,
    device_id: String,
    state: tauri::State<'_, DeviceMap>,
) {
    let mut map = lock_or_recover(&state.0, "device_map");
    map.insert(device_id, window.label().to_string());
}

/// Called by DesktopViewer when the remote hostname is learned.
/// Updates the SessionMap entry and sets the native window title.
#[tauri::command]
fn update_session_hostname(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    hostname: String,
    state: tauri::State<'_, SessionMap>,
) {
    // Update the window title from Rust (more reliable than JS setTitle)
    if let Some(win) = app.get_webview_window(window.label()) {
        let title = format!("{} — Breeze Viewer", hostname);
        if let Err(err) = win.set_title(&title) {
            eprintln!("Failed to set window title to '{}': {}", title, err);
        }
    }
    let mut map = lock_or_recover(&state.0, "session_map");
    for entry in map.values_mut() {
        if entry.window_label == window.label() {
            entry.hostname = Some(hostname);
            return;
        }
    }
}

/// Focus the highest-numbered session window, or do nothing if none exist.
fn focus_any_session_window(app: &tauri::AppHandle) {
    let counter = app.state::<WindowCounter>();
    let n = *lock_or_recover(&counter.0, "window_counter");
    for i in (1..=n).rev() {
        let label = format!("session-{}", i);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_focus();
            return;
        }
    }
}

/// Route an incoming deep link URL to the appropriate window.
///
/// - If the session is already active in a window, focus that window.
/// - Otherwise, create a new session window for it.
fn route_deep_link(app: &tauri::AppHandle, url: String) {
    let url = match validate_deep_link(&url) {
        Ok(url) => url,
        Err(err) => {
            eprintln!("Rejected invalid deep link: {}", err);
            focus_any_session_window(app);
            return;
        }
    };

    // Check device-id dedup first: if a window is already viewing this device,
    // focus it and discard the new deep link entirely.
    // Clone the label and drop the lock BEFORE calling set_focus(); on macOS
    // set_focus pumps the AppKit run loop and can re-enter Tauri command
    // handlers that also need this lock.
    if let Some(device_id) = extract_device_id(&url) {
        let existing_label = {
            let devices = app.state::<DeviceMap>();
            let map = lock_or_recover(&devices.0, "device_map");
            map.get(&device_id).cloned()
        }; // lock released here
        if let Some(label) = existing_label {
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(err) = window.set_focus() {
                    eprintln!("Failed to focus existing device window {}: {}", label, err);
                }
                return;
            }
        }
    }

    // Fallback: dedup by session id (covers older web builds and edge cases).
    if let Some(session_id) = extract_session_id(&url) {
        let existing_label = {
            let sessions = app.state::<SessionMap>();
            let map = lock_or_recover(&sessions.0, "session_map");
            map.get(&session_id).map(|e| e.window_label.clone())
        }; // lock released here
        if let Some(label) = existing_label {
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(err) = window.set_focus() {
                    eprintln!("Failed to focus existing session window {}: {}", label, err);
                }
            }
            return;
        }
    }

    // No existing window matched — open a new session window.
    create_session_window(app, url);
}

/// Emit a deep-link-received event to a window with retry delays.
/// Spawns a background thread that emits at 500ms and 1500ms to cover
/// slow webview startup. Stops early if the target window is destroyed.
fn emit_with_retry(app: &tauri::AppHandle, label: &str, url: String) {
    let handle = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        for delay_ms in [500, 1500] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            // Stop if the target window no longer exists
            if handle.get_webview_window(&label).is_none() {
                eprintln!("Window {} gone — stopping deep link emission", label);
                return;
            }
            if let Err(err) = handle.emit_to(&label, "deep-link-received", url.clone()) {
                eprintln!("Failed to emit deep-link-received to {}: {}", label, err);
            }
        }
    });
}

/// Create a new WebviewWindow for an independent remote desktop session.
fn create_session_window(app: &tauri::AppHandle, url: String) {
    let url = match validate_deep_link(&url) {
        Ok(url) => url,
        Err(err) => {
            eprintln!("Rejected invalid deep link before window creation: {}", err);
            return;
        }
    };

    if active_session_window_count(app) >= MAX_SESSION_WINDOWS {
        eprintln!(
            "Rejected deep link because session window limit ({}) is reached",
            MAX_SESSION_WINDOWS
        );
        focus_any_session_window(app);
        return;
    }

    let n = {
        let counter = app.state::<WindowCounter>();
        let mut c = lock_or_recover(&counter.0, "window_counter");
        *c += 1;
        *c
    };
    let label = format!("session-{}", n);

    // Store pending deep link for the new window
    if let Some(state) = app.try_state::<DeepLinkState>() {
        let mut links = lock_or_recover(&state.0, "deep_link_state");
        links.insert(label.clone(), url.clone());
    }

    match WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Connecting...")
        .inner_size(1280.0, 800.0)
        .build()
    {
        Ok(_) => {
            emit_with_retry(app, &label, url);
        }
        Err(e) => {
            eprintln!("Failed to create session window: {}", e);
            // Clean up orphaned deep link state
            if let Some(state) = app.try_state::<DeepLinkState>() {
                let mut links = lock_or_recover(&state.0, "deep_link_state");
                links.remove(&label);
            }
        }
    }
}

/// Update lifecycle status broadcast to all windows on the `update-status`
/// event so the frontend can show an indicator (see
/// `src/components/UpdateIndicator.tsx`). Without it, the window vanishing
/// (Windows installer) or restarting (macOS/Linux) reads as a crash.
///
/// `#[serde(tag = "phase")]` produces `{ "phase": "downloading", ... }`, which
/// the TS `UpdateStatus` union in `src/lib/updateStatus.ts` mirrors.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
enum UpdateStatus {
    Available { version: String },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Installing { version: String },
    Restarting { version: String },
    Deferred { version: String },
    Failed { version: String },
}

/// Best-effort broadcast of update status. Emit failures are non-fatal — the
/// update proceeds regardless of whether the UI is listening.
fn emit_update_status(app: &tauri::AppHandle, status: UpdateStatus) {
    if let Err(e) = app.emit("update-status", status) {
        eprintln!("Failed to emit update-status: {}", e);
    }
}

/// Whole-percent download progress, used to throttle UI events to one event
/// per percent. Returns `-1` as a sentinel when the total is unknown or zero
/// (no Content-Length) so the first such call matches the caller's initial
/// `-1` and no spurious `downloading` event is emitted — the banner stays on
/// its indeterminate state instead.
fn download_percent(downloaded: u64, total: Option<u64>) -> i64 {
    match total {
        Some(total) if total > 0 => ((downloaded * 100) / total) as i64,
        _ => -1,
    }
}

/// Check for updates and silently download + install if available.
///
/// Platform behavior after install:
/// - **macOS/Linux**: replaces the app binary on disk while the running process
///   continues in memory. The new version takes effect on next launch.
/// - **Windows**: launches the MSI/NSIS installer and terminates the process.
///   Active remote desktop sessions will be interrupted.
///
/// The 3-second startup delay plus download time means the install typically
/// fires during early session setup, minimising disruption on Windows.
async fn auto_update(app: tauri::AppHandle) {
    // Delay so the initial session connection isn't competing for network
    // bandwidth with the update download. 3s is a rough heuristic to let
    // the WebRTC handshake complete on typical connections.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("Failed to create updater: {}", e);
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return, // already up to date
        Err(e) => {
            eprintln!("Update check failed: {}", e);
            return;
        }
    };

    eprintln!("Update {} available, downloading...", update.version);

    let version = update.version.clone();
    emit_update_status(&app, UpdateStatus::Available { version: version.clone() });

    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut downloaded: u64 = 0;
    // Throttle UI events to whole-percent changes so a fast download doesn't
    // emit thousands of events; stderr logging stays per-chunk for forensics.
    let mut last_emitted_pct: i64 = -1;
    let bytes = match update
        .download(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                if let Some(total) = content_len {
                    eprintln!("Update download: {downloaded}/{total} bytes");
                }
                let pct = download_percent(downloaded, content_len);
                if pct != last_emitted_pct {
                    last_emitted_pct = pct;
                    emit_update_status(
                        &progress_app,
                        UpdateStatus::Downloading {
                            version: progress_version.clone(),
                            downloaded,
                            total: content_len,
                        },
                    );
                }
            },
            || {
                eprintln!("Update download finished");
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("Update download failed: {}", e);
            // Surface the failure so a banner already showing "Downloading…"
            // doesn't stay pinned forever, reintroducing the silent-crash look.
            emit_update_status(&app, UpdateStatus::Failed { version: version.clone() });
            return;
        }
    };

    eprintln!("Update {} downloaded, installing...", update.version);
    // On Windows install() does not return (process exits after launching the
    // installer), so this "Installing…" notice is the last thing the user sees
    // — which is exactly the point: a labelled exit, not a silent crash.
    emit_update_status(&app, UpdateStatus::Installing { version: version.clone() });

    // install() behaviour varies by platform — see doc comment above.
    // On Windows this call does not return (process exits after launching installer).
    if let Err(e) = update.install(bytes) {
        eprintln!("Update install failed: {}", e);
        // On Windows install() doesn't return on success; reaching here means it
        // failed, so clear the pinned "Installing…" banner with a failure notice.
        emit_update_status(&app, UpdateStatus::Failed { version: version.clone() });
        return;
    }

    eprintln!("Update {} installed successfully", update.version);

    // On macOS/Linux, the binary is replaced on disk but the running process
    // continues with the old version in memory. Restart automatically so the
    // user gets the new version without manual intervention.
    // If a remote desktop session is active, skip the restart to avoid
    // interrupting the user — they'll pick up the update on next launch.
    #[cfg(not(target_os = "windows"))]
    {
        let has_active_sessions = app
            .try_state::<SessionMap>()
            .map(|s| {
                let map = lock_or_recover(&s.0, "session_map");
                !map.is_empty()
            })
            .unwrap_or(false);

        if has_active_sessions {
            eprintln!("Active remote session detected — deferring restart to next launch");
            emit_update_status(&app, UpdateStatus::Deferred { version: version.clone() });
        } else {
            eprintln!("No active sessions — restarting to apply update");
            emit_update_status(&app, UpdateStatus::Restarting { version: version.clone() });
            app.restart();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            clear_pending_deep_link,
            register_session,
            unregister_session,
            register_device,
            update_session_hostname,
        ]);

    // Single instance plugin (desktop only) — ensures deep links open in existing
    // process. A second remote session is launched by the OS handing the running
    // viewer a fresh `breeze://` argv, which this callback receives.
    //
    // IMPORTANT: window operations (set_focus, WebviewWindowBuilder::build) MUST be
    // queued to a LATER event-loop tick, never run inside this callback. As of
    // tauri-plugin-single-instance 2.4.2, the Windows path signals via a synchronous
    // SendMessageW(WM_COPYDATA) to the running viewer's main-thread-owned window, so
    // this callback runs INLINE on the main/event-loop thread (see that crate's
    // windows.rs). build() pumps the wry event loop and needs it to return the new
    // window — doing that re-entrantly from inside the WM_COPYDATA dispatch deadlocks
    // the single thread that drives every window, hanging the whole app ("Not
    // Responding" on a second concurrent session — issue #1409).
    //
    // run_on_main_thread does NOT save us here: as of tauri-runtime-wry 2.11.3 it runs
    // the closure INLINE/synchronously when invoked while already on the main thread
    // (it only queues via proxy.send_event when called from another thread). So calling
    // it directly in this callback still re-enters build() synchronously. We must
    // hop off the main thread FIRST — spawning a thread forces run_on_main_thread
    // down its cross-thread (async-queued) path, deferring build() to a clean tick.
    // This mirrors the macOS on_open_url handler (search `on_open_url`, in the
    // .setup() closure below), which already does this.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let handle = app.clone();
            let url = first_deep_link_arg(&argv);
            std::thread::spawn(move || {
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || match url {
                    Some(url) => route_deep_link(&h, url),
                    // No deep link — just activate. Focus most recent session window if any.
                    None => focus_any_session_window(&h),
                });
            });
        }));
    }

    let app = builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            register_url_scheme();

            let initial_url = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .and_then(|urls| urls.first().map(|u| u.to_string()));

            let initial_url =
                initial_url.or_else(|| std::env::args().find(|arg| arg.starts_with("breeze:")));

            app.manage(DeepLinkState(Mutex::new(HashMap::new())));
            app.manage(SessionMap(Mutex::new(HashMap::new())));
            app.manage(DeviceMap(Mutex::new(HashMap::new())));
            app.manage(WindowCounter(Mutex::new(0)));

            // If launched with a deep link, defer session window creation to
            // the first event loop tick (setup runs before the loop starts).
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                let _ = app.handle().run_on_main_thread(move || {
                    create_session_window(&handle, url);
                });
            }

            let app_handle = app.handle().clone();
            // Listen for deep link events when the app is already running.
            // IMPORTANT: on macOS, on_open_url fires on the main thread.
            // run_on_main_thread may execute synchronously when already on
            // the main thread, which means route_deep_link → build() would
            // run while the deep-link plugin still holds its internal lock.
            // build() pumps the AppKit run loop → re-entry → deadlock.
            // Fix: spawn a thread so the closure is always queued async.
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    let url = url.to_string();
                    let h = app_handle.clone();
                    std::thread::spawn(move || {
                        let h2 = h.clone();
                        let _ = h.run_on_main_thread(move || {
                            route_deep_link(&h2, url);
                        });
                    });
                }
            });

            // Fire-and-forget: update failures must never block the app.
            // Errors are logged inside auto_update(); panics are absorbed by the runtime.
            // Skipped in debug builds so `pnpm tauri dev` can't get clobbered by
            // latest.json pointing at an older stable release.
            #[cfg(not(debug_assertions))]
            {
                let update_handle = app.handle().clone();
                let _update_task = tauri::async_runtime::spawn(auto_update(update_handle));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Breeze Viewer");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                if let WindowEvent::Destroyed = event {
                    if let Some(sessions) = app_handle.try_state::<SessionMap>() {
                        let mut map = lock_or_recover(&sessions.0, "session_map");
                        map.retain(|_, entry| entry.window_label != label);
                    }
                    if let Some(devices) = app_handle.try_state::<DeviceMap>() {
                        let mut map = lock_or_recover(&devices.0, "device_map");
                        map.retain(|_, l| l != &label);
                    }
                    if let Some(links) = app_handle.try_state::<DeepLinkState>() {
                        let mut map = lock_or_recover(&links.0, "deep_link_state");
                        map.remove(&label);
                    }

                    // When the last session window closes, exit the app cleanly.
                    // The hidden anchor window serves no purpose on its own.
                    if label.starts_with("session-") {
                        let counter = app_handle.state::<WindowCounter>();
                        let n = *lock_or_recover(&counter.0, "window_counter");
                        let has_remaining = (1..=n).any(|i| {
                            let l = format!("session-{}", i);
                            l != label && app_handle.get_webview_window(&l).is_some()
                        });
                        if !has_remaining {
                            app_handle.exit(0);
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                focus_any_session_window(app_handle);
            }
            // Force a clean exit code on macOS. Without this, the
            // NSApplication terminate sequence can conflict with Rust
            // runtime cleanup (tokio, threads, mutexes) and trigger
            // SIGABRT, which macOS interprets as a crash.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Exit => {
                std::process::exit(0);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_percent_cases() {
        let cases = [
            // (downloaded, total, expected)
            (0, Some(200), 0),
            (50, Some(200), 25),
            (1, Some(3), 33),   // integer floor, matches the throttle's intent
            (2, Some(3), 66),   // floor, not rounded — display rounds separately
            (200, Some(200), 100),
            (210, Some(200), 105), // overshoot is not clamped here; the TS display clamps
            (0, Some(0), -1),      // zero total → sentinel, no divide-by-zero
            (50, None, -1),        // unknown total → sentinel
        ];
        for (downloaded, total, expected) in cases {
            assert_eq!(
                download_percent(downloaded, total),
                expected,
                "download_percent({downloaded}, {total:?})"
            );
        }
    }

    /// Locks the wire shape the TS `UpdateStatus` union in
    /// `src/lib/updateStatus.ts` depends on. If a variant is renamed or a field
    /// changes, this fails — forcing the TS mirror to be updated in lockstep.
    #[test]
    fn update_status_serializes_to_expected_shape() {
        use serde_json::json;
        let v = "1.2.3".to_string();
        let cases = [
            (
                UpdateStatus::Available { version: v.clone() },
                json!({ "phase": "available", "version": "1.2.3" }),
            ),
            (
                UpdateStatus::Downloading {
                    version: v.clone(),
                    downloaded: 50,
                    total: Some(200),
                },
                json!({ "phase": "downloading", "version": "1.2.3", "downloaded": 50, "total": 200 }),
            ),
            (
                UpdateStatus::Downloading {
                    version: v.clone(),
                    downloaded: 50,
                    total: None,
                },
                json!({ "phase": "downloading", "version": "1.2.3", "downloaded": 50, "total": null }),
            ),
            (
                UpdateStatus::Installing { version: v.clone() },
                json!({ "phase": "installing", "version": "1.2.3" }),
            ),
            (
                UpdateStatus::Restarting { version: v.clone() },
                json!({ "phase": "restarting", "version": "1.2.3" }),
            ),
            (
                UpdateStatus::Deferred { version: v.clone() },
                json!({ "phase": "deferred", "version": "1.2.3" }),
            ),
            (
                UpdateStatus::Failed { version: v.clone() },
                json!({ "phase": "failed", "version": "1.2.3" }),
            ),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_value(&status).unwrap(), expected);
        }
    }

    #[test]
    fn first_deep_link_arg_cases() {
        // Typical second-instance launch: argv[0] is the exe path, the deep link follows.
        assert_eq!(
            first_deep_link_arg(&[
                "/Applications/Breeze Viewer.app".to_string(),
                "breeze://connect?session=s&code=c".to_string(),
            ])
            .as_deref(),
            Some("breeze://connect?session=s&code=c")
        );
        // `breeze:` (no slashes) is also a valid scheme prefix.
        assert_eq!(
            first_deep_link_arg(&["breeze:vnc?tunnel=t".to_string()]).as_deref(),
            Some("breeze:vnc?tunnel=t")
        );
        // First match wins when (improbably) more than one is present.
        assert_eq!(
            first_deep_link_arg(&["breeze://a".to_string(), "breeze://b".to_string()]).as_deref(),
            Some("breeze://a")
        );
        // No deep link → None (handler falls back to focusing an existing window).
        assert_eq!(first_deep_link_arg(&["exe".to_string()]), None);
        assert_eq!(first_deep_link_arg(&[]), None);
        // A non-breeze arg that merely contains the substring must not match.
        assert_eq!(
            first_deep_link_arg(&["--url=breeze://x".to_string()]),
            None
        );
        // The colon is part of the prefix: a token starting with "breeze" but
        // not "breeze:" (e.g. the helper binary name) must not match.
        assert_eq!(first_deep_link_arg(&["breeze-helper".to_string()]), None);
        assert_eq!(first_deep_link_arg(&["breezed".to_string()]), None);
        // Scheme match is case-sensitive, intentionally kept in sync with the
        // downstream parser (parse_breeze_deep_link strips "breeze:" case-sensitively).
        // The registered scheme is lowercase, so an upcased variant must not match.
        assert_eq!(first_deep_link_arg(&["BREEZE://a".to_string()]), None);
    }

    #[test]
    fn extract_device_id_cases() {
        let cases = [
            ("breeze://connect?session=s&device=d1", Some("d1")),
            ("breeze://connect?device=d1&session=s", Some("d1")),
            ("breeze://connect?session=s&device=", None),
            ("breeze://connect?session=s", None),
            ("breeze://connect", None),
            ("breeze://connect?session=s&xdevice=d1", None),
        ];
        for (url, expected) in cases {
            assert_eq!(
                extract_device_id(url).as_deref(),
                expected,
                "extract_device_id({url:?})"
            );
        }
    }

    #[test]
    fn validate_deep_link_accepts_supported_desktop_and_vnc_links() {
        assert!(validate_deep_link(
            "breeze://connect?session=s&code=c&api=https%3A%2F%2Fapi.example.com"
        )
        .is_ok());
        assert!(validate_deep_link(
            "breeze:connect?session=s&code=c&api=http%3A%2F%2Flocalhost%3A3000"
        )
        .is_ok());
        assert!(validate_deep_link(
            "breeze://vnc?tunnel=t&device=d&code=c&api=https%3A%2F%2Fapi.example.com"
        )
        .is_ok());
    }

    #[test]
    fn validate_deep_link_rejects_malformed_or_incomplete_links() {
        for url in [
            "https://example.com/connect?session=s&code=c",
            "breeze://settings?session=s&code=c&api=https%3A%2F%2Fapi.example.com",
            "breeze://connect?session=s&api=https%3A%2F%2Fapi.example.com",
            "breeze://vnc?tunnel=t&device=d&api=https%3A%2F%2Fapi.example.com",
            "breeze://connect?session=s&code=c&api=javascript%3Aalert(1)",
            "breeze://connect?session=s&code=c&api=http%3A%2F%2F10.0.0.5",
        ] {
            assert!(
                validate_deep_link(url).is_err(),
                "validate_deep_link({url:?}) should reject"
            );
        }
    }

    #[test]
    fn validate_deep_link_rejects_oversized_parameters() {
        let huge_code = "a".repeat(MAX_CODE_PARAM_BYTES + 1);
        let url = format!(
            "breeze://connect?session=s&code={huge_code}&api=https%3A%2F%2Fapi.example.com"
        );
        assert!(validate_deep_link(&url).is_err());
    }
}
