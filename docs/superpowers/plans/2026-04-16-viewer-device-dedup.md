# Viewer Device Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks "Connect" for a device that already has an open Breeze Viewer window, focus the existing window instead of opening a new one.

**Architecture:** Web app adds `device=<deviceId>` to the `breeze://connect` deep link. Viewer maintains a `device_id → window_label` map. On a new deep link, the Rust router checks the device map first; on a match it focuses the existing window and returns early instead of building a new one. The just-created server-side session for the duplicate click is left to the existing stale-session sweep.

**Tech Stack:** TypeScript (web app, viewer frontend), Rust + Tauri 2 (viewer backend), Vitest (frontend tests).

**Spec:** `docs/superpowers/specs/2026-04-16-viewer-device-dedup-design.md`

---

## File Structure

- `apps/web/src/components/remote/ConnectDesktopButton.tsx` — append `&device=<deviceId>` to the deep link.
- `apps/viewer/src/lib/protocol.ts` — add optional `deviceId` to `ConnectionParams` and parse `device` query param.
- `apps/viewer/src/lib/protocol.test.ts` — new tests for `device` parsing.
- `apps/viewer/src-tauri/src/lib.rs` — add `DeviceMap` state, `extract_device_id` helper, `register_device` Tauri command, device-first dedup in `route_deep_link`, cleanup on window destroy and `unregister_session`.
- `apps/viewer/src/components/DesktopViewer.tsx` — invoke `register_device` when `deviceId` is present in the parsed deep link.

---

### Task 1: Parse `device` query param in protocol.ts (TDD)

**Files:**
- Modify: `apps/viewer/src/lib/protocol.ts`
- Test: `apps/viewer/src/lib/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/viewer/src/lib/protocol.test.ts` inside the `describe('parseDeepLink', ...)` block (before its closing `});`):

```ts
  it('parses optional device param', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com&device=dev-123';
    expect(parseDeepLink(url)).toEqual({
      sessionId: 'abc',
      connectCode: 'def',
      apiUrl: 'https://example.com',
      deviceId: 'dev-123',
    });
  });

  it('omits deviceId when device param is absent', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com';
    const result = parseDeepLink(url);
    expect(result).not.toBeNull();
    expect(result!).not.toHaveProperty('deviceId');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter breeze-viewer test -- protocol`

Expected: the two new tests fail (`deviceId` is undefined / not present in returned object).

- [ ] **Step 3: Update `ConnectionParams` and parser**

In `apps/viewer/src/lib/protocol.ts`, change the interface:

```ts
export interface ConnectionParams {
  sessionId: string;
  connectCode: string;
  apiUrl: string;
  targetSessionId?: number;
  deviceId?: string;
}
```

In `parseDeepLink`, after the `targetSessionIdRaw` line (around current line 49) add:

```ts
    const deviceIdRaw = parsed.searchParams.get('device');
    const deviceId = deviceIdRaw && deviceIdRaw.length > 0 ? deviceIdRaw : undefined;
```

Then change the existing `return` statement to spread `deviceId` conditionally, mirroring how `targetSessionId` is handled:

```ts
    return {
      sessionId,
      connectCode,
      apiUrl: api.toString().replace(/\/$/, ''),
      ...(targetSessionId != null ? { targetSessionId } : {}),
      ...(deviceId != null ? { deviceId } : {}),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter breeze-viewer test -- protocol`

Expected: all `parseDeepLink` tests pass, including the two new ones; no other test in the file regresses.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/protocol.ts apps/viewer/src/lib/protocol.test.ts
git commit -m "feat(viewer): parse optional device param from breeze:// deep link"
```

---

### Task 2: Add `device` to deep link in web app

**Files:**
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx:186`

- [ ] **Step 1: Update the deep link construction**

In `apps/web/src/components/remote/ConnectDesktopButton.tsx`, replace the existing line 186:

```ts
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&code=${encodeURIComponent(codeData.code)}&api=${encodeURIComponent(apiUrl)}`;
```

with:

```ts
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&code=${encodeURIComponent(codeData.code)}&api=${encodeURIComponent(apiUrl)}&device=${encodeURIComponent(deviceId)}`;
```

`deviceId` is already in scope from the request body above (used at line 155).

- [ ] **Step 2: Type-check the web app**

Run: `pnpm --filter @breeze/web exec tsc --noEmit`

Expected: no new errors introduced by this change. (Pre-existing errors elsewhere in the repo are out of scope.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/remote/ConnectDesktopButton.tsx
git commit -m "feat(web): include device id in breeze:// connect deep link"
```

---

### Task 3: Add `DeviceMap` state and `extract_device_id` helper in Rust

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Add `DeviceMap` struct definition**

In `apps/viewer/src-tauri/src/lib.rs`, after the `SessionMap` definition (around line 49) add:

```rust
/// Maps device_id → window_label for active sessions.
/// Used to focus an existing window when the same device is connected again.
struct DeviceMap(Mutex<HashMap<String, String>>);
```

- [ ] **Step 2: Add `extract_device_id` helper**

After the existing `extract_session_id` function (around line 87), add:

```rust
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
```

- [ ] **Step 3: Register the state in `setup`**

In the `setup` closure (around line 405), add a third `app.manage(...)` call alongside `DeepLinkState` and `SessionMap`:

```rust
            app.manage(DeepLinkState(Mutex::new(HashMap::new())));
            app.manage(SessionMap(Mutex::new(HashMap::new())));
            app.manage(DeviceMap(Mutex::new(HashMap::new())));
            app.manage(WindowCounter(Mutex::new(0)));
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check`

Expected: compiles with no errors. Warnings about unused `DeviceMap` / `extract_device_id` are OK at this point (they'll be used in Task 4 / 5).

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): add DeviceMap state and extract_device_id helper"
```

---

### Task 4: Add `register_device` command and cleanup wiring

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the `register_device` command**

In `apps/viewer/src-tauri/src/lib.rs`, after the existing `unregister_session` function (around line 125), add:

```rust
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
```

- [ ] **Step 2: Drop device entries in `unregister_session`**

Replace the existing `unregister_session` body so it also clears the `DeviceMap`:

```rust
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
```

- [ ] **Step 3: Drop device entries on `WindowEvent::Destroyed`**

In the `app.run` closure's `WindowEvent::Destroyed` handler (around line 451), add a `DeviceMap` cleanup block alongside the existing `SessionMap` and `DeepLinkState` cleanup:

```rust
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

                    // … (leave the existing "session-" exit-when-empty block unchanged)
```

- [ ] **Step 4: Register the command in `invoke_handler!`**

In the `invoke_handler!` macro call (around line 357), add `register_device`:

```rust
        .invoke_handler(tauri::generate_handler![
            get_pending_deep_link,
            clear_pending_deep_link,
            register_session,
            unregister_session,
            register_device,
            update_session_hostname,
        ]);
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check`

Expected: compiles cleanly. No more "unused" warnings for `DeviceMap`.

- [ ] **Step 6: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): add register_device command + cleanup on close"
```

---

### Task 5: Use `DeviceMap` to focus existing window in `route_deep_link`

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs`

- [ ] **Step 1: Add device-first lookup in `route_deep_link`**

Replace the body of `route_deep_link` (around lines 169–196) with:

```rust
fn route_deep_link(app: &tauri::AppHandle, url: String) {
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
                    eprintln!(
                        "Failed to focus existing device window {}: {}",
                        label, err
                    );
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
                    eprintln!(
                        "Failed to focus existing session window {}: {}",
                        label, err
                    );
                }
            }
            return;
        }
    }

    // No existing window matched — open a new session window.
    create_session_window(app, url);
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd apps/viewer/src-tauri && cargo check`

Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): focus existing window when reconnecting same device"
```

---

### Task 6: Invoke `register_device` from DesktopViewer

**Files:**
- Modify: `apps/viewer/src/components/DesktopViewer.tsx` (around line 689)

- [ ] **Step 1: Add a `register_device` invoke alongside `register_session`**

In `apps/viewer/src/components/DesktopViewer.tsx`, locate the `useEffect` that calls `invoke('register_session', ...)` (around line 689). Replace its body with:

```tsx
	  useEffect(() => {
	    if (status === 'connected' && !sessionRegisteredRef.current) {
	      sessionRegisteredRef.current = true;
	      invoke('register_session', { sessionId: params.sessionId }).catch((err) => {
	        console.error('Failed to register desktop session:', err);
	      });
	      if (params.deviceId) {
	        invoke('register_device', { deviceId: params.deviceId }).catch((err) => {
	          console.error('Failed to register desktop device:', err);
	        });
	      }
	      return;
	    }
	    if (status !== 'connected' && status !== 'reconnecting' && sessionRegisteredRef.current) {
	      sessionRegisteredRef.current = false;
	      invoke('unregister_session').catch((err) => {
	        console.error('Failed to unregister desktop session:', err);
	      });
	    }
	  }, [status, params.sessionId, params.deviceId]);
```

(`unregister_session` already clears the device entry on the Rust side per Task 4, so no separate `unregister_device` is needed.)

- [ ] **Step 2: Type-check the viewer**

Run: `pnpm --filter breeze-viewer exec tsc --noEmit`

Expected: no new errors.

- [ ] **Step 3: Run the viewer test suite**

Run: `pnpm --filter breeze-viewer test`

Expected: all tests pass, including the protocol tests added in Task 1.

- [ ] **Step 4: Commit**

```bash
git add apps/viewer/src/components/DesktopViewer.tsx
git commit -m "feat(viewer): register device id on connect for cross-window dedup"
```

---

### Task 7: Manual verification

**Files:** none (smoke test)

- [ ] **Step 1: Build viewer locally**

Run: `cd apps/viewer && pnpm tauri dev`

Expected: viewer launches.

- [ ] **Step 2: Verify the happy path**

1. From a running web app (`pnpm dev`), open a device and click "Connect" — viewer opens a new session window for that device.
2. Without closing it, click "Connect" again on the same device.
3. Expected: the existing window receives focus; no second window appears.

- [ ] **Step 3: Verify that different devices still get separate windows**

1. With one device window open from Step 2, click "Connect" on a *different* device.
2. Expected: a second window opens for the new device.

- [ ] **Step 4: Verify backward-compat fallback**

Manually craft a `breeze://connect?session=…&code=…&api=…` URL (no `device=`) — e.g., `open "breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com"` on macOS — and confirm the viewer still opens a new window (falls through to session-id dedup, then to window creation). The deep link will fail to actually connect (fake session/code), but the routing path is what's being verified.

- [ ] **Step 5: No commit**

Manual verification only.

---

## Self-Review Notes

- **Spec coverage:** all five "Files Touched" entries from the spec are addressed (Tasks 1, 2, 6 cover frontend; Tasks 3-5 cover Rust). Backward-compat (no `device=`) preserved by Task 5's fallback to session-id dedup. Orphan server-side session handling matches the spec (no extra cleanup added).
- **Type consistency:** `register_device` parameter is `device_id: String` in Rust (snake_case) and invoked from JS with key `deviceId` (Tauri auto-converts to `device_id`). `ConnectionParams.deviceId` is consistent across `protocol.ts`, the test, and `DesktopViewer.tsx`.
- **No placeholders:** every code step contains the exact code to write or replace.
