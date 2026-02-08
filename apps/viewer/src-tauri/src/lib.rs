use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

struct DeepLinkState(Mutex<Option<String>>);

#[tauri::command]
fn get_initial_deep_link(state: tauri::State<'_, DeepLinkState>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![get_initial_deep_link]);

    // Single instance plugin (desktop only) — ensures deep links open in existing window
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // On Linux/Windows, deep link URL comes as a command-line argument.
            // On macOS, it arrives via on_open_url instead, so argv may be empty.
            if let Some(url) = argv.get(1) {
                let _ = app.emit("deep-link-received", url.clone());
            }
            // Always focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            // Check for deep link on initial launch
            let initial_url = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .and_then(|urls| urls.first().map(|u| u.to_string()));

            // Store for the get_initial_deep_link command (synchronous path)
            app.manage(DeepLinkState(Mutex::new(initial_url.clone())));

            // Also emit the initial URL as an event after a short delay, giving
            // the webview time to mount and register its event listener. This
            // handles the macOS race where get_current() returns the URL but the
            // frontend hasn't called get_initial_deep_link yet, or vice-versa.
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = handle.emit("deep-link-received", url);
                });
            }

            // Listen for deep link events when the app is already running.
            // On macOS this is the PRIMARY path for receiving URLs (both initial
            // and subsequent), since macOS delivers them via the app delegate.
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    let _ = app_handle.emit("deep-link-received", url.to_string());
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
