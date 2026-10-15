#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//! macOS application menu for the viewer (K9, #8241).
//!
//! Tauri's default macOS menu binds Cmd+W (Close Window), Cmd+H (Hide) and
//! Cmd+M (Minimize). Those key equivalents are taken by AppKit before the
//! page sees them, so an operator could never send them to the remote. This
//! menu keeps those commands (clickable, no accelerator) and keeps Cmd+Q, which
//! asks for confirmation while remote sessions are open.
//!
//! The menu is described as data (`menu_spec`) so the "no Cmd+W/H/M" rule is
//! testable without a running app; `build` turns it into a real menu.

/// Menu ids handled by `handle_menu_event`.
pub const MENU_QUIT: &str = "viewer-quit";
pub const MENU_HIDE: &str = "viewer-hide";
pub const MENU_MINIMIZE: &str = "viewer-minimize";
pub const MENU_CLOSE_WINDOW: &str = "viewer-close-window";

/// Built-in items reused as-is. Each carries the accelerator AppKit gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    About,
    Services,
    ShowAll,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Zoom,
}

impl Predefined {
    /// The key equivalent AppKit attaches to the built-in item (read by the tests).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn accelerator(self) -> Option<&'static str> {
        match self {
            Predefined::About | Predefined::Services | Predefined::ShowAll | Predefined::Zoom => None,
            Predefined::Undo => Some("Cmd+Z"),
            Predefined::Redo => Some("Shift+Cmd+Z"),
            Predefined::Cut => Some("Cmd+X"),
            Predefined::Copy => Some("Cmd+C"),
            Predefined::Paste => Some("Cmd+V"),
            Predefined::SelectAll => Some("Cmd+A"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Custom {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
    Predefined(Predefined),
    Separator,
}

pub struct SubmenuSpec {
    pub label: &'static str,
    pub entries: Vec<Entry>,
}

pub fn menu_spec() -> Vec<SubmenuSpec> {
    vec![
        SubmenuSpec {
            label: "Breeze Viewer",
            entries: vec![
                Entry::Predefined(Predefined::About),
                Entry::Separator,
                Entry::Predefined(Predefined::Services),
                Entry::Separator,
                Entry::Custom { id: MENU_HIDE, label: "Hide Breeze Viewer", accelerator: None },
                Entry::Predefined(Predefined::ShowAll),
                Entry::Separator,
                Entry::Custom { id: MENU_QUIT, label: "Quit Breeze Viewer", accelerator: Some("CmdOrCtrl+Q") },
            ],
        },
        // Unchanged from Tauri's default: the clipboard shortcuts already work
        // with the remote (the page handles them first).
        SubmenuSpec {
            label: "Edit",
            entries: vec![
                Entry::Predefined(Predefined::Undo),
                Entry::Predefined(Predefined::Redo),
                Entry::Separator,
                Entry::Predefined(Predefined::Cut),
                Entry::Predefined(Predefined::Copy),
                Entry::Predefined(Predefined::Paste),
                Entry::Predefined(Predefined::SelectAll),
            ],
        },
        SubmenuSpec {
            label: "Window",
            entries: vec![
                Entry::Custom { id: MENU_MINIMIZE, label: "Minimize", accelerator: None },
                Entry::Predefined(Predefined::Zoom),
                Entry::Separator,
                Entry::Custom { id: MENU_CLOSE_WINDOW, label: "Close Window", accelerator: None },
            ],
        },
    ]
}

/// Whether Cmd+Q should ask first: only when sessions are open and the
/// operator has not already confirmed.
pub fn should_confirm_quit(open_sessions: usize, confirmed: bool) -> bool {
    open_sessions > 0 && !confirmed
}

#[cfg(target_os = "macos")]
pub fn build<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{IsMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let mut menu = MenuBuilder::new(app);
    for spec in menu_spec() {
        let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
        for entry in spec.entries {
            let item: Box<dyn IsMenuItem<R>> = match entry {
                Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                Entry::Custom { id, label, accelerator } => {
                    let mut b = MenuItemBuilder::with_id(id, label);
                    if let Some(a) = accelerator {
                        b = b.accelerator(a);
                    }
                    Box::new(b.build(app)?)
                }
                Entry::Predefined(p) => Box::new(match p {
                    Predefined::About => PredefinedMenuItem::about(app, None, None)?,
                    Predefined::Services => PredefinedMenuItem::services(app, None)?,
                    Predefined::ShowAll => PredefinedMenuItem::show_all(app, None)?,
                    Predefined::Undo => PredefinedMenuItem::undo(app, None)?,
                    Predefined::Redo => PredefinedMenuItem::redo(app, None)?,
                    Predefined::Cut => PredefinedMenuItem::cut(app, None)?,
                    Predefined::Copy => PredefinedMenuItem::copy(app, None)?,
                    Predefined::Paste => PredefinedMenuItem::paste(app, None)?,
                    Predefined::SelectAll => PredefinedMenuItem::select_all(app, None)?,
                    Predefined::Zoom => PredefinedMenuItem::maximize(app, None)?,
                }),
            };
            items.push(item);
        }
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i.as_ref()).collect();
        let submenu = SubmenuBuilder::new(app, spec.label).items(&refs).build()?;
        menu = menu.item(&submenu);
    }
    menu.build()
}

/// Hide / Minimize / Close Window, clicked from the menu. Quit is handled by
/// the caller, which knows about sessions.
#[cfg(target_os = "macos")]
pub fn handle_window_item<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    use tauri::Manager;
    let focused = || {
        app.webview_windows()
            .into_values()
            .find(|w| w.is_focused().unwrap_or(false))
    };
    match id {
        MENU_HIDE => {
            let _ = app.hide();
        }
        MENU_MINIMIZE => {
            if let Some(w) = focused() {
                let _ = w.minimize();
            }
        }
        MENU_CLOSE_WINDOW => {
            if let Some(w) = focused() {
                let _ = w.close();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_accelerators() -> Vec<&'static str> {
        menu_spec()
            .iter()
            .flat_map(|s| s.entries.iter())
            .filter_map(|e| match e {
                Entry::Custom { accelerator, .. } => *accelerator,
                Entry::Predefined(p) => p.accelerator(),
                Entry::Separator => None,
            })
            .collect()
    }

    fn normalise(accel: &str) -> String {
        accel
            .to_ascii_lowercase()
            .replace("cmdorctrl", "cmd")
            .replace("commandorcontrol", "cmd")
            .replace("command", "cmd")
            .replace("super", "cmd")
    }

    #[test]
    fn no_accelerator_takes_cmd_w_h_or_m() {
        for accel in all_accelerators() {
            let a = normalise(accel);
            for taken in ["cmd+w", "cmd+h", "cmd+m", "alt+cmd+h", "cmd+alt+h"] {
                assert_ne!(a, taken, "{accel} would keep the key from the remote");
            }
        }
    }

    #[test]
    fn hide_minimize_and_close_stay_available_without_accelerators() {
        let customs: Vec<_> = menu_spec()
            .into_iter()
            .flat_map(|s| s.entries.into_iter())
            .filter_map(|e| match e {
                Entry::Custom { id, accelerator, .. } => Some((id, accelerator)),
                _ => None,
            })
            .collect();
        for id in [MENU_HIDE, MENU_MINIMIZE, MENU_CLOSE_WINDOW] {
            assert!(customs.contains(&(id, None)), "{id} missing or has an accelerator");
        }
    }

    #[test]
    fn cmd_q_still_quits() {
        let quit = menu_spec()
            .into_iter()
            .flat_map(|s| s.entries.into_iter())
            .find(|e| matches!(e, Entry::Custom { id, .. } if *id == MENU_QUIT));
        match quit {
            Some(Entry::Custom { accelerator: Some(a), .. }) => assert_eq!(normalise(a), "cmd+q"),
            other => panic!("quit item: {other:?}"),
        }
    }

    #[test]
    fn edit_menu_keeps_copy_and_paste() {
        let edit = menu_spec().into_iter().find(|s| s.label == "Edit").expect("Edit menu");
        assert!(edit.entries.contains(&Entry::Predefined(Predefined::Copy)));
        assert!(edit.entries.contains(&Entry::Predefined(Predefined::Paste)));
    }

    #[test]
    fn quit_confirms_only_with_open_sessions() {
        assert!(!should_confirm_quit(0, false));
        assert!(should_confirm_quit(1, false));
        assert!(should_confirm_quit(3, false));
        assert!(!should_confirm_quit(2, true));
    }
}
