use std::collections::HashMap;
#[cfg(any(target_os = "linux", test))]
use std::path::{Path, PathBuf};
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

/// How long a launch waits before concluding no deep link is coming and showing
/// the idle card. See the comment at its use site in `setup()`.
const IDLE_CARD_DELAY: std::time::Duration = std::time::Duration::from_millis(800);

/// Register this app bundle with macOS Launch Services so the `breeze://`
/// URL scheme always resolves to the current install location (not a stale
/// DMG mount path). This is a no-op on non-macOS platforms.
#[cfg(target_os = "macos")]
fn register_url_scheme() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot resolve own path: {e}"))?;
    // Walk up from .app/Contents/MacOS/binary → .app
    let app_bundle = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| format!("{} is not inside an .app bundle", exe.display()))?;

    let output = std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister")
        .arg("-f")
        .arg(app_bundle)
        .output()
        .map_err(|e| format!("failed to run lsregister: {e}"))?;

    if !output.status.success() {
        return Err(format!("lsregister failed with status {}", output.status));
    }
    Ok(())
}

/// Set once the app has asked to exit, so the shutdown that follows — which
/// destroys every remaining window and re-enters the `Destroyed` handler — can't
/// call `exit(0)` a second time from inside Tauri's own teardown. The macOS
/// terminate sequence is already fragile enough to need the `RunEvent::Exit`
/// workaround at the bottom of `run()`; re-entering it is not worth finding out.
static EXIT_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ── Linux `breeze://` registration ───────────────────────────────────────
// The helpers below are compiled on Linux, and under `cfg(test)` everywhere so
// they stay unit-testable on any dev machine. Only the fs/subprocess half
// (`register_url_scheme`, `scheme_association_is_ours`, `run_best_effort`) is
// Linux-only, and CI's ubuntu `cargo check` is what compiles it.

/// Filename of the desktop entry this app owns under the XDG applications dir.
#[cfg(any(target_os = "linux", test))]
const LINUX_DESKTOP_ENTRY_NAME: &str = "breeze-viewer.desktop";

/// The MIME type that carries the `breeze://` scheme association.
#[cfg(target_os = "linux")]
const BREEZE_SCHEME_MIME: &str = "x-scheme-handler/breeze";

/// Resolve the launcher path to record in the Linux desktop entry.
///
/// Inside an AppImage, `current_exe()` points at the ephemeral squashfs mount
/// (`/tmp/.mount_XXXXXX/usr/bin/breeze-viewer`), which disappears the moment the
/// process exits — a desktop entry pointing there is dead on arrival. The
/// AppImage runtime sets `$APPIMAGE` to the real, persistent path of the
/// `.AppImage` file, so that always wins when present. A plain (non-AppImage)
/// build falls back to `current_exe()`.
///
/// Relative paths are rejected: `Exec=` is resolved against an unspecified
/// working directory, so anything non-absolute is a handler that fails later
/// instead of failing here.
#[cfg(any(target_os = "linux", test))]
fn resolve_launcher_path(
    appimage_env: Option<&str>,
    current_exe: Option<&Path>,
) -> Option<PathBuf> {
    let candidate = match appimage_env.map(str::trim).filter(|s| !s.is_empty()) {
        Some(appimage) => PathBuf::from(appimage),
        None => current_exe?.to_path_buf(),
    };
    candidate.is_absolute().then_some(candidate)
}

/// Directory the desktop entry is written to, per the XDG base directory spec.
#[cfg(any(target_os = "linux", test))]
fn xdg_applications_dir(xdg_data_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match xdg_data_home.map(str::trim).filter(|s| !s.is_empty()) {
        Some(data_home) => PathBuf::from(data_home),
        None => Path::new(home.map(str::trim).filter(|s| !s.is_empty())?).join(".local/share"),
    };
    base.is_absolute().then(|| base.join("applications"))
}

/// Quote a path for the `Exec=` key of a desktop entry.
///
/// Always quotes rather than deciding whether quoting is needed — the
/// "does this character require quoting" branch is the bug-prone half, and an
/// unconditionally quoted argument is valid per the Desktop Entry spec.
///
/// Returns `None` rather than emitting something subtly wrong:
/// - **Control characters** — a newline would terminate the `Exec=` key and
///   corrupt every handler below it in the file. The rest are rejected on
///   principle, not because each one individually breaks parsing.
/// - **Literal backslashes** — these would have to survive two unescaping
///   passes (the `.desktop` value decoding, then `Exec=` argument parsing) and
///   the correct encoding differs between them. For a path shape that
///   essentially never occurs on Linux, declining to register and logging why
///   beats shipping an encoding that varies by desktop environment.
#[cfg(any(target_os = "linux", test))]
fn escape_desktop_exec(path: &str) -> Option<String> {
    if path.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for ch in path.chars() {
        match ch {
            // Reserved inside a quoted Exec argument.
            '"' | '`' | '$' => {
                out.push('\\');
                out.push(ch);
            }
            // `%` introduces a field code (`%u`, `%f`); a literal must be
            // doubled or the parser reads e.g. `%2` as an undefined code.
            '%' => out.push_str("%%"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    Some(out)
}

/// Body of the desktop entry that claims `breeze://` for this install.
///
/// `NoDisplay=true` because this entry exists only to register the URL scheme —
/// the viewer is launched by the Breeze console, not from an app menu, and a
/// visible entry would linger after the user deletes the AppImage.
#[cfg(any(target_os = "linux", test))]
fn desktop_entry_contents(exec_quoted: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Breeze Viewer\n\
         Comment=Breeze remote desktop viewer\n\
         Exec={exec_quoted} %u\n\
         Terminal=false\n\
         NoDisplay=true\n\
         StartupNotify=true\n\
         StartupWMClass=breeze-viewer\n\
         Categories=Network;RemoteAccess;\n\
         MimeType=x-scheme-handler/breeze;\n"
    )
}

/// Everything the Linux registration needs, derived purely from the process
/// environment. Split from the fs/subprocess work so the derivation is
/// unit-testable without a real `$HOME`: which env var feeds which slot, and
/// that the file we write is the same name we hand to `xdg-mime`. Wiring those
/// wrong compiles fine and fails silently — indistinguishable from no fix.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinuxRegistration {
    dir: PathBuf,
    entry_path: PathBuf,
    entry_name: &'static str,
    contents: String,
}

#[cfg(any(target_os = "linux", test))]
fn linux_registration_plan(
    appimage_env: Option<&str>,
    current_exe: Option<&Path>,
    xdg_data_home: Option<&str>,
    home: Option<&str>,
) -> Result<LinuxRegistration, String> {
    let launcher = resolve_launcher_path(appimage_env, current_exe)
        .ok_or_else(|| "no absolute launcher path".to_string())?;
    let exec_quoted = escape_desktop_exec(&launcher.to_string_lossy()).ok_or_else(|| {
        format!(
            "launcher path cannot be represented in a desktop entry: {}",
            launcher.display()
        )
    })?;
    let dir = xdg_applications_dir(xdg_data_home, home)
        .ok_or_else(|| "cannot locate the XDG applications directory".to_string())?;
    Ok(LinuxRegistration {
        entry_path: dir.join(LINUX_DESKTOP_ENTRY_NAME),
        dir,
        entry_name: LINUX_DESKTOP_ENTRY_NAME,
        contents: desktop_entry_contents(&exec_quoted),
    })
}

/// Register this install as the `breeze://` handler on Linux.
///
/// Nothing else does this. An AppImage is a single self-contained file that is
/// never installed into the XDG applications directory, so no `.desktop` file
/// is ever seen by `update-desktop-database` and `x-scheme-handler/breeze`
/// stays unclaimed. The console's deep link is then a silent no-op, its session
/// poll times out, and the user is told to "Download for Linux" forever — even
/// with the viewer already downloaded and running (issue #2614).
///
/// Runs on every launch so the handler follows the AppImage if the user moves
/// it.
#[cfg(target_os = "linux")]
fn register_url_scheme() -> Result<(), String> {
    let plan = linux_registration_plan(
        std::env::var("APPIMAGE").ok().as_deref(),
        std::env::current_exe().ok().as_deref(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )?;

    // Write only when the entry is missing or stale. Unreadable, truncated and
    // corrupt all compare unequal and get rewritten, so a bad file self-heals.
    if std::fs::read_to_string(&plan.entry_path).ok().as_deref() != Some(plan.contents.as_str()) {
        std::fs::create_dir_all(&plan.dir)
            .map_err(|e| format!("could not create {}: {}", plan.dir.display(), e))?;
        std::fs::write(&plan.entry_path, &plan.contents)
            .map_err(|e| format!("could not write {}: {}", plan.entry_path.display(), e))?;
    }

    // Re-assert the association on every launch unless it already points at us.
    // Matching file content proves only that the launcher path is current — it
    // says nothing about whether xdg ever *accepted* the association. If
    // `xdg-mime` failed the first time (xdg-utils absent, mimeapps.list
    // unwritable, association later clobbered by another installer), the entry
    // would sit on disk looking perfectly correct while `breeze://` stayed
    // unclaimed. Gating this on content alone would then never retry: #2614
    // forever, with no way out short of deleting the file by hand.
    if !scheme_association_is_ours(plan.entry_name) {
        run_best_effort("update-desktop-database", &[plan.dir.as_os_str()]);
        run_best_effort(
            "xdg-mime",
            &[
                std::ffi::OsStr::new("default"),
                std::ffi::OsStr::new(plan.entry_name),
                std::ffi::OsStr::new(BREEZE_SCHEME_MIME),
            ],
        );
    }
    Ok(())
}

/// True only when xdg already resolves the scheme to our entry.
///
/// "Can't tell" — query failed, xdg-utils missing — deliberately returns false.
/// Re-running registration costs two fast spawns; wrongly assuming success is
/// the unrecoverable state described above.
#[cfg(target_os = "linux")]
fn scheme_association_is_ours(entry_name: &str) -> bool {
    std::process::Command::new("xdg-mime")
        .args(["query", "default", BREEZE_SCHEME_MIME])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == entry_name)
        .unwrap_or(false)
}

/// Best-effort because minimal desktops genuinely ship neither tool, and a
/// missing cache refresh still leaves a valid entry for the next login. The
/// captured stderr is logged rather than discarded: `xdg-mime`'s own message
/// ("no method available for setting default applications", a mimeapps.list
/// permission error) is the only thing that makes a field report diagnosable —
/// an exit status alone is unactionable.
#[cfg(target_os = "linux")]
fn run_best_effort(program: &str, args: &[&std::ffi::OsStr]) {
    match std::process::Command::new(program).args(args).output() {
        Ok(output) if !output.status.success() => {
            eprintln!(
                "{} exited with {}: {}",
                program,
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        // Expected on minimal desktops — kept distinct from real failures so
        // the benign case doesn't train anyone to ignore this log line.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("{program} is not installed — breeze:// association not refreshed");
        }
        Err(err) => eprintln!("failed to run {program}: {err}"),
        Ok(_) => {}
    }
}

/// Windows (and every other non-macOS, non-Linux target) self-registers nothing
/// at runtime. The `breeze` scheme declared in `tauri.conf.json`
/// (`plugins.deep-link.desktop.schemes`) is baked into the bundler's stock WiX
/// template, which writes `HKLM\Software\Classes\breeze` at MSI install time.
/// The source of truth is that config array — not this file, and not
/// tauri-plugin-deep-link's unused HKCU `register()`.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn register_url_scheme() -> Result<(), String> {
    Ok(())
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

/// A downloaded-but-not-yet-applied update, awaiting the user's choice in the
/// `Ready` prompt. The `Update` handle is retained because `install()` is a
/// method on it. Only populated when no remote session was active at download
/// time (an active session defers instead); a session may start afterwards
/// while a value is still staged, so `is_some()` does not imply "no session now".
struct PendingUpdate(Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

/// `None` once URL-scheme registration succeeded, `Some(reason)` when it did
/// not. The idle card reads this so it cannot tell the user the viewer is ready
/// when `breeze://` will never reach it — a card asserting a success nobody
/// checked is how this class of bug stays invisible.
struct SchemeRegistration(Mutex<Option<String>>);

#[tauri::command]
fn get_scheme_registration_error(state: tauri::State<SchemeRegistration>) -> Option<String> {
    lock_or_recover(&state.0, "scheme_registration").clone()
}

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

/// "Restart & update": apply the stashed update now. On macOS/Linux this swaps
/// the binary and restarts; on Windows `install()` launches the installer and
/// the process exits. Returns `Err` if nothing is staged (e.g. invoked after
/// the slot was already taken) or if the install fails, so the caller's promise
/// rejects instead of silently resolving and stranding the prompt's buttons.
#[tauri::command]
fn apply_pending_update(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let taken = {
        let mut slot = lock_or_recover(&pending.0, "pending_update");
        slot.take()
    };
    let Some((update, bytes)) = taken else {
        return Err("no pending update to apply".to_string());
    };
    let version = update.version.clone();

    // On Windows install() launches the installer and terminates the process,
    // so emit a labelled "Installing" first — the exit is then a known step,
    // not a silent crash. (macOS/Linux swap in place and emit "Restarting" below.)
    #[cfg(target_os = "windows")]
    emit_update_status(&app, UpdateStatus::Installing { version: version.clone() });

    if let Err(e) = update.install(bytes) {
        eprintln!("Update install failed: {}", e);
        emit_update_status(&app, UpdateStatus::Failed { version });
        return Err(e.to_string());
    }

    // macOS/Linux: the binary was swapped on disk but the running process still
    // holds the old version — restart to apply. (On Windows the line above
    // already exited the process on success.)
    #[cfg(not(target_os = "windows"))]
    {
        emit_update_status(&app, UpdateStatus::Restarting { version });
        app.restart()
    }
    #[cfg(target_os = "windows")]
    Ok(())
}

/// "Remind me later": discard the prompt. On macOS/Linux swap the binary on
/// disk so the next launch is updated; on Windows drop the download (re-checks
/// next launch). Idempotent — `Ok` even when nothing is staged. The disk-swap
/// is best-effort: a failure is logged but not surfaced, since the next launch
/// re-checks regardless.
#[tauri::command]
fn dismiss_pending_update(pending: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
    let taken = {
        let mut slot = lock_or_recover(&pending.0, "pending_update");
        slot.take()
    };
    let Some((update, bytes)) = taken else {
        return Ok(());
    };

    #[cfg(not(target_os = "windows"))]
    if let Err(e) = update.install(bytes) {
        eprintln!("Deferred update disk-swap failed: {}", e);
    }
    #[cfg(target_os = "windows")]
    drop((update, bytes));

    Ok(())
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
///
/// Returns whether a session window is on screen afterwards. The caller at
/// startup needs to know: if the deep link that launched us produces no window
/// and nothing else is showing, the process would sit alive and invisible —
/// the invisible-process symptom this change exists to remove.
fn create_session_window(app: &tauri::AppHandle, url: String) -> bool {
    let url = match validate_deep_link(&url) {
        Ok(url) => url,
        Err(err) => {
            eprintln!("Rejected invalid deep link before window creation: {}", err);
            return false;
        }
    };

    if active_session_window_count(app) >= MAX_SESSION_WINDOWS {
        eprintln!(
            "Rejected deep link because session window limit ({}) is reached",
            MAX_SESSION_WINDOWS
        );
        focus_any_session_window(app);
        // The limit is only reachable when windows already exist, so something
        // is on screen — just not a new one.
        return true;
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
            // A real session took over — retire the anchor window. Hidden, not
            // closed: it is still the process anchor. Failure is cosmetic (the
            // idle card lingers beside the session) and cannot strand the exit
            // path, so log and carry on.
            if let Some(main) = app.get_webview_window("main") {
                if let Err(err) = main.hide() {
                    eprintln!("Failed to hide the idle window: {}", err);
                }
            }
            emit_with_retry(app, &label, url);
            true
        }
        Err(e) => {
            eprintln!("Failed to create session window: {}", e);
            // Clean up orphaned deep link state
            if let Some(state) = app.try_state::<DeepLinkState>() {
                let mut links = lock_or_recover(&state.0, "deep_link_state");
                links.remove(&label);
            }
            false
        }
    }
}

/// Put the anchor window on screen, or exit rather than run invisibly.
///
/// A viewer process with no window and no output is indistinguishable from a
/// crash — exactly the state that was reported. If we cannot show anything,
/// quitting at least gives the user a result they can act on.
fn show_idle_window(app: &tauri::AppHandle) {
    match app.get_webview_window("main") {
        Some(main) => {
            if let Err(err) = main.show() {
                eprintln!("Could not show the idle window ({err}) — exiting rather than running invisibly");
                request_exit(app, 1);
                return;
            }
            // Window managers routinely refuse focus steals; purely cosmetic.
            let _ = main.set_focus();
        }
        None => {
            eprintln!("No 'main' window to show — exiting rather than running invisibly");
            request_exit(app, 1);
        }
    }
}

/// Exit once. Tauri's shutdown destroys every remaining window, which re-enters
/// the `Destroyed` handler — without this latch that handler would call `exit`
/// a second time from inside the teardown it was triggered by.
fn request_exit(app: &tauri::AppHandle, code: i32) {
    if !EXIT_REQUESTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        app.exit(code);
    }
}

/// Whether the app should quit now that `label` was destroyed.
///
/// Session windows are the app's reason to exist; `main` is only on screen
/// after a manual launch. Either kind closing with no sessions left means
/// nothing is on screen. Pure so this branch is testable without a Tauri
/// runtime — getting it wrong either strands an invisible process or kills a
/// live session out from under the user.
fn should_exit_on_window_destroyed(label: &str, remaining_session_labels: &[String]) -> bool {
    (label == "main" || label.starts_with("session-")) && remaining_session_labels.is_empty()
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
    /// Downloaded and waiting for the user to choose Restart & update or
    /// Remind me later. Only emitted when no remote session is active.
    Ready { version: String },
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

    eprintln!("Update {} downloaded", update.version);

    // Decide what to do with the download based on whether a remote session is
    // live. Restarting/installing mid-session would kill it, so an active
    // session always defers; otherwise we hand the choice to the user.
    let has_active_sessions = app
        .try_state::<SessionMap>()
        .map(|s| {
            let map = lock_or_recover(&s.0, "session_map");
            !map.is_empty()
        })
        .unwrap_or(false);

    if has_active_sessions {
        // Don't interrupt a live session. macOS/Linux can swap the binary on
        // disk now (takes effect next launch); Windows can't install without
        // exiting, so drop the download and re-check on next launch.
        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = update.install(bytes) {
                eprintln!("Deferred update disk-swap failed: {}", e);
            }
        }
        #[cfg(target_os = "windows")]
        {
            drop((update, bytes));
        }
        eprintln!("Active remote session — deferring update to next launch");
        emit_update_status(&app, UpdateStatus::Deferred { version });
        return;
    }

    // No active session — stash the download and let the user choose via the
    // Ready prompt (apply_pending_update / dismiss_pending_update).
    if let Some(pending) = app.try_state::<PendingUpdate>() {
        *lock_or_recover(&pending.0, "pending_update") = Some((update, bytes));
        eprintln!("Update {} ready — awaiting user choice", version);
        emit_update_status(&app, UpdateStatus::Ready { version });
    } else {
        eprintln!("PendingUpdate state missing; cannot present update prompt");
        // Defensive: clear the banner so a (theoretically impossible) missing
        // state doesn't leave it pinned on "Downloading…" — the silent-look
        // this feature exists to remove.
        emit_update_status(&app, UpdateStatus::Failed { version });
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
            apply_pending_update,
            dismiss_pending_update,
            get_scheme_registration_error,
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
            // Kept so the idle card can say registration failed instead of
            // claiming the viewer is ready when `breeze://` will not resolve.
            let scheme_registration = register_url_scheme();
            if let Err(ref err) = scheme_registration {
                eprintln!("breeze:// registration failed: {err}");
            }
            app.manage(SchemeRegistration(Mutex::new(scheme_registration.err())));

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
            app.manage(PendingUpdate(Mutex::new(None)));

            // If launched with a deep link, defer session window creation to
            // the first event loop tick (setup runs before the loop starts).
            if let Some(url) = initial_url {
                let handle = app.handle().clone();
                let _ = app.handle().run_on_main_thread(move || {
                    // A rejected URL or a failed build would otherwise leave the
                    // process alive with no window at all — the same invisible
                    // state the `else` branch below exists to prevent, reached
                    // by a different road.
                    if !create_session_window(&handle, url) {
                        show_idle_window(&handle);
                    }
                });
            } else {
                // Launched with no deep link — which on Linux is the required
                // first run, since the AppImage has to be executed once to
                // register itself as the `breeze://` handler. The anchor window
                // is `visible: false` in tauri.conf.json, so without this the
                // process starts, registers, and then sits in the process list
                // with no window and no output: indistinguishable from a crash
                // Show it so the launch has a visible result.
                //
                // Deferred rather than immediate because "no deep link at
                // setup() time" is not the same as "no deep link": on a macOS
                // cold start via `breeze://`, LaunchServices can deliver the URL
                // to on_open_url *after* setup() returns. Showing the card
                // straight away would flash it on screen before the session
                // window replaces it. Waiting a beat and re-checking means the
                // card usually does not appear in that case — IDLE_CARD_DELAY is
                // a heuristic, not a guarantee, and a slower delivery will still
                // flash the card before the session window replaces it.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(IDLE_CARD_DELAY);
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if active_session_window_count(&h) > 0 {
                            return;
                        }
                        show_idle_window(&h);
                    });
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

                    // When the last on-screen window closes, exit cleanly rather
                    // than leave an invisible process behind. See
                    // `should_exit_on_window_destroyed` for the rule.
                    let remaining_sessions: Vec<String> = {
                        let counter = app_handle.state::<WindowCounter>();
                        let n = *lock_or_recover(&counter.0, "window_counter");
                        (1..=n)
                            .map(|i| format!("session-{}", i))
                            .filter(|l| l != &label && app_handle.get_webview_window(l).is_some())
                            .collect()
                    };
                    if should_exit_on_window_destroyed(&label, &remaining_sessions) {
                        request_exit(app_handle, 0);
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

    /// `$APPIMAGE` must win over `current_exe()`. Inside an AppImage the latter
    /// is the ephemeral squashfs mount, so registering it produces a handler
    /// that breaks the moment the process exits.
    #[test]
    fn resolve_launcher_path_prefers_appimage_over_current_exe() {
        let exe = PathBuf::from("/tmp/.mount_abc123/usr/bin/breeze-viewer");
        assert_eq!(
            resolve_launcher_path(Some("/home/u/breeze-viewer-linux.AppImage"), Some(&exe)),
            Some(PathBuf::from("/home/u/breeze-viewer-linux.AppImage"))
        );
    }

    #[test]
    fn resolve_launcher_path_falls_back_and_rejects_non_absolute() {
        let exe = PathBuf::from("/opt/breeze/breeze-viewer");
        // Unset, empty, and whitespace-only $APPIMAGE all fall back to the exe.
        for env in [None, Some(""), Some("   ")] {
            assert_eq!(
                resolve_launcher_path(env, Some(&exe)),
                Some(exe.clone()),
                "APPIMAGE={env:?}"
            );
        }
        // Relative paths are useless in Exec= — reject rather than half-register.
        assert_eq!(
            resolve_launcher_path(Some("./breeze.AppImage"), Some(&exe)),
            None
        );
        assert_eq!(
            resolve_launcher_path(None, Some(Path::new("breeze-viewer"))),
            None
        );
        assert_eq!(resolve_launcher_path(None, None), None);
        // A valid $APPIMAGE stands alone — current_exe() is never consulted.
        assert_eq!(
            resolve_launcher_path(Some("/opt/breeze.AppImage"), None),
            Some(PathBuf::from("/opt/breeze.AppImage"))
        );
    }

    #[test]
    fn xdg_applications_dir_cases() {
        assert_eq!(
            xdg_applications_dir(Some("/home/u/.xdgdata"), Some("/home/u")),
            Some(PathBuf::from("/home/u/.xdgdata/applications"))
        );
        assert_eq!(
            xdg_applications_dir(None, Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/applications"))
        );
        // Empty XDG_DATA_HOME is "unset" per the spec, not an empty base path.
        assert_eq!(
            xdg_applications_dir(Some(""), Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/applications"))
        );
        // Nothing usable, and a relative base, both yield no directory.
        assert_eq!(xdg_applications_dir(None, None), None);
        assert_eq!(
            xdg_applications_dir(Some("relative/data"), Some("/home/u")),
            None
        );
    }

    #[test]
    fn escape_desktop_exec_quotes_and_escapes() {
        assert_eq!(
            escape_desktop_exec("/home/u/breeze-viewer-linux.AppImage").as_deref(),
            Some("\"/home/u/breeze-viewer-linux.AppImage\"")
        );
        // Spaces are the realistic case (~/Downloads on a localized desktop).
        assert_eq!(
            escape_desktop_exec("/home/u/My Apps/breeze.AppImage").as_deref(),
            Some("\"/home/u/My Apps/breeze.AppImage\"")
        );
        // Non-ASCII survives untouched — ~/Téléchargements on a localized desktop.
        assert_eq!(
            escape_desktop_exec("/home/u/Téléchargements/breeze.AppImage").as_deref(),
            Some("\"/home/u/Téléchargements/breeze.AppImage\"")
        );
        // Shell-significant characters are backslash-escaped inside the quotes.
        assert_eq!(
            escape_desktop_exec("/home/u/a$b`c\"d").as_deref(),
            Some("\"/home/u/a\\$b\\`c\\\"d\"")
        );
        // `%` starts a field code: a literal one must be doubled, or a path like
        // breeze%20viewer.AppImage feeds the parser an undefined `%2` code.
        assert_eq!(
            escape_desktop_exec("/home/u/breeze%20viewer.AppImage").as_deref(),
            Some("\"/home/u/breeze%%20viewer.AppImage\"")
        );
        // A newline would terminate the Exec= key and corrupt the whole file.
        assert_eq!(escape_desktop_exec("/home/u/a\nb"), None);
        assert_eq!(escape_desktop_exec("/home/u/a\tb"), None);
        // Backslash needs a different encoding at each of the two unescaping
        // layers; we decline rather than emit something DE-dependent.
        assert_eq!(escape_desktop_exec("/home/u/a\\b"), None);
    }

    /// The planner is where the env wiring lives — passing HOME where
    /// XDG_DATA_HOME belongs still compiles and still passes every helper test.
    #[test]
    fn linux_registration_plan_wires_env_to_paths() {
        let exe = PathBuf::from("/tmp/.mount_abc/usr/bin/breeze-viewer");
        let plan = linux_registration_plan(
            Some("/home/u/Apps/breeze-viewer-linux.AppImage"),
            Some(&exe),
            None,
            Some("/home/u"),
        )
        .expect("plan");

        assert_eq!(plan.dir, PathBuf::from("/home/u/.local/share/applications"));
        assert_eq!(
            plan.entry_path,
            PathBuf::from("/home/u/.local/share/applications/breeze-viewer.desktop")
        );
        // The AppImage path wins over the ephemeral mount, and reaches Exec=.
        assert!(
            plan.contents
                .contains("Exec=\"/home/u/Apps/breeze-viewer-linux.AppImage\" %u\n"),
            "{}",
            plan.contents
        );
        // The file we write must be the name we hand to `xdg-mime default`;
        // a desync here is silent non-registration.
        assert_eq!(
            plan.entry_path.file_name().unwrap().to_str().unwrap(),
            plan.entry_name
        );
        // XDG_DATA_HOME takes precedence when set.
        let via_xdg =
            linux_registration_plan(Some("/opt/b.AppImage"), None, Some("/xdg"), Some("/home/u"))
                .expect("plan");
        assert_eq!(via_xdg.dir, PathBuf::from("/xdg/applications"));
    }

    #[test]
    fn linux_registration_plan_reports_why_it_gave_up() {
        // Relative launcher, unrepresentable launcher, and no home directory —
        // each aborts with a reason the idle card can show the user.
        assert!(
            linux_registration_plan(Some("./rel.AppImage"), None, None, Some("/home/u"))
                .unwrap_err()
                .contains("launcher path")
        );
        assert!(
            linux_registration_plan(Some("/home/u/a\nb"), None, None, Some("/home/u"))
                .unwrap_err()
                .contains("desktop entry")
        );
        assert!(
            linux_registration_plan(Some("/opt/b.AppImage"), None, None, None)
                .unwrap_err()
                .contains("XDG")
        );
    }

    /// The riskiest new branch: closing the idle card must not kill a live
    /// session, and closing the last session must not strand a ghost process.
    #[test]
    fn exit_only_when_nothing_is_left_on_screen() {
        let one = vec!["session-1".to_string()];
        assert!(
            !should_exit_on_window_destroyed("main", &one),
            "closing the idle card with a live session must not exit"
        );
        assert!(
            !should_exit_on_window_destroyed("session-2", &one),
            "closing one of two sessions must not exit"
        );
        assert!(should_exit_on_window_destroyed("session-1", &[]));
        assert!(should_exit_on_window_destroyed("main", &[]));
        // Windows we don't own shouldn't drive the lifecycle either way.
        assert!(!should_exit_on_window_destroyed("devtools", &[]));
    }

    /// The entry is worthless unless it claims the scheme and forwards the URL,
    /// so lock both: a missing `%u` launches the viewer with no deep link, and
    /// a missing MimeType leaves `breeze://` unclaimed — the exact bug.
    #[test]
    fn desktop_entry_declares_scheme_handler_and_forwards_url() {
        let entry = desktop_entry_contents("\"/home/u/breeze.AppImage\"");
        assert!(entry.starts_with("[Desktop Entry]\n"), "{entry}");
        assert!(
            entry.contains("Exec=\"/home/u/breeze.AppImage\" %u\n"),
            "{entry}"
        );
        assert!(
            entry.contains("MimeType=x-scheme-handler/breeze;\n"),
            "{entry}"
        );
        assert!(entry.contains("Type=Application\n"), "{entry}");
        // NoDisplay is deliberate: without it a deleted AppImage leaves a
        // dead entry in the application menu.
        assert!(entry.contains("NoDisplay=true\n"), "{entry}");
        assert!(entry.ends_with('\n'), "{entry}");
    }

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
            (
                UpdateStatus::Ready { version: v.clone() },
                json!({ "phase": "ready", "version": "1.2.3" }),
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
