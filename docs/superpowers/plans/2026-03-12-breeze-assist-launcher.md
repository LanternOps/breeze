# Breeze Assist Launcher Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-aware spawning and crash recovery to the Breeze Assist tray app so it launches immediately after install (including from Windows Session 0) and auto-restarts on crash.

**Architecture:** Manager gets a `SpawnFunc` option for Windows session injection, a background watcher goroutine for crash recovery, and a migration helper for the rename from "Breeze Helper" to "Breeze Assist". Platform files updated with new binary names/identifiers.

**Tech Stack:** Go (agent), React/TypeScript (frontend labels)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `agent/internal/helper/watcher.go` | Crash recovery goroutine — polls liveness, restarts with backoff |
| `agent/internal/helper/migrate.go` | Shared migration logic (legacy path detection, binary cleanup) |
| `agent/internal/helper/migrate_windows.go` | Windows-specific: kill old process, delete old `BreezeHelper` registry key |
| `agent/internal/helper/migrate_darwin.go` | macOS-specific: unload old LaunchAgent, delete old plist |
| `agent/internal/helper/migrate_linux.go` | Linux-specific: kill old process, delete old desktop entry |
| `agent/internal/sessionbroker/spawn_process_windows.go` | `SpawnProcessInSession(binaryPath, sessionID)` — launches arbitrary binary into Windows user session |
| `agent/internal/sessionbroker/spawn_process_stub.go` | Build stub for non-Windows platforms |

### Modified Files
| File | Changes |
|------|---------|
| `agent/internal/helper/manager.go` | Add `context.Context`, `SpawnFunc` option, wire watcher start/stop, update logger name and binary paths |
| `agent/internal/helper/install_windows.go` | Rename binary/registry references to "Breeze Assist" |
| `agent/internal/helper/install_darwin.go` | Rename app bundle, plist label/path to "Breeze Assist" |
| `agent/internal/helper/install_linux.go` | Rename binary name, desktop entry to "breeze-assist" |
| `agent/internal/heartbeat/heartbeat.go` | Pass `context.Context` and `WithSpawnFunc(...)` to `helper.New()` |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | `FEATURE_META.helper.label` → "Breeze Assist" |
| `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx` | Update UI copy from "Helper" to "Breeze Assist" |

---

## Chunk 1: Platform Rename + SpawnProcessInSession

### Task 1: Rename platform constants (Windows)

**Files:**
- Modify: `agent/internal/helper/install_windows.go`

- [ ] **Step 1: Update constants and function bodies**

```go
// install_windows.go — update these values:

const registryValue = "BreezeAssist"  // was "BreezeHelper"

func isHelperRunning() bool {
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq Breeze Assist.exe", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "breeze assist.exe")
}

func stopHelper() error {
	return exec.Command("taskkill", "/F", "/IM", "Breeze Assist.exe").Run()
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=windows go build ./internal/helper/...`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/install_windows.go
git commit -m "refactor(helper): rename Windows references to Breeze Assist"
```

---

### Task 2: Rename platform constants (macOS)

**Files:**
- Modify: `agent/internal/helper/install_darwin.go`

- [ ] **Step 1: Update constants**

```go
// install_darwin.go — update these values:

const plistLabel = "com.breeze.assist"                           // was com.breeze.helper
const plistPath = "/Library/LaunchAgents/com.breeze.assist.plist" // was com.breeze.helper.plist
const appBundleName = "Breeze Assist.app"                        // was "Breeze Helper.app"
const destAppPath = "/Applications/Breeze Assist.app"            // was "Breeze Helper.app"
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/install_darwin.go
git commit -m "refactor(helper): rename macOS references to Breeze Assist"
```

---

### Task 3: Rename platform constants (Linux)

**Files:**
- Modify: `agent/internal/helper/install_linux.go`

- [ ] **Step 1: Update constants and function bodies**

```go
// install_linux.go — update these values:

const desktopEntryPath = "/etc/xdg/autostart/breeze-assist.desktop"  // was breeze-helper.desktop

// In installAutoStart, update the Name field:
// Name=Breeze Assist  (was Breeze Helper)

func isHelperRunning() bool {
	out, err := exec.Command("pgrep", "-f", "breeze-assist").Output()  // was breeze-helper
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) != ""
}

func stopHelper() error {
	return exec.Command("pkill", "-f", "breeze-assist").Run()  // was breeze-helper
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/install_linux.go
git commit -m "refactor(helper): rename Linux references to breeze-assist"
```

---

### Task 4: Rename binary paths + logger in manager.go

**Files:**
- Modify: `agent/internal/helper/manager.go`

- [ ] **Step 1: Update logger and defaultBinaryPath**

```go
// Line 16: change logger component name
var log = logging.L("breeze-assist")  // was "helper"

// In defaultBinaryPath(), update the return values:
case "darwin":
    return "/Applications/Breeze Assist.app/Contents/MacOS/Breeze Assist"
case "windows":
    // ...
    return filepath.Join(pf, "Breeze Assist", "Breeze Assist.exe")
default:
    return "/usr/local/bin/breeze-assist"
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/manager.go
git commit -m "refactor(helper): rename binary paths and logger to breeze-assist"
```

---

### Task 5: Add SpawnProcessInSession (Windows)

**Files:**
- Create: `agent/internal/sessionbroker/spawn_process_windows.go`
- Create: `agent/internal/sessionbroker/spawn_process_stub.go`

- [ ] **Step 1: Create Windows implementation**

File: `agent/internal/sessionbroker/spawn_process_windows.go`

This is modeled on the existing `SpawnHelperInSession` in `spawner_windows.go` but accepts an arbitrary binary path instead of hardcoding `os.Executable()` + `user-helper`.

```go
//go:build windows

package sessionbroker

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnProcessInSession launches an arbitrary binary as SYSTEM in the
// specified Windows session. Uses the same CreateProcessAsUser + token
// session injection pattern as SpawnHelperInSession, but for external
// binaries (e.g., Breeze Assist tray app).
func SpawnProcessInSession(binaryPath string, sessionID uint32) error {
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

	var dupToken windows.Token
	err = windows.DuplicateTokenEx(
		processToken,
		windows.MAXIMUM_ALLOWED,
		nil,
		windows.SecurityDelegation,
		windows.TokenPrimary,
		&dupToken,
	)
	if err != nil {
		return fmt.Errorf("DuplicateTokenEx: %w", err)
	}
	defer dupToken.Close()

	err = windows.SetTokenInformation(
		dupToken,
		windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&sessionID)),
		uint32(unsafe.Sizeof(sessionID)),
	)
	if err != nil {
		return fmt.Errorf("SetTokenInformation(TokenSessionId=%d): %w", sessionID, err)
	}

	cmdLine, err := windows.UTF16PtrFromString(fmt.Sprintf(`"%s"`, binaryPath))
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString: %w", err)
	}

	desktop, err := windows.UTF16PtrFromString(`winsta0\Default`)
	if err != nil {
		return fmt.Errorf("UTF16PtrFromString desktop: %w", err)
	}

	si := windows.StartupInfo{
		Cb:      uint32(unsafe.Sizeof(windows.StartupInfo{})),
		Desktop: desktop,
	}
	var pi windows.ProcessInformation

	err = windows.CreateProcessAsUser(
		dupToken,
		nil,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT,
		nil,
		nil,
		&si,
		&pi,
	)
	if err != nil {
		return fmt.Errorf("CreateProcessAsUser(session=%d, binary=%s): %w", sessionID, binaryPath, err)
	}

	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)

	log.Info("spawned process in session",
		"sessionId", sessionID,
		"pid", pi.ProcessId,
		"binary", binaryPath,
	)
	return nil
}
```

- [ ] **Step 2: Create non-Windows stub**

File: `agent/internal/sessionbroker/spawn_process_stub.go`

```go
//go:build !windows

package sessionbroker

import "fmt"

// SpawnProcessInSession is only implemented on Windows.
func SpawnProcessInSession(_ string, _ uint32) error {
	return fmt.Errorf("SpawnProcessInSession not supported on this platform")
}
```

- [ ] **Step 3: Verify compilation on both platforms**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/sessionbroker/... && GOOS=windows go build ./internal/sessionbroker/...`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add agent/internal/sessionbroker/spawn_process_windows.go agent/internal/sessionbroker/spawn_process_stub.go
git commit -m "feat(sessionbroker): add SpawnProcessInSession for arbitrary binary session injection"
```

---

## Chunk 2: Manager Refactor + Watcher + Migration

### Task 6: Add SpawnFunc and context.Context to Manager

**Files:**
- Modify: `agent/internal/helper/manager.go`

- [ ] **Step 1: Add SpawnFunc type, Option pattern, and update New/Manager struct**

Update `manager.go` imports to add `"context"`. Remove `"os/exec"` import (will only be used when spawnFunc is nil — handled in ensureRunning).

Update the Manager struct, New function, and ensureRunning:

```go
// SpawnFunc launches the Breeze Assist binary in the appropriate user session.
// On Windows: wraps SpawnProcessInSession for each active session.
// On macOS/Linux: nil (falls back to exec.Command).
type SpawnFunc func(binaryPath string) error

// ErrNoActiveSession is returned by SpawnFunc when no user session is available.
var ErrNoActiveSession = fmt.Errorf("no active user session")

// Option configures a Manager.
type Option func(*Manager)

// WithSpawnFunc sets a platform-specific function for launching the helper
// binary in a user session. Required on Windows (Session 0 service).
func WithSpawnFunc(fn SpawnFunc) Option {
	return func(m *Manager) { m.spawnFunc = fn }
}

// Manager handles Breeze Assist binary lifecycle: config writing, install, start, stop.
type Manager struct {
	mu          sync.Mutex
	ctx         context.Context
	lastEnabled bool
	binaryPath  string
	configPath  string
	serverURL   string
	authToken   *secmem.SecureString
	agentID     string
	spawnFunc   SpawnFunc
	watcher     *watcher
}

// New creates a new Breeze Assist Manager.
func New(ctx context.Context, serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager {
	m := &Manager{
		ctx:        ctx,
		binaryPath: defaultBinaryPath(),
		configPath: defaultConfigPath(),
		serverURL:  serverURL,
		authToken:  authToken,
		agentID:    agentID,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}
```

- [ ] **Step 2: Update ensureRunning to use spawnFunc**

```go
func (m *Manager) ensureRunning() error {
	if isHelperRunning() {
		return nil
	}

	if m.spawnFunc != nil {
		return m.spawnFunc(m.binaryPath)
	}

	cmd := exec.Command(m.binaryPath)
	cmd.Dir = filepath.Dir(m.binaryPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Start()
}
```

Note: keep `"os/exec"` in imports since the fallback path still uses it.

- [ ] **Step 3: Add watcher start/stop to Apply**

Update `Apply()` to start/stop the watcher:

```go
func (m *Manager) Apply(settings *Settings) {
	if settings == nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if settings.Enabled {
		m.migrateFromLegacyName()

		if err := m.writeConfig(settings); err != nil {
			log.Error("failed to write breeze assist config", "error", err.Error())
			return
		}

		if !m.isInstalled() {
			if err := m.downloadAndInstall(); err != nil {
				log.Error("failed to install breeze assist", "error", err.Error())
				return
			}
		}

		if err := m.ensureRunning(); err != nil {
			log.Error("failed to start breeze assist", "error", err.Error())
		} else {
			m.startWatcher()
		}

		if !m.lastEnabled {
			log.Info("breeze assist enabled and started")
		}
	} else {
		if m.lastEnabled {
			m.stopWatcher()
			if err := m.ensureStopped(); err != nil {
				log.Error("failed to stop breeze assist", "error", err.Error())
			} else {
				log.Info("breeze assist disabled and stopped")
			}
		}
	}

	m.lastEnabled = settings.Enabled
}

// Shutdown stops the watcher and the helper process.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopWatcher()
}

func (m *Manager) startWatcher() {
	if m.watcher != nil {
		return
	}
	m.watcher = newWatcher(m.ctx, m)
	go m.watcher.run()
}

// stopWatcher cancels the watcher and waits for it to exit.
// IMPORTANT: Must release m.mu before joining to avoid deadlock —
// the watcher acquires mu during its tick, so if we hold mu and
// wait on done, we deadlock if the watcher is blocked on mu.Lock().
func (m *Manager) stopWatcher() {
	if m.watcher == nil {
		return
	}
	w := m.watcher
	m.watcher = nil
	w.cancel()
	m.mu.Unlock()
	<-w.done
	m.mu.Lock()
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: will fail until watcher.go and migrate.go exist — that's fine, proceed to next tasks

- [ ] **Step 5: Commit**

```bash
git add agent/internal/helper/manager.go
git commit -m "feat(helper): add SpawnFunc, context, and watcher lifecycle to Manager"
```

---

### Task 7: Create watcher.go

**Files:**
- Create: `agent/internal/helper/watcher.go`

- [ ] **Step 1: Write the watcher**

File: `agent/internal/helper/watcher.go`

```go
package helper

import (
	"context"
	"time"
)

const (
	watcherBaseInterval = 30 * time.Second
	watcherBackoffCap   = 30 * time.Second
	watcherMaxRetries   = 10
)

// watcher monitors Breeze Assist liveness and restarts it on crash.
// It uses an adaptive polling interval: 30s when healthy, exponential
// backoff (2s → 30s cap) on repeated failures. Stops after maxRetries
// consecutive failures; the next heartbeat Apply() resets it.
type watcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	mgr    *Manager
	done   chan struct{}
}

func newWatcher(parent context.Context, mgr *Manager) *watcher {
	ctx, cancel := context.WithCancel(parent)
	return &watcher{
		ctx:    ctx,
		cancel: cancel,
		mgr:    mgr,
		done:   make(chan struct{}),
	}
}

func (w *watcher) run() {
	defer close(w.done)

	var failures int
	interval := watcherBaseInterval

	for {
		select {
		case <-w.ctx.Done():
			return
		case <-time.After(interval):
		}

		w.mgr.mu.Lock()
		running := isHelperRunning()
		if running {
			w.mgr.mu.Unlock()
			failures = 0
			interval = watcherBaseInterval
			continue
		}

		err := w.mgr.ensureRunning()
		w.mgr.mu.Unlock()

		if err == nil {
			failures = 0
			interval = watcherBaseInterval
			log.Info("breeze assist restarted by watcher")
			continue
		}

		failures++
		log.Warn("watcher failed to restart breeze assist",
			"error", err.Error(),
			"failures", failures,
			"maxRetries", watcherMaxRetries,
		)

		if failures >= watcherMaxRetries {
			log.Error("watcher giving up after max retries, will retry on next heartbeat",
				"failures", failures,
			)
			return
		}

		// Exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s, ...
		backoff := time.Duration(1<<uint(failures)) * time.Second
		if backoff > watcherBackoffCap {
			backoff = watcherBackoffCap
		}
		interval = backoff
	}
}

// Note: stop() is not used directly — Manager.stopWatcher() handles
// cancel + join with mutex release/reacquire. This method exists for
// testing and direct use outside the Manager mutex pattern.
func (w *watcher) stop() {
	w.cancel()
	<-w.done
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: will fail until migrate.go exists — proceed to next task

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/watcher.go
git commit -m "feat(helper): add crash recovery watcher with adaptive backoff"
```

---

### Task 8: Create migration files

**Files:**
- Create: `agent/internal/helper/migrate.go` (shared logic)
- Create: `agent/internal/helper/migrate_windows.go` (Windows-specific)
- Create: `agent/internal/helper/migrate_darwin.go` (macOS-specific)
- Create: `agent/internal/helper/migrate_linux.go` (Linux-specific)

- [ ] **Step 1: Write the migration files**

**Cross-compilation note:** `removeAutoStart()` is defined in `install_windows.go` (filename-based build constraint). Calling it from an untagged `.go` file will fail to compile on non-Windows. Solution: split migration into platform-specific files.

File: `agent/internal/helper/migrate.go` (shared logic, no build tag)

```go
package helper

import (
	"os"
	"path/filepath"
	"runtime"
)

// legacyBinaryPath returns the old "Breeze Helper" binary path.
func legacyBinaryPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Applications/Breeze Helper.app/Contents/MacOS/Breeze Helper"
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		return filepath.Join(pf, "Breeze Helper", "Breeze Helper.exe")
	default:
		return "/usr/local/bin/breeze-helper"
	}
}

// migrateFromLegacyName cleans up old "Breeze Helper" installations.
// Called at the top of Apply() under the manager mutex. Idempotent.
func (m *Manager) migrateFromLegacyName() {
	oldPath := legacyBinaryPath()
	if _, err := os.Stat(oldPath); err != nil {
		return
	}

	log.Info("migrating from legacy Breeze Helper installation", "oldPath", oldPath)

	// Platform-specific: stop old process + remove old autostart
	migrateLegacyPlatform()

	// Remove old binary/app bundle
	switch runtime.GOOS {
	case "darwin":
		os.RemoveAll("/Applications/Breeze Helper.app")
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		os.RemoveAll(filepath.Join(pf, "Breeze Helper"))
	default:
		os.Remove(oldPath)
	}

	log.Info("legacy Breeze Helper installation cleaned up")
}
```

File: `agent/internal/helper/migrate_windows.go`

```go
package helper

import (
	"os/exec"

	"golang.org/x/sys/windows/registry"
)

func migrateLegacyPlatform() {
	// Kill old process
	_ = exec.Command("taskkill", "/F", "/IM", "Breeze Helper.exe").Run()

	// Remove old registry autostart key ("BreezeHelper", not "BreezeAssist")
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	_ = key.DeleteValue("BreezeHelper") // explicit old value, not the current registryValue const
}
```

File: `agent/internal/helper/migrate_darwin.go`

```go
package helper

import (
	"os"
	"os/exec"
	"strings"
)

func migrateLegacyPlatform() {
	uid := strings.TrimSpace(string(must(exec.Command("id", "-u").Output())))
	_ = exec.Command("launchctl", "bootout", "gui/"+uid, "/Library/LaunchAgents/com.breeze.helper.plist").Run()
	os.Remove("/Library/LaunchAgents/com.breeze.helper.plist")
}

func must(b []byte, err error) []byte {
	if err != nil {
		return []byte("")
	}
	return b
}
```

File: `agent/internal/helper/migrate_linux.go`

```go
//go:build !darwin && !windows

package helper

import (
	"os"
	"os/exec"
)

func migrateLegacyPlatform() {
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
	os.Remove("/etc/xdg/autostart/breeze-helper.desktop")
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/helper/...`
Expected: compiles successfully (all new files now exist)

- [ ] **Step 3: Commit**

```bash
git add agent/internal/helper/migrate.go agent/internal/helper/migrate_windows.go agent/internal/helper/migrate_darwin.go agent/internal/helper/migrate_linux.go
git commit -m "feat(helper): add legacy Breeze Helper migration cleanup"
```

---

## Chunk 3: Heartbeat Wiring + Frontend Rename

### Task 9: Wire SpawnFunc in heartbeat.go

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`

- [ ] **Step 1: Create context from stopChan and update helper.New() call**

At line 232, replace the single `helper.New()` call with the context creation + conditional SpawnFunc wiring shown in Step 2. The heartbeat struct has `stopChan chan struct{}` but no `context.Context`, so we derive one.

- [ ] **Step 2: Add SpawnFunc on Windows**

After the `helper.New()` call, add the Windows SpawnFunc wiring. This should go right after line 232. The SpawnFunc needs access to the session detector to find active sessions:

```go
// The heartbeat uses stopChan, not context.Context — create one from it.
ctx, cancel := context.WithCancel(context.Background())
go func() {
	<-h.stopChan
	cancel()
}()

// On Windows service, provide a SpawnFunc that launches Breeze Assist
// into active user sessions via CreateProcessAsUser.
if runtime.GOOS == "windows" && cfg.IsService {
	helperOpts := []helper.Option{
		helper.WithSpawnFunc(func(binaryPath string) error {
			detector := sessionbroker.NewSessionDetector()
			sessions, err := detector.ListSessions()
			if err != nil {
				return fmt.Errorf("list sessions: %w", err)
			}
			var launched int
			for _, s := range sessions {
				if s.State != "active" && s.State != "connected" {
					continue
				}
				// DetectedSession.Session is a string; parse to uint32 for Windows session ID
				sessionNum, err := strconv.ParseUint(s.Session, 10, 32)
				if err != nil {
					log.Warn("invalid session id", "session", s.Session, "error", err.Error())
					continue
				}
				if err := sessionbroker.SpawnProcessInSession(binaryPath, uint32(sessionNum)); err != nil {
					log.Warn("failed to spawn breeze assist in session",
						"sessionId", sessionNum, "error", err.Error())
					continue
				}
				launched++
			}
			if launched == 0 {
				return helper.ErrNoActiveSession
			}
			return nil
		}),
	}
	h.helperMgr = helper.New(ctx, cfg.ServerURL, ftToken, cfg.AgentID, helperOpts...)
} else {
	h.helperMgr = helper.New(ctx, cfg.ServerURL, ftToken, cfg.AgentID)
}
```

**Important notes:**
- `DetectedSession.Session` is a `string`, not `uint32`. Use `strconv.ParseUint(s.Session, 10, 32)` to convert.
- Heartbeat has no `context.Context` — create one from `stopChan` as shown above.
- Add `"strconv"` and `"context"` to imports if not already present.
- Check how `NewSessionDetector()` is called elsewhere (e.g., in `HelperLifecycleManager`) and follow the same pattern. It may be `sessionbroker.NewDetector()` or similar.

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`
Expected: compiles successfully

- [ ] **Step 4: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat(heartbeat): wire SpawnFunc for Breeze Assist session injection on Windows"
```

---

### Task 10: Frontend rename — FEATURE_META

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts`

- [ ] **Step 1: Update label and description**

At line 40, change:
```typescript
helper:      { label: 'Helper',     fetchUrl: null,                   description: 'End-user helper tray application' },
```
to:
```typescript
helper:      { label: 'Breeze Assist', fetchUrl: null,                description: 'End-user Breeze Assist tray application' },
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/types.ts
git commit -m "refactor(frontend): rename Helper to Breeze Assist in FEATURE_META"
```

---

### Task 11: Frontend rename — HelperTab UI copy

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx`

- [ ] **Step 1: Update user-facing strings**

Three strings to update:

Line 70 — Deploy toggle title:
```
"Deploy Helper to devices" → "Deploy Breeze Assist to devices"
```

Line 70 — Deploy toggle description:
```
"Install and run the Breeze Helper tray application on targeted devices."
→ "Install and run the Breeze Assist tray application on targeted devices."
```

Line 76 — Tray menu options description:
```
"Configure which items appear in the Helper's right-click context menu. Exit is always available."
→ "Configure which items appear in the Breeze Assist right-click context menu. Exit is always available."
```

Line 93 — Request Support description:
```
"Opens the Helper chat window for AI-assisted support."
→ "Opens the Breeze Assist chat window for AI-assisted support."
```

- [ ] **Step 2: Verify frontend build**

Run: `cd /Users/toddhebebrand/breeze && pnpm build`
Expected: compiles without errors (or at least `apps/web` portion succeeds)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx
git commit -m "refactor(frontend): update HelperTab UI copy to Breeze Assist"
```

---

### Task 12: Final verification

- [ ] **Step 1: Full Go agent build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`
Expected: no errors

- [ ] **Step 2: Cross-compile Windows**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go build ./...`
Expected: no errors

- [ ] **Step 3: Cross-compile Linux**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=linux GOARCH=amd64 go build ./...`
Expected: no errors

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A && git commit -m "fix: address build issues from Breeze Assist launcher implementation"
```
