# Multi-Window Viewer Design

## Problem

The Breeze Viewer currently reuses the main window for the first remote desktop connection. Subsequent deep links create new windows, but the main window loses its launcher role. Users managing multiple devices need each connection in its own dedicated window.

## Design

### Window Roles

**Main window (hidden)** — Exists for Tauri lifecycle management (state, dock icon, deep link routing). Created hidden on startup. Never shown to the user unless an update is required — then it shows the forced update prompt (the only time the main window is visible).

**Session windows** — The only visible windows during normal operation. One per connection, created by deep link. Labeled `session-1`, `session-2`, etc. Title set to `"Connecting..."` at creation, updated to hostname once connected. Closes immediately on disconnect. Deep links are the only way to connect (no manual URL input).

### Rust Backend Changes (`lib.rs`)

#### Main window hidden on startup

The main window is created by Tauri's config but should be hidden immediately. In `setup()`:

```rust
if let Some(main_win) = app.get_webview_window("main") {
    let _ = main_win.hide();
}
```

The main window stays hidden unless the frontend detects an outdated version and calls `getCurrentWebviewWindow().show()` to display the update prompt. `ensure_main_window` still recreates it hidden if destroyed.

#### Update gate for session windows

Add a boolean state `UpdateGate(Mutex<bool>)` initialized to `false`. The frontend's main window sets it to `true` via a new `set_update_ok` IPC command once the update check passes. `create_session_window` checks this gate — if `false` (update check hasn't passed or version is outdated), it stores the deep link URL in a `PendingUrls(Mutex<Vec<String>>)` queue instead of creating a window. When `set_update_ok` is called, it drains the queue and creates session windows for all pending URLs.

#### SessionEntry struct and SessionMap restructure

Current: `HashMap<String, String>` mapping `session_id → window_label`.

New: `HashMap<String, SessionEntry>` where:

```rust
#[derive(Clone, serde::Serialize)]
struct SessionEntry {
    window_label: String,
    hostname: Option<String>,
}
```

**Callsites that must be updated for this type change:**

| Location | Current code | New code |
|----------|-------------|----------|
| `register_session` | `map.insert(session_id, window.label().to_string())` | `map.insert(session_id, SessionEntry { window_label: ..., hostname: None })` |
| `unregister_session` | `map.retain(\|_, label\| label != window.label())` | `map.retain(\|_, entry\| entry.window_label != window.label())` |
| `WindowEvent::Destroyed` handler | `map.retain(\|_, wl\| wl != &label)` | `map.retain(\|_, entry\| entry.window_label != label)` |
| `route_deep_link` duplicate check | `map.get(&session_id).cloned()` → uses `String` as label | Returns `SessionEntry`, use `.window_label` to look up window |
| `route_deep_link` main-active check | `map.values().any(\|label\| label == "main")` | Removed entirely — always create a new session window |

#### Routing changes

`route_deep_link` always calls `create_session_window`. The "check if main is idle" branch is removed entirely. The only shortcut: if a deep link targets an already-active session ID, focus that existing window (unchanged).

#### `create_session_window` title change

Set initial title to `"Connecting..."`:

```rust
WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
    .title("Connecting...")
    .inner_size(1280.0, 800.0)
    .build()
```

#### New IPC commands

All new commands must be added to the `generate_handler![]` macro.

| Command | Args | Returns | Purpose |
|---------|------|---------|---------|
| `update_session_hostname` | (uses `window.label()` implicitly), `hostname` | void | DesktopViewer reports hostname; looks up entry by window label |
| `set_update_ok` | none | void | Main window signals update check passed; drains pending deep link queue into session windows |

`update_session_hostname` uses the implicit `window: tauri::WebviewWindow` param to find the matching SessionMap entry by window label (iterates values), consistent with `unregister_session`.

Commands removed from this design (no longer needed without visible main window): `list_sessions`, `focus_window`, `open_session_from_url`.

#### Cold-start deep link

During `setup()`, window creation via `WebviewWindowBuilder` may not be safe before the event loop starts. Instead:

1. Store the initial URL in a temporary key (not `"main"`)
2. Defer session window creation via `app.handle().run_on_main_thread()` from within setup, which executes on the first event loop tick after `app.run()` starts
3. The deferred closure calls `create_session_window(handle, url)`

This avoids calling `WebviewWindowBuilder::build()` before the event loop is active.

#### `ensure_main_window` changes

Still recreates the main window if destroyed (needed for state management), but keeps it hidden. Does not call `set_focus()` on it.

#### macOS `RunEvent::Reopen` (dock icon click)

When the dock icon is clicked and no session windows exist, this is a no-op (the hidden main window is sufficient). If session windows exist, focus the most recent one.

### Frontend Changes

#### `App.tsx` — simplified role-based rendering

The window label determines behavior:

- `label === "main"` → runs the update check on mount. If outdated, shows the main window (`getCurrentWebviewWindow().show()`) with the forced update prompt (existing UI). If current, stays hidden.
- `label !== "main"` → session window. Show "Connecting..." while polling for pending deep link. Render `DesktopViewer` once params arrive. Close window on disconnect. Session windows do NOT run the update check themselves — the main window handles it on startup and blocks session window creation if outdated.

The welcome screen UI, manual URL input, and session list are removed from App.tsx entirely. The only main-window UI is the update-required prompt.

#### Window titles

- Main window: irrelevant (hidden)
- Session windows: `"Connecting..."` set by Rust at creation → updated to hostname by `DesktopViewer` via `getCurrentWebviewWindow().setTitle(hostname)`

#### Disconnect behavior

All session windows close immediately on disconnect via `getCurrentWebviewWindow().close()`. No distinction between main/non-main needed since main is never a viewer.

### Data Flow

```
App starts
  → main window created hidden
  → main window frontend runs update check
  → if outdated: show main window with update prompt, block all session creation
  → if current: invoke('set_update_ok') → Rust sets gate, drains pending URLs into session windows

Deep link arrives (any app state)
  → on_open_url / single_instance callback
  → route_deep_link()
  → if update gate not passed: queue URL in PendingUrls
  → if update gate passed: create_session_window(app, url)
  → new Tauri window created (label: session-N, title: "Connecting...")
  → URL stored in DeepLinkState[session-N]
  → emit_with_retry sends deep-link-received event

Session window loads
  → App.tsx detects label != "main"
  → shows "Connecting..." spinner
  → polls get_pending_deep_link → gets URL
  → parseDeepLink → ConnectionParams
  → renders DesktopViewer

DesktopViewer connects
  → exchangeDesktopConnectCode → access token
  → createDesktopWsTicket → WS ticket
  → invoke('register_session', { session_id })
  → WebRTC/WS connection established
  → agent sends hostname
  → invoke('update_session_hostname', { hostname })
  → getCurrentWebviewWindow().setTitle(hostname)

Session disconnects
  → DesktopViewer calls onDisconnect
  → invoke('unregister_session') cleans up SessionMap
  → getCurrentWebviewWindow().close()
  → WindowEvent::Destroyed cleans up remaining state
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Deep link while app not running | Cold start: hidden main window created, update check runs, session window deferred until gate passes |
| Deep link before update check completes | URL queued in PendingUrls; drained into session windows when `set_update_ok` is called |
| Deep link when version is outdated | URL queued but never drained; main window shown with update prompt |
| Deep link for existing session | Focus existing session window (unchanged) |
| Main window destroyed somehow | `ensure_main_window` recreates it hidden |
| All session windows closed | App continues running with hidden main window (macOS dock icon visible) |
| Dock icon click, no session windows | No-op (or could quit the app — platform convention) |
| Dock icon click, session windows exist | Focus most recent session window |
| Rapid consecutive deep links | Each creates its own session window (WindowCounter serializes labels) |
| Reconnect cycle | `unregister_session` clears entry; `register_session` re-creates it. Hostname re-reported after reconnect. |

### Files Modified

| File | Changes |
|------|---------|
| `apps/viewer/src-tauri/src/lib.rs` | `SessionEntry` struct, hide main window, remove main-routing logic, `update_session_hostname` command, cold-start deferral, all SessionMap callsite updates, `RunEvent::Reopen` focuses session window |
| `apps/viewer/src/App.tsx` | Main window renders nothing, session windows skip welcome screen and go straight to connecting/viewer, remove manual URL input and session list, simplify disconnect to always close |
| `apps/viewer/src/components/DesktopViewer.tsx` | Call `update_session_hostname` + `setTitle(hostname)` on hostname received |

### Not in scope

- System tray menu or manual URL input (deep links only)
- Session window thumbnails/previews
- Persistent session history
- Launcher/hub window
