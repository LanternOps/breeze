# Viewer: Dedupe Sessions by Device

**Date:** 2026-04-16
**Status:** Approved (design); awaiting implementation plan

## Problem

When the user clicks "Connect" on a device that already has an open Breeze Viewer window for that device, a second window opens instead of focusing the existing one.

The viewer already dedupes by `session=<uuid>` in the `breeze://connect` deep link, but the web app generates a *new* session id on every click, so the existing dedup never fires. To dedupe properly, the viewer needs a stable identifier — the device id.

## Goal

Clicking "Connect" for a device that already has an open viewer window focuses the existing window instead of opening a new one.

## Non-Goals

- Reusing or restarting the underlying remote session. The existing WebRTC session in the focused window keeps running; the freshly created server-side session for the duplicate click is left to the existing stale-session sweep to clean up.
- Detecting the duplicate in the web app before creating a new session. That requires viewer-state visibility the web app does not have.

## Design

### 1. Web app — add `device` to the deep link

`apps/web/src/components/remote/ConnectDesktopButton.tsx`

Append `&device=<deviceId>` to the deep link constructed at line 186:

```ts
const deepLink =
  `breeze://connect?session=${encodeURIComponent(session.id)}` +
  `&code=${encodeURIComponent(codeData.code)}` +
  `&api=${encodeURIComponent(apiUrl)}` +
  `&device=${encodeURIComponent(deviceId)}`;
```

`deviceId` is already in scope in the request body above.

### 2. Viewer protocol parser — expose `deviceId`

`apps/viewer/src/lib/protocol.ts`

Add `deviceId?: string` to the parser return shape and read the `device` query param. Parser remains permissive: missing `device` is not an error (backward-compatible with older web builds).

`apps/viewer/src/lib/protocol.test.ts`: add a test asserting `deviceId` is parsed when present, and is `undefined` when absent.

### 3. Viewer Rust — device-keyed session map

`apps/viewer/src-tauri/src/lib.rs`

- Add `extract_device_id(url)` mirroring `extract_session_id`.
- Add managed state `DeviceMap(Mutex<HashMap<String, String>>)` mapping `device_id → window_label`.
- New Tauri command:
  ```rust
  #[tauri::command]
  fn register_device(window: WebviewWindow, device_id: String, state: State<DeviceMap>)
  ```
  Inserts/updates the entry for the calling window.
- In `route_deep_link`, before the existing `SessionMap` check, look up the URL's `device` param in `DeviceMap`. If a window exists, focus it and return early (do not create a new window, do not emit the deep link). Use the same lock-then-drop pattern as the session check to avoid macOS re-entrancy.
- Cleanup wiring (mirror `SessionMap`):
  - `WindowEvent::Destroyed` handler: drop entries pointing to the destroyed label.
  - `unregister_session` command: drop entries pointing to the calling window.
- Register the new command in `invoke_handler!` and `app.manage(DeviceMap(...))` in `setup`.

### 4. Viewer frontend — register the device

`apps/viewer/src/components/DesktopViewer.tsx`

When the parsed deep link includes `deviceId`, call `invoke('register_device', { deviceId })` alongside the existing `register_session` invocation. No-op if `deviceId` is missing.

## Backward Compatibility

- Older web builds that don't include `device=` keep current behavior: per-session dedup + new window each click.
- Older viewers that don't know about `device=` ignore the extra query param. Web app change is safe to ship independently.

## Orphan Server-Side Sessions

When a duplicate click is suppressed by device dedup, the new server-side session created in `ConnectDesktopButton` becomes immediately stale. This is acceptable:

- The next click already runs `DELETE /remote/sessions/stale` in parallel before creating a new session.
- Server-side session TTL evicts orphans on its own.

No additional cleanup logic is added in this change.

## Tests

- `apps/viewer/src/lib/protocol.test.ts`: parses `device=` param; absent `device` yields `undefined`.
- Manual: open a session, click "Connect" again on the same device → existing window focuses, no second window. Verify on macOS (where `set_focus` re-entrancy was historically a problem) and Windows.

Rust unit tests are not currently present in `lib.rs`; not adding them in this change.

## Files Touched

- `apps/web/src/components/remote/ConnectDesktopButton.tsx` (1 line)
- `apps/viewer/src/lib/protocol.ts` (add `deviceId` to return shape)
- `apps/viewer/src/lib/protocol.test.ts` (one new test case)
- `apps/viewer/src/components/DesktopViewer.tsx` (one extra `invoke`)
- `apps/viewer/src-tauri/src/lib.rs` (new state, command, route check, cleanup)
