# JIT VNC Fallback for Older macOS at Login Screen

**Date:** 2026-04-05
**Status:** Approved

## Problem

Older macOS devices (Monterey / Darwin 21 and below) cannot use the WebRTC desktop viewer at the login screen because the agent reports `desktopAccess.mode === 'unavailable'` with `reason === 'unsupported_os'`. Currently, users see a tooltip explaining the limitation with no way to connect remotely.

macOS Screen Sharing (VNC on port 5900) works on these devices regardless of OS version and does not require a logged-in user session.

## Solution

When a user clicks **Connect Desktop** on an affected Mac, automatically fall back to an in-browser VNC session with a JIT-enabled Screen Sharing server and ephemeral password.

## Flow

1. User clicks **Connect Desktop** on a macOS device
2. Frontend detects `desktopAccess.mode === 'unavailable'` + `reason === 'unsupported_os'` + `remoteAccessPolicy.vncRelay === true`
3. Frontend calls `POST /tunnels` with `type: 'vnc'`
4. API checks `vncRelay` policy (already enforced), generates random 8-char alphanumeric password
5. API sends `tunnel_open` command to agent with `vncPassword` in payload
6. Agent runs `EnableScreenSharing(password)` — activates macOS Screen Sharing via kickstart with VNC legacy password
7. Agent opens TCP to `127.0.0.1:5900`, reports success
8. API returns tunnel ID + `vncPassword` to frontend
9. Frontend obtains WS ticket, navigates to `/remote/vnc/[tunnelId]?ws=...&pwd=...`
10. noVNC connects; on `credentialsrequired` event, viewer auto-injects password via `rfb.sendCredentials()`
11. Password shown in toolbar badge with copy button as fallback
12. On disconnect: API sends `tunnel_close`, agent runs `DisableScreenSharing()` to deactivate VNC server entirely

## Agent Changes

### `agent/internal/tunnel/vnc_darwin.go`

Modify `EnableScreenSharing` signature to accept a password:

```go
func EnableScreenSharing(password string) error
```

- Existing activate/configure flags remain
- Add: `-configure -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw <password>`
- If password is empty, fall back to current no-password behavior

Add `DisableScreenSharing`:

```go
func DisableScreenSharing() error
```

- Runs `kickstart -deactivate -stop` to turn off ARD agent and VNC server
- Idempotent — safe to call if already disabled

### `agent/internal/tunnel/vnc_other.go`

Both functions are no-ops on non-macOS (already the pattern).

### `agent/internal/heartbeat/handlers_tunnel.go`

- `handleTunnelOpen`: extract `vncPassword` string from command payload, pass to `EnableScreenSharing(password)` when `isVNC`
- `handleTunnelClose`: call `DisableScreenSharing()` when tunnel type is VNC

### `agent/internal/tunnel/manager.go`

Store `tunnelType` (string) per session so `CloseTunnel` can check if VNC cleanup is needed. Add a method like `GetTunnelType(id) string` or pass type through the close callback.

### Backward Compatibility

If no `vncPassword` in the command payload, `EnableScreenSharing("")` falls back to existing no-password behavior. Old agents that don't have the updated handler will reject `tunnel_open` as before (existing behavior, no regression).

## API Changes

### `apps/api/src/routes/tunnels.ts` — `POST /tunnels`

For VNC tunnels only:

- Generate random 8-char alphanumeric password: `crypto.randomBytes(6).toString('base64url').slice(0, 8)`
- Include `vncPassword` in the `tunnel_open` command payload
- Return `vncPassword` in the JSON response body

No other API changes needed — policy enforcement, tunnel relay, WS ticket auth all work as-is.

## Frontend Changes

### `apps/web/src/components/remote/ConnectDesktopButton.tsx`

Add VNC detection branch when button is clicked:

- Condition: `desktopAccess?.mode === 'unavailable'` AND `reason === 'unsupported_os'` AND `remoteAccessPolicy?.vncRelay === true`
- Action: call `POST /tunnels` (type: vnc), get WS ticket, navigate to `/remote/vnc/[tunnelId]?ws=...&pwd=...`
- Password passed as URL query param (ephemeral, same-origin only)

When `unsupported_os` but `vncRelay` is NOT enabled in policy, update tooltip message:
> "Enable VNC Relay in the device's configuration policy to connect to this Mac at the login screen."

### `apps/web/src/components/remote/VncViewer.tsx`

- Accept optional `password?: string` prop
- On `credentialsrequired` event: if password is provided, call `rfb.sendCredentials({ password })`
- If no password, noVNC handles the prompt natively (existing fallback)

### `apps/web/src/components/remote/VncViewerPage.tsx`

- Read `password` from URL search params, pass to `VncViewer`
- Show password in a small toolbar badge with copy-to-clipboard button
- Remove auto-redirect on disconnect — show error state and a "Reconnect" or "Back" option instead

### `apps/web/src/pages/remote/vnc/[tunnelId].astro`

- Read `pwd` query param from `Astro.url.searchParams`
- Pass through to `VncViewerPage` component as `password` prop

## Bug Fixes Included

### noVNC ESM Import

- Upgrade `@novnc/novnc` from 1.6.0 (CJS) to 1.7.0-beta (native ESM)
- Remove `exclude: ['@novnc/novnc']` from Vite optimizeDeps
- Keep `ssr.external: ['@novnc/novnc']` (client-only component)
- Update import in `VncViewer.tsx` to use `@/lib/novnc` wrapper

### VncViewerPage Disconnect Handler

- Remove `window.close()` + `setTimeout(() => window.location.href = '/remote')` auto-redirect
- Show error state with back/reconnect options instead

## Interruption Safety

VNC must never be left enabled after a session ends, regardless of how it ends.

### Atomic Enable with Rollback

`EnableScreenSharing(password)` runs all kickstart flags in a single command. If the command fails or the port check fails afterward, immediately call `DisableScreenSharing()` before returning the error. The agent never leaves VNC half-configured.

### Idle Reaper Cleanup

The agent tracks active VNC tunnel IDs. The existing tunnel idle reaper (30s tick, 5 min timeout) already closes idle tunnels. Extend the `CloseTunnel` path: when a VNC tunnel is reaped due to idle timeout, call `DisableScreenSharing()`. This catches network drops and orphaned sessions where the agent never receives `tunnel_close`.

### Startup Cleanup

On agent startup, before connecting to the API, check if macOS Screen Sharing is enabled (`isPortListening(127.0.0.1:5900)`) and there are no active VNC tunnels in the tunnel manager. If Screen Sharing is running with no active tunnels, call `DisableScreenSharing()`. This catches agent crash/restart scenarios.

### Idempotent Disable

`DisableScreenSharing()` is safe to call multiple times. Returns nil if already disabled. All cleanup paths (explicit disconnect, idle reaper, startup) can call it without coordination.

### Summary of Cleanup Triggers

| Scenario | Cleanup mechanism |
|----------|------------------|
| Normal disconnect (user clicks Disconnect) | `tunnel_close` command → `DisableScreenSharing()` |
| Browser tab closed | API detects WS close → sends `tunnel_close` → agent disables |
| Network drop (no WS close received) | Idle reaper (5 min) closes tunnel → disables |
| Agent crash during session | Startup cleanup on restart → disables |
| Enable fails mid-kickstart | Atomic rollback in `EnableScreenSharing()` → disables |

## Non-Goals

- VNC password storage in config policy (password is ephemeral per session)
- VNC for Windows/Linux (they use WebRTC)
- VNC as a user-selectable option (auto-detect only)
- Changes to the config policy schema (`vncRelay` boolean already exists)
- VNC on newer macOS at login screen (uses WebRTC via helper)

## Security Considerations

- VNC password is random per session, never stored persistently
- Screen Sharing is disabled after each session (no residual attack surface)
- Policy gate: `vncRelay` must be explicitly enabled in the device's config policy
- Tunnel relay goes through the API's authenticated WS — no direct VNC exposure
- Password in URL params is same-origin only and ephemeral (tunnel expires)
