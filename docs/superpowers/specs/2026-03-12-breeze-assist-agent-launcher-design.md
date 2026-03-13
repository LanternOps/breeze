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

1. **Fix `ensureRunning()` on Windows** — Create a new `SpawnProcessInSession()` function (distinct from the existing `SpawnHelperInSession()` which spawns the agent's own binary for desktop helpers) to launch the Breeze Assist binary into user sessions.
2. **Add a watcher goroutine** — Monitors Breeze Assist liveness with exponential backoff on failures.
3. **Wire into heartbeat** — Start watcher after successful first launch; stop watcher when policy disables Breeze Assist.

**Relationship to existing HelperLifecycleManager:** The `HelperLifecycleManager` in `sessionbroker/lifecycle.go` manages the agent's own *desktop helper* process (the agent binary launched with `user-helper` subcommand for WebRTC). Breeze Assist is a *separate* tray application binary. These are distinct systems with different binaries, different lifecycles, and different purposes. The watcher is intentionally separate.

**Flow:**

```
Heartbeat → Apply(settings)
              ├─ enabled=true:  writeConfig → install if needed → ensureRunning → startWatcher
              └─ enabled=false: stopWatcher → ensureStopped

Watcher goroutine (adaptive interval):
  └─ isHelperRunning()?
       ├─ yes: reset backoff, wait 30s
       └─ no:  ensureRunning(), backoff on failure (2s → 4s → ... → 30s cap)
```

### 2. Windows Session-Aware Spawning

**New function:** `SpawnProcessInSession(binaryPath string, sessionID uint32) error` in `sessionbroker/spawner_windows.go`. This is distinct from the existing `SpawnHelperInSession(sessionID)` which hardcodes `os.Executable()` + `user-helper` subcommand. The new function uses the same `CreateProcessAsUser` + `DuplicateTokenEx` + `SetTokenInformation(TokenSessionId)` mechanism but accepts an arbitrary binary path.

Manager accepts an optional `SpawnFunc` via functional options, plus a `context.Context` for lifecycle management:

```go
// SpawnFunc launches the helper binary in the appropriate user session.
// On Windows: wraps SpawnProcessInSession for each active session.
// On macOS/Linux: nil (falls back to exec.Command).
type SpawnFunc func(binaryPath string) error

type Option func(*Manager)

func WithSpawnFunc(fn SpawnFunc) Option {
    return func(m *Manager) { m.spawnFunc = fn }
}

func New(ctx context.Context, serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager
```

**On Windows**, the heartbeat initializer provides a `SpawnFunc` that:
1. Calls `sessionDetector.ListSessions()` to find active console/RDP sessions
2. Calls `SpawnProcessInSession(binaryPath, sessionID)` for each active session
3. Returns a sentinel error (`ErrNoActiveSession`) if no active session exists (watcher retries on next tick)

**On macOS/Linux**, `SpawnFunc` is nil. `ensureRunning()` checks: if `spawnFunc != nil`, use it; otherwise fall back to `exec.Command(m.binaryPath).Start()`.

**Multi-session (Windows RDP):** The `SpawnFunc` iterates all active sessions. Per-session liveness is tracked via a `map[uint32]sessionState` inside the `SpawnFunc` closure, using `tasklist /FI "SESSION eq N" /FI "IMAGENAME eq Breeze Assist.exe"` to check whether Breeze Assist is running in each specific session.

### 3. Crash Recovery Watcher

New file: `agent/internal/helper/watcher.go` (~100 lines)

```go
type watcher struct {
    baseInterval time.Duration  // 30s
    maxRetries   int            // 10
    backoffCap   time.Duration  // 30s
    stopCh       chan struct{}

    // state
    failures     int
    nextInterval time.Duration  // adapts: 30s on success, backoff duration on failure
}
```

**Lifecycle:**
- `Manager.startWatcher()` — spawns goroutine if not already running. Called after successful `ensureRunning()`.
- `Manager.stopWatcher()` — signals `stopCh`. Called when policy disables Breeze Assist.
- Watcher also stops when the `context.Context` passed to `Manager.New()` is cancelled (agent shutdown).
- The watcher goroutine is guaranteed to exit before `stopWatcher()` returns (uses a `done` channel for join).

**Locking discipline:** The watcher does NOT hold `Manager.mu` during its sleep interval. It acquires `mu` once to perform the check-then-act atomically: `isHelperRunning()` → `ensureRunning()` under a single lock acquisition. This prevents both deadlock with `Apply()` and TOCTOU races between the liveness check and the spawn.

**Tick logic (adaptive interval):**
1. Wait for `nextInterval` (starts at 30s)
2. `isHelperRunning()` → yes: reset `failures`, set `nextInterval = 30s`
3. Not running → call `ensureRunning()`
4. `ensureRunning()` succeeds → reset `failures`, set `nextInterval = 30s`
5. `ensureRunning()` fails → increment `failures`, set `nextInterval = min(2^failures * 1s, 30s)`
6. `failures >= maxRetries` (10) → log error, stop watcher

**Why adaptive interval?** A fixed 30s tick means early backoff values (2s, 4s) are meaningless. Instead, the watcher interval itself adjusts — after a failure, the next check happens at the backoff duration, not after a fixed 30s wait. On success, it reverts to the standard 30s poll.

**Why max retries?** Prevents CPU burn if binary is corrupted/missing. Next heartbeat `Apply()` re-checks `isInstalled()`, re-downloads if needed, and restarts the watcher.

### 4. Session-Aware Stop (Windows)

Current `stopHelper()` uses `taskkill /F /IM "Breeze Assist.exe"` which kills ALL instances across all sessions. For multi-session RDP, this would stop Breeze Assist for all logged-in users.

**Fix:** `stopHelper()` on Windows accepts an optional session filter:
- When called from `Apply()` (disable policy), kill all instances (correct — policy applies to the device)
- Future: if per-session stop is needed, use `taskkill /F /PID <pid>` targeting specific PIDs from `tasklist /FI "SESSION eq N"`

For now, global kill on disable is the correct behavior since the config policy is device-scoped, not user-scoped.

### 5. Naming — Breeze Assist

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

**Upgrade migration path:**
On first `Apply()` after agent upgrade, before `isInstalled()` check:
1. Check if old binary exists at the legacy path (`Breeze Helper.exe` / `Breeze Helper.app` / `breeze-helper`)
2. If found: stop old process, unregister old autostart (remove registry key / unload old plist / delete old .desktop), delete old binary/app bundle
3. `isInstalled()` then returns false for the new path, triggering a fresh download and install at the new location

This is handled by a new `migrateFromLegacyName()` method called at the top of `Apply()`.

## Files to Create/Modify

### New Files
- `agent/internal/helper/watcher.go` — Crash recovery watcher goroutine
- `agent/internal/helper/migrate.go` — Legacy name cleanup (`migrateFromLegacyName()`)

### Modified Files
- `agent/internal/helper/manager.go` — Add `context.Context`, `SpawnFunc` option, `startWatcher`/`stopWatcher`, update `ensureRunning()` to use `spawnFunc` when available, update binary paths and log component
- `agent/internal/helper/install_windows.go` — Update binary name in `defaultBinaryPath()`, `isHelperRunning()` (tasklist image name), `stopHelper()`, `installAutoStart()` registry key name
- `agent/internal/helper/install_darwin.go` — Update app bundle name in `defaultBinaryPath()`, `isHelperRunning()` (launchctl service ID → `com.breeze.assist`), `stopHelper()`, `installAutoStart()` plist ID
- `agent/internal/helper/install_linux.go` — Update binary name in `defaultBinaryPath()`, `isHelperRunning()` (pgrep pattern → `breeze-assist`), `stopHelper()` (pkill pattern), `installAutoStart()` desktop entry
- `agent/internal/sessionbroker/spawner_windows.go` — Add `SpawnProcessInSession(binaryPath string, sessionID uint32) error`
- `agent/internal/heartbeat/heartbeat.go` — Pass `context.Context` and `WithSpawnFunc(...)` when constructing Manager on Windows
- `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx` — Update UI copy to "Breeze Assist"
- `packages/shared/src/types/` (or wherever `FEATURE_META` is defined) — Update `label: 'Helper'` → `label: 'Breeze Assist'`

## Testing Strategy

- **Unit:** Watcher tick logic with mock `isHelperRunning`/`ensureRunning` — verify adaptive interval, backoff progression, max retries, reset on success
- **Unit:** `migrateFromLegacyName()` — verify old binary detection, cleanup, and idempotency
- **Unit (macOS/Linux):** Verify `ensureRunning()` falls back to `exec.Command` when `spawnFunc` is nil (regression test)
- **Integration (Windows):** Verify `SpawnFunc` is called instead of `exec.Command` when provided; verify `SpawnProcessInSession` launches binary in target session
- **Manual:** Deploy to test device, enable policy, confirm tray icon appears; kill process, confirm it restarts within 30s; upgrade from old "Breeze Helper" install, confirm migration cleans up old binary
