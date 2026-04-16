# In-Viewer WebRTC ↔ VNC Switcher (macOS)

**Date:** 2026-04-16
**Status:** Approved (design)

## Problem

The Tauri viewer (`apps/viewer`) only speaks WebRTC (with a JPEG/WebSocket fallback). On macOS at the login window, our WebRTC pipeline can capture video but `CGEventPost(kCGHIDEventTap)` is blocked by the OS — input is impossible. macOS Screen Sharing (`screensharingd` on `:5900`, with Apple Remote Desktop authentication) works fine at the login window because Apple ships it with private entitlements we cannot replicate.

Today the workaround uses the **web** noVNC client (`apps/web/src/components/remote/VncViewer.tsx`) opened in a browser tab. The web app already builds a `breeze://vnc?tunnel=...&ws=...` deep link and tries to launch the viewer, but the viewer doesn't handle that scheme and falls back to "Open in Browser." That breaks the workflow operators expect: the desktop window stays inside the Breeze viewer.

We also can't currently switch transports mid-session — if a remote user logs out while the operator is connected via WebRTC, the operator gets a black screen and has to manually launch a separate VNC session.

## Goals

1. The Tauri viewer can render a VNC session inside the same window it uses for WebRTC.
2. Operators can flip between WebRTC and VNC inside the viewer without re-launching from the web.
3. macOS sessions auto-fall-back from WebRTC to VNC when WebRTC becomes unviable (login window, capture failure). Switching the *other* direction (back to WebRTC after a user logs in) is operator-initiated.
4. Cleanup invariants from the existing JIT VNC fallback design (`2026-04-05-jit-vnc-fallback-design.md`) carry over — Screen Sharing must never be left enabled after a session ends.

## Non-Goals

- Linux / Windows VNC fallback (their WebRTC pipelines work at all session states).
- Sub-second auto-handoff. Tear-down + reconnect (~1–2 s of black screen) is acceptable.
- Persisting "preferred transport" across sessions.
- VNC under any auth model other than ARD username + password.
- Bandwidth / quality controls for the VNC transport (noVNC defaults are fine).
- Recording / session capture parity — WebRTC has it; VNC doesn't, and that's OK for now.

## Architecture

A single Tauri viewer window owns one device session at a time. Inside, a transport layer provides one of three pipes to the agent:

```
                   ┌─ webrtc      H264/RTP via pion. Full input + audio + clipboard + monitors.
DesktopViewer ────┼─ websocket   JPEG fallback. Already exists, untouched.
                   └─ vnc         noVNC over tunnel-WS to agent's screensharingd:5900.
```

Three things change to make this work:

### 1. Transport modules

Extract `connectWebRTC` and `connectWebSocket` from the 1600-line `DesktopViewer.tsx` into per-transport modules. Add `vnc.ts` alongside.

```
apps/viewer/src/lib/
  transports/
    types.ts        — shared TransportSession interface
    webrtc.ts       — extracted from DesktopViewer.tsx
    websocket.ts    — extracted from DesktopViewer.tsx
    vnc.ts          — new
  tunnel.ts         — new: POST/DELETE /tunnels, ws-ticket
```

Shared interface:

```ts
export interface TransportSession {
  kind: 'webrtc' | 'websocket' | 'vnc';
  close(): void;
  capabilities: {
    monitors: boolean;        // monitor switcher (webrtc only)
    bitrateControl: boolean;  // bitrate slider (webrtc only)
    audio: boolean;
    sas: boolean;             // Ctrl+Alt+Del (webrtc only)
    sessionSwitch: boolean;   // session switcher (webrtc only)
    clipboardChannel: boolean;
  };
  inputChannel?: { send(json: string): void };
  controlChannel?: {
    send(json: string): void;
    on(event: string, cb: (msg: unknown) => void): void;
  };
  videoElement?: HTMLVideoElement;   // webrtc
  canvasElement?: HTMLCanvasElement; // websocket
  vncContainer?: HTMLDivElement;     // vnc
}
```

`vnc.ts` extracts the noVNC `RFB` setup from the existing `apps/web/src/components/remote/VncViewer.tsx` (the `connect()` function inside its main `useEffect`) into a plain function returning a `TransportSession`. The React component itself is not lifted; only the wiring is shared in spirit.

### 2. Tunnel client in the viewer

`apps/viewer/src/lib/tunnel.ts` — thin wrapper around `POST /tunnels {deviceId, type:'vnc'}`, `POST /tunnels/:id/ws-ticket`, `DELETE /tunnels/:id`. Uses the access token already obtained via the existing connect-code exchange (`exchangeDesktopConnectCode`). No new API surface.

### 3. Desktop state stream

The agent already detects loginwindow ↔ user-session transitions (`agent/internal/heartbeat/desktop_handoff_darwin.go`). Surface those transitions to the viewer over the existing WebRTC control channel:

```json
{ "type": "desktop_state", "state": "loginwindow" | "user_session", "userName": "olive" }
```

Fired on:
- Initial helper attach (so the viewer knows the starting state).
- Any handoff event the reconciler observes.

When the viewer is on VNC (no control channel available), it falls back to polling `GET /devices/:id/desktop-access` every ~5 s while connected. Polling is good enough for a "should I offer to switch?" signal — the tunnel relay stays a clean byte pipe.

## Agent Changes

### `agent/internal/tunnel/vnc_darwin.go`

Drop the password parameter:

```go
func EnableScreenSharing() error
func DisableScreenSharing() error
```

`EnableScreenSharing` runs:
```
kickstart -activate -configure -access -on -allUsers -privs -all -restart -agent
```

No `-setvncpw`, no `-vnclegacy`. macOS Screen Sharing accepts ARD authentication (real macOS user accounts) by default — that's the auth path operators already use successfully.

`DisableScreenSharing` is unchanged: `kickstart -deactivate -stop`. Idempotent.

### `agent/internal/heartbeat/handlers_tunnel.go`

`handleTunnelOpen` no longer reads `vncPassword` from the payload — it just calls `EnableScreenSharing()`.

### `agent/internal/heartbeat/desktop_handoff_darwin.go`

Add a small hook so the existing reconciler emits `desktop_state` JSON over any active WebRTC control channel:

- On user-session helper attach → `{state:"user_session", userName: "<resolved>"}`.
- On loginwindow helper attach → `{state:"loginwindow"}`.
- On handoff → fire matching event.

The exact wiring goes through whatever desktop-helper → control-channel hook already exists; no new transport.

### Backward compatibility

Old API payloads that include `vncPassword` are ignored. Old web clients that try to inject a password via `rfb.sendCredentials({password})` still work — noVNC's ARD path only triggers when the agent advertises ARD auth, which happens regardless of whether the legacy VNC password was set.

## API Changes

### `apps/api/src/routes/tunnels.ts`

`POST /tunnels` no longer generates a `vncPassword`, no longer includes one in the `tunnel_open` payload, no longer returns one in the response body.

Existing policy gate (`vncRelay` boolean in remote-access policy) is unchanged.

### Sunsetting the legacy password path

Same PR removes:
- `vncPassword` field from the `tunnel_open` command payload schema.
- Password generation in `POST /tunnels`.
- `password` query param plumbing in `apps/web/src/pages/remote/vnc/[tunnelId].astro` and `VncViewerPage.tsx`.
- Password badge UI in `VncViewerPage.tsx`.

ARD auth becomes the only supported VNC auth mode.

## Web Changes

### `apps/web/src/components/remote/VncViewer.tsx`

- Remove the `password?: string` prop.
- Remove the auto-injection branch in the `credentialsrequired` handler — always show the username + password prompt (the existing `needsUsername` branch handles ARD; both fields visible).

### `apps/web/src/components/remote/ConnectVncButton.tsx`

No code change required for the deep link — it's already `breeze://vnc?tunnel=...&ws=...`. With the password gone we just don't append `&pwd=`.

## Viewer Changes

### Deep link

Register `breeze://vnc` URL scheme in `apps/viewer/src-tauri/tauri.conf.json` alongside the existing `breeze://desktop` handler. App.tsx parses:

```
breeze://vnc?tunnel=<id>&ws=<wsUrl>&deviceId=<uuid>&apiUrl=<url>&accessToken=<jwt>
```

The `accessToken` is critical — the viewer needs it to call `tunnel.create()` later for auto-switching. The web app already mints this via the existing connect-code exchange.

App.tsx routes a VNC deep link to `<DesktopViewer params={...} initialTransport="vnc">`.

### `DesktopViewer.tsx` shrinks

The connect logic becomes:

```ts
const session = await transports[transport].connect(auth, deps);
```

The current mass of WebRTC stat polling, control-channel listeners, monitor handling, etc. moves into `webrtc.ts` as part of the session it returns. `DesktopViewer.tsx` keeps: status overlay, reconnect orchestration, toolbar wiring, transport switching, deep-link handling.

### Auto-handoff state machine

```
                    user logs in
   [VNC]  ──────────────────────────►  toolbar shows "<userName> logged in — Switch to WebRTC"
     ▲                                 (manual click; operator focus preserved)
     │
     │ WebRTC fails or
     │ desktop_state goes to loginwindow
     │
   [WebRTC]  ◄──── manual click "Switch to WebRTC"
```

**Auto-fall-back to VNC** (one direction, automatic):
- WebRTC `connectionState` reaches `failed` AND the existing 30 s reconnect deadline expires.
- Agent emits `desktop_state: loginwindow` over the control channel.
- Agent reports `desktopAccess.mode === 'unavailable'` on (re)connect.

**"Switch to WebRTC" pill** (manual click required):
- On VNC, polling sees `desktopAccess.mode === 'available'` AND `osType === 'macos'` AND `state === 'user_session'`.
- Toolbar shows a non-modal pill: `<userName> logged in — Switch to WebRTC`.
- Auto-dismiss after 30 s; reappears if state changes again.

**Manual override (always available, macOS only):**
- Toolbar dropdown: `Transport: WebRTC ▾` → options `WebRTC`, `VNC`.
- Disabled options show a tooltip ("WebRTC unavailable: device is at login window").
- Clicking switches immediately via the same teardown / new-connect path as auto-handoff.

### Switch implementation

1. `setStatus('switching')` — overlay reuses the existing `switchingSession` style with new copy ("Switching to VNC…" / "Switching to WebRTC…").
2. Tear down current session via `session.close()`.
3. If switching to VNC: `tunnel.create(deviceId)` → `{tunnelId, wsUrl}`.
4. If switching to WebRTC: reuse cached `auth`, call `webrtc.connect(auth)`.
5. Cache previous transport's session/tunnel handle. If new transport fails, restore previous and surface error banner ("Failed to switch to VNC. Restored WebRTC session.").

### UI: switcher hidden on non-Mac

The transport dropdown, "Switch available" pill, and any Mac-specific cleanup live behind `if (remoteOs === 'macos')`. On Windows / Linux the toolbar looks identical to today — static `WebRTC` indicator only. `remoteOs` is already tracked in `DesktopViewer.tsx`.

### Capability-aware toolbar

`ViewerToolbar.tsx` reads `session.capabilities` and hides controls VNC can't drive: monitor switcher, bitrate slider, FPS dropdown, audio toggle, SAS button, session switcher. Keeps: clipboard sync (noVNC supports it), scaling toggle, paste-as-keystrokes, disconnect.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Operator clicks "Switch to VNC" while WebRTC reconnect timer is running | Cancel reconnect first, then teardown + tunnel-create + connect. |
| Tunnel-create fails on switch (agent offline) | Restore previous session if alive; otherwise show error with Retry. |
| Operator on VNC, agent goes offline | Tunnel close fires; existing "Agent offline" + reconnect path. |
| Viewer window closed mid-session | Existing `unregister_session` runs; tunnel close fires; agent disables Screen Sharing. |
| Two viewer windows for the same device on different transports | Each owns its own tunnel / WebRTC session. No coordination. |
| `desktop_state: loginwindow` arrives while operator is typing on WebRTC | WebRTC will already be failing. Auto-fall-back path handles it. |
| ARD auth fails (wrong creds) | noVNC's existing `securityfailure` handler shows error; operator retries — no agent involvement. |

## Cleanup Invariants

Carried over from `2026-04-05-jit-vnc-fallback-design.md`:

- VNC tunnel close → agent runs `DisableScreenSharing()`. Idempotent.
- Idle reaper (30 s tick / 5 min idle) closes orphaned tunnels and disables Screen Sharing.
- Agent startup: if `127.0.0.1:5900` is listening and no tunnels are active, disable Screen Sharing.
- Atomic enable: if `kickstart -activate` succeeds but the port check fails, immediately call `DisableScreenSharing()` before returning the error.

## Build Order

The refactor of `DesktopViewer.tsx` is risky (1600 lines, working code). Sequence:

1. **PR 1 — Pure refactor.** Extract `webrtc.ts` and `websocket.ts` into `transports/`. No behavior change. Verified by running through the existing test matrix on Mac + Windows + Linux devices.
2. **PR 2 — Agent + API.** Drop the legacy VNC password path everywhere. Add `desktop_state` events. Wire up `tunnel.ts` in viewer. Strip password UI from web.
3. **PR 3 — Viewer VNC transport.** Add `vnc.ts`, deep-link route, switcher UI, auto-handoff state machine.

Each PR is independently shippable; PR 3 is the user-visible feature.

## Testing Checklist

- macOS 14+ at user session: WebRTC default, manual switch to VNC works.
- macOS at loginwindow on session start: VNC auto-selected from the start.
- macOS user logs out while operator on WebRTC: WebRTC fails → auto-switch to VNC.
- macOS user logs in while operator on VNC: "Switch to WebRTC" pill appears.
- Non-Mac device: toolbar shows no switcher (verify hidden, no dropdown DOM rendered).
- Tunnel cleanup verified: after disconnect, `lsof -i :5900` on the Mac returns nothing.
- Switch failure path: kill the agent during a switch, confirm the previous session is restored and the error banner appears.
- ARD auth: confirm noVNC prompts for username + password, accepts the macOS user account, rejects bad creds with a clear error.

## Related

- `docs/superpowers/specs/2026-04-05-jit-vnc-fallback-design.md` — original VNC tunnel + agent integration (cleanup invariants carry over).
- `LanternOps/breeze#330` — auto-reconnect viewer on login/logout (this spec covers the macOS path).
- `LanternOps/breeze#331` — black screen after remote user logs out (resolved by auto-fall-back path).
