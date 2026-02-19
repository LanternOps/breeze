use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindowBuilder, WebviewUrl, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Register this app bundle with macOS Launch Services so the `breeze://`
/// URL scheme always resolves to the current install location (not a stale
/// DMG mount path). This is a no-op on non-macOS platforms.
#[cfg(target_os = "macos")]
fn register_url_scheme() {
    if let Ok(exe) = std::env::current_exe() {
        // Walk up from .app/Contents/MacOS/binary → .app
        if let Some(app_bundle) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            let _ = std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister")
                .arg("-f")
                .arg(app_bundle)
                .output();
        }
    }
}

/// Per-window pending deep link URLs. Key = window label, value = deep link URL.
struct DeepLinkState(Mutex<HashMap<String, String>>);

/// Tracks which windows have active remote sessions.
struct SessionState(Mutex<HashSet<String>>);

/// Monotonic counter for unique window labels.
struct WindowCounter(Mutex<u32>);

/// Called by the frontend to poll for a pending deep link URL.
/// Returns the URL for the calling window without consuming it (retries safe).
#[tauri::command]
fn get_pending_deep_link(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DeepLinkState>,
) -> Option<String> {
    state.0.lock().unwrap().get(window.label()).cloned()
}

/// Called by the frontend to clear the pending URL after it has been applied.
#[tauri::command]
fn clear_pending_deep_link(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DeepLinkState>,
) {
    state.0.lock().unwrap().remove(window.label());
}

/// Called by the frontend when a DesktopViewer mounts (session active).
#[tauri::command]
fn register_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SessionState>,
) {
    state.0.lock().unwrap().insert(window.label().to_string());
}

/// Called by the frontend on disconnect (session no longer active).
#[tauri::command]
fn unregister_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SessionState>,
) {
    state.0.lock().unwrap().remove(window.label());
}

/// Route an incoming deep link URL to the appropriate window.
/// If the main window is idle, route to it. Otherwise, create a new window.
fn route_deep_link(app: &tauri::AppHandle, url: String) {
    let main_active = app
        .state::<SessionState>()
        .0
        .lock()
        .unwrap()
        .contains("main");

    if !main_active {
        // Route to main window (existing behavior)
        if let Some(state) = app.try_state::<DeepLinkState>() {
            state.0.lock().unwrap().insert("main".to_string(), url.clone());
        }
        let _ = app.emit_to("main", "deep-link-received", url);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    } else {
        // Main is busy — create a new session window
        create_session_window(app, url);
    }
}

/// Create a new WebviewWindow for an independent remote desktop session.
fn create_session_window(app: &tauri::AppHandle, url: String) {
    let n = {
        let counter = app.state::<WindowCounter>();
        let mut c = counter.0.lock().unwrap();
        *c += 1;
        *c
    };
    let label = format!("session-{}", n);

    // Store pending deep link for the new window
    if let Some(state) = app.try_state::<DeepLinkState>() {
        state.0.lock().unwrap().insert(label.clone(), url.clone());
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
                    let _ = handle.emit_to(&label_clone, "deep-link-received", url_clone.clone());
                }
            });
        }
        Err(e) => {
            eprintln!("Failed to create session window: {}", e);
            // Clean up orphaned deep link state
            if let Some(state) = app.try_state::<DeepLinkState>() {
                state.0.lock().unwrap().remove(&label);
            }
            // Fallback: route to main window
            if let Some(state) = app.try_state::<DeepLinkState>() {
                state.0.lock().unwrap().insert("main".to_string(), url.clone());
            }
            let _ = app.emit_to("main", "deep-link-received", url);
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
                let _ = window.set_focus();
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

            // Initialize state
            let mut deep_links = HashMap::new();
            if let Some(ref url) = initial_url {
                deep_links.insert("main".to_string(), url.clone());
            }
            app.manage(DeepLinkState(Mutex::new(deep_links)));
            app.manage(SessionState(Mutex::new(HashSet::new())));
            app.manage(WindowCounter(Mutex::new(0)));

            // Emit the initial URL after delays to cover slow webview startup.
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    for delay_ms in [500, 1500] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        let _ = handle.emit_to("main", "deep-link-received", url.clone());
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
                if let Some(sessions) = app_handle.try_state::<SessionState>() {
                    sessions.0.lock().unwrap().remove(&label);
                }
                if let Some(links) = app_handle.try_state::<DeepLinkState>() {
                    links.0.lock().unwrap().remove(&label);
                }
            }
        }
    });
}
