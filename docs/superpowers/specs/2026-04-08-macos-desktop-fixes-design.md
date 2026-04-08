# macOS Remote Desktop Fixes — Design Spec

**Date:** 2026-04-08
**Reporter:** semotech (external user)
**Devices affected:** 2014 Mac mini (macOS 12 Monterey), likely all pre-Sonoma Macs

## Problem Summary

Three related issues with macOS remote desktop:

1. **Agent disables Apple Remote Management** on every startup/update, killing the user's independently-configured Screen Sharing service.
2. **Input not working at login screen** — when Mac is at the login window, WebRTC video capture works (user_session helper captures the physical display showing the login screen), but clicks and keyboard are blocked because the input handler uses CGEvent, which macOS silently blocks at the login window.
3. **Session selection cleanup** — `preferredDesktopSessionLocked()` has iteration-order-dependent logic that can pick the wrong helper when both user_session and login_window helpers exist.

## Root Cause Analysis

### Bug 1: Remote Management disabled on startup

`CleanupOrphanedVNC()` in `agent/internal/tunnel/manager.go:156` runs on every agent startup via `heartbeat.go`. It checks if port 5900 is listening and calls `DisableScreenSharing()` which runs:

```
/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -deactivate -stop
```

This disables ALL of Apple's Remote Management, not just Breeze-initiated VNC. Additional trigger points:
- Tunnel manager shutdown (agent update/restart) — `manager.go:184`
- Idle tunnel reaping (5min timeout) — `manager.go:228`
- Any VNC tunnel close — `handlers_tunnel.go`

### Bug 2: Input blocked at login window

`NewInputHandler()` in `input_darwin.go:274` is called once when a WebRTC session starts and receives `desktopContext` (either `"user_session"` or `"login_window"`). For `user_session` context, it uses CGEvent exclusively. macOS blocks CGEvent clicks and keyboard (but not mouse movement) at the login window.

The `login_window` context uses IOHIDPostEvent which works at the login window, but:
- On pre-Sonoma Macs, there's no `login_window` helper (unsupported OS)
- The `user_session` helper captures the physical display fine, showing the login screen
- But its input handler is locked to CGEvent, making it read-only

### Bug 3: Session selection iteration order

`preferredDesktopSessionLocked()` in `broker.go:291` iterates a Go map (random order). The preference logic on lines 304-312 only works if certain helpers appear in a specific order. This is a correctness issue for Sonoma+ Macs where both helper types exist.

## Design

### Fix 1: Stop touching Remote Management

**Principle:** Never disable Apple Screen Sharing unless Breeze explicitly enabled it in the current process lifetime.

**Changes to `agent/internal/tunnel/manager.go`:**

- Add a `breezeEnabledVNC` boolean field to `Manager` (not persisted — defaults to false on startup)
- `EnableScreenSharing()` sets `breezeEnabledVNC = true`
- `DisableScreenSharingIfIdle()` checks `breezeEnabledVNC` before calling `DisableScreenSharing()`; if false, does nothing
- `CleanupOrphanedVNC()` — remove entirely. On startup, we don't know who enabled Screen Sharing, so we don't touch it.
- `Stop()` — only disable if `breezeEnabledVNC` is true

**Future (not this PR):** If Breeze needs to manage Screen Sharing proactively, expose it via Config Policy with user choice:
1. "User manages Remote Management" (Breeze never touches it)
2. "Breeze manages Remote Management" (enable/disable as needed for VNC tunnels)

### Fix 2: Dynamic input switching at login window

**Principle:** The input handler should switch between CGEvent and IOHIDPostEvent based on the current console state, not the static context at launch.

**Changes to `agent/internal/remote/desktop/input_darwin.go`:**

1. **Always initialize HID connection** in `NewInputHandler()` regardless of `desktopContext`:
   - Try `openHIDConnection()` for all contexts. The desktop helper has Accessibility TCC permission (confirmed in semotech screenshots), which grants IOHIDSystem access even though it runs as the user (not root).
   - If HID init fails, log warning but don't disable input — fall back to CGEvent
   - `inputAvailable` always true (CGEvent mouse movement always works)

2. **Add `atLoginWindow` atomic flag** to `DarwinInputHandler`:
   ```go
   type DarwinInputHandler struct {
       mouseDown      bool
       mouseBtn       int
       scaleFactor    float64
       hidAvailable   bool          // true if IOHIDSystem connection succeeded
       atLoginWindow  atomic.Bool   // dynamically toggled by console user changes
       inputAvailable bool          // always true now (CGEvent mouse at minimum)
   }
   ```

3. **Each input method** checks `atLoginWindow` + `hidAvailable`:
   - If `atLoginWindow && hidAvailable` → use IOHIDPostEvent (full input at login screen)
   - If `atLoginWindow && !hidAvailable` → use CGEvent (mouse only, clicks/keyboard will fail but at least mouse works)
   - If `!atLoginWindow` → use CGEvent (normal user session)

4. **Add `SetAtLoginWindow(bool)` method** to both `InputHandler` interface and `DarwinInputHandler`:
   ```go
   // SetAtLoginWindow toggles login-window input mode. When true and HID is
   // available, input uses IOHIDPostEvent (works at macOS login screen).
   // When false, input uses CGEvent (normal user session).
   SetAtLoginWindow(atLoginWindow bool)
   ```
   Windows implementation is a no-op.

**Changes to `agent/internal/ipc/message.go`:**

5. **New IPC message type** `TypeConsoleUserChanged`:
   ```go
   TypeConsoleUserChanged = "console_user_changed"
   ```
   Payload: `{ "username": "loginwindow" }` or `{ "username": "alice" }`

**Changes to `agent/internal/heartbeat/desktop_handoff_darwin.go`:**

6. **Broadcast console user change** to all connected desktop helpers when `SetConsoleUser()` is called. Add to `handleDarwinSessionEvent()`:
   ```go
   // Notify active desktop helpers of console user change so they can
   // switch input injection method (CGEvent vs IOHIDPostEvent).
   h.sessionBroker.BroadcastToDesktopSessions(ipc.TypeConsoleUserChanged, map[string]string{
       "username": newConsoleUser,
   })
   ```

**Changes to `agent/internal/userhelper/client.go` (helper IPC dispatch):**

7. **Add `TypeConsoleUserChanged` case** to the message dispatch switch at line ~291. When received, call `c.desktopMgr.setAtLoginWindow(username == "loginwindow")` which propagates to all active WebRTC sessions' input handlers.

**Changes to `agent/internal/userhelper/desktop.go`:**

8. **Add `setAtLoginWindow(bool)` method** to `helperDesktopManager` — calls through to `SessionManager.SetAtLoginWindow(bool)` which updates all active sessions.

**Changes to `agent/internal/remote/desktop/session_manager.go` (or equivalent):**

9. **Add `SetAtLoginWindow(bool)` method** to `SessionManager` — iterates active sessions and calls `session.inputHandler.SetAtLoginWindow(bool)` on each.

### Fix 3: Session selection cleanup

**Changes to `agent/internal/sessionbroker/broker.go`:**

Simplify `preferredDesktopSessionLocked()` to use a two-pass approach:

```go
func (b *Broker) preferredDesktopSessionLocked() *Session {
    atLoginWindow := b.consoleUser == "loginwindow"

    // Pass 1: if at login window, try login_window helpers first.
    if atLoginWindow {
        var best *Session
        for _, s := range b.sessions {
            if !s.HasScope("desktop") || s.Capabilities == nil || !s.Capabilities.CanCapture {
                continue
            }
            if s.DesktopContext == ipc.DesktopContextLoginWindow {
                if best == nil || betterDesktopSession(s, best) {
                    best = s
                }
            }
        }
        if best != nil {
            return best
        }
        // No login_window helper — fall through to user_session helpers
        // (they can still capture the login screen on macOS, input will
        // use IOHIDPostEvent via dynamic switching).
    }

    // Pass 2: best available session (normal selection or login window fallback).
    var best *Session
    for _, s := range b.sessions {
        if !s.HasScope("desktop") || s.Capabilities == nil || !s.Capabilities.CanCapture {
            continue
        }
        if best == nil || betterDesktopSession(s, best) {
            best = s
        }
    }
    return best
}
```

This is iteration-order independent and deterministic.

## Files Changed

| File | Change |
|------|--------|
| `agent/internal/tunnel/manager.go` | Add `breezeEnabledVNC` flag, guard all disable calls, remove `CleanupOrphanedVNC()` |
| `agent/internal/tunnel/vnc_darwin.go` | Return `breezeEnabledVNC` flag from `EnableScreenSharing()` |
| `agent/internal/heartbeat/heartbeat.go` | Remove `CleanupOrphanedVNC()` call at startup |
| `agent/internal/remote/desktop/input.go` | Add `SetAtLoginWindow(bool)` to `InputHandler` interface |
| `agent/internal/remote/desktop/input_darwin.go` | Always init HID, add atomic `atLoginWindow` flag, dynamic switching |
| `agent/internal/remote/desktop/input_windows.go` | No-op `SetAtLoginWindow` |
| `agent/internal/remote/desktop/session_control.go` | Remove `sendInputStatus` (input always available now), update `handleInputMessage` |
| `agent/internal/ipc/message.go` | Add `TypeConsoleUserChanged` |
| `agent/internal/heartbeat/desktop_handoff_darwin.go` | Broadcast console user change to desktop helpers |
| `agent/internal/sessionbroker/broker.go` | Two-pass session selection, add `BroadcastToDesktopSessions()` |
| `agent/internal/userhelper/client.go` | Handle `TypeConsoleUserChanged` in IPC dispatch |
| `agent/internal/userhelper/desktop.go` | Add `setAtLoginWindow(bool)` pass-through |
| `agent/internal/remote/desktop/session_manager.go` | Add `SetAtLoginWindow(bool)` to propagate to active sessions |

## Testing

1. **VNC cleanup removal** — start agent with Apple Screen Sharing enabled → verify it stays enabled after agent restart
2. **Input at login window** — connect to Mac at login screen via WebRTC → verify mouse, clicks, and keyboard all work
3. **Dynamic switching** — connect while user logged in → user logs out → verify input switches to HID mode automatically
4. **Session selection** — with both helper types, verify login_window preferred at login screen, user_session preferred when logged in
5. **Existing behavior preserved** — VNC tunnel open still enables Screen Sharing, close still disables (only Breeze-initiated)

## Out of Scope

- Config Policy for Remote Management management (future PR)
- VNC tunnel removal (VNC tunnels still work when explicitly requested)
- Login window helper support for pre-Sonoma Macs (the dynamic input fix makes this unnecessary)
