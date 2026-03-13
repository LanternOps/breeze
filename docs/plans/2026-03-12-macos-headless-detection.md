# macOS Headless Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the macOS (and Linux) agent detect when it's running headless as a system daemon and route remote desktop/screenshot commands through the IPC user-helper instead of attempting direct screen capture that fails without a GUI session.

**Architecture:** Add an `IsHeadless` flag to the agent config, detected via `!hasConsole()` on Unix. The session broker and desktop command handlers use `isHeadless` alongside the existing `isService` flag to decide whether to route through IPC. On macOS, the user-helper LaunchAgent (managed by launchd, not spawned by the daemon) connects via IPC when a user logs in. On Windows, `isHeadless` mirrors `isService` for consistency.

**Tech Stack:** Go, CGO (macOS ScreenCaptureKit), IPC (Unix domain sockets)

---

### Task 1: Add `IsHeadless` to Config struct

**Files:**
- Modify: `agent/internal/config/config.go:88`

**Step 1: Add field**

Add `IsHeadless` next to the existing `IsService` field at line 88:

```go
// IsService is a runtime flag set when the agent is running as a system service
// (Windows SCM, macOS launchd, Linux systemd). It is not persisted to config.
IsService bool `mapstructure:"-"`

// IsHeadless is a runtime flag set when no console/TTY is attached (launchd
// daemon, systemd service, etc.). Desktop commands route through IPC when set.
IsHeadless bool `mapstructure:"-"`
```

**Step 2: Commit**

```bash
git add agent/internal/config/config.go
git commit -m "feat(agent): add IsHeadless runtime flag to Config struct"
```

---

### Task 2: Add `isHeadless()` detection to `service_unix.go`

**Files:**
- Modify: `agent/cmd/breeze-agent/service_unix.go`

**Step 1: Add `isHeadless` function**

Add below the existing `hasConsole()` function:

```go
// isHeadless returns true when the process has no controlling terminal.
// This is the case for launchd daemons and systemd services — both of which
// redirect stdout/stderr to log files, leaving no character device.
func isHeadless() bool { return !hasConsole() }
```

**Step 2: Commit**

```bash
git add agent/cmd/breeze-agent/service_unix.go
git commit -m "feat(agent): add isHeadless() detection for Unix daemons"
```

---

### Task 3: Add `isHeadless()` to `service_windows.go` (mirror `isService`)

**Files:**
- Find and modify the Windows service file (likely `agent/cmd/breeze-agent/service_windows.go` or the Windows build-tagged equivalent)

**Step 1: Add function**

```go
// isHeadless mirrors isWindowsService on Windows — Session 0 has no display.
func isHeadless() bool { return isWindowsService() }
```

**Step 2: Commit**

```bash
git add agent/cmd/breeze-agent/service_windows.go
git commit -m "feat(agent): add isHeadless() for Windows (mirrors isWindowsService)"
```

---

### Task 4: Set `cfg.IsHeadless` in `main.go`

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go:255-263`

**Step 1: Set the flag alongside `IsService`**

Change lines 255-263 from:

```go
// Propagate service mode flag so the heartbeat can route desktop
// sessions through the IPC user helper instead of capturing directly.
cfg.IsService = isWindowsService()

// Ensure SAS (Ctrl+Alt+Del) policy allows services to generate it.
// Only relevant on Windows when running as a service.
if cfg.IsService {
    ensureSASPolicy()
}
```

To:

```go
// Propagate service/headless flags so the heartbeat routes desktop
// sessions through the IPC user helper instead of capturing directly.
cfg.IsService = isWindowsService()
cfg.IsHeadless = isHeadless()

// Ensure SAS (Ctrl+Alt+Del) policy allows services to generate it.
// Only relevant on Windows when running as a service.
if cfg.IsService {
    ensureSASPolicy()
}

if cfg.IsHeadless {
    log.Info("running in headless mode (no console attached), desktop commands will route via IPC")
}
```

**Step 2: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "feat(agent): set IsHeadless flag at startup"
```

---

### Task 5: Wire `isHeadless` into Heartbeat struct and broker init

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:129,216,253-275,332-338`

**Step 1: Add field to struct (after line 129)**

```go
// User session helper (IPC)
sessionBroker *sessionbroker.Broker
isService     bool
isHeadless    bool
scmSessionCh  chan sessionbroker.SCMSessionEvent // fed by SCM handler
```

**Step 2: Set in constructor (after line 216)**

```go
h.isService = cfg.IsService
h.isHeadless = cfg.IsHeadless
```

**Step 3: Update broker init guard (line 257)**

Change:
```go
if cfg.UserHelperEnabled || cfg.IsService {
```
To:
```go
if cfg.UserHelperEnabled || cfg.IsService || cfg.IsHeadless {
```

Update the reason logging (line 264):
```go
reason := "config"
if cfg.IsService {
    reason = "windows-service"
} else if cfg.IsHeadless {
    reason = "headless-daemon"
}
```

**Step 4: Update disconnect callback guard (line 334)**

Change:
```go
if !cfg.IsService {
```
To:
```go
if !cfg.IsService && !cfg.IsHeadless {
```

**Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): wire isHeadless into heartbeat and session broker init"
```

---

### Task 6: Update desktop command handlers to route via IPC when headless

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go`

**Step 1: Update `handleStartDesktop` (line 127-132)**

Change:
```go
// Route through IPC helper when running as a Windows service
if h.isService && h.sessionBroker != nil {
```
To:
```go
// Route through IPC helper when running headless (no display access)
if (h.isService || h.isHeadless) && h.sessionBroker != nil {
```

**Step 2: Update `handleStopDesktop` (line 156)**

Change:
```go
if h.isService && h.sessionBroker != nil {
```
To:
```go
if (h.isService || h.isHeadless) && h.sessionBroker != nil {
```

**Step 3: Update `handleDesktopStreamStart` (line 228)**

Change:
```go
if h.isService {
    return serviceUnavailable("desktop_stream_start", start)
}
```
To:
```go
if h.isService || h.isHeadless {
    return serviceUnavailable("desktop_stream_start", start)
}
```

**Step 4: Update `handleDesktopStreamStop` (line 267)**

Change:
```go
if h.isService {
```
To:
```go
if h.isService || h.isHeadless {
```

**Step 5: Update `handleDesktopInput` (line 285)**

Change:
```go
if h.isService {
    return serviceUnavailable("desktop_input", start)
}
```
To:
```go
if h.isService || h.isHeadless {
    return serviceUnavailable("desktop_input", start)
}
```

**Step 6: Update `handleDesktopConfig` (line 338)**

Change:
```go
if h.isService {
    return serviceUnavailable("desktop_config", start)
}
```
To:
```go
if h.isService || h.isHeadless {
    return serviceUnavailable("desktop_config", start)
}
```

**Step 7: Update the `serviceUnavailable` message (line 41-47)**

Change:
```go
func serviceUnavailable(command string, start time.Time) tools.CommandResult {
	return tools.CommandResult{
		Status:     "failed",
		Error:      command + " unavailable in service mode; use WebRTC instead",
		DurationMs: time.Since(start).Milliseconds(),
	}
}
```
To:
```go
func serviceUnavailable(command string, start time.Time) tools.CommandResult {
	return tools.CommandResult{
		Status:     "failed",
		Error:      command + " unavailable in headless/service mode; use WebRTC instead",
		DurationMs: time.Since(start).Milliseconds(),
	}
}
```

**Step 8: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop.go
git commit -m "feat(agent): route desktop commands via IPC when headless"
```

---

### Task 7: Update screenshot handler

**Files:**
- Modify: `agent/internal/heartbeat/handlers_screenshot.go:20`

**Step 1: Update guard**

Change:
```go
if h.isService && h.sessionBroker != nil {
```
To:
```go
if (h.isService || h.isHeadless) && h.sessionBroker != nil {
```

**Step 2: Commit**

```bash
git add agent/internal/heartbeat/handlers_screenshot.go
git commit -m "feat(agent): route screenshots via IPC when headless"
```

---

### Task 8: Improve error message when no helper connects on macOS

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop_helper.go:60-78`

The existing `spawnHelperForDesktop` calls `sessionbroker.SpawnHelperInSession()` which returns an error on non-Windows. The error message should guide the user to install the LaunchAgent.

**Step 1: Update `spawnHelperForDesktop` (lines 122-157)**

Change the function to return a platform-specific error on macOS/Linux instead of attempting spawn:

```go
func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf(
			"no user-helper connected; install the LaunchAgent with: " +
				"sudo breeze-agent service install --with-user-helper")
	}

	if targetSession == "" {
		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("failed to list sessions: %w", err)
		}
		// Prefer active sessions, fall back to connected (lock screen after reboot).
		var fallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			if ds.State == "active" {
				targetSession = ds.Session
				break
			}
			if ds.State == "connected" && fallback == "" {
				fallback = ds.Session
			}
		}
		if targetSession == "" {
			targetSession = fallback
		}
		if targetSession == "" {
			return fmt.Errorf("no active or connected non-services session found")
		}
	}

	var sessionNum uint32
	if _, err := fmt.Sscanf(targetSession, "%d", &sessionNum); err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}

	return sessionbroker.SpawnHelperInSession(sessionNum)
}
```

**Step 2: Add `"runtime"` to imports if not already present**

**Step 3: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop_helper.go
git commit -m "feat(agent): actionable error when macOS user-helper not connected"
```

---

### Task 9: Build and verify

**Step 1: Build the agent**

```bash
cd agent && make build
```

Expected: Clean build with no errors.

**Step 2: Run existing tests**

```bash
cd agent && go test ./internal/heartbeat/... -v -count=1
```

Expected: All existing tests pass.

**Step 3: Verify headless detection interactively**

Run the agent in a terminal (interactive — should NOT be headless):
```bash
cd agent && go run ./cmd/breeze-agent run --config /dev/null 2>&1 | head -20
```

Should NOT log "running in headless mode".

**Step 4: Commit any fixes**

---

### Task 10: End-to-end test as LaunchDaemon

**Step 1: Build and install with user-helper**

```bash
cd agent && make build
sudo ./bin/breeze-agent-darwin-arm64 service install --with-user-helper
```

**Step 2: Start the service**

```bash
sudo breeze-agent service start
```

**Step 3: Verify headless detection in logs**

```bash
tail -50 /Library/Logs/Breeze/agent.log | grep -i "headless\|user helper IPC"
```

Expected: Both "running in headless mode" and "user helper IPC enabled" with `reason=headless-daemon`.

**Step 4: Test remote desktop from the dashboard**

1. Open the Breeze dashboard
2. Find the macOS device
3. Click "Connect Desktop"
4. Verify the session creates and the viewer connects

**Step 5: Check agent logs for IPC routing**

```bash
tail -100 /Library/Logs/Breeze/agent.log | grep -i "desktop\|IPC\|helper"
```

Expected: Desktop commands routed via IPC, not direct capture.

---

## Summary of Changes

| File | Change |
|------|--------|
| `agent/internal/config/config.go` | Add `IsHeadless bool` field |
| `agent/cmd/breeze-agent/service_unix.go` | Add `isHeadless()` function |
| `agent/cmd/breeze-agent/service_windows.go` | Add `isHeadless()` (mirrors `isWindowsService`) |
| `agent/cmd/breeze-agent/main.go` | Set `cfg.IsHeadless` at startup |
| `agent/internal/heartbeat/heartbeat.go` | Add `isHeadless` field, update broker init + disconnect guard |
| `agent/internal/heartbeat/handlers_desktop.go` | Gate all 6 handlers on `isService \|\| isHeadless` |
| `agent/internal/heartbeat/handlers_screenshot.go` | Gate screenshot on `isService \|\| isHeadless` |
| `agent/internal/heartbeat/handlers_desktop_helper.go` | Platform-specific error for macOS spawn |
