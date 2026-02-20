use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

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

/// Maps session_id → window_label for active sessions.
/// Used to detect duplicate deep links and focus the existing window.
struct SessionMap(Mutex<HashMap<String, String>>);

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
    map.insert(session_id, window.label().to_string());
}

/// Called by the frontend on disconnect (session no longer active).
#[tauri::command]
fn unregister_session(window: tauri::WebviewWindow, state: tauri::State<'_, SessionMap>) {
    let mut map = lock_or_recover(&state.0, "session_map");
    // Remove all entries that point to this window
    map.retain(|_, label| label != window.label());
}

/// Route an incoming deep link URL to the appropriate window.
///
/// - If the session is already active in a window, focus that window.
/// - If the main window is idle (no active session), route to it.
/// - Otherwise, create a new window for the session.
fn route_deep_link(app: &tauri::AppHandle, url: String) {
    // Check if this session is already being viewed
    if let Some(session_id) = extract_session_id(&url) {
        let sessions = app.state::<SessionMap>();
        let map = lock_or_recover(&sessions.0, "session_map");
        if let Some(existing_label) = map.get(&session_id) {
            // Session already active — just focus that window
            if let Some(window) = app.get_webview_window(existing_label) {
                if let Err(err) = window.set_focus() {
                    eprintln!(
                        "Failed to focus existing session window {}: {}",
                        existing_label, err
                    );
                }
            }
            return;
        }
    }

    // Check if main window has an active session
    let main_active = {
        let sessions = app.state::<SessionMap>();
        let map = lock_or_recover(&sessions.0, "session_map");
        map.values().any(|label| label == "main")
    };

    if !main_active {
        // Main window is idle — route the deep link there
        if let Some(state) = app.try_state::<DeepLinkState>() {
            let mut links = lock_or_recover(&state.0, "deep_link_state");
            links.insert("main".to_string(), url.clone());
        }
        if let Err(err) = app.emit_to("main", "deep-link-received", url) {
            eprintln!("Failed to emit deep-link-received to main window: {}", err);
        }
        if let Some(window) = app.get_webview_window("main") {
            if let Err(err) = window.set_focus() {
                eprintln!("Failed to focus main window: {}", err);
            }
        }
    } else {
        // Main is busy with another session — open a new window
        create_session_window(app, url);
    }
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
        .title("Breeze Remote Desktop")
        .inner_size(1280.0, 800.0)
        .build()
    {
        Ok(_) => {
            // Emit the deep link to the new window after delays to cover slow webview startup
            let handle = app.clone();
            let label_clone = label;
            let url_clone = url;
            std::thread::spawn(move || {
                for delay_ms in [500, 1500] {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    if let Err(err) =
                        handle.emit_to(&label_clone, "deep-link-received", url_clone.clone())
                    {
                        eprintln!(
                            "Failed to emit deep-link-received to window {}: {}",
                            label_clone, err
                        );
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("Failed to create session window: {}", e);
            // Clean up orphaned deep link state
            if let Some(state) = app.try_state::<DeepLinkState>() {
                let mut links = lock_or_recover(&state.0, "deep_link_state");
                links.remove(&label);
            }
            // Fallback: route to main (will replace active session)
            if let Some(state) = app.try_state::<DeepLinkState>() {
                let mut links = lock_or_recover(&state.0, "deep_link_state");
                links.insert("main".to_string(), url.clone());
            }
            if let Err(err) = app.emit_to("main", "deep-link-received", url) {
                eprintln!(
                    "Failed to emit deep-link-received to main window after fallback: {}",
                    err
                );
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            clear_pending_deep_link,
            register_session,
            unregister_session,
        ]);

    // Single instance plugin (desktop only) — ensures deep links open in existing process
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|arg| arg.starts_with("breeze:")).cloned() {
                route_deep_link(app, url);
            } else if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.set_focus() {
                    eprintln!(
                        "Failed to focus main window on single-instance activate: {}",
                        err
                    );
                }
            }
        }));
    }

    let app = builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            register_url_scheme();

            // Check for deep link on initial launch
            let initial_url = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .and_then(|urls| urls.first().map(|u| u.to_string()));

            // Fallback: check command-line args for deep link URL.
            // On Windows, the protocol handler passes the URL as a CLI argument,
            // which get_current() may not capture in all Tauri versions.
            let initial_url = initial_url.or_else(|| {
                std::env::args().find(|arg| arg.starts_with("breeze:"))
            });

            // Initialize state
            let mut deep_links = HashMap::new();
            if let Some(ref url) = initial_url {
                deep_links.insert("main".to_string(), url.clone());
            }
            app.manage(DeepLinkState(Mutex::new(deep_links)));
            app.manage(SessionMap(Mutex::new(HashMap::new())));
            app.manage(WindowCounter(Mutex::new(0)));

            // Emit the initial URL after delays to cover slow webview startup.
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for delay_ms in [500, 1500] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        if let Err(err) = handle.emit_to("main", "deep-link-received", url.clone())
                        {
                            eprintln!("Failed to emit initial deep-link-received event: {}", err);
                        }
                    }
                });
            }

            // Listen for deep link events when the app is already running.
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    route_deep_link(&app_handle, url.to_string());
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Breeze Viewer");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent { label, event, .. } = event {
            if let WindowEvent::Destroyed = event {
                // Clean up session and deep link state for destroyed windows
                if let Some(sessions) = app_handle.try_state::<SessionMap>() {
                    let mut map = lock_or_recover(&sessions.0, "session_map");
                    map.retain(|_, wl| wl != &label);
                }
                if let Some(links) = app_handle.try_state::<DeepLinkState>() {
                    let mut map = lock_or_recover(&links.0, "deep_link_state");
                    map.remove(&label);
                }
            }
        }
    });
}
