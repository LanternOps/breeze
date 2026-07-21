# JIT VNC Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user clicks Connect Desktop on an older Mac (Monterey and below) at the login screen, automatically fall back to an in-browser VNC session with ephemeral password and full cleanup on disconnect.

**Architecture:** The agent enables macOS Screen Sharing JIT with a random password sent from the API. The existing tunnel relay pipes VNC traffic through the API WebSocket. noVNC in the browser auto-injects the password. On disconnect, the agent disables Screen Sharing entirely.

**Tech Stack:** Go agent (tunnel/vnc), Hono API (TypeScript), React + noVNC (frontend), macOS kickstart CLI

---

### Task 1: Agent — Add password support to EnableScreenSharing and add DisableScreenSharing

**Files:**
- Modify: `agent/internal/tunnel/vnc_darwin.go`
- Modify: `agent/internal/tunnel/vnc_other.go`

- [ ] **Step 1: Update `EnableScreenSharing` to accept a password and add `DisableScreenSharing` on darwin**

Replace the entire contents of `agent/internal/tunnel/vnc_darwin.go`:

```go
//go:build darwin

package tunnel

import (
	"fmt"
	"net"
	"os/exec"
	"time"
)

const (
	vncPort       = 5900
	vncCheckDelay = 2 * time.Second
	kickstartPath = "/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart"
)

// EnableScreenSharing enables macOS Screen Sharing (VNC) with an optional
// VNC legacy password. If password is empty, VNC legacy auth is not configured.
// The agent runs as root, so kickstart works without sudo.
func EnableScreenSharing(password string) error {
	log.Info("enabling macOS Screen Sharing via kickstart", "hasPassword", password != "")

	args := []string{
		"-activate",
		"-configure", "-access", "-on",
		"-restart", "-agent",
		"-privs", "-all",
	}

	if password != "" {
		args = append(args, "-configure", "-clientopts",
			"-setvnclegacy", "-vnclegacy", "yes",
			"-setvncpw", "-vncpw", password,
		)
	}

	cmd := exec.Command(kickstartPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Atomic rollback: disable if enable failed partway
		_ = DisableScreenSharing()
		return fmt.Errorf("kickstart failed: %w (output: %s)", err, string(output))
	}

	// Give the VNC server a moment to start listening.
	time.Sleep(vncCheckDelay)

	if !isPortListening("127.0.0.1", vncPort) {
		// Atomic rollback: disable if port never came up
		_ = DisableScreenSharing()
		return fmt.Errorf("VNC server not listening on port %d after kickstart", vncPort)
	}

	log.Info("macOS Screen Sharing enabled successfully")
	return nil
}

// DisableScreenSharing deactivates macOS Screen Sharing (ARD agent).
// Idempotent — safe to call if already disabled.
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

// IsScreenSharingRunning checks if VNC is listening on port 5900.
func IsScreenSharingRunning() bool {
	return isPortListening("127.0.0.1", vncPort)
}

func isPortListening(host string, port int) bool {
	addr := fmt.Sprintf("%s:%d", host, port)
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
```

- [ ] **Step 2: Update vnc_other.go with matching signatures**

Replace the entire contents of `agent/internal/tunnel/vnc_other.go`:

```go
//go:build !darwin

package tunnel

// EnableScreenSharing is a no-op on non-macOS platforms.
// VNC tunnels can still work if a VNC server is running.
func EnableScreenSharing(_ string) error {
	return nil
}

// DisableScreenSharing is a no-op on non-macOS platforms.
func DisableScreenSharing() error {
	return nil
}

// IsScreenSharingRunning always returns false on non-macOS.
func IsScreenSharingRunning() bool {
	return false
}
```

- [ ] **Step 3: Verify the agent compiles**

Run: `cd agent && go build ./...`
Expected: Clean compilation (warnings about go-m1cpu are OK)

- [ ] **Step 4: Commit**

```bash
git add agent/internal/tunnel/vnc_darwin.go agent/internal/tunnel/vnc_other.go
git commit -m "feat(agent): add password support to EnableScreenSharing and add DisableScreenSharing"
```

---

### Task 2: Agent — VNC cleanup in tunnel handlers

**Files:**
- Modify: `agent/internal/heartbeat/handlers_tunnel.go`

- [ ] **Step 1: Update handleTunnelOpen to pass vncPassword to EnableScreenSharing**

In `agent/internal/heartbeat/handlers_tunnel.go`, find the block (around line 76-82):

```go
// For VNC on macOS, enable Screen Sharing if needed.
if isVNC {
	if err := tunnel.EnableScreenSharing(); err != nil {
		log.Warn("failed to enable screen sharing", "error", err.Error())
		// Non-fatal — VNC server might already be running.
	}
}
```

Replace with:

```go
// For VNC on macOS, enable Screen Sharing with JIT password.
if isVNC {
	vncPassword, _ := cmd.Payload["vncPassword"].(string)
	if err := tunnel.EnableScreenSharing(vncPassword); err != nil {
		log.Warn("failed to enable screen sharing", "error", err.Error())
		// Non-fatal — VNC server might already be running.
	}
}
```

- [ ] **Step 2: Update handleTunnelClose to disable Screen Sharing for VNC tunnels**

In `agent/internal/heartbeat/handlers_tunnel.go`, find `handleTunnelClose` (around line 157). Replace the entire function:

```go
func handleTunnelClose(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	tunnelID, _ := cmd.Payload["tunnelId"].(string)
	if tunnelID == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing tunnelId",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Check tunnel type before closing so we know if VNC cleanup is needed.
	var wasVNC bool
	if h.tunnelMgr != nil {
		wasVNC = h.tunnelMgr.GetTunnelType(tunnelID) == "vnc"
		h.tunnelMgr.CloseTunnel(tunnelID)
	}

	// Disable Screen Sharing if this was a VNC tunnel and no other VNC tunnels remain.
	if wasVNC && h.tunnelMgr != nil && !h.tunnelMgr.HasVNCTunnels() {
		if err := tunnel.DisableScreenSharing(); err != nil {
			log.Warn("failed to disable screen sharing after VNC tunnel close", "error", err.Error())
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"tunnelId": tunnelID,
		"closed":   true,
	}, time.Since(start).Milliseconds())
}
```

- [ ] **Step 3: Verify the agent compiles (will fail — GetTunnelType and HasVNCTunnels not yet added)**

Run: `cd agent && go build ./...`
Expected: Compilation error for `GetTunnelType` and `HasVNCTunnels` — these are added in Task 3.

---

### Task 3: Agent — Add GetTunnelType and HasVNCTunnels to tunnel manager

**Files:**
- Modify: `agent/internal/tunnel/manager.go`

- [ ] **Step 1: Add GetTunnelType and HasVNCTunnels methods**

Add the following methods to `agent/internal/tunnel/manager.go` after the `ActiveCount` method (after line 115):

```go
// GetTunnelType returns the tunnel type for the given ID, or empty string if not found.
func (m *Manager) GetTunnelType(id string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s, ok := m.sessions[id]; ok && s != nil {
		return s.TunnelType
	}
	return ""
}

// HasVNCTunnels returns true if any active tunnel has type "vnc".
func (m *Manager) HasVNCTunnels() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s != nil && s.TunnelType == "vnc" {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Extend reapIdle to disable Screen Sharing when a VNC tunnel is reaped**

In `agent/internal/tunnel/manager.go`, replace the `reapIdle` method (around line 150):

```go
func (m *Manager) reapIdle() {
	now := time.Now().Unix()
	threshold := int64(m.idleTimeout.Seconds())

	m.mu.RLock()
	var stale []string
	for id, s := range m.sessions {
		if s != nil && (now-s.LastActive()) > threshold {
			stale = append(stale, id)
		}
	}
	m.mu.RUnlock()

	var reapedVNC bool
	for _, id := range stale {
		if m.GetTunnelType(id) == "vnc" {
			reapedVNC = true
		}
		log.Info("reaping idle tunnel", "tunnelId", id)
		m.CloseTunnel(id)
	}

	// If we reaped a VNC tunnel and no others remain, disable Screen Sharing.
	if reapedVNC && !m.HasVNCTunnels() {
		if err := DisableScreenSharing(); err != nil {
			log.Warn("failed to disable screen sharing after idle VNC reap", "error", err.Error())
		}
	}
}
```

- [ ] **Step 3: Verify the agent compiles**

Run: `cd agent && go build ./...`
Expected: Clean compilation

- [ ] **Step 4: Commit tasks 2 and 3 together**

```bash
git add agent/internal/heartbeat/handlers_tunnel.go agent/internal/tunnel/manager.go
git commit -m "feat(agent): VNC cleanup on tunnel close and idle reap"
```

---

### Task 4: Agent — Startup cleanup for orphaned Screen Sharing

**Files:**
- Modify: `agent/internal/tunnel/manager.go`

- [ ] **Step 1: Add CleanupOrphanedVNC method to Manager**

Add to `agent/internal/tunnel/manager.go` after the `HasVNCTunnels` method:

```go
// CleanupOrphanedVNC disables Screen Sharing if it's running but there are
// no active VNC tunnels. Called on agent startup to clean up after crashes.
func (m *Manager) CleanupOrphanedVNC() {
	if !IsScreenSharingRunning() {
		return
	}
	if m.HasVNCTunnels() {
		return
	}
	log.Info("disabling orphaned Screen Sharing (no active VNC tunnels)")
	if err := DisableScreenSharing(); err != nil {
		log.Warn("failed to disable orphaned screen sharing", "error", err.Error())
	}
}
```

- [ ] **Step 2: Call CleanupOrphanedVNC on agent startup**

Find where the tunnel manager is created in the heartbeat initialization. Search for `tunnel.NewManager()` in `agent/internal/heartbeat/heartbeat.go`. After the manager is created, add:

```go
h.tunnelMgr.CleanupOrphanedVNC()
```

Run: `cd agent && grep -n "NewManager" internal/heartbeat/heartbeat.go` to find the exact line.

- [ ] **Step 3: Verify the agent compiles**

Run: `cd agent && go build ./...`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add agent/internal/tunnel/manager.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): clean up orphaned Screen Sharing on startup"
```

---

### Task 5: API — Generate VNC password and send in tunnel_open payload

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts`

- [ ] **Step 1: Add crypto import and password generation**

At the top of `apps/api/src/routes/tunnels.ts`, add the import (if not already present):

```typescript
import { randomBytes } from 'node:crypto';
```

- [ ] **Step 2: Generate password and include in tunnel_open command**

In the `POST /tunnels` handler, find the section that sends the `tunnel_open` command (around line 244-256). Replace the command-sending block and response:

```typescript
    // Generate ephemeral VNC password for JIT Screen Sharing
    const vncPassword = isVNC ? randomBytes(6).toString('base64url').slice(0, 8) : undefined;

    // Send tunnel_open command to agent
    const allowlistPatterns = isVNC ? [] : await getActiveAllowlistPatterns(device.orgId);
    const sent = sendCommandToAgent(device.agentId!, {
      id: `tun-open-${session!.id}`,
      type: 'tunnel_open',
      payload: {
        tunnelId: session!.id,
        targetHost,
        targetPort,
        tunnelType: body.type,
        allowlistRules: allowlistPatterns,
        ...(vncPassword && { vncPassword }),
      },
    });
    if (!sent) {
      await db.update(tunnelSessions)
        .set({ status: 'failed', errorMessage: 'Agent disconnected before tunnel could be opened', endedAt: new Date() })
        .where(eq(tunnelSessions.id, session!.id));
      return c.json({ error: 'Agent disconnected before tunnel could be opened' }, 503);
    }

    return c.json({ ...session, ...(vncPassword && { vncPassword }) }, 201);
```

- [ ] **Step 3: Verify API type-checks**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors (pre-existing errors in test files are OK)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/tunnels.ts
git commit -m "feat(api): generate ephemeral VNC password in tunnel creation"
```

---

### Task 6: Frontend — noVNC ESM fix (bug fix from testing)

**Files:**
- Modify: `apps/web/astro.config.mjs`
- Modify: `apps/web/src/lib/novnc.ts`
- Already done: `@novnc/novnc` upgraded to 1.7.0-beta in package.json

Note: The noVNC upgrade and novnc.ts wrapper were already created during testing. This task verifies the current state is correct and commits cleanly.

- [ ] **Step 1: Verify astro.config.mjs has no `exclude: ['@novnc/novnc']`**

In `apps/web/astro.config.mjs`, the `optimizeDeps` section should NOT have an `exclude` for noVNC. The `ssr.external` for noVNC should remain. Current state should be:

```javascript
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand', 'zustand/middleware']
    },
    ssr: {
      noExternal: ['@tanstack/react-query'],
      external: ['@novnc/novnc']
    },
```

- [ ] **Step 2: Verify novnc.ts wrapper imports from the package root**

`apps/web/src/lib/novnc.ts` should contain:

```typescript
// Re-export noVNC RFB class.
// v1.7.0-beta ships native ESM via the "exports" field in package.json.
// @ts-expect-error — no types for noVNC
export { default as RFB } from '@novnc/novnc';
```

- [ ] **Step 3: Verify VncViewer.tsx imports from the wrapper**

In `apps/web/src/components/remote/VncViewer.tsx`, the import should be:

```typescript
const { RFB } = await import('@/lib/novnc');
```

- [ ] **Step 4: Commit if any changes were needed**

```bash
git add apps/web/astro.config.mjs apps/web/src/lib/novnc.ts apps/web/src/components/remote/VncViewer.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "fix(web): upgrade noVNC to 1.7.0-beta for ESM compatibility"
```

---

### Task 7: Frontend — VncViewer password auto-inject

**Files:**
- Modify: `apps/web/src/components/remote/VncViewer.tsx`

- [ ] **Step 1: Add password prop to VncViewer**

In `apps/web/src/components/remote/VncViewer.tsx`, update the interface (around line 16):

```typescript
interface VncViewerProps {
  wsUrl: string;
  tunnelId: string;
  password?: string;
  onDisconnect?: () => void;
  className?: string;
}
```

Update the component signature (around line 30):

```typescript
export default function VncViewer({ wsUrl, tunnelId, password, onDisconnect, className }: VncViewerProps) {
```

- [ ] **Step 2: Auto-inject password on credentialsrequired**

Replace the `credentialsrequired` event listener (around line 70-72):

```typescript
      rfb.addEventListener('credentialsrequired', () => {
        if (password) {
          rfb.sendCredentials({ password });
        }
        // If no password, noVNC shows its native password prompt in the canvas
      });
```

- [ ] **Step 3: Add password to the useEffect dependency array**

Update the dependency array at the end of the `useEffect` (around line 95):

```typescript
  }, [wsUrl, password, onDisconnect]);
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/remote/VncViewer.tsx
git commit -m "feat(web): auto-inject VNC password on credentialsrequired"
```

---

### Task 8: Frontend — VncViewerPage password badge and disconnect fix

**Files:**
- Modify: `apps/web/src/components/remote/VncViewerPage.tsx`

- [ ] **Step 1: Rewrite VncViewerPage with password support and no auto-redirect**

Replace the entire contents of `apps/web/src/components/remote/VncViewerPage.tsx`:

```tsx
import { useCallback, useState } from 'react';
import { ArrowLeft, X, Key, Copy, Check } from 'lucide-react';
import VncViewer from './VncViewer';
import { fetchWithAuth } from '@/stores/auth';

interface Props {
  tunnelId: string;
  wsUrl: string;
  password?: string;
}

export default function VncViewerPage({ tunnelId, wsUrl, password }: Props) {
  const [copied, setCopied] = useState(false);

  const handleDisconnect = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch(() => {});
  }, [tunnelId]);

  const handleCopyPassword = useCallback(async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be blocked
    }
  }, [password]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-4 py-2">
        <div className="flex items-center gap-3">
          <a
            href="/remote"
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
          <span className="text-sm text-gray-500">|</span>
          <span className="text-sm font-medium text-gray-200">
            VNC Session
          </span>
          <span className="text-xs text-gray-500">{tunnelId.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-2">
          {password && (
            <button
              type="button"
              onClick={handleCopyPassword}
              className="flex items-center gap-1.5 rounded-md bg-gray-800 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 transition"
              title="Copy VNC password"
            >
              <Key className="h-3 w-3" />
              <span className="font-mono">{password}</span>
              {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
          <button
            type="button"
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition"
          >
            <X className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      </div>
      <div className="flex-1">
        <VncViewer
          wsUrl={wsUrl}
          tunnelId={tunnelId}
          password={password}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update the Astro page to pass password**

Replace the entire contents of `apps/web/src/pages/remote/vnc/[tunnelId].astro`:

```astro
---
import Layout from '../../../layouts/Layout.astro';
import VncViewerPage from '../../../components/remote/VncViewerPage';

const { tunnelId } = Astro.params;
const wsUrl = Astro.url.searchParams.get('ws') || '';
const password = Astro.url.searchParams.get('pwd') || '';

if (!tunnelId || !wsUrl) {
  return Astro.redirect('/remote');
}
---

<Layout title="VNC Remote Desktop">
  <div class="h-[calc(100vh-1rem)]">
    <VncViewerPage
      tunnelId={tunnelId}
      wsUrl={wsUrl}
      password={password}
      client:only="react"
    />
  </div>
</Layout>
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/remote/VncViewerPage.tsx apps/web/src/pages/remote/vnc/\\[tunnelId\\].astro
git commit -m "feat(web): VNC viewer password badge and remove auto-redirect on disconnect"
```

---

### Task 9: Frontend — ConnectDesktopButton VNC fallback flow

**Files:**
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx`

- [ ] **Step 1: Add VNC flow to the click handler**

In `apps/web/src/components/remote/ConnectDesktopButton.tsx`, find `handleConnect` (around line 68). Add a VNC detection branch at the very start of the try block, before the existing WebRTC session creation code. Insert after `setError(null);` (line 70):

```typescript
      // Auto-detect: fall back to VNC for older macOS at login screen
      const needsVNC = desktopAccess?.mode === 'unavailable'
        && desktopAccess?.reason === 'unsupported_os'
        && remoteAccessPolicy?.vncRelay === true;

      if (needsVNC) {
        // Create VNC tunnel — API generates ephemeral password
        const tunnelRes = await fetchWithAuth('/tunnels', {
          method: 'POST',
          body: JSON.stringify({ deviceId, type: 'vnc' }),
        });

        if (!tunnelRes.ok) {
          const err = await tunnelRes.json().catch(() => ({ error: 'Failed to create VNC tunnel' }));
          throw new Error(err.error || 'Failed to create VNC tunnel');
        }

        const tunnel = await tunnelRes.json();
        const vncPassword = tunnel.vncPassword || '';

        // Get WS ticket for the tunnel
        const ticketRes = await fetchWithAuth(`/tunnels/${tunnel.id}/ws-ticket`, {
          method: 'POST',
        });
        if (!ticketRes.ok) {
          throw new Error('Failed to obtain VNC tunnel ticket');
        }
        const ticketData = await ticketRes.json();
        const ticket = ticketData.ticket?.ticket;

        // Navigate to the in-browser VNC viewer
        const apiHost = window.location.origin;
        const wsUrl = `wss://${window.location.host}/api/v1/tunnel-ws/${tunnel.id}/ws?ticket=${ticket}`;
        window.location.href = `/remote/vnc/${tunnel.id}?ws=${encodeURIComponent(wsUrl)}&pwd=${encodeURIComponent(vncPassword)}`;

        setStatus('idle');
        return;
      }
```

- [ ] **Step 2: Update the unsupported_os tooltip when VNC is not enabled**

In `apps/web/src/components/remote/ConnectDesktopButton.tsx`, find the `desktopAccessUnavailableReason` function (around line 31). Update the `unsupported_os` case:

```typescript
    case 'unsupported_os':
      return remoteAccessPolicy?.vncRelay
        ? null  // VNC fallback available — don't show unavailable message
        : 'Login-window desktop requires macOS 14 (Sonoma) or later. Enable VNC Relay in the device\'s configuration policy to connect at the login screen.';
```

Note: The function needs access to `remoteAccessPolicy`. Since it's currently a standalone function, either convert it to accept the policy as a second parameter or inline the check. The simplest approach is to add the parameter:

Update the function signature:

```typescript
function desktopAccessUnavailableReason(
  desktopAccess: DesktopAccessState | null | undefined,
  remoteAccessPolicy?: RemoteAccessPolicy | null,
): string | null {
```

Then update all call sites (search for `desktopAccessUnavailableReason(` in the file) to pass `remoteAccessPolicy` as the second argument.

- [ ] **Step 3: Verify no TypeScript errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/remote/ConnectDesktopButton.tsx
git commit -m "feat(web): auto-detect VNC fallback for unsupported_os macOS in Connect Desktop"
```

---

### Task 10: Integration test — Dev push agent and verify VNC flow

This task is manual verification, not automated tests.

- [ ] **Step 1: Build and push agent to test device**

```bash
cd agent
JWT=$(curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@breeze.local","password":"qac3amt5PRB3djf@vxg"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")

GOOS=darwin GOARCH=arm64 go build -ldflags "-X main.version=dev-$(date +%s)" -o bin/breeze-agent-dev ./cmd/breeze-agent

curl -sf -X POST "http://localhost:3001/api/v1/dev/push" \
  -H "Authorization: Bearer $JWT" \
  -F "agentId=dd6982b3-0cc7-4e29-8268-44c74f3c8eab" \
  -F "version=dev-vnc" \
  -F "binary=@bin/breeze-agent-dev" | python3 -m json.tool
```

After push, SSH into the Mac and sign + restart if needed:
```bash
sudo codesign --force --sign - /usr/local/bin/breeze-agent
sudo launchctl kickstart -k system/com.breeze.agent
```

- [ ] **Step 2: Rebuild web container**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d web
```

- [ ] **Step 3: Verify VNC flow via Playwright**

1. Login to `https://2breeze.app`
2. Navigate to the test device
3. Click Connect Desktop
4. If device reports `unsupported_os` + VNC relay enabled: should create tunnel, navigate to VNC viewer, auto-inject password
5. Verify noVNC shows the remote desktop (or password prompt if auto-inject fails)
6. Disconnect and verify Screen Sharing is disabled on the Mac

- [ ] **Step 4: Verify cleanup scenarios**

1. Close browser tab during VNC session — wait 5 min, verify Screen Sharing disabled
2. Restart agent during VNC session — verify startup cleanup disables Screen Sharing
