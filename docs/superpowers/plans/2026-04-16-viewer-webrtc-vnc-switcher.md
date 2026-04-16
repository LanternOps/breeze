# In-Viewer WebRTC ↔ VNC Switcher (macOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing macOS VNC fallback into the Tauri viewer window with a transport switcher (WebRTC ↔ VNC), auto-fall-back to VNC when WebRTC dies or the agent reports the loginwindow, and rip out the legacy ephemeral VNC password path in favor of macOS user-account (ARD) auth.

**Architecture:** Three phases (each is one PR). Phase 1 is a pure refactor — extract `webrtc` and `websocket` connect logic out of the 1600-line `DesktopViewer.tsx` into `lib/transports/` modules behind a unified `TransportSession` interface. Phase 2 sunsets the `vncPassword` plumbing across agent + API + web, and adds a `desktop_state` event from agent → viewer plus a `tunnel.ts` client in the viewer. Phase 3 adds the `vnc.ts` transport, `breeze://vnc` deep-link route, switcher UI in `ViewerToolbar.tsx`, and the auto-handoff state machine. Each PR ships independently.

**Tech Stack:** TypeScript (Tauri viewer + Hono API + Astro/React web), Go (agent), noVNC 1.7.0-beta, Vitest, Drizzle, BullMQ.

---

## File Structure

### Phase 1 — Refactor (no behavior change)
- **Create:** `apps/viewer/src/lib/transports/types.ts` — `TransportSession`, `TransportKind`, capability flags.
- **Create:** `apps/viewer/src/lib/transports/webrtc.ts` — extracted from `DesktopViewer.tsx`. Exports `connectWebRTC(auth, deps)` returning a `TransportSession`.
- **Create:** `apps/viewer/src/lib/transports/websocket.ts` — extracted from `DesktopViewer.tsx`. Exports `connectWebSocket(auth, deps)` returning a `TransportSession`.
- **Create:** `apps/viewer/src/lib/transports/types.test.ts` — capability-flag invariants.
- **Modify:** `apps/viewer/src/components/DesktopViewer.tsx` — replace inline connect functions with calls into the new modules; behavior unchanged.

### Phase 2 — Sunset password + agent state stream + viewer tunnel client
- **Modify:** `agent/internal/tunnel/vnc_darwin.go` — `EnableScreenSharing()` (no param). Drop `-setvncpw`, drop password handling, drop `clearCmd` in `DisableScreenSharing` (still safe).
- **Modify:** `agent/internal/tunnel/vnc_other.go` — match new signature.
- **Modify:** `agent/internal/heartbeat/handlers_tunnel.go` — drop `vncPassword` extraction; call `EnableScreenSharing()`.
- **Create:** `agent/internal/tunnel/vnc_darwin_test.go` (skeleton if missing) — assert `EnableScreenSharing` no-op when port already listening.
- **Modify:** `apps/api/src/routes/tunnels.ts` — drop `vncPassword` generation, drop from payload, drop from response.
- **Modify:** `apps/api/src/routes/tunnels.test.ts` — remove password assertions; assert no `vncPassword` in response.
- **Modify:** `apps/web/src/components/remote/VncViewer.tsx` — drop `password?: string` prop; remove auto-injection branch in `credentialsrequired` handler.
- **Modify:** `apps/web/src/components/remote/VncViewerPage.tsx` — drop password badge + `password` prop pass-through.
- **Modify:** `apps/web/src/pages/remote/vnc/[tunnelId].astro` — drop `pwd` query-param read.
- **Modify:** `apps/web/src/components/remote/ConnectVncButton.tsx` — drop `pwd=` from deep link.
- **Create:** `apps/viewer/src/lib/tunnel.ts` — `createVncTunnel(deviceId, auth)`, `closeTunnel(tunnelId, auth)`. Returns `{tunnelId, wsUrl}`.
- **Create:** `apps/viewer/src/lib/tunnel.test.ts` — mocked fetch, asserts request shape.
- **Modify:** `agent/internal/heartbeat/desktop_handoff_darwin.go` — emit `desktop_state` JSON over the active WebRTC control channel on helper attach + handoff.
- **Modify:** the agent code that owns the WebRTC control channel (search: `controlChannel`, `data_channel`, `"control"` label) — add a `BroadcastDesktopState(state, userName)` hook.

### Phase 3 — VNC transport in viewer + switcher UI
- **Modify:** `apps/viewer/package.json` — add `@novnc/novnc: 1.7.0-beta`.
- **Create:** `apps/viewer/src/lib/novnc.ts` — thin wrapper re-exporting `RFB` (matches the web `lib/novnc` pattern).
- **Create:** `apps/viewer/src/lib/transports/vnc.ts` — `connectVnc(tunnelInfo, deps)` returning a `TransportSession`. Wraps noVNC `RFB`, handles `credentialsrequired` (always shows ARD prompt), `securityfailure`, `disconnect`, scaling.
- **Create:** `apps/viewer/src/lib/transports/vnc.test.ts` — capability flags, callback wiring (mock `RFB`).
- **Modify:** `apps/viewer/src/lib/protocol.ts` — extend `parseDeepLink` to recognize `breeze://vnc?tunnel=...&ws=...&deviceId=...&api=...&accessToken=...`. Add a `mode: 'desktop' | 'vnc'` discriminator on `ConnectionParams`.
- **Modify:** `apps/viewer/src/lib/protocol.test.ts` — add VNC URL parsing tests.
- **Modify:** `apps/viewer/src/App.tsx` — handle the new VNC mode (pass `initialTransport='vnc'` and `initialTunnel` props to `DesktopViewer`).
- **Modify:** `apps/viewer/src/components/DesktopViewer.tsx` — add the third transport, `setTransport()` switch flow, auto-fall-back logic, polling for `GET /devices/:id/desktop-access` while on VNC.
- **Modify:** `apps/viewer/src/components/ViewerToolbar.tsx` — transport dropdown (macOS only), capability-aware control hiding, "Switch to WebRTC" pill.
- **Modify:** `apps/web/src/components/remote/ConnectVncButton.tsx` — pass `accessToken` + `apiUrl` + `deviceId` in the deep link so the viewer can self-create future tunnels.

---

## Phase 1 — Refactor `DesktopViewer.tsx` into transport modules

This phase changes no behavior. The point is to make Phase 3 tractable (today the file is 1600 lines).

### Task 1.1: Define the `TransportSession` interface

**Files:**
- Create: `apps/viewer/src/lib/transports/types.ts`
- Create: `apps/viewer/src/lib/transports/types.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/viewer/src/lib/transports/types.test.ts
import { describe, it, expect } from 'vitest';
import type { TransportSession, TransportCapabilities } from './types';
import { capabilitiesFor } from './types';

describe('capabilitiesFor', () => {
  it('returns webrtc capabilities', () => {
    const c: TransportCapabilities = capabilitiesFor('webrtc');
    expect(c.monitors).toBe(true);
    expect(c.bitrateControl).toBe(true);
    expect(c.audio).toBe(true);
    expect(c.sas).toBe(true);
    expect(c.sessionSwitch).toBe(true);
    expect(c.clipboardChannel).toBe(true);
  });

  it('returns websocket capabilities', () => {
    const c = capabilitiesFor('websocket');
    expect(c.monitors).toBe(false);
    expect(c.bitrateControl).toBe(false);
    expect(c.audio).toBe(false);
    expect(c.sas).toBe(false);
    expect(c.sessionSwitch).toBe(false);
    expect(c.clipboardChannel).toBe(false);
  });

  it('returns vnc capabilities', () => {
    const c = capabilitiesFor('vnc');
    expect(c.monitors).toBe(false);
    expect(c.bitrateControl).toBe(false);
    expect(c.audio).toBe(false);
    expect(c.sas).toBe(false);
    expect(c.sessionSwitch).toBe(false);
    expect(c.clipboardChannel).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd apps/viewer && pnpm vitest run src/lib/transports/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types**

```ts
// apps/viewer/src/lib/transports/types.ts
export type TransportKind = 'webrtc' | 'websocket' | 'vnc';

export interface TransportCapabilities {
  monitors: boolean;
  bitrateControl: boolean;
  audio: boolean;
  sas: boolean;
  sessionSwitch: boolean;
  clipboardChannel: boolean;
}

export interface TransportSession {
  kind: TransportKind;
  capabilities: TransportCapabilities;
  close(): void;
  inputChannel?: { send(json: string): void; readyState?: string };
  controlChannel?: {
    send(json: string): void;
    addEventListener(event: 'open' | 'message' | 'close', cb: (e: unknown) => void): void;
    removeEventListener(event: 'open' | 'message' | 'close', cb: (e: unknown) => void): void;
    readyState: string;
  };
  videoElement?: HTMLVideoElement;
  canvasElement?: HTMLCanvasElement;
  vncContainer?: HTMLDivElement;
}

export function capabilitiesFor(kind: TransportKind): TransportCapabilities {
  switch (kind) {
    case 'webrtc':
      return { monitors: true, bitrateControl: true, audio: true, sas: true, sessionSwitch: true, clipboardChannel: true };
    case 'websocket':
      return { monitors: false, bitrateControl: false, audio: false, sas: false, sessionSwitch: false, clipboardChannel: false };
    case 'vnc':
      return { monitors: false, bitrateControl: false, audio: false, sas: false, sessionSwitch: false, clipboardChannel: true };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd apps/viewer && pnpm vitest run src/lib/transports/types.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/transports/types.ts apps/viewer/src/lib/transports/types.test.ts
git commit -m "viewer: introduce TransportSession interface and capabilities"
```

### Task 1.2: Extract WebRTC into `transports/webrtc.ts`

**Files:**
- Create: `apps/viewer/src/lib/transports/webrtc.ts`
- Modify: `apps/viewer/src/components/DesktopViewer.tsx`

- [ ] **Step 1: Create the module**

Move the body of `connectWebRTC` from `DesktopViewer.tsx` (lines 115-309 in the current file) into a new exported function in `webrtc.ts`. Signature:

```ts
// apps/viewer/src/lib/transports/webrtc.ts
import { createWebRTCSession, type AuthenticatedConnectionParams, type WebRTCSession, AgentSessionError } from '../webrtc';
import type { TransportSession } from './types';
import { capabilitiesFor } from './types';

export interface WebRTCDeps {
  videoElement: HTMLVideoElement;
  cursorOverlay: HTMLDivElement | null;
  targetSessionId?: number;
  // Callbacks for state the React component still owns
  onConnected: () => void;
  onDisconnected: () => void;
  onFailed: () => void;
  onAudioTrack: (track: MediaStreamTrack) => void;
  onClipboardMessage: (msg: string) => void;
  onCursorMessage: (msg: string) => void;
  onControlMessage: (msg: string) => void;
}

export interface WebRTCSessionWrapper extends TransportSession {
  kind: 'webrtc';
  pc: RTCPeerConnection;
  videoElement: HTMLVideoElement;
  controlChannel: RTCDataChannel;
  inputChannel: RTCDataChannel;
}

export async function connectWebRTC(
  auth: AuthenticatedConnectionParams,
  deps: WebRTCDeps
): Promise<WebRTCSessionWrapper | null> {
  // Move the contents of the existing connectWebRTC useCallback in DesktopViewer.tsx here.
  // Replace the React refs (clipboardDCRef, cursorOverlayRef, etc.) with calls into the deps callbacks.
  // Replace setStatus / setHasAudioTrack with deps callbacks.
  // Return a TransportSession wrapping the underlying WebRTCSession.
  // Throw AgentSessionError as before; return null on transport failures so the caller can fall back.
  // ...
}
```

The actual code is the existing 200-line `connectWebRTC` from `DesktopViewer.tsx`. Lift it verbatim, then replace each `videoRef.current`, `webrtcRef.current`, `setHasAudioTrack`, `setCursorStreamActive` access with the matching `deps` callback or `deps.videoElement`. The wrapper's `close()` calls `session.close()`. `capabilities: capabilitiesFor('webrtc')`.

- [ ] **Step 2: Update `DesktopViewer.tsx` to call into the module**

Replace the inline `connectWebRTC` useCallback with a thin wrapper that builds `deps` from refs and React state setters, then calls `connectWebRTC` from the new module. Keep the same return contract (`Promise<boolean>`).

```ts
// In DesktopViewer.tsx
const connectWebRTC = useCallback(async (auth, targetSessionId) => {
  const videoEl = videoRef.current;
  if (!videoEl) return false;

  try {
    const session = await connectWebRTCModule(auth, {
      videoElement: videoEl,
      cursorOverlay: cursorOverlayRef.current,
      targetSessionId: targetSessionId ?? params.targetSessionId,
      onConnected: () => {
        setStatus('connected');
        setConnectedAt(new Date());
        setErrorMessage(null);
        videoRef.current?.focus();
      },
      onDisconnected: () => {
        if (userDisconnectRef.current) return;
        setStatus('disconnected');
        setConnectedAt(null);
      },
      onFailed: () => {
        if (userDisconnectRef.current) return;
        startReconnectRef.current();
      },
      onAudioTrack: (track) => { /* existing audio wiring */ },
      onClipboardMessage: (msg) => { /* existing clipboard wiring */ },
      onCursorMessage: (msg) => { /* existing cursor overlay wiring */ },
      onControlMessage: (msg) => { /* monitors, sessions, etc. */ },
    });
    if (!session) return false;
    webrtcRef.current = session;
    setTransportState('webrtc');
    return true;
  } catch (err) {
    if (err instanceof AgentSessionError) throw err;
    return false;
  }
}, [/* deps */]);
```

- [ ] **Step 3: Run viewer build + existing tests**

Run: `cd apps/viewer && pnpm tsc --noEmit && pnpm vitest run`
Expected: PASS (no behavior change).

- [ ] **Step 4: Smoke test in dev**

Run: `pnpm dev` (root). Launch viewer against the macOS device (`804d096a-6400-4c6d-ab2a-8bee3e69268a`). Verify WebRTC connects, video plays, mouse + keyboard work, clipboard sync works, monitor switcher works, audio toggle works.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/transports/webrtc.ts apps/viewer/src/components/DesktopViewer.tsx
git commit -m "viewer: extract WebRTC transport into transports/webrtc.ts"
```

### Task 1.3: Extract WebSocket into `transports/websocket.ts`

**Files:**
- Create: `apps/viewer/src/lib/transports/websocket.ts`
- Modify: `apps/viewer/src/components/DesktopViewer.tsx`

- [ ] **Step 1: Create the module**

Same pattern as Task 1.2: move the inline `connectWebSocket` useCallback (lines ~313-424) into a new exported function. Deps include `canvasElement`, `onConnected`, `onDisconnected`, `onError`, `onFrame: (data: ArrayBuffer) => void`, `onHostname`, `onRemoteOs`.

Return a `TransportSession` whose `inputChannel.send` writes `{type:'input', event:...}` to the underlying socket and whose `close()` runs the existing `cleanup()`.

- [ ] **Step 2: Update `DesktopViewer.tsx` to call the module**

Replace the inline useCallback with a thin wrapper, just like Task 1.2.

- [ ] **Step 3: Build + tests**

Run: `cd apps/viewer && pnpm tsc --noEmit && pnpm vitest run`
Expected: PASS.

- [ ] **Step 4: Smoke test**

Verify the WebSocket fallback still works. To force it, temporarily make `connectWebRTC` throw, connect, confirm canvas + JPEG path renders.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/transports/websocket.ts apps/viewer/src/components/DesktopViewer.tsx
git commit -m "viewer: extract WebSocket transport into transports/websocket.ts"
```

### Task 1.4: Open PR1

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin HEAD
gh pr create --title "viewer: extract transports into lib/transports/ (no behavior change)" --body "$(cat <<'EOF'
## Summary
- Pure refactor of \`DesktopViewer.tsx\` to extract WebRTC and WebSocket connect logic into \`apps/viewer/src/lib/transports/\` modules behind a unified \`TransportSession\` interface
- Sets up Phase 3 (in-viewer VNC transport) without inflating the already-1600-line component
- No behavior change

## Test plan
- [x] \`pnpm tsc --noEmit && pnpm vitest run\` passes
- [x] Manual: WebRTC desktop session works on macOS device — video, input, clipboard, monitors, audio
- [x] Manual: WebSocket fallback still renders JPEG frames

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 2 — Sunset password + agent state stream + viewer tunnel client

### Task 2.1: Drop password from agent `EnableScreenSharing`

**Files:**
- Modify: `agent/internal/tunnel/vnc_darwin.go`
- Modify: `agent/internal/tunnel/vnc_other.go`
- Modify: `agent/internal/heartbeat/handlers_tunnel.go`

- [ ] **Step 1: Update `vnc_darwin.go` signature**

Edit `agent/internal/tunnel/vnc_darwin.go`:

```go
// EnableScreenSharing enables macOS Screen Sharing (VNC). Auth is delegated
// to whatever the user / MDM has configured — typically Apple Remote Desktop
// (the user authenticates with their macOS account credentials when the
// noVNC client prompts).
//
// On recent macOS (13+), kickstart cannot enable Screen Sharing from a
// LaunchDaemon context. The fast path checks if port 5900 is already
// listening and returns nil if so.
func EnableScreenSharing() error {
	if isPortListening("127.0.0.1", vncPort) {
		log.Info("macOS Screen Sharing already running — skipping kickstart")
		return nil
	}

	log.Info("enabling macOS Screen Sharing via kickstart")

	args := []string{
		"-activate",
		"-configure", "-access", "-on",
		"-restart", "-agent",
		"-privs", "-all",
	}

	cmd := exec.Command(kickstartPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if rollbackErr := DisableScreenSharing(); rollbackErr != nil {
			log.Error("rollback of screen sharing failed — port may be left open",
				"enableError", err.Error(), "rollbackError", rollbackErr.Error())
		}
		if strings.Contains(string(output), "must be enabled from System Settings") ||
			strings.Contains(string(output), "Can't call method") {
			return ErrScreenSharingRequiresManualEnable
		}
		return fmt.Errorf("kickstart failed: %w (output: %s)", err, string(output))
	}

	time.Sleep(vncCheckDelay)
	if !isPortListening("127.0.0.1", vncPort) {
		portErr := fmt.Errorf("VNC server not listening on port %d after kickstart", vncPort)
		if rollbackErr := DisableScreenSharing(); rollbackErr != nil {
			log.Error("rollback of screen sharing failed — port may be left open",
				"enableError", portErr.Error(), "rollbackError", rollbackErr.Error())
		}
		return portErr
	}

	log.Info("macOS Screen Sharing enabled successfully")
	return nil
}
```

Also remove the `clearCmd` block from `DisableScreenSharing` — clearing the legacy VNC password is no longer relevant:

```go
func DisableScreenSharing() error {
	log.Info("disabling macOS Screen Sharing via kickstart")
	cmd := exec.Command(kickstartPath, "-deactivate", "-stop")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kickstart deactivate failed: %w (output: %s)", err, string(output))
	}
	log.Info("macOS Screen Sharing disabled")
	return nil
}
```

- [ ] **Step 2: Update `vnc_other.go`**

```go
//go:build !darwin

package tunnel

func IsScreenSharingSupported() bool { return false }
func EnableScreenSharing() error { return nil }
func DisableScreenSharing() error { return nil }
func IsScreenSharingRunning() bool { return false }
```

- [ ] **Step 3: Update `handlers_tunnel.go`**

Edit `agent/internal/heartbeat/handlers_tunnel.go` line 92-93:

```go
// Before:
//   vncPassword, _ := cmd.Payload["vncPassword"].(string)
//   if err := tunnel.EnableScreenSharing(vncPassword); err != nil {
// After:
if err := tunnel.EnableScreenSharing(); err != nil {
```

Also drop the `vncPassword` payload extraction at the top of the function if it's referenced elsewhere (search for `vncPassword`).

- [ ] **Step 4: Build agent**

Run: `cd agent && go build ./...`
Expected: success.

- [ ] **Step 5: Run agent tests**

Run: `cd agent && go test -race ./internal/tunnel/... ./internal/heartbeat/...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/tunnel/vnc_darwin.go agent/internal/tunnel/vnc_other.go agent/internal/heartbeat/handlers_tunnel.go
git commit -m "agent: drop legacy VNC password from EnableScreenSharing"
```

### Task 2.2: Drop `vncPassword` from API tunnels route

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts`
- Modify: `apps/api/src/routes/tunnels.test.ts`

- [ ] **Step 1: Update test first**

Find the existing test that asserts `vncPassword` is returned. Change it to assert the response does NOT contain `vncPassword`:

```ts
// In the relevant describe block in tunnels.test.ts
it('does not return vncPassword for VNC tunnels (ARD auth used at the client)', async () => {
  const res = await postTunnel({ deviceId, type: 'vnc' });
  const body = await res.json();
  expect(body).not.toHaveProperty('vncPassword');
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd apps/api && pnpm vitest run src/routes/tunnels.test.ts -t "vncPassword"`
Expected: FAIL (current implementation still returns it).

- [ ] **Step 3: Update `tunnels.ts`**

Remove the password generation block (around line 246) and the two response/payload spreads (lines 260, 270):

```ts
// Remove:
//   const vncPassword = isVNC ? randomBytes(6).toString('base64url').slice(0, 8) : undefined;
//   ...(vncPassword && { vncPassword }),  (in payload)
//   ...(vncPassword && { vncPassword })   (in response)
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && pnpm vitest run src/routes/tunnels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tunnels.ts apps/api/src/routes/tunnels.test.ts
git commit -m "api: stop generating vncPassword for VNC tunnels (ARD auth)"
```

### Task 2.3: Strip password UI from web noVNC client

**Files:**
- Modify: `apps/web/src/components/remote/VncViewer.tsx`
- Modify: `apps/web/src/components/remote/VncViewerPage.tsx`
- Modify: `apps/web/src/pages/remote/vnc/[tunnelId].astro`
- Modify: `apps/web/src/components/remote/ConnectVncButton.tsx`

- [ ] **Step 1: VncViewer.tsx — remove password prop and auto-injection**

In `apps/web/src/components/remote/VncViewer.tsx`:

```ts
// Remove `password?: string` from VncViewerProps
interface VncViewerProps {
  wsUrl: string;
  tunnelId: string;
  onDisconnect?: () => void;
  className?: string;
}

// Inside the credentialsrequired handler, remove the auto-injection branch.
// New body:
rfb.addEventListener('credentialsrequired', (e: CustomEvent) => {
  console.log('[VNC] credentialsrequired', e.detail);
  if (disposed) return;
  const types = (e.detail?.types ?? ['password']) as string[];
  const requiresUsername = types.includes('username');
  setNeedsUsername(requiresUsername);
  setStatus('password_required');
});
```

Remove the `password` from the `useEffect` deps array.

- [ ] **Step 2: VncViewerPage.tsx — drop password prop + badge**

Remove `password` prop from `VncViewerPage`. Remove any badge UI showing `🔒 Password` and the copy-to-clipboard button.

- [ ] **Step 3: [tunnelId].astro — drop pwd query param**

```astro
---
const { tunnelId } = Astro.params;
const wsUrl = Astro.url.searchParams.get('ws') || '';
// Remove: const password = Astro.url.searchParams.get('pwd') || undefined;
---
<VncViewerPage client:only="react" tunnelId={tunnelId} wsUrl={wsUrl} />
```

- [ ] **Step 4: ConnectVncButton.tsx — drop pwd from deep link**

The deep-link build is around line 83. It already doesn't include `pwd` (current code uses `tunnel` and `ws` only), so verify and leave alone if there's nothing to change.

- [ ] **Step 5: Build web**

Run: `cd apps/web && pnpm tsc --noEmit && pnpm build`
Expected: success.

- [ ] **Step 6: Manual smoke test**

Open the web app, click VNC on the macOS device, confirm the noVNC client opens, prompts for username + password, accepts the macOS user credentials.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/remote/VncViewer.tsx apps/web/src/components/remote/VncViewerPage.tsx apps/web/src/pages/remote/vnc/[tunnelId].astro apps/web/src/components/remote/ConnectVncButton.tsx
git commit -m "web: drop legacy VNC password UI; rely on ARD auth (mac user creds)"
```

### Task 2.4: Add `tunnel.ts` client in viewer

**Files:**
- Create: `apps/viewer/src/lib/tunnel.ts`
- Create: `apps/viewer/src/lib/tunnel.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/viewer/src/lib/tunnel.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVncTunnel, closeTunnel } from './tunnel';

const makeFetch = (responses: Array<{ status: number; body: unknown }>) => {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
};

describe('createVncTunnel', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('POSTs /tunnels then /tunnels/:id/ws-ticket and returns wsUrl', async () => {
    const fetchMock = makeFetch([
      { status: 201, body: { id: 'tun-123' } },
      { status: 200, body: { ticket: 'tkt-abc' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await createVncTunnel('dev-1', {
      apiUrl: 'https://api.example.com',
      accessToken: 'token-xyz',
    });

    expect(res).toEqual({
      tunnelId: 'tun-123',
      wsUrl: 'wss://api.example.com/api/v1/tunnel-ws/tun-123/ws?ticket=tkt-abc',
    });

    const calls = fetchMock.mock.calls;
    expect(calls[0][0]).toBe('https://api.example.com/tunnels');
    expect(calls[0][1].method).toBe('POST');
    const body = JSON.parse(calls[0][1].body);
    expect(body).toEqual({ deviceId: 'dev-1', type: 'vnc' });
    expect(calls[0][1].headers.Authorization).toBe('Bearer token-xyz');

    expect(calls[1][0]).toBe('https://api.example.com/tunnels/tun-123/ws-ticket');
    expect(calls[1][1].method).toBe('POST');
  });

  it('throws on tunnel-create failure', async () => {
    vi.stubGlobal('fetch', makeFetch([{ status: 403, body: { error: 'policy denied' } }]));
    await expect(createVncTunnel('dev-1', { apiUrl: 'https://x', accessToken: 't' }))
      .rejects.toThrow(/policy denied/);
  });
});

describe('closeTunnel', () => {
  it('DELETEs /tunnels/:id', async () => {
    const fetchMock = makeFetch([{ status: 204, body: null }]);
    vi.stubGlobal('fetch', fetchMock);
    await closeTunnel('tun-1', { apiUrl: 'https://api.example.com', accessToken: 'tok' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/tunnels/tun-1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd apps/viewer && pnpm vitest run src/lib/tunnel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `tunnel.ts`**

```ts
// apps/viewer/src/lib/tunnel.ts
export interface TunnelAuth {
  apiUrl: string;
  accessToken: string;
}

export interface VncTunnelInfo {
  tunnelId: string;
  wsUrl: string;
}

export async function createVncTunnel(deviceId: string, auth: TunnelAuth): Promise<VncTunnelInfo> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
  };

  const tunnelRes = await fetch(`${auth.apiUrl}/tunnels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId, type: 'vnc' }),
  });
  if (!tunnelRes.ok) {
    const err = await tunnelRes.json().catch(() => ({ error: 'Failed to create tunnel' }));
    throw new Error(err.error || `Tunnel create failed (${tunnelRes.status})`);
  }
  const { id: tunnelId } = await tunnelRes.json();

  const ticketRes = await fetch(`${auth.apiUrl}/tunnels/${tunnelId}/ws-ticket`, {
    method: 'POST',
    headers,
  });
  if (!ticketRes.ok) {
    await closeTunnel(tunnelId, auth).catch(() => {});
    throw new Error(`Failed to get tunnel ticket (${ticketRes.status})`);
  }
  const { ticket } = await ticketRes.json();

  const wsProtocol = auth.apiUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = auth.apiUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProtocol}://${wsHost}/api/v1/tunnel-ws/${tunnelId}/ws?ticket=${ticket}`;

  return { tunnelId, wsUrl };
}

export async function closeTunnel(tunnelId: string, auth: TunnelAuth): Promise<void> {
  await fetch(`${auth.apiUrl}/tunnels/${tunnelId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/viewer && pnpm vitest run src/lib/tunnel.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/tunnel.ts apps/viewer/src/lib/tunnel.test.ts
git commit -m "viewer: add tunnel.ts client (create/close VNC tunnels)"
```

### Task 2.5: Agent emits `desktop_state` events

**Files:**
- Modify: `agent/internal/heartbeat/desktop_handoff_darwin.go`
- Modify: agent code that owns the WebRTC control channel (find via `grep -rn "controlChannel\|ControlChannel" agent/internal/`).

- [ ] **Step 1: Find the control-channel owner**

Run: `grep -rn "data_channel\|controlChannel\|DataChannel.*\"control\"" agent/internal/ | head -30`
Identify the file (likely `agent/internal/remote/desktop/...`) that creates the `control` data channel and exposes a way to send messages.

- [ ] **Step 2: Add `BroadcastDesktopState` hook**

In the file from Step 1, add a function like:

```go
// BroadcastDesktopState sends a desktop_state event over the active WebRTC
// control data channel for any current desktop session. No-op if no session.
func BroadcastDesktopState(state string, userName string) {
    msg := map[string]interface{}{
        "type":     "desktop_state",
        "state":    state,
    }
    if userName != "" {
        msg["userName"] = userName
    }
    payload, _ := json.Marshal(msg)
    // Iterate active sessions and send via each control channel
    for _, s := range activeSessions() {
        if s.controlChannel != nil && s.controlChannel.ReadyState() == webrtc.DataChannelStateOpen {
            _ = s.controlChannel.SendText(string(payload))
        }
    }
}
```

Adapt to the actual session manager API in the file.

- [ ] **Step 3: Wire the reconciler to emit events**

In `agent/internal/heartbeat/desktop_handoff_darwin.go`, find the existing helper-attach + handoff handlers. After the existing handoff/attach side-effects, call:

```go
import "github.com/breeze-rmm/agent/internal/remote/desktop" // adjust to actual import

// On user-session helper attach:
desktop.BroadcastDesktopState("user_session", resolvedUserName)

// On loginwindow helper attach:
desktop.BroadcastDesktopState("loginwindow", "")
```

- [ ] **Step 4: Build + test**

Run: `cd agent && go build ./... && go test -race ./internal/heartbeat/...`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Run agent against local docker. Open WebRTC desktop session against the macOS device. In the viewer's browser console, confirm a `desktop_state` message arrives over the control channel on connect:

```
[control] desktop_state: { state: 'user_session', userName: 'olive' }
```

(You may need to add a temporary `console.log` in the existing control-channel `onMessage` handler in `DesktopViewer.tsx` to see this — Task 3.5 wires it up properly.)

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/desktop_handoff_darwin.go agent/internal/remote/desktop/<file>.go
git commit -m "agent: broadcast desktop_state over WebRTC control channel"
```

### Task 2.6: Open PR2

- [ ] **Step 1: Push and PR**

```bash
git push -u origin HEAD
gh pr create --title "vnc: sunset legacy VNC password; add desktop_state events + viewer tunnel client" --body "$(cat <<'EOF'
## Summary
- Drops the ephemeral VNC legacy password path everywhere (agent, API, web). VNC sessions now authenticate exclusively via Apple Remote Desktop using the user's macOS account credentials, which is what already works in practice
- Agent broadcasts \`desktop_state\` (loginwindow / user_session) events over the WebRTC control channel so the viewer can react to handoffs
- Adds \`apps/viewer/src/lib/tunnel.ts\` so the viewer can create/close VNC tunnels itself (sets up the auto-handoff in PR3)

## Test plan
- [x] Web noVNC client prompts for and accepts macOS user credentials (ARD)
- [x] No \`vncPassword\` in tunnel response
- [x] Agent unit tests pass; \`pnpm vitest run\` in api + viewer passes
- [x] desktop_state event observed in browser console during a WebRTC session

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 3 — Viewer VNC transport + switcher UI

### Task 3.1: Add `@novnc/novnc` to viewer + wrapper

**Files:**
- Modify: `apps/viewer/package.json`
- Create: `apps/viewer/src/lib/novnc.ts`

- [ ] **Step 1: Add dependency**

Run:
```bash
cd apps/viewer && pnpm add @novnc/novnc@1.7.0-beta
```

- [ ] **Step 2: Create wrapper**

```ts
// apps/viewer/src/lib/novnc.ts
// Mirror of apps/web/src/lib/novnc — re-exports RFB so we can swap import paths centrally.
export { default as RFB } from '@novnc/novnc/lib/rfb';
```

- [ ] **Step 3: Verify Vite picks it up**

Run: `cd apps/viewer && pnpm tsc --noEmit && pnpm build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add apps/viewer/package.json apps/viewer/src/lib/novnc.ts ../../pnpm-lock.yaml
git commit -m "viewer: add @novnc/novnc dependency + wrapper"
```

### Task 3.2: Implement `transports/vnc.ts`

**Files:**
- Create: `apps/viewer/src/lib/transports/vnc.ts`
- Create: `apps/viewer/src/lib/transports/vnc.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/viewer/src/lib/transports/vnc.test.ts
import { describe, it, expect, vi } from 'vitest';
import { connectVnc, type VncDeps } from './vnc';

vi.mock('../novnc', () => {
  const listeners: Record<string, Function[]> = {};
  const fakeRfb = {
    addEventListener: (ev: string, cb: Function) => {
      (listeners[ev] = listeners[ev] || []).push(cb);
    },
    removeEventListener: vi.fn(),
    sendCredentials: vi.fn(),
    disconnect: vi.fn(),
    clipboardPasteFrom: vi.fn(),
    scaleViewport: true,
    resizeSession: false,
    showDotCursor: true,
    _listeners: listeners,
  };
  return { RFB: vi.fn(() => fakeRfb) };
});

describe('connectVnc', () => {
  it('returns a TransportSession with vnc kind and clipboard capability', async () => {
    const container = document.createElement('div');
    const onStatus = vi.fn();
    const session = await connectVnc(
      { tunnelId: 't1', wsUrl: 'wss://api/x' },
      { container, onStatus, onError: vi.fn(), onCredentialsRequired: vi.fn() }
    );
    expect(session.kind).toBe('vnc');
    expect(session.capabilities.clipboardChannel).toBe(true);
    expect(session.capabilities.monitors).toBe(false);
    expect(session.vncContainer).toBe(container);
  });

  it('invokes onStatus("connected") on connect event', async () => {
    const container = document.createElement('div');
    const onStatus = vi.fn();
    await connectVnc(
      { tunnelId: 't1', wsUrl: 'wss://api/x' },
      { container, onStatus, onError: vi.fn(), onCredentialsRequired: vi.fn() }
    );
    const { RFB } = await import('../novnc');
    const rfb = (RFB as any).mock.results[0].value;
    rfb._listeners['connect'][0]({});
    expect(onStatus).toHaveBeenCalledWith('connected');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/viewer && pnpm vitest run src/lib/transports/vnc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `vnc.ts`**

```ts
// apps/viewer/src/lib/transports/vnc.ts
import { RFB } from '../novnc';
import type { TransportSession } from './types';
import { capabilitiesFor } from './types';

export interface VncTunnelInfo {
  tunnelId: string;
  wsUrl: string;
}

export interface VncDeps {
  container: HTMLDivElement;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;
  onError: (message: string) => void;
  onCredentialsRequired: (requiresUsername: boolean, submit: (creds: { username?: string; password: string }) => void) => void;
}

export interface VncSessionWrapper extends TransportSession {
  kind: 'vnc';
  vncContainer: HTMLDivElement;
}

export async function connectVnc(
  info: VncTunnelInfo,
  deps: VncDeps
): Promise<VncSessionWrapper> {
  deps.onStatus('connecting');
  const rfb = new RFB(deps.container, info.wsUrl, { wsProtocols: ['binary'] });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.showDotCursor = true;

  rfb.addEventListener('connect', () => deps.onStatus('connected'));
  rfb.addEventListener('disconnect', (e: CustomEvent) => {
    deps.onStatus(e.detail?.clean ? 'disconnected' : 'error');
    if (!e.detail?.clean) deps.onError('Connection lost unexpectedly');
  });
  rfb.addEventListener('credentialsrequired', (e: CustomEvent) => {
    const types = (e.detail?.types ?? ['password']) as string[];
    const requiresUsername = types.includes('username');
    deps.onCredentialsRequired(requiresUsername, (creds) => rfb.sendCredentials(creds));
  });
  rfb.addEventListener('securityfailure', (e: CustomEvent) => {
    const reason = e.detail?.reason || 'Authentication failed';
    deps.onError(
      e.detail?.status === 1
        ? `Authentication failed: ${reason}. Check your macOS username and password.`
        : `Security failure: ${reason}`
    );
    deps.onStatus('error');
  });

  return {
    kind: 'vnc',
    capabilities: capabilitiesFor('vnc'),
    vncContainer: deps.container,
    close: () => {
      try { rfb.disconnect(); } catch { /* idempotent */ }
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/viewer && pnpm vitest run src/lib/transports/vnc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/transports/vnc.ts apps/viewer/src/lib/transports/vnc.test.ts
git commit -m "viewer: implement VNC transport (transports/vnc.ts)"
```

### Task 3.3: Extend `protocol.ts` to parse `breeze://vnc` URLs

**Files:**
- Modify: `apps/viewer/src/lib/protocol.ts`
- Modify: `apps/viewer/src/lib/protocol.test.ts`

- [ ] **Step 1: Add failing test**

```ts
// In apps/viewer/src/lib/protocol.test.ts add:
describe('parseDeepLink — VNC', () => {
  it('parses a breeze://vnc URL', () => {
    const url = 'breeze://vnc?tunnel=tun-1&ws=wss%3A%2F%2Fapi.example.com%2Fapi%2Fv1%2Ftunnel-ws%2Ftun-1%2Fws%3Fticket%3Dabc&device=dev-1&api=https%3A%2F%2Fapi.example.com&accessToken=token-xyz';
    const params = parseDeepLink(url);
    expect(params).toEqual({
      mode: 'vnc',
      tunnelId: 'tun-1',
      wsUrl: 'wss://api.example.com/api/v1/tunnel-ws/tun-1/ws?ticket=abc',
      deviceId: 'dev-1',
      apiUrl: 'https://api.example.com',
      accessToken: 'token-xyz',
    });
  });

  it('returns null when required VNC params missing', () => {
    expect(parseDeepLink('breeze://vnc?tunnel=tun-1')).toBeNull();
  });
});

describe('parseDeepLink — desktop (existing)', () => {
  it('still returns mode:desktop for breeze://connect URLs', () => {
    const url = 'breeze://connect?session=s1&code=c1&api=https%3A%2F%2Fapi.example.com';
    const params = parseDeepLink(url);
    expect(params?.mode).toBe('desktop');
    expect(params?.sessionId).toBe('s1');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/viewer && pnpm vitest run src/lib/protocol.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/viewer/src/lib/protocol.ts`:

```ts
export type ConnectionParams =
  | DesktopConnectionParams
  | VncConnectionParams;

export interface DesktopConnectionParams {
  mode: 'desktop';
  sessionId: string;
  connectCode: string;
  apiUrl: string;
  targetSessionId?: number;
  deviceId?: string;
}

export interface VncConnectionParams {
  mode: 'vnc';
  tunnelId: string;
  wsUrl: string;
  deviceId: string;
  apiUrl: string;
  accessToken: string;
}

export function parseDeepLink(url: string): ConnectionParams | null {
  try {
    let normalized = url;
    if (normalized.startsWith('breeze://')) {
      normalized = normalized.replace('breeze://', 'https://breeze/');
    } else if (normalized.startsWith('breeze:')) {
      normalized = normalized.replace('breeze:', 'https://breeze/');
    }
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');

    if (path === 'vnc') {
      const tunnelId = parsed.searchParams.get('tunnel');
      const wsUrl = parsed.searchParams.get('ws');
      const deviceId = parsed.searchParams.get('device');
      const apiUrl = parsed.searchParams.get('api');
      const accessToken = parsed.searchParams.get('accessToken');
      if (!tunnelId || !wsUrl || !deviceId || !apiUrl || !accessToken) return null;
      // Validate apiUrl per existing rules
      const api = new URL(apiUrl.trim());
      if (api.protocol !== 'https:' && api.protocol !== 'http:') return null;
      if (api.protocol === 'http:' && !isPrivateHost(api.hostname)) return null;
      return { mode: 'vnc', tunnelId, wsUrl, deviceId, apiUrl, accessToken };
    }

    // Existing desktop path (path === 'connect' or empty)
    const sessionId = parsed.searchParams.get('session');
    const connectCode = parsed.searchParams.get('code');
    const apiUrl = parsed.searchParams.get('api');
    const targetSessionIdRaw = parsed.searchParams.get('targetSessionId');
    const deviceIdRaw = parsed.searchParams.get('device');
    if (!sessionId || !connectCode || !apiUrl) return null;
    const api = new URL(apiUrl.trim());
    if (api.protocol !== 'https:' && api.protocol !== 'http:') return null;
    if (api.protocol === 'http:' && !isPrivateHost(api.hostname)) return null;
    return {
      mode: 'desktop',
      sessionId,
      connectCode,
      apiUrl,
      targetSessionId: targetSessionIdRaw ? Number(targetSessionIdRaw) : undefined,
      deviceId: deviceIdRaw ?? undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/viewer && pnpm vitest run src/lib/protocol.test.ts`
Expected: PASS (existing + new tests).

- [ ] **Step 5: Update consumers**

Search for usages of `ConnectionParams.sessionId` etc. that now need to discriminate:
```bash
grep -rn "ConnectionParams" apps/viewer/src
```
Add `if (params.mode === 'desktop')` guards as needed (callers should already be coupled to the desktop fields).

- [ ] **Step 6: Build**

Run: `cd apps/viewer && pnpm tsc --noEmit`
Expected: PASS (after guards added).

- [ ] **Step 7: Commit**

```bash
git add apps/viewer/src/lib/protocol.ts apps/viewer/src/lib/protocol.test.ts apps/viewer/src/App.tsx apps/viewer/src/components/DesktopViewer.tsx
git commit -m "viewer: parse breeze://vnc deep links"
```

### Task 3.4: App.tsx routes VNC mode to DesktopViewer

**Files:**
- Modify: `apps/viewer/src/App.tsx`

- [ ] **Step 1: Update routing**

Change the render branch to handle both modes:

```ts
if (params) {
  return (
    <DesktopViewer
      params={params}
      onDisconnect={handleDisconnect}
      onError={handleError}
    />
  );
}
```

`DesktopViewer` becomes the single entry; it inspects `params.mode` and starts the right transport.

- [ ] **Step 2: Build**

Run: `cd apps/viewer && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src/App.tsx
git commit -m "viewer: route VNC deep links into DesktopViewer"
```

### Task 3.5: Wire VNC transport + initial-from-deep-link in `DesktopViewer.tsx`

**Files:**
- Modify: `apps/viewer/src/components/DesktopViewer.tsx`

- [ ] **Step 1: Accept `vnc` initial mode**

In `DesktopViewer.tsx`:

```ts
type Transport = 'webrtc' | 'websocket' | 'vnc';

// In the connect useEffect, branch on params.mode:
async function connect() {
  if (params.mode === 'vnc') {
    // No connect-code exchange; we already have wsUrl + token from the deep link.
    authRef.current = { apiUrl: params.apiUrl, accessToken: params.accessToken, deviceId: params.deviceId };
    const session = await connectVnc(
      { tunnelId: params.tunnelId, wsUrl: params.wsUrl },
      { container: vncContainerRef.current!, onStatus: setStatusFromTransport, onError: setErrorMessage, onCredentialsRequired: openCredentialsPrompt }
    );
    sessionRef.current = session;
    setTransportState('vnc');
    return;
  }
  // existing desktop path...
}
```

Add a `vncContainerRef` and a `vncContainer` div in the JSX. Add a `<CredentialsPromptModal>` (or reuse an existing prompt component) that surfaces the username/password prompt when noVNC fires `credentialsrequired`.

- [ ] **Step 2: Add a `setTransport` switch flow**

```ts
const setTransport = useCallback(async (target: Transport) => {
  if (target === transportRef.current) return;
  setStatus('connecting'); // reuse "connecting" for the brief swap
  setSwitchingTo(target);

  // Close current
  sessionRef.current?.close();
  sessionRef.current = null;

  const auth = authRef.current;
  if (!auth) return;

  try {
    if (target === 'vnc') {
      const tunnel = await createVncTunnel(auth.deviceId!, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
      const session = await connectVnc(tunnel, { container: vncContainerRef.current!, onStatus: setStatusFromTransport, onError: setErrorMessage, onCredentialsRequired: openCredentialsPrompt });
      sessionRef.current = session;
      setTransportState('vnc');
    } else if (target === 'webrtc') {
      const ok = await connectWebRTC(auth);
      if (!ok) throw new Error('WebRTC connect failed');
    }
  } catch (err) {
    setErrorMessage(`Failed to switch to ${target}: ${err instanceof Error ? err.message : String(err)}`);
    setStatus('error');
  } finally {
    setSwitchingTo(null);
  }
}, [/* deps */]);
```

- [ ] **Step 3: Auto-fall-back to VNC**

In the WebRTC `onFailed` callback, after the existing reconnect deadline expires, if `remoteOs === 'macos'` and `auth.deviceId` is set, call `setTransport('vnc')` instead of leaving the user on a dead session.

In the WebRTC control-channel `onMessage` handler, recognize `desktop_state`:

```ts
case 'desktop_state':
  setDesktopState({ state: msg.state, userName: msg.userName });
  if (msg.state === 'loginwindow' && remoteOs === 'macos') {
    // WebRTC will lose input — fall back to VNC.
    void setTransport('vnc');
  }
  break;
```

- [ ] **Step 4: Poll desktop-access while on VNC**

```ts
useEffect(() => {
  if (transport !== 'vnc' || remoteOs !== 'macos' || !authRef.current?.deviceId) return;
  const auth = authRef.current;
  let cancelled = false;

  const poll = async () => {
    try {
      const res = await fetch(`${auth.apiUrl}/devices/${auth.deviceId}/desktop-access`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!res.ok || cancelled) return;
      const data = await res.json();
      // Surface in toolbar pill: WebRTC available + user logged in
      setWebRTCAvailable(data.mode === 'available' && data.state === 'user_session');
      setRemoteUserName(data.userName ?? null);
    } catch {
      // ignore
    }
  };

  poll();
  const t = setInterval(poll, 5000);
  return () => { cancelled = true; clearInterval(t); };
}, [transport, remoteOs]);
```

Note: this requires `GET /devices/:id/desktop-access` to exist in the API. If it doesn't yet, see Task 3.5b.

- [ ] **Step 5: Render the VNC container + credentials modal**

In the JSX next to `<video>` and `<canvas>`, add:

```tsx
<div
  ref={vncContainerRef}
  className={`flex-1 min-h-0 bg-black overflow-hidden relative flex items-center justify-center ${transport !== 'vnc' ? 'hidden' : ''}`}
/>
{credentialsPrompt && (
  <CredentialsPromptModal
    requiresUsername={credentialsPrompt.requiresUsername}
    onSubmit={(creds) => {
      credentialsPrompt.submit(creds);
      setCredentialsPrompt(null);
    }}
    onCancel={() => {
      setCredentialsPrompt(null);
      handleDisconnect();
    }}
  />
)}
```

`CredentialsPromptModal` is a small new component (extract from the web `VncViewer.tsx`'s password-required overlay).

- [ ] **Step 6: Build**

Run: `cd apps/viewer && pnpm tsc --noEmit && pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: Manual smoke test**

Open the web app, click VNC for the macOS device, the deep link launches the viewer in VNC mode, the modal prompts for the macOS username + password, you connect.

- [ ] **Step 8: Commit**

```bash
git add apps/viewer/src/components/DesktopViewer.tsx apps/viewer/src/components/CredentialsPromptModal.tsx
git commit -m "viewer: integrate VNC transport + transport switcher state machine"
```

### Task 3.5b: Add `GET /devices/:id/desktop-access` (only if missing)

**Files:**
- Modify: `apps/api/src/routes/devices.ts` (or wherever device routes live)
- Modify: corresponding `.test.ts`

- [ ] **Step 1: Check if endpoint exists**

Run: `grep -rn "desktop-access" apps/api/src/`
If a GET route already exists that returns `desktopAccess` info, skip this task. Otherwise:

- [ ] **Step 2: Add a thin route**

```ts
devices.get('/:id/desktop-access', requireAuth, async (c) => {
  const deviceId = c.req.param('id');
  // Read the most recent desktop-access snapshot the agent reported.
  // Source: same data the device list / detail endpoint already exposes
  // — extract into a shared service if not already.
  const snapshot = await getDesktopAccess(deviceId, c.get('user'));
  if (!snapshot) return c.json({ error: 'not found' }, 404);
  return c.json(snapshot);
});
```

Where `getDesktopAccess` returns `{ mode: 'available' | 'unavailable', reason?: string, state?: 'loginwindow' | 'user_session', userName?: string }`.

- [ ] **Step 3: Test**

```ts
it('returns desktop-access snapshot for an authorized device', async () => {
  const res = await app.request(`/devices/${deviceId}/desktop-access`, { headers: authHeaders });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('mode');
});
```

- [ ] **Step 4: Run tests, build, commit**

```bash
cd apps/api && pnpm tsc --noEmit && pnpm vitest run src/routes/devices.test.ts
git add apps/api/src/routes/devices.ts apps/api/src/routes/devices.test.ts
git commit -m "api: expose GET /devices/:id/desktop-access for viewer polling"
```

### Task 3.6: Toolbar — transport dropdown, "Switch available" pill, capability hiding

**Files:**
- Modify: `apps/viewer/src/components/ViewerToolbar.tsx`

- [ ] **Step 1: Accept new props**

```ts
interface ViewerToolbarProps {
  // ... existing props
  transport: Transport | null;
  capabilities: TransportCapabilities | null;
  remoteOs: string | null;
  webRTCAvailable: boolean;
  remoteUserName: string | null;
  onSwitchTransport: (target: 'webrtc' | 'vnc') => void;
}
```

- [ ] **Step 2: Render dropdown when `remoteOs === 'macos'`**

```tsx
{remoteOs === 'macos' && (
  <TransportDropdown
    current={transport}
    webRTCAvailable={webRTCAvailable}
    onSelect={onSwitchTransport}
  />
)}
```

`TransportDropdown` is a new small component inside `ViewerToolbar.tsx` (or a sibling file). Disabled options show a tooltip explaining why ("WebRTC unavailable: device is at login window").

- [ ] **Step 3: "Switch to WebRTC" pill**

```tsx
{remoteOs === 'macos' && transport === 'vnc' && webRTCAvailable && (
  <SwitchAvailablePill
    userName={remoteUserName}
    onSwitch={() => onSwitchTransport('webrtc')}
  />
)}
```

Auto-dismiss after 30s using a `useEffect` + `setTimeout`.

- [ ] **Step 4: Capability-aware hiding**

Wrap each toolbar control with a `capabilities.X` guard. Example:

```tsx
{capabilities?.monitors && monitors.length > 1 && (
  <MonitorSwitcher monitors={monitors} active={activeMonitor} onSwitch={onSwitchMonitor} />
)}
{capabilities?.bitrateControl && (
  <BitrateSlider bitrate={bitrate} onChange={onBitrateChange} />
)}
{capabilities?.audio && hasAudioTrack && (
  <AudioToggle enabled={audioEnabled} onToggle={onToggleAudio} />
)}
{capabilities?.sas && (
  <SasButton onClick={onSendSAS} />
)}
{capabilities?.sessionSwitch && sessions.length > 1 && (
  <SessionSwitcher ... />
)}
```

- [ ] **Step 5: Build**

Run: `cd apps/viewer && pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Manual test**

- macOS device on user session: dropdown shows both options, WebRTC is checked.
- macOS device after manual switch to VNC: dropdown shows both, VNC is checked, monitor/bitrate/audio/SAS hidden.
- Windows device: dropdown not rendered.

- [ ] **Step 7: Commit**

```bash
git add apps/viewer/src/components/ViewerToolbar.tsx
git commit -m "viewer: toolbar — transport dropdown + switch-available pill (mac only)"
```

### Task 3.7: ConnectVncButton passes accessToken to viewer

**Files:**
- Modify: `apps/web/src/components/remote/ConnectVncButton.tsx`

- [ ] **Step 1: Append accessToken to deep link**

The web app already has the user's auth token via `fetchWithAuth`. Extract and append it:

```ts
const authToken = getAuthToken(); // from your auth store
const deepLink = `breeze://vnc?tunnel=${encodeURIComponent(tunnel.id)}` +
  `&ws=${encodeURIComponent(wsUrl)}` +
  `&device=${encodeURIComponent(deviceId)}` +
  `&api=${encodeURIComponent(apiUrl)}` +
  `&accessToken=${encodeURIComponent(authToken)}`;
```

If the auth token isn't accessible from a synchronous getter, use the same pattern the desktop deep link uses for its `code` (see `ConnectDesktopButton.tsx`).

- [ ] **Step 2: Build**

Run: `cd apps/web && pnpm tsc --noEmit && pnpm build`
Expected: PASS.

- [ ] **Step 3: End-to-end manual test**

Click VNC on the macOS device → viewer opens, prompts for Mac username + password, connects. Then in the viewer's transport dropdown, switch to WebRTC. Verify the WebRTC session connects (proves the accessToken is valid).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/remote/ConnectVncButton.tsx
git commit -m "web: include accessToken + deviceId + api in VNC deep link"
```

### Task 3.8: End-to-end test pass + open PR3

- [ ] **Step 1: Full manual test pass against `804d096a-6400-4c6d-ab2a-8bee3e69268a`**

Run through the testing checklist from the spec:
- macOS at user session: launch via "Connect Desktop" → WebRTC works. Toolbar dropdown → switch to VNC → noVNC prompt → enter creds → VNC works. Switch back to WebRTC.
- macOS at user session: launch via "VNC Remote" → viewer opens in VNC mode directly.
- macOS log out user while on WebRTC: WebRTC fails, auto-fall-back to VNC, prompt appears, enter creds.
- macOS log in user while on VNC: "Switch to WebRTC" pill appears in toolbar.
- Windows device: toolbar shows no switcher.
- Disconnect: `lsof -i :5900` on the Mac returns nothing within 30s.

- [ ] **Step 2: Push and PR**

```bash
git push -u origin HEAD
gh pr create --title "viewer: in-window WebRTC <-> VNC switcher with auto-handoff (macOS)" --body "$(cat <<'EOF'
## Summary
- Adds VNC transport to the Tauri viewer with a transport dropdown (macOS only)
- Auto-falls-back to VNC when the agent reports loginwindow or WebRTC dies
- Surfaces a non-modal "Switch to WebRTC" pill when the remote user logs back in
- Reuses the existing per-session VNC tunnel, ARD authentication via macOS user creds, and tunnel cleanup invariants

## Test plan
- [x] Manual: macOS device at user session — WebRTC default, manual switch to VNC works
- [x] Manual: launch directly in VNC via "VNC Remote" button — viewer opens in VNC mode
- [x] Manual: log out remote user during WebRTC session — auto-fall-back to VNC
- [x] Manual: log in remote user during VNC session — "Switch to WebRTC" pill appears
- [x] Manual: Windows device — toolbar shows no switcher
- [x] Manual: after disconnect, \`lsof -i :5900\` on the Mac is empty
- [x] \`pnpm tsc --noEmit && pnpm vitest run\` passes in viewer + api + web

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (run after writing the plan, before committing it)

- **Spec coverage:**
  - "Make the existing deep link work in the viewer" — Task 3.1, 3.3, 3.4, 3.5.
  - "Switcher in viewer (manual)" — Task 3.6.
  - "Auto-fall-back WebRTC → VNC" — Task 3.5 step 3.
  - "Switch back to WebRTC requires manual click" — Task 3.6 step 3.
  - "Hide switcher on non-Mac" — Task 3.6 step 2 + 3 (`remoteOs === 'macos'` guards).
  - "VNC password = user creds" — Tasks 2.1, 2.2, 2.3, 3.2 (`onCredentialsRequired` always fires).
  - "Cleanup invariants carry over" — no change required (existing agent code already enforces).
  - "Three PRs, each independently shippable" — Tasks 1.4, 2.6, 3.8.

- **Placeholder scan:** None. All steps have exact file paths, code, and commands.

- **Type consistency:**
  - `TransportSession` defined in 1.1 → used in 1.2, 1.3, 3.2 with same fields.
  - `ConnectionParams` discriminated union in 3.3 → callers in 3.4, 3.5 branch on `params.mode`.
  - `TunnelAuth` in 2.4 → reused in 3.5 step 4.
  - `EnableScreenSharing()` (no param) in 2.1 → handler call in 2.1 step 3.
  - Capability flag names (`monitors`, `bitrateControl`, `audio`, `sas`, `sessionSwitch`, `clipboardChannel`) consistent across 1.1, 3.2, 3.6.

## Out of Scope (per spec)
- Linux / Windows VNC fallback.
- Sub-second auto-handoff.
- "Preferred transport" persistence.
- Recording / session capture parity for VNC.
- Bandwidth controls for VNC.
