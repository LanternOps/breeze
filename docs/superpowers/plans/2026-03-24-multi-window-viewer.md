# Multi-Window Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every remote desktop connection open in its own window. The main window is hidden (used only for update gating and Tauri lifecycle). Deep links are the sole connection method.

**Architecture:** Rust backend routes all deep links to new session windows, gated by an update check that runs in the hidden main window. Frontend renders based on window label: main = update check only, session-N = viewer.

**Tech Stack:** Tauri 2.x (Rust), React (TypeScript), existing deep-link + single-instance plugins

**Spec:** `docs/superpowers/specs/2026-03-24-multi-window-viewer-design.md`

---

### Task 1: Rust — SessionEntry struct and new state types

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs:36-44` (state structs)

- [ ] **Step 1: Replace SessionMap value type with SessionEntry, add UpdateGate and PendingUrls**

Replace lines 36-44:

```rust
/// Per-window pending deep link URLs. Key = window label, value = deep link URL.
struct DeepLinkState(Mutex<HashMap<String, String>>);

/// Maps session_id → window_label for active sessions.
/// Used to detect duplicate deep links and focus the existing window.
struct SessionMap(Mutex<HashMap<String, String>>);

/// Monotonic counter for unique window labels.
struct WindowCounter(Mutex<u32>);
```

With:

```rust
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

/// Set to true by the frontend once the update check passes.
/// Deep links received before this gate opens are queued in PendingUrls.
struct UpdateGate(Mutex<bool>);

/// URLs received before the update gate opened. Drained into session windows
/// when set_update_ok is called.
struct PendingUrls(Mutex<Vec<String>>);
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check 2>&1`
Expected: Compilation errors in functions that use `SessionMap` (expected — we'll fix those next)

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "refactor(viewer): add SessionEntry, UpdateGate, PendingUrls state types"
```

---

### Task 2: Rust — Update all SessionMap callsites

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs` (register_session, unregister_session, route_deep_link, WindowEvent::Destroyed)

- [ ] **Step 1: Update register_session (line 102-109)**

Replace:

```rust
#[tauri::command]
fn register_session(
    window: tauri::WebviewWindow,
    session_id: String,
    state: tauri::State<'_, SessionMap>,
) {
    let mut map = lock_or_recover(&state.0, "session_map");
    map.insert(session_id, window.label().to_string());
}
```

With:

```rust
#[tauri::command]
fn register_session(
    window: tauri::WebviewWindow,
    session_id: String,
    state: tauri::State<'_, SessionMap>,
) {
    let mut map = lock_or_recover(&state.0, "session_map");
    map.insert(session_id, SessionEntry {
        window_label: window.label().to_string(),
        hostname: None,
    });
}
```

- [ ] **Step 2: Update unregister_session (line 113-117)**

Replace:

```rust
    let mut map = lock_or_recover(&state.0, "session_map");
    // Remove all entries that point to this window
    map.retain(|_, label| label != window.label());
```

With:

```rust
    let mut map = lock_or_recover(&state.0, "session_map");
    map.retain(|_, entry| entry.window_label != window.label());
```

- [ ] **Step 3: Update route_deep_link duplicate check (line 129-146)**

Replace:

```rust
    if let Some(session_id) = extract_session_id(&url) {
        let existing_label = {
            let sessions = app.state::<SessionMap>();
            let map = lock_or_recover(&sessions.0, "session_map");
            map.get(&session_id).cloned()
        }; // lock released here
        if let Some(label) = existing_label {
            if let Some(window) = app.get_webview_window(&label) {
```

With:

```rust
    if let Some(session_id) = extract_session_id(&url) {
        let existing_label = {
            let sessions = app.state::<SessionMap>();
            let map = lock_or_recover(&sessions.0, "session_map");
            map.get(&session_id).map(|e| e.window_label.clone())
        }; // lock released here
        if let Some(label) = existing_label {
            if let Some(window) = app.get_webview_window(&label) {
```

- [ ] **Step 4: Remove the main-active check and route-to-main branch in route_deep_link**

Replace the entire block from "Check if main window has an active session" through the end of route_deep_link (lines 148-173):

```rust
    // Check if main window has an active session
    let main_active = {
        let sessions = app.state::<SessionMap>();
        let map = lock_or_recover(&sessions.0, "session_map");
        map.values().any(|label| label == "main")
    };

    if !main_active {
        // Main window is idle — route the deep link there.
        // Recreate the main window if it was closed (macOS).
        if !ensure_main_window(app) {
            // Last resort: try creating a session window instead
            create_session_window(app, url);
            return;
        }
        if let Some(state) = app.try_state::<DeepLinkState>() {
            let mut links = lock_or_recover(&state.0, "deep_link_state");
            links.insert("main".to_string(), url.clone());
        }
        // Emit with retry — the recreated window's webview needs time to load
        emit_with_retry(app, "main", url);
        if let Some(window) = app.get_webview_window("main") {
            if let Err(err) = window.set_focus() {
                eprintln!("Failed to focus main window: {}", err);
            }
        }
    } else {
        // Main is busy with another session — open a new window
        create_session_window(app, url);
    }
```

With:

```rust
    // Always open a new session window. Check update gate first.
    let gate_open = {
        let gate = app.state::<UpdateGate>();
        *lock_or_recover(&gate.0, "update_gate")
    };
    if gate_open {
        create_session_window(app, url);
    } else {
        // Queue until the frontend signals the update check passed
        let pending = app.state::<PendingUrls>();
        let mut queue = lock_or_recover(&pending.0, "pending_urls");
        queue.push(url);
    }
```

- [ ] **Step 5: Update WindowEvent::Destroyed handler (line 347-348)**

Replace:

```rust
                    map.retain(|_, wl| wl != &label);
```

With:

```rust
                    map.retain(|_, entry| entry.window_label != label);
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check 2>&1`
Expected: Clean compilation

- [ ] **Step 7: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "refactor(viewer): update all SessionMap callsites for SessionEntry"
```

---

### Task 3: Rust — New IPC commands (update_session_hostname, set_update_ok)

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Add update_session_hostname command**

Add after the `unregister_session` function:

```rust
/// Called by DesktopViewer when the remote hostname is learned.
/// Uses the calling window's label to find the matching SessionMap entry.
#[tauri::command]
fn update_session_hostname(
    window: tauri::WebviewWindow,
    hostname: String,
    state: tauri::State<'_, SessionMap>,
) {
    let mut map = lock_or_recover(&state.0, "session_map");
    for entry in map.values_mut() {
        if entry.window_label == window.label() {
            entry.hostname = Some(hostname);
            return;
        }
    }
}
```

- [ ] **Step 2: Add set_update_ok command**

Add after `update_session_hostname`:

```rust
/// Called by the main window frontend once the update check passes.
/// Opens the update gate and drains any queued deep link URLs into session windows.
#[tauri::command]
fn set_update_ok(app: tauri::AppHandle) {
    // Open the gate
    {
        let gate = app.state::<UpdateGate>();
        let mut ok = lock_or_recover(&gate.0, "update_gate");
        *ok = true;
    }
    // Drain pending URLs
    let urls: Vec<String> = {
        let pending = app.state::<PendingUrls>();
        let mut queue = lock_or_recover(&pending.0, "pending_urls");
        queue.drain(..).collect()
    };
    for url in urls {
        create_session_window(&app, url);
    }
}
```

- [ ] **Step 3: Register new commands in generate_handler![]**

Replace:

```rust
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            clear_pending_deep_link,
            register_session,
            unregister_session,
        ]);
```

With:

```rust
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            clear_pending_deep_link,
            register_session,
            unregister_session,
            update_session_hostname,
            set_update_ok,
        ]);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check 2>&1`
Expected: Clean compilation

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): add update_session_hostname and set_update_ok IPC commands"
```

---

### Task 4: Rust — Hide main window, rework setup and cold-start

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs` (setup handler, lines 278-340)
- Modify: `apps/viewer/src-tauri/tauri.conf.json` (hide main window)

- [ ] **Step 1: Set main window to hidden in tauri.conf.json**

Replace the `windows` array:

```json
    "windows": [
      {
        "title": "Breeze Remote Desktop",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ]
```

With:

```json
    "windows": [
      {
        "title": "Breeze Remote Desktop",
        "width": 500,
        "height": 340,
        "resizable": false,
        "fullscreen": false,
        "visible": false
      }
    ]
```

- [ ] **Step 2: Rework the setup handler**

Replace the entire setup closure body (lines 279-338) with:

```rust
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
            let initial_url = initial_url.or_else(|| {
                std::env::args().find(|arg| arg.starts_with("breeze:"))
            });

            // Initialize state — no deep links stored for main window anymore
            app.manage(DeepLinkState(Mutex::new(HashMap::new())));
            app.manage(SessionMap(Mutex::new(HashMap::new())));
            app.manage(WindowCounter(Mutex::new(0)));
            app.manage(UpdateGate(Mutex::new(false)));
            // Queue the initial URL if present — it will be drained when set_update_ok is called
            let pending = if let Some(url) = initial_url {
                vec![url]
            } else {
                vec![]
            };
            app.manage(PendingUrls(Mutex::new(pending)));

            // Listen for deep link events when the app is already running.
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    let url = url.to_string();
                    let handle = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || {
                        route_deep_link(&handle, url);
                    });
                }
            });

            Ok(())
        })
```

- [ ] **Step 3: Update create_session_window title**

Replace in `create_session_window`:

```rust
        .title("Breeze Remote Desktop")
```

With:

```rust
        .title("Connecting...")
```

- [ ] **Step 4: Remove the fallback-to-main in create_session_window error handler**

Replace the error branch (lines 215-233):

```rust
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
```

With:

```rust
        Err(e) => {
            eprintln!("Failed to create session window: {}", e);
            if let Some(state) = app.try_state::<DeepLinkState>() {
                let mut links = lock_or_recover(&state.0, "deep_link_state");
                links.remove(&label);
            }
        }
```

- [ ] **Step 5: Update `ensure_main_window` to create a hidden window**

Replace the existing `ensure_main_window` function:

```rust
fn ensure_main_window(app: &tauri::AppHandle) -> bool {
    if app.get_webview_window("main").is_some() {
        return true;
    }
    eprintln!("Main window missing — recreating");
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Breeze Remote Desktop")
        .inner_size(1280.0, 800.0)
        .build()
    {
        Ok(_) => true,
        Err(e) => {
            eprintln!("Failed to recreate main window: {}", e);
            false
        }
    }
}
```

With:

```rust
fn ensure_main_window(app: &tauri::AppHandle) -> bool {
    if app.get_webview_window("main").is_some() {
        return true;
    }
    eprintln!("Main window missing — recreating (hidden)");
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Breeze Remote Desktop")
        .inner_size(500.0, 340.0)
        .visible(false)
        .build()
    {
        Ok(_) => true,
        Err(e) => {
            eprintln!("Failed to recreate main window: {}", e);
            false
        }
    }
}
```

- [ ] **Step 6: Update single-instance no-URL path**

Replace the else branch in single_instance callback (the "No deep link — just activate/focus" block):

```rust
            } else {
                // No deep link — just activate/focus. Recreate main window if needed.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    ensure_main_window(&handle);
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(err) = window.set_focus() {
                            eprintln!(
                                "Failed to focus main window on single-instance activate: {}",
                                err
                            );
                        }
                    }
                });
            }
```

With:

```rust
            } else {
                // No deep link — just activate. Focus most recent session window if any.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    focus_any_session_window(&handle);
                });
            }
```

- [ ] **Step 7: Add focus_any_session_window helper**

Add after `ensure_main_window`:

```rust
/// Focus the highest-numbered session window, or do nothing if none exist.
fn focus_any_session_window(app: &tauri::AppHandle) {
    let counter = app.state::<WindowCounter>();
    let n = *lock_or_recover(&counter.0, "window_counter");
    // Walk backwards from the newest window label to find one that still exists
    for i in (1..=n).rev() {
        let label = format!("session-{}", i);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_focus();
            return;
        }
    }
}
```

- [ ] **Step 8: Update RunEvent handlers — dock icon focus + auto-recreate hidden main**

Replace the entire `app.run` callback:

```rust
    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                if let WindowEvent::Destroyed = event {
                    // Clean up session and deep link state for destroyed windows
                    if let Some(sessions) = app_handle.try_state::<SessionMap>() {
                        let mut map = lock_or_recover(&sessions.0, "session_map");
                        map.retain(|_, entry| entry.window_label != label);
                    }
                    if let Some(links) = app_handle.try_state::<DeepLinkState>() {
                        let mut map = lock_or_recover(&links.0, "deep_link_state");
                        map.remove(&label);
                    }
                }
            }
            // macOS: dock icon clicked with no open windows — recreate main window
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                focus_any_session_window(app_handle);
            }
            _ => {}
        }
    });
```

Note: the `WindowEvent::Destroyed` handler now uses `entry.window_label` (from Task 2 Step 5). The hidden main window is auto-recreated by `ensure_main_window` if it's destroyed and a deep link arrives (handled inside `route_deep_link` indirectly — the main window isn't needed for session windows, but we keep it alive for Tauri lifecycle). If the main window is somehow destroyed, the app stays running as long as session windows exist.

- [ ] **Step 9: Verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check 2>&1`
Expected: Clean compilation

- [ ] **Step 10: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs apps/viewer/src-tauri/tauri.conf.json
git commit -m "feat(viewer): hide main window, route all deep links to session windows with update gate"
```

---

### Task 5: Frontend — Rewrite App.tsx for role-based rendering

**Files:**
- Modify: `apps/viewer/src/App.tsx`

- [ ] **Step 1: Rewrite App.tsx**

Replace the entire file content with:

```tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentType } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';
import { checkForUpdate, type UpdateInfo } from './lib/version';
import { ArrowDownCircle, AlertTriangle } from 'lucide-react';

const UpdateIcon = ArrowDownCircle as unknown as ComponentType<{ className?: string }>;
const AlertIcon = AlertTriangle as unknown as ComponentType<{ className?: string }>;

type UpdateStatus = 'checking' | 'current' | 'outdated' | 'error';

/**
 * Main window: runs update check, stays hidden unless outdated.
 * Session windows: connect via deep link, show DesktopViewer.
 */
export default function App() {
  const [windowLabel, setWindowLabel] = useState<string>('main');
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const lastDeepLinkRef = useRef<{ key: string; at: number } | null>(null);

  // Detect window role on mount
  useEffect(() => {
    try {
      const win = getCurrentWebviewWindow();
      setWindowLabel(win.label);
    } catch {
      // fallback: main
    }
  }, []);

  // ── Main window: update check ──────────────────────────────────────
  useEffect(() => {
    if (windowLabel !== 'main') return;

    checkForUpdate().then((info) => {
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus('outdated');
        // Show the main window so the user sees the update prompt
        try { getCurrentWebviewWindow().show(); } catch {}
      } else {
        setUpdateStatus('current');
        // Signal Rust that it's safe to create session windows
        invoke('set_update_ok').catch(() => {});
      }
    }).catch(() => {
      // Can't reach GitHub — allow usage rather than bricking offline
      setUpdateStatus('error');
      invoke('set_update_ok').catch(() => {});
    });
  }, [windowLabel]);

  // ── Session window: deep link polling + events ─────────────────────
  const applyDeepLink = useCallback((url: string) => {
    const parsed = parseDeepLink(url);
    if (!parsed) return;

    const key = `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`;
    const now = Date.now();
    const last = lastDeepLinkRef.current;
    if (last && last.key === key && now - last.at < 2000) return;

    lastDeepLinkRef.current = { key, at: now };
    invoke('clear_pending_deep_link').catch(() => {});
    setParams(parsed);
    setError(null);
  }, []);

  useEffect(() => {
    if (windowLabel === 'main') return;

    // Path 1: Poll Rust for pending deep link
    let pollCount = 0;
    const maxPolls = 17;
    const pollTimer = setInterval(() => {
      pollCount++;
      invoke<string | null>('get_pending_deep_link').then((url) => {
        if (url) {
          clearInterval(pollTimer);
          applyDeepLink(url);
        } else if (pollCount >= maxPolls) {
          clearInterval(pollTimer);
        }
      }).catch(() => {
        if (pollCount >= maxPolls) clearInterval(pollTimer);
      });
    }, 300);

    // Path 2: Listen for events
    const unlisten = listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      clearInterval(pollTimer);
      unlisten.then((fn) => fn());
    };
  }, [windowLabel, applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastDeepLinkRef.current = null;
    try {
      getCurrentWebviewWindow().close();
    } catch {
      // If close fails, at least clear state
      setParams(null);
    }
  }, []);

  const handleError = useCallback((msg: string) => {
    lastDeepLinkRef.current = null;
    setError(msg);
  }, []);

  const handleOpenDownload = useCallback(async () => {
    const url = updateInfo?.downloadUrl || updateInfo?.releaseUrl;
    if (!url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      window.open(url, '_blank');
    }
    try {
      getCurrentWebviewWindow().close();
    } catch {
      // best-effort
    }
  }, [updateInfo]);

  // ── Main window renders ────────────────────────────────────────────
  if (windowLabel === 'main') {
    // Outdated: show update prompt (window was made visible above)
    if (updateStatus === 'outdated' && updateInfo) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-900">
          <div className="text-center max-w-md px-6">
            <div className="flex items-center justify-center w-16 h-16 bg-amber-600/20 rounded-2xl mx-auto mb-6">
              <AlertIcon className="w-8 h-8 text-amber-400" />
            </div>
            <h1 className="text-2xl font-semibold text-white mb-2">Update Required</h1>
            <p className="text-gray-400 mb-2">
              A new version of Breeze Viewer is available. Please update to continue.
            </p>
            <div className="mb-8 p-3 bg-gray-800/50 rounded-lg">
              <p className="text-gray-300 text-sm">
                Installed: <span className="font-mono text-amber-400">v{updateInfo.currentVersion}</span>
                <span className="mx-2 text-gray-600">&rarr;</span>
                Latest: <span className="font-mono text-green-400">v{updateInfo.latestVersion}</span>
              </p>
            </div>
            <button
              onClick={handleOpenDownload}
              className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition"
            >
              <UpdateIcon className="w-5 h-5" />
              Download Update
            </button>
            <p className="text-gray-600 text-xs mt-4">
              Install the update and relaunch the viewer.
            </p>
          </div>
        </div>
      );
    }
    // Hidden — render nothing (checking or current)
    return null;
  }

  // ── Session window renders ─────────────────────────────────────────
  if (params) {
    return (
      <DesktopViewer
        params={params}
        onDisconnect={handleDisconnect}
        onError={handleError}
      />
    );
  }

  // Waiting for deep link
  return (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <div className="text-center">
        <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-400 text-sm">Connecting...</p>
        {error && (
          <p className="text-red-400 text-sm mt-2">{error}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd apps/viewer && pnpm build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src/App.tsx
git commit -m "feat(viewer): rewrite App.tsx for hidden main window + session-only viewers"
```

---

### Task 6: Frontend — DesktopViewer hostname → window title + IPC

**Files:**
- Modify: `apps/viewer/src/components/DesktopViewer.tsx:306` (hostname received)

- [ ] **Step 1: Add window title update and update_session_hostname call**

Find line 306 where hostname is set from the WS `connected` message:

```typescript
            setHostname(msg.device?.hostname || 'Unknown');
```

Replace with:

```typescript
            const deviceHostname = msg.device?.hostname || 'Unknown';
            setHostname(deviceHostname);
            try {
              getCurrentWebviewWindow().setTitle(deviceHostname);
            } catch {}
            invoke('update_session_hostname', { hostname: deviceHostname }).catch(() => {});
```

- [ ] **Step 2: Add the import if not present**

Check that `getCurrentWebviewWindow` is imported at the top of the file. If not, add:

```typescript
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd apps/viewer && pnpm build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/viewer/src/components/DesktopViewer.tsx
git commit -m "feat(viewer): update window title and session hostname on connect"
```

---

### Task 7: Full build verification

**Files:** None (verification only)

- [ ] **Step 1: Verify Rust compiles clean**

Run: `cd apps/viewer/src-tauri && cargo check 2>&1`
Expected: Clean compilation, no warnings about unused code

- [ ] **Step 2: Verify frontend builds clean**

Run: `cd apps/viewer && pnpm build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 3: Run existing tests**

Run: `cd apps/viewer && pnpm test 2>&1 | tail -20`
Expected: All existing protocol/keymap/paste/wheel tests pass

- [ ] **Step 4: Commit any final cleanup if needed**

---

### Task 8: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Build and launch the viewer**

Run: `cd apps/viewer/src-tauri && cargo tauri dev 2>&1`

Verify:
- App launches with no visible window (main is hidden)
- Dock icon appears on macOS
- Check stderr for any panics or errors

- [ ] **Step 2: Test deep link cold start**

Close the app. Open a `breeze://connect?session=test&code=test&api=https://example.com` deep link (or pass as CLI arg).

Verify:
- App launches
- A session window appears with title "Connecting..."
- Main window stays hidden
- Session window shows "Connecting..." spinner (connection will fail since it's a test URL, which is expected)

- [ ] **Step 3: Test deep link while running**

With the app running, open another deep link with a different session ID.

Verify:
- A second session window opens
- Both windows are independent
- Closing one doesn't affect the other

- [ ] **Step 4: Test duplicate session focus**

Open a deep link with the same session ID as an already-connected session.

Verify:
- No new window created
- Existing window is focused

- [ ] **Step 5: Test dock icon behavior**

Close all session windows. Click the dock icon.

Verify:
- No crash
- No window appears (expected — no sessions active)
