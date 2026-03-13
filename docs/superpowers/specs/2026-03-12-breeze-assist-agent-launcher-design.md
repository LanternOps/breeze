# Breeze Assist — Agent Launcher & Crash Recovery

**Date:** 2026-03-12
**Status:** Draft
**Scope:** Go agent changes + cosmetic rename across frontend/binary paths

## Problem

Breeze Assist (formerly "Helper Chat App") has a configuration policy and deployment pipeline, but two gaps exist:

1. **First-run launch:** After install, `ensureRunning()` uses `exec.Command()` which starts the process in the caller's session. On Windows (Session 0 service), this means Breeze Assist launches invisible to the user — no tray icon, no desktop access.
2. **Crash recovery:** No monitoring between heartbeats. If Breeze Assist dies, it stays dead until the next heartbeat `Apply()` call (~60s worst case, no retry logic).

## Design

### 1. Architecture Overview

Three changes to `agent/internal/helper/Manager`:

1. **Fix `ensureRunning()` on Windows** — Use session broker's `SpawnHelperInSession()` to launch into the active user session instead of Session 0.
2. **Add a watcher goroutine** — Polls `isHelperRunning()` every 30s with exponential backoff on failures.
3. **Wire into heartbeat** — Start watcher after successful first launch; stop watcher when policy disables Breeze Assist.

**Flow:**

```
Heartbeat → Apply(settings)
              ├─ enabled=true:  writeConfig → install if needed → ensureRunning → startWatcher
              └─ enabled=false: stopWatcher → ensureStopped

Watcher goroutine (30s tick):
  └─ isHelperRunning()?
       ├─ yes: reset backoff
       └─ no:  ensureRunning() with backoff
```

### 2. Windows Session-Aware Spawning

Manager accepts an optional `SpawnFunc` via functional options:

```go
// SpawnFunc launches the helper binary in the appropriate user session.
type SpawnFunc func(binaryPath string) error

type Option func(*Manager)

func WithSpawnFunc(fn SpawnFunc) Option {
    return func(m *Manager) { m.spawnFunc = fn }
}

func New(serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager
```

**On Windows**, the heartbeat initializer provides a `SpawnFunc` that:
1. Calls `sessionDetector.ListSessions()` to find active console/RDP sessions
2. Calls `SpawnHelperInSession(sessionID)` with the Breeze Assist binary path
3. Returns a sentinel error if no active session exists (watcher retries on next tick)

**On macOS/Linux**, `SpawnFunc` is nil. `ensureRunning()` checks: if `spawnFunc != nil`, use it; otherwise fall back to `exec.Command(m.binaryPath).Start()`.

**Multi-session (Windows RDP):** Spawns into each active session. Watcher checks per-session liveness via session broker's tracked session map.

### 3. Crash Recovery Watcher

New file: `agent/internal/helper/watcher.go` (~80 lines)

```go
type watcher struct {
    interval    time.Duration  // 30s
    maxRetries  int            // 10
    backoffCap  time.Duration  // 30s
    stopCh      chan struct{}
    failures    int
    lastBackoff time.Duration
}
```

**Lifecycle:**
- `Manager.startWatcher()` — spawns goroutine if not already running. Called after successful `ensureRunning()`.
- `Manager.stopWatcher()` — signals `stopCh`. Called when policy disables Breeze Assist.
- Watcher also stops if manager is shut down (context cancellation).

**Tick logic:**
1. `isHelperRunning()` → yes: reset `failures` and `lastBackoff`
2. Not running → call `ensureRunning()`
3. `ensureRunning()` fails → increment `failures`, backoff doubles (2s → 4s → 8s → ... → 30s cap)
4. `failures >= maxRetries` (10) → log error, stop watcher

**Why max retries?** Prevents CPU burn if binary is corrupted/missing. Next heartbeat `Apply()` re-checks `isInstalled()`, re-downloads if needed, and restarts the watcher.

**Windows multi-session:** Watcher delegates to session broker's tracked session map — each session monitored independently.

### 4. Naming — Breeze Assist

Cosmetic rename of user-facing strings and binary names only. No schema migrations, no API breaking changes.

**Changes:**
| Item | Before | After |
|------|--------|-------|
| Log component | `"helper"` | `"breeze-assist"` |
| Windows binary | `Breeze Helper\Breeze Helper.exe` | `Breeze Assist\Breeze Assist.exe` |
| macOS app bundle | `Breeze Helper.app` | `Breeze Assist.app` |
| Linux binary | `breeze-helper` | `breeze-assist` |
| LaunchAgent plist | `com.breeze.helper` | `com.breeze.assist` |
| XDG autostart | `breeze-helper.desktop` | `breeze-assist.desktop` |
| Frontend UI copy | "Helper" labels | "Breeze Assist" labels |

**Unchanged:**
| Item | Value | Reason |
|------|-------|--------|
| Go package name | `helper` | Internal, no user impact |
| DB enum | `'helper'` | Schema migration not worth it |
| API routes | `/helper/*` | No breaking API change |
| Config policy featureType | `'helper'` | Internal identifier |
| Config file name | `helper_config.yaml` | No user visibility |

## Files to Create/Modify

### New Files
- `agent/internal/helper/watcher.go` — Crash recovery watcher goroutine

### Modified Files
- `agent/internal/helper/manager.go` — Add `SpawnFunc` option, `startWatcher`/`stopWatcher`, update `ensureRunning()` to use `spawnFunc` when available, update binary paths and log component
- `agent/internal/helper/install_windows.go` — Update binary name references
- `agent/internal/helper/install_darwin.go` — Update app bundle name, LaunchAgent plist identifier
- `agent/internal/helper/install_linux.go` — Update binary name, XDG desktop entry name
- `agent/internal/heartbeat/heartbeat.go` — Pass `WithSpawnFunc(...)` when constructing Manager on Windows
- `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx` — Update UI copy to "Breeze Assist"

## Testing Strategy

- **Unit:** Watcher tick logic with mock `isHelperRunning`/`ensureRunning` — verify backoff, max retries, reset on success
- **Integration (Windows):** Verify `SpawnFunc` is called instead of `exec.Command` when provided
- **Manual:** Deploy to test device, enable policy, confirm tray icon appears; kill process, confirm it restarts within 30s
