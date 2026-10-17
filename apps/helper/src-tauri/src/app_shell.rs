//! macOS app-shell behaviour for Breeze Assist (#8399).
//!
//! Assist is always running and lives in the menu bar (#8138). On macOS that
//! needs two things Tauri does not do by default:
//!
//! 1. **No Dock icon.** `lib.rs` sets `ActivationPolicy::Accessory` at setup,
//!    which also drops the app's menu bar and the Dock's Quit entry.
//! 2. **No Cmd+Q.** Tauri's default macOS menu carries
//!    `PredefinedMenuItem::quit`, which sends `[NSApp terminate:]`. That path
//!    never reaches `RunEvent::ExitRequested` (tao only implements
//!    `applicationWillTerminate:`, which ends the loop with `RunEvent::Exit`),
//!    so `prevent_exit()` cannot stop it. AppKit dispatches key equivalents
//!    through `NSApp.mainMenu` whether or not the menu bar is drawn, so the
//!    shortcut is expected to stay live under `Accessory` while the chat
//!    window is key (lab-verify). [`build_macos_app_menu`] therefore rebuilds
//!    the menu without Quit and binds Cmd+Q to a "Hide Window" item instead.
//!
//! Logout, restart and shutdown still terminate Assist: they reach
//! `terminate:` through Apple Events, not through the menu.

/// Menu item id for the Cmd+Q "Hide Window" item in the macOS app menu.
/// Distinct from every tray menu id (`tray_menu_label` in `lib.rs`).
#[cfg(target_os = "macos")]
pub(crate) const HIDE_WINDOW_MENU_ID: &str = "assist_hide_window";

/// Decide whether an `ExitRequested` event should be cancelled.
///
/// `code` is `None` when the exit came from user interaction and `Some(_)`
/// when it was requested programmatically through `AppHandle::exit` or
/// `AppHandle::restart` (tauri 2.12.1 `src/app.rs:225-228`). A programmatic
/// exit (updater, uninstall, watchdog) must always go through. `prevent_exit`
/// is also a no-op for `RESTART_EXIT_CODE` (`src/app.rs:90-94`).
///
/// This is a safety net only: on macOS the user-initiated `None` path fires
/// when the last window is destroyed, which cannot happen while the main
/// window's `CloseRequested` hides instead of closing. Cmd+Q is handled by
/// the menu, see the module docs.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn should_prevent_exit(code: Option<i32>) -> bool {
    code.is_none()
}

/// Tauri's default macOS menu (tauri 2.12.1 `src/menu/menu.rs`, `Menu::default`)
/// without `PredefinedMenuItem::quit`, plus a Cmd+Q "Hide Window" item. The
/// View (fullscreen) and empty Help submenus are dropped too: under
/// `Accessory` no menu bar is drawn, so only key equivalents matter.
/// Hide / Hide Others (Cmd+H, Cmd+Opt+H) are dropped as well: `[NSApp hide:]`
/// on an app with no Dock icon is one more way to strand the window.
///
/// Edit stays: its key equivalents (Cmd+C/V/X/A/Z) are how copy and paste
/// reach the webview. The File/Window "Close Window" items send
/// `performClose:`, which the main window's `CloseRequested` handler turns
/// into a hide.
#[cfg(target_os = "macos")]
pub(crate) fn build_macos_app_menu(
    app: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg_info = app.package_info();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let hide_window = MenuItem::with_id(
        app,
        HIDE_WINDOW_MENU_ID,
        "Hide Window",
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &hide_window,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_initiated_exit_is_prevented() {
        assert!(should_prevent_exit(None));
    }

    // #8399: Quit in the macOS app menu is `[NSApp terminate:]`, which
    // nothing can cancel. Never put it (or a quit-the-process call) back.
    #[test]
    fn app_menu_has_no_quit_path() {
        let code: String = include_str!("app_shell.rs")
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .unwrap_or("")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        // The scan must actually cover the menu builder.
        assert!(code.contains("fn build_macos_app_menu("));
        for forbidden in ["::quit(", ".exit(", "process::exit", "terminate"] {
            assert!(
                !code.contains(forbidden),
                "app_shell.rs must not use {forbidden}"
            );
        }
        assert!(code.contains("Some(\"CmdOrCtrl+Q\")"));
        assert!(code.contains("\"Edit\""), "Edit menu carries Cmd+C/V");
    }

    #[test]
    fn programmatic_exit_is_never_prevented() {
        for code in [0, 1, -1, 2, tauri::RESTART_EXIT_CODE] {
            assert!(
                !should_prevent_exit(Some(code)),
                "exit code {code} must not be prevented"
            );
        }
    }
}
