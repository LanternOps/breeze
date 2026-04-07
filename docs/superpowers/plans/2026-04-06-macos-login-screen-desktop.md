# macOS Login Screen Desktop Selection Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix macOS Remote Desktop so it connects to the login screen (not a stale user session) when the Mac is at the login window.

**Architecture:** Two-part fix: (A) Add console-state awareness to the broker's desktop session selection so `login_window` helpers are preferred when the console is at the login screen; (C) Proactively close stale `user_session` helpers when a logout event fires, preventing them from lingering as candidates.

**Tech Stack:** Go, `sessionbroker` package, `ipc` package, Darwin `SCDynamicStore`

---

### File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `agent/internal/sessionbroker/broker.go` | Add `consoleUser` field, `SetConsoleUser()`, `CloseSessionsByDesktopContext()` methods; modify `preferredDesktopSessionLocked()` |
| Modify | `agent/internal/sessionbroker/broker_test.go` | Tests for console-aware selection and context-based session closure |
| Modify | `agent/internal/heartbeat/desktop_handoff_darwin.go` | Wire console user updates + stale helper teardown on logout |

---

### Task 1: Add Console-Aware Desktop Session Selection to Broker

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go:57-74` (Broker struct)
- Modify: `agent/internal/sessionbroker/broker.go:278-292` (`preferredDesktopSessionLocked`)
- Test: `agent/internal/sessionbroker/broker_test.go`

- [ ] **Step 1: Write failing tests for console-aware selection**

Add these tests to `agent/internal/sessionbroker/broker_test.go`:

```go
func TestPreferredDesktopSession_LoginWindowConsole_PrefersLoginWindowHelper(t *testing.T) {
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

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:  userSession,
			loginSession.SessionID: loginSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	// Without console user set, user_session wins (existing behavior).
	got := b.PreferredDesktopSession()
	if got.SessionID != "user-sess" {
		t.Fatalf("without console user: got %q, want user-sess", got.SessionID)
	}

	// With console at login window, login_window helper should win.
	b.SetConsoleUser("loginwindow")
	got = b.PreferredDesktopSession()
	if got.SessionID != "login-sess" {
		t.Fatalf("with loginwindow console: got %q, want login-sess", got.SessionID)
	}
}

func TestPreferredDesktopSession_LoggedInConsole_PrefersUserSession(t *testing.T) {
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

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:  userSession,
			loginSession.SessionID: loginSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	// With a real user logged in, user_session should still win.
	b.SetConsoleUser("alice")
	got := b.PreferredDesktopSession()
	if got.SessionID != "user-sess" {
		t.Fatalf("with alice console: got %q, want user-sess", got.SessionID)
	}
}

func TestPreferredDesktopSession_LoginWindowConsole_OnlyLoginHelpers(t *testing.T) {
	now := time.Now()

	// Only a user_session helper connected, but console is at login window.
	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now,
		LastSeen:       now,
	}

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID: userSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	b.SetConsoleUser("loginwindow")
	got := b.PreferredDesktopSession()
	// Should still return the user_session as fallback — better than nil.
	if got == nil {
		t.Fatal("should return user_session as fallback when no login_window helper exists")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race -run 'TestPreferredDesktopSession_(LoginWindowConsole|LoggedInConsole)' ./internal/sessionbroker/ -v`
Expected: FAIL — `SetConsoleUser` method does not exist.

- [ ] **Step 3: Add `consoleUser` field and `SetConsoleUser` method to Broker**

In `agent/internal/sessionbroker/broker.go`, add the field to the `Broker` struct (after `staleHelpers`):

```go
consoleUser string // macOS: current console user ("loginwindow" at login screen)
```

Then add the method after `SetSessionClosedHandler`:

```go
// SetConsoleUser updates the current macOS console user. When set to
// "loginwindow", desktop session selection prefers login_window helpers.
func (b *Broker) SetConsoleUser(username string) {
	b.mu.Lock()
	b.consoleUser = username
	b.mu.Unlock()
}
```

- [ ] **Step 4: Modify `preferredDesktopSessionLocked` to be console-aware**

Replace `preferredDesktopSessionLocked` in `agent/internal/sessionbroker/broker.go`:

```go
func (b *Broker) preferredDesktopSessionLocked() *Session {
	atLoginWindow := b.consoleUser == "loginwindow"

	var best *Session
	for _, s := range b.sessions {
		if !s.HasScope("desktop") {
			continue
		}
		if s.Capabilities == nil || !s.Capabilities.CanCapture {
			continue
		}
		// On macOS at the login screen, skip user_session helpers if a
		// login_window helper is available.
		if atLoginWindow && s.DesktopContext == ipc.DesktopContextUserSession &&
			best != nil && best.DesktopContext == ipc.DesktopContextLoginWindow {
			continue
		}
		if atLoginWindow && best != nil && best.DesktopContext == ipc.DesktopContextUserSession &&
			s.DesktopContext == ipc.DesktopContextLoginWindow {
			best = s
			continue
		}
		if best == nil || betterDesktopSession(s, best) {
			best = s
		}
	}
	return best
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent && go test -race -run 'TestPreferredDesktopSession_(LoginWindowConsole|LoggedInConsole)' ./internal/sessionbroker/ -v`
Expected: PASS

- [ ] **Step 6: Run full broker test suite to check for regressions**

Run: `cd agent && go test -race ./internal/sessionbroker/ -v`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go
git commit -m "fix(desktop): console-aware session selection prefers login_window at login screen

When the macOS console is at the login window, preferredDesktopSessionLocked
now prefers login_window helpers over stale user_session helpers. Adds
SetConsoleUser() to the broker for the heartbeat to update on session events.

Fixes LanternOps/breeze#369"
```

---

### Task 2: Add `CloseSessionsByDesktopContext` to Broker

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go`
- Test: `agent/internal/sessionbroker/broker_test.go`

- [ ] **Step 1: Write failing test for context-based session closure**

Add to `agent/internal/sessionbroker/broker_test.go`:

```go
func TestCloseSessionsByDesktopContext(t *testing.T) {
	now := time.Now()

	userSess, userClient := createSocketPair(t)
	defer userClient.Close()
	userSession := NewSession(ipc.NewConn(userSess), 1000, "1000", "alice", "", "user-desktop", []string{"desktop"})
	userSession.BinaryKind = ipc.HelperBinaryDesktopHelper
	userSession.DesktopContext = ipc.DesktopContextUserSession
	userSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	userSession.ConnectedAt = now

	loginSess, loginClient := createSocketPair(t)
	defer loginClient.Close()
	loginSession := NewSession(ipc.NewConn(loginSess), 0, "0", "loginwindow", "", "login-desktop", []string{"desktop"})
	loginSession.BinaryKind = ipc.HelperBinaryDesktopHelper
	loginSession.DesktopContext = ipc.DesktopContextLoginWindow
	loginSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	loginSession.ConnectedAt = now

	notifySess, notifyClient := createSocketPair(t)
	defer notifyClient.Close()
	notifySession := NewSession(ipc.NewConn(notifySess), 1000, "1000", "alice", "", "notify-only", []string{"notify"})
	notifySession.ConnectedAt = now

	closedSessions := make(chan string, 4)
	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:   userSession,
			loginSession.SessionID:  loginSession,
			notifySession.SessionID: notifySession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
		onSessionClosed: func(s *Session) {
			closedSessions <- s.SessionID
		},
	}

	closed := b.CloseSessionsByDesktopContext(ipc.DesktopContextUserSession)
	if closed != 1 {
		t.Fatalf("CloseSessionsByDesktopContext returned %d, want 1", closed)
	}

	// Verify user session was removed.
	if b.SessionByID("user-desktop") != nil {
		t.Fatal("user-desktop session should be removed")
	}

	// Verify login and notify sessions remain.
	if b.SessionByID("login-desktop") == nil {
		t.Fatal("login-desktop session should remain")
	}
	if b.SessionByID("notify-only") == nil {
		t.Fatal("notify-only session should remain")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race -run 'TestCloseSessionsByDesktopContext' ./internal/sessionbroker/ -v`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement `CloseSessionsByDesktopContext`**

Add to `agent/internal/sessionbroker/broker.go`, after `KillStaleHelpers`:

```go
// CloseSessionsByDesktopContext closes all sessions with the given desktop
// context (e.g., "user_session"). Used on macOS to tear down stale helpers
// after a logout event. Returns the number of sessions closed.
func (b *Broker) CloseSessionsByDesktopContext(ctx string) int {
	b.mu.Lock()
	var toClose []*Session
	for _, s := range b.sessions {
		if s.DesktopContext == ctx {
			toClose = append(toClose, s)
		}
	}
	b.mu.Unlock()

	for _, s := range toClose {
		s.Close()
	}
	return len(toClose)
}
```

Note: `s.Close()` triggers the session's `done` channel, which causes `RecvLoop` to exit and call `removeSession` (which fires `onSessionClosed`). We don't call `removeSession` directly here to avoid deadlocks — the normal disconnect path handles cleanup.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race -run 'TestCloseSessionsByDesktopContext' ./internal/sessionbroker/ -v`
Expected: PASS

- [ ] **Step 5: Run full broker test suite**

Run: `cd agent && go test -race ./internal/sessionbroker/ -v`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go
git commit -m "feat(desktop): add CloseSessionsByDesktopContext to broker

Closes all sessions with a given DesktopContext value (e.g., user_session).
Used to tear down stale desktop helpers after macOS logout events.

Part of LanternOps/breeze#369"
```

---

### Task 3: Wire Console User Updates and Stale Teardown in Heartbeat

**Files:**
- Modify: `agent/internal/heartbeat/desktop_handoff_darwin.go`

- [ ] **Step 1: Update `startDarwinDesktopWatcher` to set initial console user**

In `agent/internal/heartbeat/desktop_handoff_darwin.go`, modify `startDarwinDesktopWatcher` to query the initial console state and set it on the broker before starting the watcher loop:

```go
func (h *Heartbeat) startDarwinDesktopWatcher() {
	if h.sessionBroker == nil {
		return
	}

	// Set initial console user so session selection is correct from startup.
	detector := sessionbroker.NewSessionDetector()
	if sessions, err := detector.ListSessions(); err == nil && len(sessions) > 0 {
		h.sessionBroker.SetConsoleUser(sessions[0].Username)
	} else {
		// No console user detected — assume login window.
		h.sessionBroker.SetConsoleUser("loginwindow")
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-h.stopChan
		cancel()
	}()

	events := detector.WatchSessions(ctx)
	go func() {
		for event := range events {
			switch event.Type {
			case sessionbroker.SessionLogin, sessionbroker.SessionLogout, sessionbroker.SessionSwitch:
				h.handleDarwinSessionEvent(event)
			}
		}
	}()
}
```

- [ ] **Step 2: Update `handleDarwinSessionEvent` to set console user and tear down stale helpers**

Replace `handleDarwinSessionEvent` in the same file:

```go
func (h *Heartbeat) handleDarwinSessionEvent(event sessionbroker.SessionEvent) {
	// Update console user on the broker for session selection.
	switch event.Type {
	case sessionbroker.SessionLogout:
		// User logged out — console returns to login window.
		h.sessionBroker.SetConsoleUser("loginwindow")
		// Tear down stale user_session helpers so they don't linger.
		if n := h.sessionBroker.CloseSessionsByDesktopContext(ipc.DesktopContextUserSession); n > 0 {
			log.Info("closed stale user_session helpers after logout", "count", n, "user", event.Username)
		}
	case sessionbroker.SessionLogin:
		h.sessionBroker.SetConsoleUser(event.Username)
	case sessionbroker.SessionSwitch:
		if event.Username != "" {
			h.sessionBroker.SetConsoleUser(event.Username)
		}
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

- [ ] **Step 3: Add `ipc` import if not already present**

Check the imports in `desktop_handoff_darwin.go` — add `"github.com/breeze-rmm/agent/internal/ipc"` if not present.

- [ ] **Step 4: Verify the agent compiles**

Run: `cd agent && go build ./...`
Expected: No errors.

- [ ] **Step 5: Run all sessionbroker and heartbeat tests**

Run: `cd agent && go test -race ./internal/sessionbroker/ ./internal/heartbeat/ -v -count=1`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/desktop_handoff_darwin.go
git commit -m "fix(desktop): wire console user tracking and stale helper teardown on macOS

On session events, updates the broker's console user so login_window helpers
are preferred when at the login screen. On logout, proactively closes stale
user_session helpers to prevent them from being selected over login_window.

Fixes LanternOps/breeze#369"
```

---

### Task 4: Final Integration Verification

- [ ] **Step 1: Run full agent test suite**

Run: `cd agent && go test -race ./... -count=1`
Expected: All tests pass.

- [ ] **Step 2: Verify cross-platform build**

Run: `cd agent && GOOS=darwin GOARCH=arm64 go build ./... && GOOS=windows GOARCH=amd64 go build ./... && GOOS=linux GOARCH=amd64 go build ./...`
Expected: Builds succeed on all platforms (the `consoleUser` field and methods are in platform-agnostic `broker.go`, but only called from darwin-specific files).

- [ ] **Step 3: Verify no lint issues**

Run: `cd agent && go vet ./...`
Expected: No issues.
