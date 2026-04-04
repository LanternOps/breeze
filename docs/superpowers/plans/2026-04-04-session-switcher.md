# Session Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar dropdown in the Tauri viewer that lists Windows sessions and allows switching between them via WebRTC tear-down/reconnect.

**Architecture:** The viewer sends `list_sessions` over the WebRTC control channel; the agent-side helper enumerates WTS sessions and responds. Switching tears down the current WebRTC session and reconnects with `targetSessionId`. The agent relaxes its disconnected-session filter when an explicit target is provided.

**Tech Stack:** Go (agent control handler), React/TypeScript (Tauri viewer), WebRTC data channels

---

### Task 1: Add `list_sessions` control message handler (Agent)

**Files:**
- Modify: `agent/internal/remote/desktop/session_control.go:85` (add case to switch)

- [ ] **Step 1: Add the `list_sessions` case to `handleControlMessage`**

Add a new case in the `switch msg.Type` block (after `case "request_keyframe"` at line 114, before `case "list_monitors"` at line 119). This follows the exact same pattern as `list_monitors`:

```go
	case "list_sessions":
		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			slog.Warn("Failed to list sessions", "session", s.id, "error", err.Error())
			return
		}
		items := make([]ipc.SessionInfoItem, 0, len(detected))
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			sessionNum, parseErr := sessionbroker.ParseWindowsSessionIDForHeartbeat(ds.Session)
			if parseErr != nil {
				continue
			}
			items = append(items, ipc.SessionInfoItem{
				SessionID:       sessionNum,
				Username:        ds.Username,
				State:           ds.State,
				Type:            ds.Type,
				HelperConnected: false, // helper has no broker access
			})
		}
		resp, _ := json.Marshal(map[string]any{
			"type":     "sessions",
			"sessions": items,
		})
		s.mu.RLock()
		dc := s.controlDC
		s.mu.RUnlock()
		if dc != nil {
			dc.SendText(string(resp))
		}
```

- [ ] **Step 2: Add required imports**

Add to the import block at the top of `session_control.go`:

```go
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/remote/desktop/...`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/session_control.go
git commit -m "feat(agent): add list_sessions control channel handler

Enumerates WTS sessions via NewSessionDetector and returns them
over the WebRTC control data channel. Filters out Session 0
(services). Used by the viewer session switcher dropdown."
```

---

### Task 2: Relax disconnected-session skip for explicit targets (Agent)

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop_helper.go:195,221,245`

The current logic in `findOrSpawnHelper` unconditionally rejects helpers in disconnected Windows sessions. When the viewer explicitly requests a session via `targetSessionId`, the skip should be bypassed so the helper can attempt capture (GDI fallback handles disconnected displays).

- [ ] **Step 1: Update first disconnected check (line 195-199)**

Change from:
```go
	if session != nil && isWinSessionDisconnected(session.WinSessionID) {
		log.Warn("helper is in a disconnected Windows session, spawning new helper",
			"helperSession", session.SessionID,
			"winSession", session.WinSessionID)
		session = nil
	}
```

To:
```go
	if session != nil && targetSession == "" && isWinSessionDisconnected(session.WinSessionID) {
		log.Warn("helper is in a disconnected Windows session, spawning new helper",
			"helperSession", session.SessionID,
			"winSession", session.WinSessionID)
		session = nil
	}
```

- [ ] **Step 2: Update second disconnected check after lock (line 221-222)**

Change from:
```go
	if session != nil && isWinSessionDisconnected(session.WinSessionID) {
		session = nil
	}
```

To:
```go
	if session != nil && targetSession == "" && isWinSessionDisconnected(session.WinSessionID) {
		session = nil
	}
```

- [ ] **Step 3: Update polling loop check (line 245)**

Change from:
```go
		if session != nil && !isWinSessionDisconnected(session.WinSessionID) {
			return session
		}
```

To:
```go
		if session != nil && (targetSession != "" || !isWinSessionDisconnected(session.WinSessionID)) {
			return session
		}
```

This means: when an explicit target is specified, accept the session even if disconnected. When auto-detecting, maintain the existing behavior of skipping disconnected sessions.

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/heartbeat/...`
Expected: Clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop_helper.go
git commit -m "feat(agent): allow helper spawn in disconnected sessions when explicitly targeted

When targetSessionId is set (user chose the session), bypass the
disconnected-session check. GDI fallback handles capture when DXGI
fails on disconnected displays. Auto-detect mode keeps the existing
skip behavior."
```

---

### Task 3: Add session state and switch logic (Viewer)

**Files:**
- Modify: `apps/viewer/src/components/DesktopViewer.tsx`

This task adds session tracking state, control channel integration for `list_sessions`, 30-second polling, and the tear-down/reconnect switch handler.

- [ ] **Step 1: Add SessionInfo type and state variables**

After the existing `MonitorInfo`-style state (line 61, after `const [activeMonitor, setActiveMonitor] = useState(0);`), add:

```typescript
  const [sessions, setSessions] = useState<Array<{ sessionId: number; username: string; state: string; type: string; helperConnected: boolean }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(params.targetSessionId ?? null);
  const [switchingSession, setSwitchingSession] = useState<string | null>(null);
```

- [ ] **Step 2: Add `targetSessionId` parameter to `connectWebRTC`**

Change the `connectWebRTC` signature (line 108) from:

```typescript
  const connectWebRTC = useCallback(async (auth: AuthenticatedConnectionParams): Promise<boolean> => {
```

To:

```typescript
  const connectWebRTC = useCallback(async (auth: AuthenticatedConnectionParams, targetSessionId?: number): Promise<boolean> => {
```

And change line 113 from:

```typescript
      const session = await createWebRTCSession(auth, videoEl, undefined, params.targetSessionId);
```

To:

```typescript
      const session = await createWebRTCSession(auth, videoEl, undefined, targetSessionId ?? params.targetSessionId);
```

Also update the two call sites that invoke `connectWebRTC(auth)` — they pass no second arg, so they continue to use `params.targetSessionId` as fallback. No changes needed at those call sites.

- [ ] **Step 3: Send `list_sessions` on control channel open and handle response**

In the `useEffect` that handles the control channel (around line 806-851), add `list_sessions` to the `onOpen` handler and a response case to `onMessage`:

Change `onOpen` from:
```typescript
    const onOpen = () => {
      ch.send(JSON.stringify({ type: 'list_monitors' }));
    };
```

To:
```typescript
    const onOpen = () => {
      ch.send(JSON.stringify({ type: 'list_monitors' }));
      ch.send(JSON.stringify({ type: 'list_sessions' }));
    };
```

Add a case in the `onMessage` switch (after the `case 'monitors':` block):
```typescript
          case 'sessions':
            if (Array.isArray(msg.sessions)) setSessions(msg.sessions);
            break;
```

- [ ] **Step 4: Add 30-second polling for session list**

Inside the same `useEffect` (after the `ch.addEventListener('message', onMessage);` line, before the return cleanup), add a polling interval:

```typescript
    const sessionPollInterval = setInterval(() => {
      if (ch.readyState === 'open') {
        ch.send(JSON.stringify({ type: 'list_sessions' }));
      }
    }, 30_000);
```

Add cleanup in the return function:
```typescript
    return () => {
      ch.removeEventListener('open', onOpen);
      ch.removeEventListener('message', onMessage);
      clearInterval(sessionPollInterval);
    };
```

- [ ] **Step 5: Add `handleSwitchSession` callback**

Add after `handleSwitchMonitor` (around line 1220):

```typescript
  const handleSwitchSession = useCallback(async (sessionId: number) => {
    const auth = authRef.current;
    if (!auth) return;
    const target = sessions.find(s => s.sessionId === sessionId);
    const label = target?.username || `Session ${sessionId}`;

    setSwitchingSession(label);

    // Tear down current WebRTC session
    releaseAllKeys();
    const prevSession = webrtcRef.current;
    webrtcRef.current = null;
    const audioEl = (prevSession as any)?._audioEl as HTMLAudioElement | undefined;
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
    }
    prevSession?.close();

    // Reset display state
    setMonitors([]);
    setActiveMonitor(0);
    setTransportState(null);

    try {
      const ok = await connectWebRTC(auth, sessionId);
      if (!ok) throw new Error('WebRTC connection failed');
      setActiveSessionId(sessionId);
    } catch (err) {
      setErrorMessage(`Failed to switch to ${label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSwitchingSession(null);
    }
  }, [sessions, connectWebRTC, releaseAllKeys, setTransportState]);
```

- [ ] **Step 6: Pass session props to ViewerToolbar**

In the `<ViewerToolbar>` JSX (around line 1308), add three new props after `activeMonitor={activeMonitor}`:

```typescript
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSwitchSession={handleSwitchSession}
```

- [ ] **Step 7: Add switching overlay**

In the render section, inside the `<div className="flex-1 overflow-hidden ...">` container (around line 1338), add after the video element:

```typescript
        {/* Session switching overlay */}
        {switchingSession && (
          <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-20">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-white text-sm">Switching to {switchingSession}...</p>
            </div>
          </div>
        )}
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd /Users/toddhebebrand/breeze/apps/viewer && npx tsc --noEmit`
Expected: No new errors (may have pre-existing ones).

- [ ] **Step 9: Commit**

```bash
git add apps/viewer/src/components/DesktopViewer.tsx
git commit -m "feat(viewer): add session state, polling, and switch logic

Sends list_sessions on control channel open and polls every 30s.
handleSwitchSession tears down the current WebRTC connection and
reconnects with targetSessionId. Shows a switching overlay during
the transition."
```

---

### Task 4: Add session dropdown UI to toolbar (Viewer)

**Files:**
- Modify: `apps/viewer/src/components/ViewerToolbar.tsx`

The session dropdown follows the same visual pattern as the monitor switcher: a horizontal button group with badges, visible only when there are 2+ sessions on a WebRTC connection.

- [ ] **Step 1: Add session props to the Props interface**

After `activeMonitor: number;` in the `Props` interface, add:

```typescript
  sessions: Array<{ sessionId: number; username: string; state: string; type: string; helperConnected: boolean }>;
  activeSessionId: number | null;
  onSwitchSession: (id: number) => void;
```

- [ ] **Step 2: Destructure new props**

In the component's destructuring (after `onSwitchMonitor`), add:

```typescript
  sessions,
  activeSessionId,
  onSwitchSession,
```

- [ ] **Step 3: Add UserIcon SVG component**

Add near the existing `MonitorIcon` component (or inline). A simple user silhouette icon:

```typescript
function UserIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 14s-1 0-1-1 1-4 7-4 7 3 7 4-1 1-1 1H2Z" />
    </svg>
  );
}
```

- [ ] **Step 4: Add session dropdown UI**

Add the session switcher block after the monitor picker block (after line 299's closing `</>`) and before `<div className="flex-1" />`:

```typescript
      {/* Session picker (only shown with 2+ sessions on WebRTC) */}
      {sessions.length > 1 && transport === 'webrtc' && (
        <>
          <div className="w-px h-5 bg-gray-600" />
          <div className="flex items-center gap-1">
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => onSwitchSession(s.sessionId)}
                disabled={activeSessionId === s.sessionId}
                title={`${s.username || `Session ${s.sessionId}`} (${s.type}${s.state === 'disconnected' ? ', disconnected' : ''})`}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${
                  activeSessionId === s.sessionId
                    ? 'text-blue-400 bg-blue-500/20'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
                }`}
              >
                <UserIcon className="w-3 h-3" />
                <span className="max-w-[80px] truncate">{s.username || `Session ${s.sessionId}`}</span>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  s.state === 'active' ? 'bg-green-400' : 'bg-yellow-400'
                }`} />
                {s.type === 'rdp' && (
                  <span className="text-[9px] font-medium text-gray-500 uppercase">RDP</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/toddhebebrand/breeze/apps/viewer && npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/viewer/src/components/ViewerToolbar.tsx
git commit -m "feat(viewer): add session switcher dropdown to toolbar

Shows a horizontal button group with username, state dot (green/yellow),
and RDP badge for each Windows session. Follows the same visual pattern
as the monitor switcher. Only visible with 2+ sessions on WebRTC."
```

---

### Task 5: Manual verification checklist

No code changes — this is a verification pass.

- [ ] **Step 1: Verify agent builds cross-platform**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go build ./... && GOOS=darwin GOARCH=arm64 go build ./... && GOOS=linux GOARCH=amd64 go build ./...`
Expected: All three build cleanly.

- [ ] **Step 2: Verify viewer builds**

Run: `cd /Users/toddhebebrand/breeze/apps/viewer && npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Run Go tests**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/sessionbroker/... ./internal/heartbeat/...`
Expected: All pass.

- [ ] **Step 4: Verify spec coverage**

Checklist against spec:
- [x] `list_sessions` control message: Task 1
- [x] `sessions` response with sessionId/username/state/type/helperConnected: Task 1
- [x] No `switch_session` message (tear-down-and-reconnect): Task 3 `handleSwitchSession`
- [x] Disconnected-session skip relaxed for explicit targets: Task 2
- [x] Dropdown visible with 2+ sessions on WebRTC: Task 4
- [x] Username, type badge, state dot, active highlight: Task 4
- [x] 30-second auto-refresh: Task 3 step 4
- [x] "Switching to..." overlay: Task 3 step 7
- [x] Re-send `list_sessions` + `list_monitors` on new channel: Task 3 step 3 (control channel effect re-fires)
- [x] No changes to `webrtc.ts`: confirmed (Task 3 step 2 only touches `DesktopViewer.tsx`)
- [x] Not in scope items excluded: no pre-connect chooser, no WTSConnectSession, no web viewer, no multi-session

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: session switcher fixups"
```
