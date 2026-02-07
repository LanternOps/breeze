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
            if let Some(url) = argv.get(1) {
                let _ = app.emit("deep-link-received", url.clone());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            }
        }));
    }

    builder
        .setup(|app| {
            // Check for deep link on initial launch — store it for the frontend to retrieve
            let initial_url = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .and_then(|urls| urls.first().map(|u| u.to_string()));

            app.manage(DeepLinkState(Mutex::new(initial_url)));

            // Listen for future deep link events (after app is already running)
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
