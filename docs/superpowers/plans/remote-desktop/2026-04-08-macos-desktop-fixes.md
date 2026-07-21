# macOS Remote Desktop Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three macOS remote desktop issues: stop disabling Apple Remote Management, enable input at login window from user_session helpers, fix session selection determinism.

**Architecture:** Gate all Screen Sharing (kickstart) calls behind a `managedByPolicy` flag on the tunnel Manager, defaulting to off. Make the macOS input handler dynamically switch between CGEvent and IOHIDPostEvent based on console user state via IPC broadcast. Replace the iteration-order-dependent session selector with a deterministic two-pass algorithm.

**Tech Stack:** Go agent, IOKit/CoreGraphics cgo, IPC (Unix socket), Config Policy

---

### Task 1: Gate Screen Sharing management behind policy flag

**Files:**
- Modify: `agent/internal/tunnel/manager.go:16-24` (Manager struct), `:27-36` (NewManager), `:145-162` (cleanup methods), `:165-189` (Stop)
- Modify: `agent/internal/heartbeat/heartbeat.go:90-99` (HeartbeatResponse), `:115-203` (Heartbeat struct), `:2030-2047` (response handler)
- Modify: `agent/internal/heartbeat/handlers_tunnel.go:19-87` (handleTunnelOpen), `:164-188` (handleTunnelClose)

- [ ] **Step 1: Add `managedByPolicy` field to tunnel Manager**

In `agent/internal/tunnel/manager.go`, add the field and a constructor option:

```go
// Manager struct — add field after `stopped bool` (line 23):
type Manager struct {
	sessions        map[string]*Session
	mu              sync.RWMutex
	maxSessions     int
	idleTimeout     time.Duration
	done            chan struct{}
	stopOnce        sync.Once
	stopped         bool
	managedByPolicy bool // true when Config Policy allows Breeze to manage Screen Sharing
}

// NewManager — add parameter:
func NewManager(managedByPolicy bool) *Manager {
	m := &Manager{
		sessions:        make(map[string]*Session),
		maxSessions:     defaultMaxSessions,
		idleTimeout:     defaultIdleTimeout,
		done:            make(chan struct{}),
		managedByPolicy: managedByPolicy,
	}
	go m.reapLoop()
	return m
}

// Add setter for dynamic updates from heartbeat response:
func (m *Manager) SetManagedByPolicy(managed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.managedByPolicy = managed
}
```

- [ ] **Step 2: Gate CleanupOrphanedVNC behind policy**

Replace `CleanupOrphanedVNC()` in `manager.go:156-162`:

```go
func (m *Manager) CleanupOrphanedVNC() {
	m.mu.RLock()
	managed := m.managedByPolicy
	m.mu.RUnlock()
	if !managed {
		return
	}
	if !IsScreenSharingRunning() {
		return
	}
	log.Info("disabling orphaned Screen Sharing (no active VNC tunnels)")
	m.DisableScreenSharingIfIdle("orphan cleanup")
}
```

- [ ] **Step 3: Gate DisableScreenSharingIfIdle behind policy**

Replace `DisableScreenSharingIfIdle()` in `manager.go:145-152`:

```go
func (m *Manager) DisableScreenSharingIfIdle(context string) {
	m.mu.RLock()
	managed := m.managedByPolicy
	m.mu.RUnlock()
	if !managed {
		return
	}
	if m.HasVNCTunnels() {
		return
	}
	if err := DisableScreenSharing(); err != nil {
		log.Warn("failed to disable screen sharing", "context", context, "error", err.Error())
	}
}
```

- [ ] **Step 4: Gate Stop() cleanup behind policy**

In `manager.go` Stop() method (line 184), wrap the disable call:

```go
// Replace line 183-184:
if hasVNC {
	m.DisableScreenSharingIfIdle("shutdown")
}
// DisableScreenSharingIfIdle already checks managedByPolicy internally,
// so no additional gating needed here.
```

No change needed — `DisableScreenSharingIfIdle` already gates on policy from Step 3.

- [ ] **Step 5: Gate VNC enable in handleTunnelOpen and add informative error**

In `agent/internal/heartbeat/handlers_tunnel.go`, replace lines 77-87:

```go
	// For VNC on macOS, ensure Screen Sharing is running.
	if isVNC {
		if !tunnel.IsScreenSharingRunning() {
			if h.tunnelMgr == nil || !h.tunnelMgr.IsManagedByPolicy() {
				return tools.CommandResult{
					Status: "failed",
					Error:  "Screen Sharing is disabled on this device. Enable 'Manage Remote Management' in Config Policy to allow Breeze to control this, or enable it manually in System Preferences > Sharing.",
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}
		// Policy allows management — enable Screen Sharing.
		if h.tunnelMgr != nil && h.tunnelMgr.IsManagedByPolicy() {
			vncPassword, _ := cmd.Payload["vncPassword"].(string)
			if err := tunnel.EnableScreenSharing(vncPassword); err != nil {
				return tools.CommandResult{
					Status:     "failed",
					Error:      fmt.Sprintf("failed to enable VNC screen sharing: %s", err.Error()),
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}
	}
```

- [ ] **Step 6: Add IsManagedByPolicy getter to Manager**

In `agent/internal/tunnel/manager.go`, add after SetManagedByPolicy:

```go
func (m *Manager) IsManagedByPolicy() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.managedByPolicy
}
```

- [ ] **Step 7: Add ManageRemoteManagement to HeartbeatResponse and wire it up**

In `agent/internal/heartbeat/heartbeat.go`:

```go
// Add to HeartbeatResponse struct (after line 98):
type HeartbeatResponse struct {
	Commands                []Command       `json:"commands"`
	ConfigUpdate            map[string]any  `json:"configUpdate,omitempty"`
	UpgradeTo               string          `json:"upgradeTo,omitempty"`
	RenewCert               bool            `json:"renewCert,omitempty"`
	RotateToken             bool            `json:"rotateToken,omitempty"`
	HelperEnabled           bool            `json:"helperEnabled,omitempty"`
	HelperSettings          *HelperSettings `json:"helperSettings,omitempty"`
	HelperUpgradeTo         string          `json:"helperUpgradeTo,omitempty"`
	ManageRemoteManagement  bool            `json:"manageRemoteManagement,omitempty"`
}
```

In the response handler (after line 2046, before the closing `}`):

```go
	// Update tunnel manager policy flag
	h.tunnelMgr.SetManagedByPolicy(response.ManageRemoteManagement)
```

- [ ] **Step 8: Update NewManager call site**

In `agent/internal/heartbeat/heartbeat.go` line 258, change:

```go
// From:
tunnelMgr: tunnel.NewManager(),
// To:
tunnelMgr: tunnel.NewManager(false),
```

- [ ] **Step 9: Compile and verify**

Run: `cd agent && go build ./...`
Expected: Clean compile

- [ ] **Step 10: Commit**

```bash
cd agent && git add internal/tunnel/manager.go internal/heartbeat/handlers_tunnel.go internal/heartbeat/heartbeat.go
git commit -m "fix(agent): gate Screen Sharing management behind Config Policy

Default: Breeze never touches Apple Screen Sharing (kickstart).
When manageRemoteManagement is true in heartbeat response, existing
enable/disable/cleanup behavior runs. When VNC tunnel opens and
Screen Sharing is off without policy, return informative error."
```

---

### Task 2: Add SetAtLoginWindow to InputHandler interface

**Files:**
- Modify: `agent/internal/remote/desktop/input.go:14-52` (InputHandler interface)
- Modify: `agent/internal/remote/desktop/input_windows.go:100-106` (Windows handler)

- [ ] **Step 1: Add SetAtLoginWindow to InputHandler interface**

In `agent/internal/remote/desktop/input.go`, add after `InputAvailable() bool` (line 51):

```go
	// SetAtLoginWindow toggles login-window input mode. On macOS, when true
	// and IOHIDSystem is available, input uses IOHIDPostEvent instead of CGEvent
	// (CGEvent clicks/keyboard are blocked at the macOS login window).
	// No-op on Windows.
	SetAtLoginWindow(atLoginWindow bool)
```

- [ ] **Step 2: Add no-op on Windows**

In `agent/internal/remote/desktop/input_windows.go`, add after `SetDisplayOffset` (line 113):

```go
func (h *WindowsInputHandler) SetAtLoginWindow(_ bool) {}
```

- [ ] **Step 3: Compile and verify**

Run: `cd agent && go build ./...`
Expected: Compile error — `DarwinInputHandler` does not implement `SetAtLoginWindow` yet. This is expected; we'll fix it in Task 3.

- [ ] **Step 4: Commit**

```bash
cd agent && git add internal/remote/desktop/input.go internal/remote/desktop/input_windows.go
git commit -m "feat(agent): add SetAtLoginWindow to InputHandler interface

Prepares for dynamic input switching between CGEvent and IOHIDPostEvent
based on console user state. Windows impl is a no-op."
```

---

### Task 3: Implement dynamic input switching on macOS

**Files:**
- Modify: `agent/internal/remote/desktop/input_darwin.go:264-292` (struct + constructor), `:345-503` (all input methods)

- [ ] **Step 1: Update DarwinInputHandler struct**

In `agent/internal/remote/desktop/input_darwin.go`, replace the struct and constructor (lines 264-292):

```go
// DarwinInputHandler handles input on macOS using CGEvents (user session)
// or IOHIDPostEvent (login window). Requires Accessibility permission.
type DarwinInputHandler struct {
	mouseDown      bool    // track if mouse button is held for drag events
	mouseBtn       int
	scaleFactor    float64 // backing scale factor (2.0 on Retina)
	hidAvailable   bool    // true if IOHIDSystem connection succeeded
	atLoginWindow  atomic.Bool // dynamically toggled by console user changes
	inputAvailable bool    // always true — CGEvent mouse movement works as minimum
}

func NewInputHandler(desktopContext string) InputHandler {
	sf := float64(C.getMainDisplayScaleFactor())
	if sf < 1.0 {
		sf = 1.0
	}
	h := &DarwinInputHandler{scaleFactor: sf, inputAvailable: true}

	// Always try to open HID connection regardless of context.
	// IOHIDPostEvent is the only way to inject clicks/keyboard at the
	// macOS login window. The helper has Accessibility TCC permission.
	if rc := C.openHIDConnection(); rc == 0 {
		h.hidAvailable = true
		slog.Info("IOHIDSystem connection opened for login-window input support")
	} else {
		slog.Warn("IOHIDSystem unavailable — input at login window will be limited to mouse movement",
			"rc", int(rc))
	}

	// If launched in login_window context, start in login window mode.
	if desktopContext == "login_window" {
		h.atLoginWindow.Store(true)
	}

	return h
}
```

Add the `sync/atomic` import if not already present. The `atomic.Bool` type is in `sync/atomic` (Go 1.19+).

- [ ] **Step 2: Add SetAtLoginWindow method**

Add after `InputAvailable()` (around line 303):

```go
func (h *DarwinInputHandler) SetAtLoginWindow(atLoginWindow bool) {
	prev := h.atLoginWindow.Swap(atLoginWindow)
	if prev != atLoginWindow {
		if atLoginWindow {
			slog.Info("input switching to IOHIDPostEvent mode (login window)")
		} else {
			slog.Info("input switching to CGEvent mode (user session)")
		}
	}
}
```

- [ ] **Step 3: Add useHID helper method**

Replace the old `useHID` field logic with a dynamic check. Add after `SetAtLoginWindow`:

```go
// shouldUseHID returns true when input should use IOHIDPostEvent.
func (h *DarwinInputHandler) shouldUseHID() bool {
	return h.atLoginWindow.Load() && h.hidAvailable
}
```

- [ ] **Step 4: Update all input methods to use shouldUseHID()**

Replace every occurrence of `if h.useHID {` with `if h.shouldUseHID() {` in the following methods. There are 9 methods to update:

`SendMouseMove` (line ~345):
```go
func (h *DarwinInputHandler) SendMouseMove(x, y int) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	if h.shouldUseHID() {
		if h.mouseDown {
			C.hidMouseDrag(sx, sy, C.int(h.mouseBtn))
		} else {
			C.hidMouseMove(sx, sy)
		}
	} else if h.mouseDown {
		C.inputMouseDrag(sx, sy, C.int(h.mouseBtn))
	} else {
		C.inputMouseMove(sx, sy)
	}
	return nil
}
```

`SendMouseClick` (line ~364):
```go
func (h *DarwinInputHandler) SendMouseClick(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	btn := C.int(buttonToInt(button))
	if h.shouldUseHID() {
		C.hidMouseDown(sx, sy, btn)
		C.hidMouseUp(sx, sy, btn)
	} else {
		C.inputMouseDown(sx, sy, btn)
		C.inputMouseUp(sx, sy, btn)
	}
	return nil
}
```

`SendMouseDown` (line ~380):
```go
func (h *DarwinInputHandler) SendMouseDown(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	h.mouseBtn = buttonToInt(button)
	h.mouseDown = true
	sx, sy := h.scaleXY(x, y)
	if h.shouldUseHID() {
		C.hidMouseDown(sx, sy, C.int(h.mouseBtn))
	} else {
		C.inputMouseDown(sx, sy, C.int(h.mouseBtn))
	}
	return nil
}
```

`SendMouseUp` (line ~395):
```go
func (h *DarwinInputHandler) SendMouseUp(x, y int, button string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	h.mouseDown = false
	sx, sy := h.scaleXY(x, y)
	btn := C.int(buttonToInt(button))
	if h.shouldUseHID() {
		C.hidMouseUp(sx, sy, btn)
	} else {
		C.inputMouseUp(sx, sy, btn)
	}
	return nil
}
```

`SendMouseScroll` (line ~410):
```go
func (h *DarwinInputHandler) SendMouseScroll(x, y int, delta int) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	sx, sy := h.scaleXY(x, y)
	if h.shouldUseHID() {
		C.hidMouseMove(sx, sy)
		C.hidMouseScroll(C.int(-delta))
	} else {
		C.inputMouseMove(sx, sy)
		C.inputMouseScroll(C.int(-delta))
	}
	return nil
}
```

`SendKeyPress` (line ~425):
```go
func (h *DarwinInputHandler) SendKeyPress(key string, modifiers []string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	flags := modifiersToFlags(modifiers)
	if h.shouldUseHID() {
		C.hidKeyDown(C.int(keycode), flags)
		C.hidKeyUp(C.int(keycode), flags)
	} else {
		C.inputKeyDown(C.int(keycode), flags)
		C.inputKeyUp(C.int(keycode), flags)
	}
	return nil
}
```

`SendKeyDown` (line ~445):
```go
func (h *DarwinInputHandler) SendKeyDown(key string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	if h.shouldUseHID() {
		C.hidKeyDown(C.int(keycode), 0)
	} else {
		C.inputKeyDown(C.int(keycode), 0)
	}
	return nil
}
```

`SendKeyUp` (line ~462):
```go
func (h *DarwinInputHandler) SendKeyUp(key string) error {
	if !h.inputAvailable {
		return errInputUnavailable
	}
	key = normalizeKeyName(key)
	keycode, ok := keyNameToKeycode[key]
	if !ok {
		return fmt.Errorf("unknown key: %s", key)
	}
	if h.shouldUseHID() {
		C.hidKeyUp(C.int(keycode), 0)
	} else {
		C.inputKeyUp(C.int(keycode), 0)
	}
	return nil
}
```

- [ ] **Step 5: Remove the old `useHID` field**

The `useHID bool` field in the struct is replaced by the dynamic `shouldUseHID()` method. Verify it's fully removed from the struct definition. The `inputAvailable` field stays but is now always `true` (set in constructor).

- [ ] **Step 6: Update session_control.go — remove input unavailable notification**

In `agent/internal/remote/desktop/session_control.go`, the `sendInputStatus()` function (lines 46-88) sent a notification when input was unavailable at the login window. Since input is now always available (at minimum mouse via CGEvent), this notification is no longer needed in the login_window context.

However, keep the function for cases where `inputAvailable` is genuinely false (shouldn't happen now, but defensive). Update the call site in `startStreaming` to only call `sendInputStatus` when `!inputHandler.InputAvailable()`:

Search for where `sendInputStatus()` is called (likely in `session.go` or `session_webrtc.go`) and verify it's conditional on `!s.inputHandler.InputAvailable()`. If it unconditionally fires for login_window, gate it.

- [ ] **Step 7: Compile and verify**

Run: `cd agent && go build ./...`
Expected: Clean compile (on macOS; Windows will need cross-compile check)

- [ ] **Step 8: Commit**

```bash
cd agent && git add internal/remote/desktop/input_darwin.go internal/remote/desktop/session_control.go
git commit -m "feat(agent): dynamic CGEvent/IOHIDPostEvent switching at login window

Always init IOHIDSystem connection regardless of desktop context.
Use atomic atLoginWindow flag to dynamically switch between CGEvent
(user session) and IOHIDPostEvent (login window) at runtime.
Fixes input (clicks, keyboard) at macOS login screen from user_session
helpers on pre-Sonoma Macs."
```

---

### Task 4: Add IPC message type for console user changes

**Files:**
- Modify: `agent/internal/ipc/message.go:25-40` (type constants)

- [ ] **Step 1: Add TypeConsoleUserChanged constant**

In `agent/internal/ipc/message.go`, add after `TypeDesktopPeerDisconnected` (line 39):

```go
	// Console user changed — agent notifies helpers to switch input mode
	TypeConsoleUserChanged = "console_user_changed"
```

- [ ] **Step 2: Add ConsoleUserChangedPayload struct**

Add after the existing `DesktopContext` constants (line 98):

```go
// ConsoleUserChangedPayload is sent from agent to desktop helpers when
// the macOS console user changes (login/logout/switch).
type ConsoleUserChangedPayload struct {
	Username string `json:"username"`
}
```

- [ ] **Step 3: Commit**

```bash
cd agent && git add internal/ipc/message.go
git commit -m "feat(agent): add console_user_changed IPC message type"
```

---

### Task 5: Broadcast console user change from agent to helpers

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go:354-370` (add BroadcastToDesktopSessions)
- Modify: `agent/internal/heartbeat/desktop_handoff_darwin.go:57-85` (handleDarwinSessionEvent)

- [ ] **Step 1: Add BroadcastToDesktopSessions to broker**

In `agent/internal/sessionbroker/broker.go`, add after `BroadcastNotification` (after line 370):

```go
// BroadcastToDesktopSessions sends a fire-and-forget IPC message to all
// connected sessions that have the "desktop" scope.
func (b *Broker) BroadcastToDesktopSessions(msgType string, payload any) {
	b.mu.RLock()
	sessions := make([]*Session, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.HasScope("desktop") {
			sessions = append(sessions, s)
		}
	}
	b.mu.RUnlock()

	for _, s := range sessions {
		if err := s.SendNotify("", msgType, payload); err != nil {
			log.Debug("broadcast to desktop session failed",
				"sessionId", s.SessionID, "msgType", msgType, "error", err.Error())
		}
	}
}
```

- [ ] **Step 2: Broadcast from handleDarwinSessionEvent**

In `agent/internal/heartbeat/desktop_handoff_darwin.go`, add console user broadcast after the `SetConsoleUser` calls. Replace the function body of `handleDarwinSessionEvent` (lines 57-85):

```go
func (h *Heartbeat) handleDarwinSessionEvent(event sessionbroker.SessionEvent) {
	var newConsoleUser string

	// Update console user on the broker for session selection.
	switch event.Type {
	case sessionbroker.SessionLogout:
		// User logged out — console returns to login window.
		newConsoleUser = "loginwindow"
		h.sessionBroker.SetConsoleUser(newConsoleUser)
		// Tear down stale user_session helpers so they don't linger.
		if n := h.sessionBroker.CloseSessionsByDesktopContext(ipc.DesktopContextUserSession); n > 0 {
			log.Info("closed stale user_session helpers after logout", "count", n, "user", event.Username)
		}
	case sessionbroker.SessionLogin:
		newConsoleUser = event.Username
		h.sessionBroker.SetConsoleUser(newConsoleUser)
	case sessionbroker.SessionSwitch:
		if event.Username != "" {
			newConsoleUser = event.Username
			h.sessionBroker.SetConsoleUser(newConsoleUser)
		}
	}

	// Notify desktop helpers of console user change so they can switch
	// input injection method (CGEvent vs IOHIDPostEvent).
	if newConsoleUser != "" {
		h.sessionBroker.BroadcastToDesktopSessions(ipc.TypeConsoleUserChanged,
			ipc.ConsoleUserChangedPayload{Username: newConsoleUser})
	}

	go func() {
		select {
		case <-time.After(darwinDesktopHandoffDelay):
		case <-h.stopChan:
			return
		}

		_ = h.spawnDesktopHelper("")
		h.reconcileDarwinDesktopOwners("session_" + string(event.Type))
	}()
}
```

- [ ] **Step 3: Compile and verify**

Run: `cd agent && go build ./...`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
cd agent && git add internal/sessionbroker/broker.go internal/heartbeat/desktop_handoff_darwin.go
git commit -m "feat(agent): broadcast console_user_changed to desktop helpers

When macOS console user changes (login/logout/switch), notify all
connected desktop helpers via IPC so they can switch input mode."
```

---

### Task 6: Handle console_user_changed in desktop helper

**Files:**
- Modify: `agent/internal/userhelper/client.go:291-338` (IPC dispatch switch)
- Modify: `agent/internal/userhelper/desktop.go:21-35` (helperDesktopManager)
- Modify: `agent/internal/remote/desktop/session.go:126-141` (SessionManager struct)

- [ ] **Step 1: Add SetAtLoginWindow to SessionManager**

In `agent/internal/remote/desktop/session.go`, add after `HasActiveSessions()`:

```go
// SetAtLoginWindow updates the login-window input mode on all active sessions.
// Called when the macOS console user changes.
func (m *SessionManager) SetAtLoginWindow(atLoginWindow bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		s.inputHandler.SetAtLoginWindow(atLoginWindow)
	}
}
```

- [ ] **Step 2: Add setAtLoginWindow to helperDesktopManager**

In `agent/internal/userhelper/desktop.go`, add after `hasActiveSessions()`:

```go
func (h *helperDesktopManager) setAtLoginWindow(atLoginWindow bool) {
	h.mgr.SetAtLoginWindow(atLoginWindow)
}
```

- [ ] **Step 3: Handle TypeConsoleUserChanged in IPC dispatch**

In `agent/internal/userhelper/client.go`, add a new case after `TypeDesktopInput` (line 316):

```go
		case ipc.TypeConsoleUserChanged:
			safeGo("console_user_changed", func() { c.handleConsoleUserChanged(env) })
```

- [ ] **Step 4: Implement handleConsoleUserChanged handler**

In `agent/internal/userhelper/client.go`, add the handler function (after `handleDesktopStop`):

```go
func (c *Client) handleConsoleUserChanged(env *ipc.Envelope) {
	var payload ipc.ConsoleUserChangedPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Warn("invalid console_user_changed payload", "error", err)
		return
	}
	atLoginWindow := payload.Username == "loginwindow"
	log.Info("console user changed, updating input mode",
		"username", payload.Username, "atLoginWindow", atLoginWindow)
	c.desktopMgr.setAtLoginWindow(atLoginWindow)
}
```

- [ ] **Step 5: Compile and verify**

Run: `cd agent && go build ./...`
Expected: Clean compile

- [ ] **Step 6: Commit**

```bash
cd agent && git add internal/remote/desktop/session.go internal/userhelper/desktop.go internal/userhelper/client.go
git commit -m "feat(agent): handle console_user_changed in desktop helper

Propagate console user change from IPC dispatch through
helperDesktopManager to SessionManager to all active session
input handlers, enabling dynamic CGEvent/IOHIDPostEvent switching."
```

---

### Task 7: Fix session selection determinism

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go:291-318` (preferredDesktopSessionLocked)
- Modify: `agent/internal/sessionbroker/broker_test.go:308-420` (existing tests)

- [ ] **Step 1: Replace preferredDesktopSessionLocked with two-pass algorithm**

In `agent/internal/sessionbroker/broker.go`, replace lines 291-318:

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
		// No login_window helper — fall through to user_session helpers.
		// They can still capture the login screen on macOS; input will
		// use IOHIDPostEvent via dynamic switching.
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

- [ ] **Step 2: Run existing tests**

Run: `cd agent && go test -race ./internal/sessionbroker/... -v -run TestPreferredDesktop`
Expected: All 3 existing tests pass (the two-pass algorithm preserves all existing behavior)

- [ ] **Step 3: Add determinism test**

Add to `agent/internal/sessionbroker/broker_test.go` after line 420:

```go
func TestPreferredDesktopSession_LoginWindow_DeterministicRegardlessOfOrder(t *testing.T) {
	now := time.Now()

	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-10 * time.Minute),
		LastSeen:       now,
	}
	loginSession := &Session{
		SessionID:      "login-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextLoginWindow,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-1 * time.Minute),
		LastSeen:       now,
	}

	// Run 50 iterations — Go map iteration is random, so if the old
	// iteration-order-dependent bug were still present, some iterations
	// would pick the wrong session.
	for i := 0; i < 50; i++ {
		b := &Broker{
			sessions: map[string]*Session{
				userSession.SessionID:  userSession,
				loginSession.SessionID: loginSession,
			},
			byIdentity:   make(map[string][]*Session),
			staleHelpers: make(map[string][]int),
		}
		b.SetConsoleUser("loginwindow")

		got := b.PreferredDesktopSession()
		if got.SessionID != "login-sess" {
			t.Fatalf("iteration %d: got %q, want login-sess", i, got.SessionID)
		}
	}
}
```

- [ ] **Step 4: Run all tests**

Run: `cd agent && go test -race ./internal/sessionbroker/... -v -run TestPreferredDesktop`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
cd agent && git add internal/sessionbroker/broker.go internal/sessionbroker/broker_test.go
git commit -m "fix(agent): deterministic session selection at login window

Replace iteration-order-dependent session preference logic with
two-pass algorithm: first try login_window helpers, then fall back
to user_session. Fixes random session selection with Go maps."
```

---

### Task 8: Full build and test verification

**Files:** None (verification only)

- [ ] **Step 1: Run full agent build**

Run: `cd agent && go build ./...`
Expected: Clean compile

- [ ] **Step 2: Run all agent tests**

Run: `cd agent && go test -race ./...`
Expected: All tests pass (some pre-existing failures in unrelated packages are acceptable)

- [ ] **Step 3: Run sessionbroker tests specifically**

Run: `cd agent && go test -race ./internal/sessionbroker/... -v`
Expected: All tests pass

- [ ] **Step 4: Run tunnel tests if they exist**

Run: `cd agent && go test -race ./internal/tunnel/... -v`
Expected: Tests pass (or no tests exist)

- [ ] **Step 5: Final commit if any fixes needed**

Only if compilation or tests revealed issues in previous tasks.
