use std::sync::Mutex;
use tauri::{Emitter, Manager};
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

/// Stores the most recent deep link URL. Unlike the old take()-based approach,
/// this uses clone() so the URL survives multiple poll attempts from the frontend.
struct DeepLinkState(Mutex<Option<String>>);

/// Called by the frontend to poll for a pending deep link URL.
/// Returns the URL without consuming it (clone, not take) so retries work.
#[tauri::command]
fn get_pending_deep_link(state: tauri::State<'_, DeepLinkState>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Called by the frontend to clear the pending URL after it has been applied.
#[tauri::command]
fn clear_pending_deep_link(state: tauri::State<'_, DeepLinkState>) {
    *state.0.lock().unwrap() = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![get_pending_deep_link, clear_pending_deep_link]);

    // Single instance plugin (desktop only) — ensures deep links open in existing window
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // On Linux/Windows, deep link URL comes as a command-line argument.
            // On macOS, it arrives via on_open_url instead, so argv may be empty.
            if let Some(url) = argv.iter().find(|arg| arg.starts_with("breeze:")).cloned() {
                // Store in state so the frontend poll picks it up
                if let Some(state) = app.try_state::<DeepLinkState>() {
                    *state.0.lock().unwrap() = Some(url.clone());
                }
                let _ = app.emit("deep-link-received", url);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
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

            // Store for the frontend poll command
            app.manage(DeepLinkState(Mutex::new(initial_url.clone())));

            // Emit the initial URL after delays to cover slow webview startup.
            // The frontend deduplicates, so multiple emits of the same URL are safe.
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Emit at 500ms and 1500ms to cover both fast and slow startups
                    for delay_ms in [500, 1500] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        let _ = handle.emit("deep-link-received", url.clone());
                    }
                });
            }

            // Listen for deep link events when the app is already running.
            // On macOS this is the PRIMARY path for receiving URLs.
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    let url_str = url.to_string();
                    // Store in state so frontend poll picks it up even if event is missed
                    if let Some(state) = app_handle.try_state::<DeepLinkState>() {
                        *state.0.lock().unwrap() = Some(url_str.clone());
                    }
                    let _ = app_handle.emit("deep-link-received", url_str);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.set_focus();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Breeze Viewer");
}
