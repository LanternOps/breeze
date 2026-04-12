use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;

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
    map.insert(session_id, SessionEntry { window_label: window.label().to_string(), hostname: None });
}

/// Called by the frontend on disconnect (session no longer active).
#[tauri::command]
fn unregister_session(window: tauri::WebviewWindow, state: tauri::State<'_, SessionMap>) {
    let mut map = lock_or_recover(&state.0, "session_map");
    // Remove all entries that point to this window
    map.retain(|_, entry| entry.window_label != window.label());
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
    // Check if this session is already being viewed.
    // Clone the label and drop the lock BEFORE calling set_focus(),
    // which on macOS pumps the AppKit run loop and can re-enter Tauri
    // command handlers that also need the SessionMap lock.
    if let Some(session_id) = extract_session_id(&url) {
        let existing_label = {
            let sessions = app.state::<SessionMap>();
            let map = lock_or_recover(&sessions.0, "session_map");
            map.get(&session_id).map(|e| e.window_label.clone())
        }; // lock released here
        if let Some(label) = existing_label {
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(err) = window.set_focus() {
                    eprintln!(
                        "Failed to focus existing session window {}: {}",
                        label, err
                    );
                }
            }
            return;
        }
    }

    // Always open a new session window immediately.
    // Updates are handled by the background auto_update task at startup.
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
                eprintln!(
                    "Failed to emit deep-link-received to {}: {}",
                    label, err
                );
            }
        }
    });
}

/// Create a new WebviewWindow for an independent remote desktop session.
fn create_session_window(app: &tauri::AppHandle, url: String) {
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

    let mut downloaded: usize = 0;
    let bytes = match update
        .download(
            |chunk_len, content_len| {
                downloaded += chunk_len;
                if let Some(total) = content_len {
                    eprintln!("Update download: {downloaded}/{total} bytes");
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
            return;
        }
    };

    eprintln!("Update {} downloaded, installing...", update.version);

    // install() behaviour varies by platform — see doc comment above.
    // On Windows this call does not return (process exits after launching installer).
    if let Err(e) = update.install(bytes) {
        eprintln!("Update install failed: {}", e);
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
        } else {
            eprintln!("No active sessions — restarting to apply update");
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
            update_session_hostname,
        ]);

    // Single instance plugin (desktop only) — ensures deep links open in existing process.
    // IMPORTANT: Defer all window operations (set_focus, WebviewWindowBuilder::build)
    // via run_on_main_thread so they execute AFTER this callback returns. On macOS,
    // the plugin holds an internal lock during the callback; set_focus/build pump
    // the AppKit run loop, which can re-enter the plugin and deadlock.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|arg| arg.starts_with("breeze:")).cloned() {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    route_deep_link(&handle, url);
                });
            } else {
                // No deep link — just activate. Focus most recent session window if any.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    focus_any_session_window(&handle);
                });
            }
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

            let initial_url = initial_url.or_else(|| {
                std::env::args().find(|arg| arg.starts_with("breeze:"))
            });

            app.manage(DeepLinkState(Mutex::new(HashMap::new())));
            app.manage(SessionMap(Mutex::new(HashMap::new())));
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
            let update_handle = app.handle().clone();
            let _update_task = tauri::async_runtime::spawn(auto_update(update_handle));

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
