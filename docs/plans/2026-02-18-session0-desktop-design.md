# Session 0 Remote Desktop — Design

## Problem

When the Breeze agent runs as a Windows service (Session 0), remote desktop shows a black screen. Session 0 is isolated from interactive desktops — DXGI Desktop Duplication, GDI capture, and input APIs (`SetCursorPos`, `SendInput`) all fail because there are no monitors or desktops accessible.

Symptoms observed in agent logs:
- `DXGI Desktop Duplication unavailable` (HRESULT 0x887A0022 — `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`)
- `captured=0 encoded=0 sent=0` across all metric intervals
- `no monitors found`
- `This operation requires an interactive window station`
- `SetCursorPos failed`

## Solution

Move the entire WebRTC pipeline (capture, encode, stream, input) into a helper process that the service spawns **as SYSTEM** in the target interactive session. The service only relays WebRTC signaling (offer/answer) over IPC — no frame data crosses the pipe.

## Architecture

```
Service (Session 0, SYSTEM)              Helper (Session N, SYSTEM)
┌─────────────────────────┐              ┌──────────────────────────┐
│ Session Detector (WTS)  │──detects──→  │ spawned by service       │
│ Helper Spawner          │──spawns───→  │ full desktop access      │
│ Session Broker (IPC)    │◄══pipe════►  │ IPC client               │
│ handleStartDesktop()    │              │                          │
│   relay offer ──────────│──────────→   │ desktop.SessionManager   │
│   ◄── relay answer ─────│◄─────────   │ DXGI capture + H264      │
│                         │              │ WebRTC PeerConnection    │
└─────────────────────────┘              │ InputHandler             │
                                         └──────────────────────────┘
                                                    ↕ WebRTC (direct P2P)
                                         ┌──────────────────────────┐
                                         │ Viewer (Tauri/Browser)   │
                                         └──────────────────────────┘
```

## Data Flow

1. API → WS → Service: `start_desktop` with `{offer, iceServers, displayIndex, targetSessionId?}`
2. Service finds connected helper (or spawns one) with `CanCapture` in target session
3. Service → IPC → Helper: `desktop_start` with `{sessionId, offer, iceServers, displayIndex}`
4. Helper creates PeerConnection, DXGI capturer, H264 encoder, sets offer, generates answer
5. Helper → IPC → Service: response with `{answer}`
6. Service → WS → API: relays answer
7. WebRTC streams directly between helper and viewer (P2P, no frame data over IPC)
8. Input goes through WebRTC DataChannel → helper's InputHandler

## Helper Spawning (Windows)

The service spawns helpers as SYSTEM in the target session:

1. `DuplicateTokenEx(own SYSTEM token)` → duplicate token
2. `SetTokenInformation(duplicate, TokenSessionId, targetSession)`
3. `CreateProcessAsUser(duplicate, "breeze-agent user-helper", desktop="winsta0\\Default")`

This gives the helper:
- SYSTEM privileges (full access to all desktops including Winlogon)
- Presence in the interactive session (DXGI and input APIs work)
- UAC/lock screen capture via existing `switchToInputDesktop()`
- Network access for WebRTC ICE

### Spawn triggers

| Trigger | Action |
|---------|--------|
| User logs in (WTS event) | Auto-spawn helper in that session |
| Desktop requested, no helper | On-demand spawn into target session |
| Login screen requested | On-demand spawn into console session |
| User logs out / disconnects | Helper exits, broker cleans up |

## Multi-Session Support

### `list_sessions` command

API sends this to the agent; agent merges WTS detector data with broker connection state:

```json
{
  "sessions": [
    {"sessionId": 1, "username": "jsmith", "state": "active", "type": "console", "helperConnected": true},
    {"sessionId": 2, "username": "admin",  "state": "disconnected", "type": "rdp", "helperConnected": true},
    {"sessionId": 0, "username": "",       "state": "active", "type": "services", "helperConnected": false}
  ]
}
```

### `start_desktop` with `targetSessionId`

```json
{"sessionId": "desk-abc", "offer": "...", "iceServers": [...], "targetSessionId": 2}
```

- If `targetSessionId` provided → route to helper in that Windows session
- If omitted → route to console session (backwards-compatible)
- If no helper in target → spawn one on-demand, then relay

### Session switching

Stop current session + start new one targeting different session. WebRTC renegotiation happens automatically. No special `switch_session` message needed.

## Secure Desktop Access

Because the helper runs as SYSTEM:
- `OpenInputDesktop(GENERIC_ALL)` succeeds for all desktops (Default, Winlogon, Screensaver)
- Existing `switchToInputDesktop()` in `capture_dxgi_windows.go` handles UAC/lock screen transitions
- Login screen capture works by spawning into the console session before any user logs in

## Files to Create

| File | Purpose |
|------|---------|
| `agent/internal/sessionbroker/spawner_windows.go` | `SpawnHelperInSession(sessionID)` — Win32 token + CreateProcessAsUser |
| `agent/internal/sessionbroker/spawner_stub.go` | No-op for non-Windows builds |
| `agent/internal/userhelper/desktop.go` | Desktop session lifecycle in helper (wraps `desktop.SessionManager`) |

## Files to Modify

| File | Change |
|------|--------|
| `agent/internal/userhelper/client.go` | Implement `handleDesktopStart/Stop`, add desktop manager field, fix `detectCapabilities` for Windows |
| `agent/internal/heartbeat/handlers_desktop.go` | `handleStartDesktop` checks for helper → IPC relay or direct fallback; add `handleListSessions` |
| `agent/internal/sessionbroker/broker.go` | Add `FindCapableSession("capture")`, auto-spawn on session events |
| `agent/internal/sessionbroker/detector_windows.go` | Expose session info (username, type, state) for `list_sessions` |
| `agent/internal/ipc/message.go` | Add `DesktopStartRequest`, `DesktopStartResponse` structs |
| `agent/internal/remote/tools/commands.go` | Add `CmdListSessions` constant |

## What Stays the Same

- Direct capture path (non-service / dev mode) — unchanged
- All WebRTC, capture, encode, input code — reused as-is inside helper
- `switchToInputDesktop()` — still used inside helper for UAC transitions
- IPC protocol (HMAC, framing, named pipes) — already built
- Session broker auth and rate limiting — already built
- Viewer-side code — no changes needed (offer/answer protocol unchanged)

## Edge Cases

| Case | Handling |
|------|----------|
| Helper dies mid-session | WebRTC `disconnected` state → viewer reconnects → service re-spawns helper |
| RDP session disconnect | Helper stays alive (disconnected sessions still have desktops via DXGI) |
| Multiple logged-in users | Each session gets its own helper; `targetSessionId` selects which one |
| Fast user switching | Detector sees new session → spawns new helper |
| Dev mode (not a service) | Falls through to direct `SessionManager.StartSession()` as today |
| Helper spawn fails | Return error to API; log details for debugging |
| No interactive sessions | Return session list showing only services session; spawn into console on-demand |
