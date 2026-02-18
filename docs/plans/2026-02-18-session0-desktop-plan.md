# Session 0 Remote Desktop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable remote desktop when agent runs as a Windows service (Session 0) by spawning a SYSTEM-level helper in the user's interactive session that owns the entire WebRTC pipeline.

**Architecture:** The service detects interactive sessions via WTS API, spawns a helper process as SYSTEM in the target session using `CreateProcessAsUser`, and relays WebRTC signaling (offer/answer) over IPC. The helper owns DXGI capture, H264 encoding, and WebRTC streaming. No frame data crosses IPC.

**Tech Stack:** Go, Windows WTS API, Win32 token APIs, named pipes (go-winio), pion/webrtc, DXGI Desktop Duplication

**Design doc:** `docs/plans/2026-02-18-session0-desktop-design.md`

---

### Task 1: IPC Message Types for Desktop Signaling

**Files:**
- Modify: `agent/internal/ipc/message.go`

**Step 1: Add typed request/response structs**

After the existing `TrayAction` struct (line ~128), add:

```go
// DesktopStartRequest is sent from the service to the user helper to start a
// remote desktop session. The helper creates the full WebRTC pipeline and
// returns an SDP answer.
type DesktopStartRequest struct {
	SessionID    string          `json:"sessionId"`
	Offer        string          `json:"offer"`
	ICEServers   json.RawMessage `json:"iceServers,omitempty"`
	DisplayIndex int             `json:"displayIndex"`
}

// DesktopStartResponse is returned by the user helper after creating the
// WebRTC peer connection.
type DesktopStartResponse struct {
	SessionID string `json:"sessionId"`
	Answer    string `json:"answer"`
}

// DesktopStopRequest tells the user helper to tear down a desktop session.
type DesktopStopRequest struct {
	SessionID string `json:"sessionId"`
}

// SessionInfoItem describes one interactive Windows session for the
// list_sessions command response.
type SessionInfoItem struct {
	SessionID       uint32 `json:"sessionId"`
	Username        string `json:"username"`
	State           string `json:"state"`           // "active", "disconnected"
	Type            string `json:"type"`             // "console", "rdp", "services"
	HelperConnected bool   `json:"helperConnected"`
}
```

**Step 2: Run build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/ipc/...`
Expected: PASS (no errors)

**Step 3: Commit**

```bash
git add agent/internal/ipc/message.go
git commit -m "feat(ipc): add desktop signaling and session list message types"
```

---

### Task 2: Add CmdListSessions Command Constant

**Files:**
- Modify: `agent/internal/remote/tools/types.go`

**Step 1: Add the constant**

After the `CmdComputerAction` constant (line 139), add:

```go
	// Session management
	CmdListSessions = "list_sessions"
```

**Step 2: Run build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/remote/tools/...`
Expected: PASS

**Step 3: Commit**

```bash
git add agent/internal/remote/tools/types.go
git commit -m "feat(tools): add list_sessions command constant"
```

---

### Task 3: Windows Helper Spawner

**Files:**
- Create: `agent/internal/sessionbroker/spawner_windows.go`
- Create: `agent/internal/sessionbroker/spawner_stub.go`

**Step 1: Create the stub for non-Windows platforms**

File: `agent/internal/sessionbroker/spawner_stub.go`

```go
//go:build !windows

package sessionbroker

import "fmt"

// SpawnHelperInSession is only implemented on Windows.
// On other platforms the user helper is launched by the OS login mechanism
// (launchd LaunchAgent, systemd user service, XDG autostart).
func SpawnHelperInSession(sessionID uint32) error {
	return fmt.Errorf("helper spawning not supported on this platform")
}
```

**Step 2: Create the Windows spawner**

File: `agent/internal/sessionbroker/spawner_windows.go`

```go
//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnHelperInSession launches a user-helper process as SYSTEM in the
// specified Windows session. The helper inherits our SYSTEM token with the
// session ID overridden, giving it full desktop access (Default, Winlogon,
// Screensaver) in the target session.
func SpawnHelperInSession(sessionID uint32) error {
	// 1. Open our own process token (SYSTEM).
	var processToken windows.Token
	proc, err := windows.GetCurrentProcess()
	if err != nil {
		return fmt.Errorf("GetCurrentProcess: %w", err)
	}
	err = windows.OpenProcessToken(proc, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &processToken)
	if err != nil {
		return fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer processToken.Close()

	// 2. Duplicate as a primary token we can modify.
	var dupToken windows.Token
	err = windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil, // default security attributes
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&dupToken,
	)
	if err != nil {
		return fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dupToken.Close()

	// 3. Set the session ID on the duplicate token.
	err = windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	)
	if err != nil {
		return fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	// 4. Build the command line: same binary, "user-helper" subcommand.
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s" user-helper`, exePath))
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString: %w", err)
	}

	// 5. Target the interactive window station + default desktop.
	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}

	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation

	// 6. Create the process.
	err = windows.CreateProcessAsUser(
		dupToken,
		nil,     // lpApplicationName (use cmdLine)
		cmdLine, // lpCommandLine
		nil,     // lpProcessAttributes
		nil,     // lpThreadAttributes
		false,   // bInheritHandles
		windows.CREATE_NEW_CONSOLE|windows.CREATE_UNICODE_ENVIRONMENT,
		nil, // lpEnvironment (inherit)
		nil, // lpCurrentDirectory (inherit)
		&si,
		&pi,
	)
	if err != nil {
		return fmt.Errorf("CreateProcessAsUser(session=%d): %w", sessionID, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned user helper in session",
		"sessionId", sessionID,
		"pid", pi.ProcessId,
		"exe", exePath,
	)
	return nil
}
```

**Step 3: Verify build on macOS (stub only)**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/sessionbroker/...`
Expected: PASS (stub compiles on non-Windows)

**Step 4: Commit**

```bash
git add agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/spawner_stub.go
git commit -m "feat(sessionbroker): add Windows helper spawner using CreateProcessAsUser"
```

---

### Task 4: Broker Extensions — FindCapableSession + Session Type

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go`

**Step 1: Add `FindCapableSession` method**

After `SessionCount()` (line ~202), add:

```go
// FindCapableSession returns the first connected session whose helper reports
// the given capability (e.g., "capture"). If targetWinSession is non-empty,
// only sessions in that Windows session are considered.
func (b *Broker) FindCapableSession(capability string, targetWinSession string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, s := range b.sessions {
		if targetWinSession != "" && s.WinSessionID != targetWinSession {
			continue
		}
		if s.Capabilities == nil {
			continue
		}
		switch capability {
		case "capture":
			if s.Capabilities.CanCapture {
				return s
			}
		case "clipboard":
			if s.Capabilities.CanClipboard {
				return s
			}
		case "notify":
			if s.Capabilities.CanNotify {
				return s
			}
		}
	}
	return nil
}
```

**Step 2: Add `WinSessionID` field to Session**

In `agent/internal/sessionbroker/session.go`, add field to the `Session` struct after `AllowedScopes`:

```go
	WinSessionID  string   // Windows session ID string (e.g., "1", "2") for targeting
```

And in `NewSession`, accept and store it:
```go
func NewSession(conn *ipc.Conn, uid uint32, identityKey, username, displayEnv, sessionID string, scopes []string) *Session {
```
The existing `SessionID` field is the helper's self-assigned ID (e.g., `helper-user-1234`). We need to extract the Windows session ID from the auth request. This is the OS-level session ID (1, 2, etc.).

Add to `SessionInfo`:
```go
	WinSessionID string             `json:"winSessionId,omitempty"`
```

And to `Info()`:
```go
	WinSessionID: s.WinSessionID,
```

**Step 3: Wire up WinSessionID in broker's `handleConnection`**

In `broker.go`'s `handleConnection`, after creating the session, set `WinSessionID` from the auth request's `DisplayEnv` or add a dedicated field. Since the helper runs in a Windows session and reports `DisplayEnv: "windows"`, we need the helper to also report its Windows session ID.

Add to `ipc.AuthRequest`:
```go
	WinSessionID uint32 `json:"winSessionId,omitempty"` // Windows session ID (1, 2, etc.)
```

In `broker.go`, after session creation:
```go
	session.WinSessionID = fmt.Sprintf("%d", authReq.WinSessionID)
```

**Step 4: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/sessionbroker/...`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/session.go agent/internal/ipc/message.go
git commit -m "feat(sessionbroker): add FindCapableSession and WinSessionID tracking"
```

---

### Task 5: Enhance Detector for list_sessions

**Files:**
- Modify: `agent/internal/sessionbroker/detector.go`
- Modify: `agent/internal/sessionbroker/detector_windows.go`

**Step 1: Add session type to DetectedSession**

In `detector.go`, the `DetectedSession` struct already has `State` but not `Type`. Add:

```go
	Type     string `json:"type,omitempty"`     // "console", "rdp", "services"
```

**Step 2: Enhance Windows detector to report type and include more sessions**

In `detector_windows.go`, update `ListSessions()`:
- Query `WTSClientProtocolType` (info class 16) to detect RDP vs console
- Include session 0 (services) with `Type: "services"` and empty username
- Include sessions even without a username (for login screen)

Add constant:
```go
	wtsClientProtocolType = 16
```

Add helper:
```go
func (d *windowsDetector) querySessionUint32(sessionID uint32, infoClass uint32) (uint32, bool) {
	var buf uintptr
	var bytesReturned uint32

	r1, _, _ := procWTSQuerySessionInfo.Call(
		wtsCurrentServerHandle,
		uintptr(sessionID),
		uintptr(infoClass),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if r1 == 0 || buf == 0 {
		return 0, false
	}
	defer procWTSFreeMemory.Call(buf)

	val := *(*uint32)(unsafe.Pointer(buf))
	return val, true
}
```

Update the session loop to detect type:
```go
		sessionType := "console"
		if info.SessionID == 0 {
			sessionType = "services"
		} else if proto, ok := d.querySessionUint32(info.SessionID, wtsClientProtocolType); ok && proto == 2 {
			sessionType = "rdp"
		}
```

And relax the skip logic to include session 0 + sessions without usernames:
```go
		// Skip only listener sessions
		if info.State == 6 { // WTSListen
			continue
		}
		// Only include active/disconnected sessions (and session 0)
		if info.State != 0 && info.State != 4 && info.SessionID != 0 {
			continue
		}

		username := d.querySessionString(info.SessionID, wtsUserName)
		// Session 0 and login screen sessions won't have a username

		sessions = append(sessions, DetectedSession{
			Username: username,
			Session:  fmt.Sprintf("%d", info.SessionID),
			State:    wtsStateString(info.State),
			Display:  "windows",
			Type:     sessionType,
		})
```

**Step 3: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/sessionbroker/...`
Expected: PASS

**Step 4: Commit**

```bash
git add agent/internal/sessionbroker/detector.go agent/internal/sessionbroker/detector_windows.go
git commit -m "feat(sessionbroker): enhance detector with session type and login screen support"
```

---

### Task 6: Fix User Helper Windows Capabilities

**Files:**
- Modify: `agent/internal/userhelper/client.go`

**Step 1: Fix `detectDisplayEnv` for Windows**

In `client.go:360`, the `detectDisplayEnv()` function returns `""` on Windows because there's no `DISPLAY` or `WAYLAND_DISPLAY` env var. Fix:

```go
func detectDisplayEnv() string {
	if runtime.GOOS == "windows" {
		return "windows"
	}
	if runtime.GOOS == "darwin" {
		return "quartz"
	}
	if display := os.Getenv("WAYLAND_DISPLAY"); display != "" {
		return "wayland:" + display
	}
	if display := os.Getenv("DISPLAY"); display != "" {
		return "x11:" + display
	}
	return ""
}
```

This makes `detectCapabilities()` return `CanCapture: true` on Windows, which is correct since the helper runs in an interactive session.

**Step 2: Report WinSessionID in auth request**

In `authenticate()`, after computing `authReq`, add the Windows session ID. This requires calling `ProcessIdToSessionId`:

Add to imports: `"golang.org/x/sys/windows"` (behind build tag — need a new file or build-tagged helper)

Create `agent/internal/userhelper/session_windows.go`:

```go
//go:build windows

package userhelper

import "golang.org/x/sys/windows"

func currentWinSessionID() uint32 {
	var sessionID uint32
	err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sessionID)
	if err != nil {
		return 0
	}
	return sessionID
}
```

Create `agent/internal/userhelper/session_stub.go`:

```go
//go:build !windows

package userhelper

func currentWinSessionID() uint32 {
	return 0
}
```

Then in `authenticate()` in `client.go`, add to `authReq`:
```go
	authReq := ipc.AuthRequest{
		// ...existing fields...
		WinSessionID: currentWinSessionID(),
	}
```

**Step 3: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/userhelper/...`
Expected: PASS

**Step 4: Commit**

```bash
git add agent/internal/userhelper/client.go agent/internal/userhelper/session_windows.go agent/internal/userhelper/session_stub.go
git commit -m "feat(userhelper): fix Windows capabilities detection and report WinSessionID"
```

---

### Task 7: User Helper Desktop Session Manager

**Files:**
- Create: `agent/internal/userhelper/desktop.go`
- Modify: `agent/internal/userhelper/client.go`

**Step 1: Create the desktop session wrapper**

File: `agent/internal/userhelper/desktop.go`

```go
package userhelper

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// helperDesktopManager manages remote desktop sessions within the user helper.
// It wraps desktop.SessionManager and handles IPC-driven lifecycle.
type helperDesktopManager struct {
	mgr *desktop.SessionManager
	mu  sync.Mutex
}

func newHelperDesktopManager() *helperDesktopManager {
	return &helperDesktopManager{
		mgr: desktop.NewSessionManager(),
	}
}

// startSession parses the IPC request, creates the WebRTC session, and returns
// the SDP answer.
func (h *helperDesktopManager) startSession(req *ipc.DesktopStartRequest) (*ipc.DesktopStartResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Parse ICE servers from raw JSON
	var iceServers []desktop.ICEServerConfig
	if len(req.ICEServers) > 0 {
		if err := json.Unmarshal(req.ICEServers, &iceServers); err != nil {
			log.Warn("failed to parse ICE servers from IPC, using defaults", "error", err)
		}
	}

	answer, err := h.mgr.StartSession(req.SessionID, req.Offer, iceServers, req.DisplayIndex)
	if err != nil {
		return nil, fmt.Errorf("start desktop session: %w", err)
	}

	return &ipc.DesktopStartResponse{
		SessionID: req.SessionID,
		Answer:    answer,
	}, nil
}

// stopSession tears down the desktop session.
func (h *helperDesktopManager) stopSession(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mgr.StopSession(sessionID)
}

// stopAll tears down all active sessions (for shutdown).
func (h *helperDesktopManager) stopAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mgr.StopAllSessions()
}
```

**Step 2: Add `StopAllSessions` to `desktop.SessionManager`**

In `agent/internal/remote/desktop/webrtc.go`, add after `StopSession`:

```go
// StopAllSessions tears down all active desktop sessions.
func (m *SessionManager) StopAllSessions() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		s.Stop()
	}
}
```

**Step 3: Implement handleDesktopStart/Stop in client.go**

Replace the stubs (lines 321-332):

```go
func (c *Client) handleDesktopStart(env *ipc.Envelope) {
	var req ipc.DesktopStartRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid desktop_start payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeDesktopStart, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send desktop_start error", "error", sendErr)
		}
		return
	}

	log.Info("starting desktop session via IPC",
		"sessionId", req.SessionID,
		"displayIndex", req.DisplayIndex,
	)

	resp, err := c.desktopMgr.startSession(&req)
	if err != nil {
		log.Warn("desktop session start failed", "sessionId", req.SessionID, "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeDesktopStart, err.Error()); sendErr != nil {
			log.Warn("failed to send desktop_start error", "error", sendErr)
		}
		return
	}

	if err := c.conn.SendTyped(env.ID, ipc.TypeDesktopStart, resp); err != nil {
		log.Warn("failed to send desktop_start response", "error", err)
		c.desktopMgr.stopSession(req.SessionID)
	}
}

func (c *Client) handleDesktopStop(env *ipc.Envelope) {
	var req ipc.DesktopStopRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid desktop_stop payload", "error", err)
		return
	}

	log.Info("stopping desktop session via IPC", "sessionId", req.SessionID)
	c.desktopMgr.stopSession(req.SessionID)
}
```

**Step 4: Add desktopMgr field to Client and initialize it**

In `client.go`, add to the `Client` struct:

```go
	desktopMgr *helperDesktopManager
```

In `New()`, initialize it:

```go
func New(socketPath string) *Client {
	return &Client{
		socketPath: socketPath,
		stopChan:   make(chan struct{}),
		desktopMgr: newHelperDesktopManager(),
	}
}
```

In `Stop()`, add cleanup before closing conn:

```go
func (c *Client) Stop() {
	select {
	case <-c.stopChan:
	default:
		close(c.stopChan)
	}
	if c.desktopMgr != nil {
		c.desktopMgr.stopAll()
	}
	if c.conn != nil {
		c.conn.SendTyped("disconnect", ipc.TypeDisconnect, nil)
		c.conn.Close()
	}
}
```

**Step 5: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/userhelper/...`
Expected: PASS

**Step 6: Commit**

```bash
git add agent/internal/userhelper/desktop.go agent/internal/userhelper/client.go agent/internal/remote/desktop/webrtc.go
git commit -m "feat(userhelper): implement desktop session handling via IPC signaling relay"
```

---

### Task 8: Heartbeat — Route Desktop via IPC or Direct

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (add `isService` field or detection)

**Step 1: Add service detection**

The agent already logs `"agent running as Windows service"`. Find how it detects this. Check `agent/cmd/breeze-agent/main.go` for `isWindowsService` or similar. The service detection likely sets a flag or runs a different code path.

We need a way for the heartbeat handler to know if we're running as a service. Add to `HeartbeatConfig`:

```go
	IsService bool // True when running as a Windows service (Session 0)
```

And store it on the Heartbeat:

```go
	isService bool
```

Set it in `New()`:

```go
	h.isService = cfg.IsService
```

**Step 2: Modify `handleStartDesktop` to route via IPC when in service mode**

Replace the current `handleStartDesktop` (lines 53-96 in `handlers_desktop.go`):

```go
func handleStartDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, _ := cmd.Payload["sessionId"].(string)
	offer, _ := cmd.Payload["offer"].(string)
	if sessionID == "" || offer == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing sessionId or offer",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Parse optional ICE servers from payload
	var iceServers []desktop.ICEServerConfig
	var iceServersRaw json.RawMessage
	if raw, ok := cmd.Payload["iceServers"].([]interface{}); ok {
		iceServersRaw, _ = json.Marshal(raw)
		for _, item := range raw {
			if m, ok := item.(map[string]interface{}); ok {
				username, _ := m["username"].(string)
				credential, _ := m["credential"].(string)
				s := desktop.ICEServerConfig{
					URLs:       m["urls"],
					Username:   username,
					Credential: credential,
				}
				iceServers = append(iceServers, s)
			}
		}
	}

	// Parse optional display index (multi-monitor selection)
	displayIndex := 0
	if di, ok := cmd.Payload["displayIndex"].(float64); ok && di >= 0 {
		displayIndex = int(di)
	}

	// Session 0 service mode: route through user helper via IPC
	if h.isService && h.sessionBroker != nil {
		return h.startDesktopViaHelper(sessionID, offer, iceServersRaw, displayIndex, cmd.Payload, start)
	}

	// Direct mode (dev, non-service): use local SessionManager
	answer, err := h.desktopMgr.StartSession(sessionID, offer, iceServers, displayIndex)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    answer,
	}, time.Since(start).Milliseconds())
}

func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServersRaw json.RawMessage, displayIndex int, payload map[string]any, start time.Time) tools.CommandResult {
	// Determine target Windows session
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok && ts > 0 {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	// Find a connected helper with capture capability
	session := h.sessionBroker.FindCapableSession("capture", targetSession)
	if session == nil {
		// Try to spawn a helper on-demand
		if err := h.spawnHelperForDesktop(targetSession); err != nil {
			return tools.CommandResult{
				Status:     "failed",
				Error:      fmt.Sprintf("no user helper available and spawn failed: %v", err),
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
		// Wait briefly for the helper to connect
		for i := 0; i < 10; i++ {
			time.Sleep(500 * time.Millisecond)
			session = h.sessionBroker.FindCapableSession("capture", targetSession)
			if session != nil {
				break
			}
		}
		if session == nil {
			return tools.CommandResult{
				Status:     "failed",
				Error:      "user helper did not connect after spawn (timeout 5s)",
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
	}

	req := ipc.DesktopStartRequest{
		SessionID:    sessionID,
		Offer:        offer,
		ICEServers:   iceServersRaw,
		DisplayIndex: displayIndex,
	}

	resp, err := session.SendCommand(
		"desk-"+sessionID,
		ipc.TypeDesktopStart,
		req,
		30*time.Second, // WebRTC negotiation can take time
	)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("IPC desktop_start: %w", err), time.Since(start).Milliseconds())
	}
	if resp.Error != "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      resp.Error,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	var deskResp ipc.DesktopStartResponse
	if err := json.Unmarshal(resp.Payload, &deskResp); err != nil {
		return tools.NewErrorResult(fmt.Errorf("unmarshal desktop response: %w", err), time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    deskResp.Answer,
	}, time.Since(start).Milliseconds())
}

func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if targetSession == "" {
		// Default: spawn into the console session
		detector := sessionbroker.NewSessionDetector()
		sessions, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("list sessions: %w", err)
		}
		// Find the console (non-services) session
		for _, s := range sessions {
			if s.Type == "console" || (s.State == "active" && s.Type != "services") {
				targetSession = s.Session
				break
			}
		}
		if targetSession == "" {
			return fmt.Errorf("no active interactive session found")
		}
	}

	var sessionNum uint32
	if _, err := fmt.Sscanf(targetSession, "%d", &sessionNum); err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	return sessionbroker.SpawnHelperInSession(sessionNum)
}
```

**Step 3: Also route `handleStopDesktop` through IPC when in service mode**

Update `handleStopDesktop`:

```go
func handleStopDesktop(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	sessionID, errResult := tools.RequirePayloadString(cmd.Payload, "sessionId")
	if errResult != nil {
		errResult.DurationMs = time.Since(start).Milliseconds()
		return *errResult
	}

	// Service mode: relay stop to user helper
	if h.isService && h.sessionBroker != nil {
		session := h.sessionBroker.FindCapableSession("capture", "")
		if session != nil {
			req := ipc.DesktopStopRequest{SessionID: sessionID}
			_, _ = session.SendCommand("desk-stop-"+sessionID, ipc.TypeDesktopStop, req, 5*time.Second)
		}
	} else {
		h.desktopMgr.StopSession(sessionID)
	}

	return tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
}
```

**Step 4: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/heartbeat/...`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(heartbeat): route desktop sessions via IPC helper when running as service"
```

---

### Task 9: Add handleListSessions Handler

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go`

**Step 1: Register the handler in `init()`**

Add to the `init()` function:

```go
	handlerRegistry[tools.CmdListSessions] = handleListSessions
```

**Step 2: Implement the handler**

```go
func handleListSessions(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	detector := sessionbroker.NewSessionDetector()
	detected, err := detector.ListSessions()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	// Merge with broker state to show which sessions have connected helpers
	var helperSessions []sessionbroker.SessionInfo
	if h.sessionBroker != nil {
		helperSessions = h.sessionBroker.AllSessions()
	}

	helperByWinSession := make(map[string]bool)
	for _, hs := range helperSessions {
		if hs.WinSessionID != "" {
			helperByWinSession[hs.WinSessionID] = true
		}
	}

	items := make([]ipc.SessionInfoItem, 0, len(detected))
	for _, ds := range detected {
		var sessionNum uint32
		fmt.Sscanf(ds.Session, "%d", &sessionNum)
		items = append(items, ipc.SessionInfoItem{
			SessionID:       sessionNum,
			Username:        ds.Username,
			State:           ds.State,
			Type:            ds.Type,
			HelperConnected: helperByWinSession[ds.Session],
		})
	}

	return tools.NewSuccessResult(map[string]any{
		"sessions": items,
	}, time.Since(start).Milliseconds())
}
```

**Step 3: Add necessary imports**

Ensure `handlers_desktop.go` imports:
```go
	"encoding/json"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
```

**Step 4: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/heartbeat/...`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop.go
git commit -m "feat(heartbeat): add list_sessions handler with helper connection state"
```

---

### Task 10: Wire IsService Flag from main.go

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go`

**Step 1: Find where HeartbeatConfig is constructed**

Look for where `HeartbeatConfig` or `heartbeat.Config` is created in `main.go` and set `IsService: true` when running as a Windows service.

The agent already detects service mode (log says `"agent running as Windows service"`). Find this detection and propagate to the config.

Set `cfg.IsService = true` when the service detection returns true.

**Step 2: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./cmd/breeze-agent/...`
Expected: PASS

**Step 3: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "feat(agent): propagate isService flag to heartbeat config for IPC routing"
```

---

### Task 11: Add SendError Helper to ipc.Conn

**Files:**
- Modify: `agent/internal/ipc/protocol.go` (or wherever `Conn` is defined)

**Step 1: Check if SendError already exists**

Search for `SendError` in the IPC package. If it doesn't exist, add:

```go
// SendError sends a typed message with an error string in the envelope.
func (c *Conn) SendError(id, msgType, errMsg string) error {
	return c.SendTyped(id, msgType, map[string]string{"error": errMsg})
}
```

**Step 2: Verify build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/ipc/...`
Expected: PASS

**Step 3: Commit**

```bash
git add agent/internal/ipc/protocol.go
git commit -m "feat(ipc): add SendError helper for typed error responses"
```

---

### Task 12: Integration Test Plan (Manual)

This task cannot be automated in unit tests since it requires a running Windows service, named pipe, and interactive session. Document the manual test procedure.

**Test 1: Helper spawn**
1. Run agent as Windows service: `sc start BreezeAgent`
2. Check for spawned helper: `tasklist | findstr breeze-agent` — should show two processes
3. Check agent log for: `spawned user helper in session`
4. Check helper connects: `user helper connected and authenticated`

**Test 2: Desktop session via IPC**
1. From web UI, click "Connect Desktop" on the Windows device
2. Check agent log for: `starting desktop session via IPC`
3. Check helper log for: `Desktop WebRTC session started`
4. Verify video stream in viewer (not black screen)
5. Verify metrics: `captured>0 encoded>0 sent>0`

**Test 3: UAC prompt capture**
1. While connected, trigger UAC on the remote machine (e.g., run something as admin)
2. Check helper log for: `Switched to input desktop for secure desktop capture`
3. Verify UAC dialog is visible in viewer

**Test 4: Multi-session**
1. Have two users logged in (one console, one RDP)
2. Send `list_sessions` command to agent
3. Verify both sessions listed with correct types
4. Start desktop targeting each session separately

**Test 5: On-demand spawn**
1. Kill the helper process: `taskkill /IM breeze-agent.exe /F` (kills only the helper)
2. Request desktop connection
3. Verify agent spawns new helper and session starts within ~5s

**Commit:**

```bash
git add docs/plans/2026-02-18-session0-desktop-plan.md
git commit -m "docs: Session 0 desktop implementation plan with manual test procedures"
```

---

## Task Dependency Graph

```
Task 1 (IPC types)
  └→ Task 4 (broker extensions) — uses DesktopStartRequest
  └→ Task 7 (helper desktop mgr) — uses DesktopStartRequest/Response
  └→ Task 9 (list_sessions) — uses SessionInfoItem

Task 2 (command constant)
  └→ Task 9 (list_sessions handler) — uses CmdListSessions

Task 3 (spawner)
  └→ Task 8 (heartbeat routing) — calls SpawnHelperInSession

Task 5 (detector enhancements)
  └→ Task 8 (heartbeat routing) — uses detector for target session
  └→ Task 9 (list_sessions) — uses detector for session list

Task 6 (helper capabilities)
  └→ Task 7 (helper desktop mgr) — needs CanCapture=true

Task 7 (helper desktop mgr)
  └→ Task 8 (heartbeat routing) — service relies on helper handling desktop

Task 8 (heartbeat routing)
  └→ Task 10 (main.go wiring) — needs IsService flag

Tasks 1-6 can be done in parallel.
Tasks 7-8 depend on 1-6.
Tasks 9-10 depend on 1-2 and 5-8.
Task 11 (SendError) can be done anytime.
Task 12 (manual tests) done last.
```
