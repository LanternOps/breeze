# Session Switcher for Tauri Viewer

**Date:** 2026-04-04
**Status:** Approved

## Problem

Remote desktop connections always route to the console session. Admins cannot view or switch between RDP sessions, and disconnected sessions are invisible. The agent-side infrastructure for `targetSessionId` routing exists but the viewer has no UI to use it.

## Design

### UX Flow

A dropdown appears in the viewer toolbar when the target machine has more than one Windows session. It sits next to the existing monitor switcher and follows the same visual pattern.

On connection, the viewer sends `list_sessions` over the WebRTC control channel. The dropdown shows each session with username, type badge (Console / RDP), and state indicator (green dot for active, yellow for disconnected). The current session is highlighted in blue.

Clicking a different session tears down the current WebRTC connection, shows a "Switching to [username]..." overlay, and reconnects via `POST /offer` with `targetSessionId` set to the chosen session ID. The session list auto-refreshes every 30 seconds and after each switch.

### Control Channel Protocol

Viewer to agent:
```json
{ "type": "list_sessions" }
```

Agent to viewer:
```json
{
  "type": "sessions",
  "sessions": [
    { "sessionId": 1, "username": "Admin", "state": "active", "type": "console", "helperConnected": true },
    { "sessionId": 2, "username": "User", "state": "disconnected", "type": "rdp", "helperConnected": false }
  ]
}
```

No `switch_session` control message. Switching is tear-down-and-reconnect: the viewer disconnects the current WebRTC session and creates a new one with `targetSessionId`. This avoids the complexity of hot-swapping capture across helper processes.

### Agent Changes

**Control message handler** (`agent/internal/remote/desktop/session_control.go`): Add a `list_sessions` case to `handleControlMessage`. The helper calls `sessionbroker.NewSessionDetector().ListSessions()` directly — WTS session enumeration works from any SYSTEM process, no broker access needed. Filter out `type == "services"` (Session 0). Return the same `SessionInfoItem` structure used by the heartbeat `list_sessions` command.

**Relax disconnected-session skip** (`agent/internal/heartbeat/handlers_desktop_helper.go`): In `findOrSpawnHelper`, the `isWinSessionDisconnected` check currently rejects disconnected sessions unconditionally. Change to only skip when `targetSession == ""` (auto-detect mode). When `targetSession != ""` (user explicitly chose the session), allow the spawn attempt. If DXGI fails on a disconnected session, the GDI fallback will attempt capture. If that also fails, the viewer receives a clear error via the session status.

**No changes needed to**: `SpawnHelperInSession` (handles any session ID), `startDesktopViaHelper` / `targetSessionId` plumbing (already wired), `handleListSessions` heartbeat command (separate path, already works).

### Viewer Changes

**`DesktopViewer.tsx`** — State and control channel wiring:
- `sessions` and `activeSession` state variables
- On control channel open, send `list_sessions` alongside `list_monitors`
- Handle `sessions` response in the control message switch
- 30-second `setInterval` to re-send `list_sessions` for live updates
- `handleSwitchSession(sessionId)` callback: shows overlay, disconnects, reconnects with `targetSessionId`

**Reconnection flow when switching:**
1. Store chosen `targetSessionId`
2. Close current WebRTC session
3. Show "Switching to [username]..." overlay
4. Call `createWebRTCSession` with new `targetSessionId`
5. On success: update `activeSession`, clear overlay, send `list_sessions` + `list_monitors` on new control channel
6. On failure: show error with retry/switch-back option

**`ViewerToolbar.tsx`** — Dropdown UI:
- New props: `sessions: SessionInfo[]`, `activeSession: number | null`, `onSwitchSession: (id: number) => void`
- Dropdown button with user icon, visible when `sessions.length > 1`
- Each entry: username, type badge (Console / RDP), state dot (green = active, yellow = disconnected)
- Active session highlighted blue
- Same styling conventions as monitor switcher

**`webrtc.ts`** — No changes needed. `targetSessionId` is already plumbed into `createWebRTCSession` and the offer POST body.

### Files Modified

| File | Change |
|---|---|
| `agent/internal/remote/desktop/session_control.go` | Add `list_sessions` control message handler |
| `agent/internal/heartbeat/handlers_desktop_helper.go` | Relax disconnected-session skip when targetSession is explicit |
| `apps/viewer/src/components/DesktopViewer.tsx` | Session state, control channel wiring, switch logic |
| `apps/viewer/src/components/ViewerToolbar.tsx` | Session dropdown UI |

### Not In Scope

- Session chooser before initial connection (connect always targets console/auto-detect, then switch from toolbar)
- `WTSConnectSession` to reactivate disconnected sessions (rely on GDI fallback or error)
- Web viewer support (Tauri viewer only for now)
- Concurrent multi-session viewing (one session at a time, switch to change)
