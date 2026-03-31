# Session-Aware Breeze Assist Redesign

**Date:** 2026-03-30
**Status:** Draft
**Scope:** Agent-side per-session Assist lifecycle management

## Problem

Breeze Assist (the helper Tauri app) is managed as a machine-global singleton. The helper Manager tracks one `lastEnabled` flag, one config path, one status file, one watcher, and checks liveness by process name. On multi-user hosts (Windows RDP, macOS Fast User Switching), this causes a class of bugs:

- One session blocks launch into another
- Disabling after restart fails to stop existing instances correctly
- Status/idle data races between sessions
- Watcher makes machine-global decisions that are wrong per-session
- `taskkill /IM` and `pkill -f` kill all instances when only one should stop

The session broker already tracks helpers per-session for IPC, desktop ownership, and script execution. The mismatch is in the Manager layer, which treats Assist as one thing per machine.

## Solution

Manage Assist per interactive session, not per machine process. Keep `helper.Manager` as the external API (stable heartbeat interface). Replace its internal global state with a `map[sessionKey]*sessionState`. Each session gets its own config file, status file, liveness watcher, and spawn/stop lifecycle.

### Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API contract | Unchanged — single `HelperSettings` per device | Bugs are agent-side. Per-user API policy is a future feature. |
| Session key (Windows) | `WinSessionID` (string) | Already tracked in broker and WTS. |
| Session key (Unix) | UID (string) | Maps to `launchctl gui/<uid>`, one GUI session per user on macOS, simple on Linux. |
| File layout | Per-session dirs under system path (`sessions/<key>/`) | Agent runs as root/SYSTEM, needs write access. Easy enumeration. |
| Config path delivery | `--config <path>` CLI flag on helper | No dual-write. Old helpers ignore flag, new helpers use it. Fallback to global path. |
| Reconciler vs lifecycle mgr | Separate. Desktop `LifecycleManager` stays as-is. | Different lifecycles: desktop is event-driven/capability-focused, Assist is policy-driven/config-focused. |
| Manager redesign | B-shell, A-guts. Stable outer interface, fully replaced inner model. | Minimal callsite churn, clean internal architecture, incremental rollout. |

## Data Model

### Session key

| Platform | Key | Source |
|----------|-----|--------|
| Windows | `WinSessionID` (e.g. `"1"`, `"2"`) | WTS via broker, SCM events |
| macOS | UID string (e.g. `"501"`) | Broker peer credentials, `/dev/console` ownership |
| Linux | UID string (e.g. `"1000"`) | Broker peer credentials |

### Per-session state

```go
type sessionState struct {
    key            string        // session key
    desiredEnabled bool          // should Assist be running?
    configPath     string        // sessions/<key>/helper_config.yaml
    statusPath     string        // sessions/<key>/helper_status.yaml
    lastConfig     *Config       // last-written config (skip redundant writes)
    pid            int           // last known PID (from status file or spawn)
    watcher        *watcher      // per-session liveness monitor
    lastApplied    time.Time     // when config was last written
}
```

### Process identity verification

A bare PID is not sufficient to confirm Assist is still running — PIDs are reused by the OS. The `isOurProcess(pid)` check must verify the executable path matches the helper binary, not just that a process with that PID exists:

- **macOS:** `sysctl kern.procargs2` or `libproc proc_pidpath()`
- **Linux:** `readlink /proc/<pid>/exe`
- **Windows:** `QueryFullProcessImageName(handle)`

**Future enhancement (deferred):** A `StartedAt` timestamp in the status file could guard against the edge case where a recycled PID happens to also be running a helper binary (e.g., another session's helper). This is extremely unlikely in practice — it requires the OS to recycle a PID to the exact same binary. The executable path check is sufficient protection for now. `StartedAt` can be added in a follow-up if this edge case proves real.

### Manager struct

```go
type Manager struct {
    mu          sync.Mutex
    sessions    map[string]*sessionState  // replaces global state

    // Machine-global (unchanged)
    binaryPath           string
    baseDir              string           // e.g. /Library/Application Support/Breeze/
    serverURL            string
    authToken            *secmem.SecureString
    agentID              string
    pendingHelperVersion string

    // Dependencies
    sessionEnumerator    SessionEnumerator  // injected
    spawnFunc            SpawnFunc           // platform-specific
}

// SpawnFunc launches a helper in the given session with extra CLI args.
// sessionKey is the WinSessionID (Windows) or UID string (Unix).
type SpawnFunc func(sessionKey string, binaryPath string, args ...string) error
```

### Session enumerator

```go
type SessionEnumerator interface {
    // ActiveSessions returns session keys for all interactive sessions
    // that should have Assist running.
    ActiveSessions() []SessionInfo
}

type SessionInfo struct {
    Key      string // WinSessionID or UID
    Username string
    Active   bool   // connected and interactive (not disconnected/locked)
}
```

Platform implementations use OS-level session enumeration, not broker connections. This avoids a chicken-and-egg problem: if Assist isn't running, no broker connection exists, and a broker-based enumerator would never discover the session to launch Assist into.

- **Windows:** WTS enumeration (already exists in `lifecycle.go`). Filter to active/connected sessions, skip Session 0.
- **macOS:** `utmpx` records via `getutxent()` filtered to `USER_PROCESS` entries, or parse `w -h` output. Returns unique UIDs with active GUI sessions. Fallback: `/dev/console` ownership for the console user.
- **Linux:** `loginctl list-sessions --no-legend --no-pager` parsed for active graphical sessions (Type=x11 or Type=wayland). Returns unique UIDs.

### File layout

```
<baseDir>/                                    (platform-specific system path)
├── sessions/
│   ├── 501/                                  (UID on Unix, WinSessionID on Windows)
│   │   ├── helper_config.yaml                (written by agent)
│   │   └── helper_status.yaml                (written by helper)
│   └── 502/
│       ├── helper_config.yaml
│       └── helper_status.yaml
├── helper_config.yaml                        (legacy global — left on disk, not written after migration)
└── helper_status.yaml                        (legacy global — becomes stale after migration)
```

Platform base directories:
- macOS: `/Library/Application Support/Breeze/`
- Windows: `C:\ProgramData\Breeze\`
- Linux: `/etc/breeze/`

### Permission model

| Path | Owner | Perms | Why |
|------|-------|-------|-----|
| `sessions/` | root/SYSTEM | 0755 | Agent creates, all users can traverse |
| `sessions/<key>/` | session user | 0755 | Agent creates and `chown`s to session user. Helper can write status. Agent (root/SYSTEM) can still read and write config via privilege. On Windows, ACL grants session user modify rights. |
| `helper_config.yaml` | root/SYSTEM | 0644 | Agent writes as root/SYSTEM into user-owned dir (privilege override). Helper reads. |
| `helper_status.yaml` | session user | 0644 | Helper writes (dir is user-owned, so create/replace succeeds). Agent reads as root. |

**Why session-user ownership on the dir:** On Unix, file creation requires write permission on the parent directory. A root-owned 0755 directory would prevent the helper (running as session user) from creating or replacing `helper_status.yaml`. Giving the session user ownership of their `sessions/<key>/` directory solves this while keeping the parent `sessions/` directory root-owned.

## Reconcile Flow

`Manager.Apply(settings)` is called once per heartbeat with the device-global `HelperSettings`.

### Apply

```
Apply(settings)
  │
  ├─ 1. Enumerate active sessions (via SessionEnumerator)
  │
  ├─ 2. For each active session key:
  │     ├─ Get or create sessionState in map
  │     ├─ Set desiredEnabled = settings.Enabled
  │     ├─ Write per-session config (if changed)
  │     │     └─ Atomic temp + rename to sessions/<key>/helper_config.yaml
  │     ├─ If enabled:
  │     │     ├─ ensureRunning(sessionState)
  │     │     └─ startWatcher(sessionState) if not already watching
  │     └─ If disabled:
  │           ├─ ensureStopped(sessionState)
  │           └─ stopWatcher(sessionState)
  │
  ├─ 3. Reap stale sessions:
  │     For each key in map NOT in active sessions:
  │     ├─ ensureStopped(sessionState)
  │     ├─ stopWatcher(sessionState)
  │     └─ Remove from map (leave files on disk for debugging)
  │
  └─ 4. Apply pending update (machine-global, gated on ALL sessions idle):
        ├─ Check allSessionsIdle()
        ├─ If all idle: stop all → update binary → restart enabled sessions
        └─ If any active chat: defer update to next heartbeat
```

### ensureRunning (per-session)

```go
func (m *Manager) ensureRunning(state *sessionState) error {
    // Read status file for PID, verify it's actually our helper binary
    if state.pid > 0 && isOurProcess(state.pid, m.binaryPath) {
        return nil
    }
    // Spawn with --config flag
    return m.spawn(state.key, m.binaryPath, "--config", state.configPath)
}
```

### ensureStopped (per-session)

```go
func (m *Manager) ensureStopped(state *sessionState) error {
    // Kill by PID, but only after verifying it's actually our helper binary
    if state.pid > 0 && isOurProcess(state.pid, m.binaryPath) {
        return killProcess(state.pid)
    }
    return nil
}
```

### isOurProcess

```go
// isOurProcess returns true only if pid is a running process whose
// executable path matches binaryPath. Prevents PID-reuse misidentification.
func isOurProcess(pid int, binaryPath string) bool {
    exePath, err := processExePath(pid)  // platform-specific
    if err != nil {
        return false
    }
    return filepath.Clean(exePath) == filepath.Clean(binaryPath)
}
```

Key changes:
- **Stop by verified PID, not by process name.** `taskkill /IM` and `pkill -f` are gone.
- **PID reuse safety.** Every liveness check and kill confirms the executable path matches the helper binary. A recycled PID running an unrelated process is never touched.

### Update gating

```go
func (m *Manager) allSessionsIdle() bool {
    for _, state := range m.sessions {
        status, err := ReadStatus(state.statusPath)
        if err != nil {
            continue // no status = idle
        }
        if status.ChatActive && time.Since(status.LastActivity) < idleTimeout {
            return false
        }
    }
    return true
}
```

Binary update only proceeds when every session is idle. One active chat blocks the update for all sessions.

### Watcher (per-session)

Each `sessionState` gets its own watcher goroutine. Same 30s poll / exponential backoff / 10-retry logic as today, scoped to one session. The deadlock-avoidance pattern (release `mu` before joining) carries over unchanged.

## Platform-Specific Spawn & Stop

### macOS

| Concern | Before | After |
|---------|--------|-------|
| Spawn | `exec.Command` or `launchctl kickstart` | Same, with `--config` flag. Prefer `LaunchProcessViaUserHelper()` IPC if broker has user-role session for UID. |
| Stop | `launchctl bootout gui/<uid>` | `syscall.Kill(pid, SIGTERM)` — by PID, not by unloading the launch agent |
| Running check | `pgrep -f breeze-helper` | `processExists(pid)` |
| Session enumeration | N/A | OS-level: `utmpx` / `w -h` for GUI sessions. Fallback: `/dev/console` ownership. |

### Windows

| Concern | Before | After |
|---------|--------|-------|
| Spawn | `SpawnHelperInSession(winSessionID)` | Same, with `--config` appended to command line |
| Stop | `taskkill /F /IM breeze-helper.exe` | `TerminateProcess(handle, 0)` — by PID |
| Running check | `tasklist /FI IMAGENAME` | `processExists(pid)` |
| Session enumeration | N/A | WTS enumeration (wraps existing logic from `lifecycle.go`) |

### Linux

| Concern | Before | After |
|---------|--------|-------|
| Spawn | `exec.Command` | Same, with `--config` flag and `SysProcAttr{Credential}` for target user |
| Stop | `pkill -f breeze-helper` | `syscall.Kill(pid, SIGTERM)` — by PID |
| Running check | `pgrep -f breeze-helper` | `processExists(pid)` |
| Session enumeration | N/A | OS-level: `loginctl list-sessions` filtered to graphical sessions |

## Helper-Side Changes

### `--config` flag

The Breeze Helper (Tauri app) adds a `--config` CLI flag:

```
breeze-helper --config /Library/Application Support/Breeze/sessions/501/helper_config.yaml
```

- If `--config` is present: use that path for config, derive status path as sibling (`helper_status.yaml` in same directory)
- If `--config` is absent: fall back to legacy global path (existing behavior, unchanged)
- Helper writes its `helper_status.yaml` to the same directory as its config

### Multiple helper instances

- Multiple helper processes can coexist (different users on macOS, different Windows sessions)
- Each reads its own config, writes its own status
- No shared state between instances — fully independent
- Tray icon / system tray is per-user-session by OS design — no UI conflicts

## Migration & Backward Compatibility

### Rollout sequence

1. **Helper ships first** with `--config` flag support. Without the flag, reads global path — fully backward compatible.
2. **Agent ships second** with per-session Manager internals. On first heartbeat: creates `sessions/` dirs, writes per-session configs, spawns with `--config`, stops any globally-spawned helper.
3. **Legacy global config** left on disk, no longer written by agent after migration.

### First-run migration

On the first `Apply()` after upgrade, the Manager detects the transition:

```go
func (m *Manager) needsMigration() bool {
    _, err := os.Stat(filepath.Join(m.baseDir, "sessions"))
    return os.IsNotExist(err)
}
```

Migration steps:
1. Create `sessions/` directory (0755, owned by root/SYSTEM)
2. For each active session: create `sessions/<key>/` subdirectory, `chown` to session user
3. Copy current global config into each per-session directory
4. Remove autostart artifacts (LaunchAgent plist / Registry Run key / XDG desktop entry)
5. Stop the globally-spawned helper
6. Spawn per-session helpers with `--config` flag
7. Normal reconcile loop takes over

### Rollback

If the agent is rolled back, the old version finds the global config file still on disk (never deleted) and works as before. No rollback-specific logic needed.

### Autostart artifact migration

Leaving legacy autostart entries unchanged would spawn an unmanaged helper on every login that reads the stale global config (via the `--config`-absent fallback path). The agent would then spawn a second per-session instance with `--config`. This creates duplicate Assist processes and reintroduces global-status races.

**Fix:** Migration must remove or replace autostart artifacts:

| Platform | Artifact | Migration action |
|----------|----------|-----------------|
| macOS | `/Library/LaunchAgents/com.breeze.helper.plist` | **Remove the plist.** Agent reconciler is now responsible for spawning Assist in active sessions. The plist's `RunAtLoad` is no longer needed — the agent runs at boot (launchd service) and the reconciler handles user sessions as they appear. |
| Windows | `HKLM\..\Run\BreezeHelper` | **Remove the registry key.** Same reasoning — the agent reconciler and the existing `HelperLifecycleManager` (for desktop helpers) handle spawning. |
| Linux | `/etc/xdg/autostart/breeze-helper.desktop` | **Remove the desktop entry.** Agent reconciler handles spawning. |

The agent removes these artifacts during the first-run migration (step added to migration sequence). After migration, all Assist spawning goes through the reconciler with `--config`.

**Rollback safety:** If the agent is rolled back to a pre-migration version, `installAutoStart()` in the old code recreates the plist/registry/desktop entry on the next `Apply()`. No manual intervention needed.

### Artifact lifecycle (post-migration)

| Artifact | Action |
|----------|--------|
| Global `helper_config.yaml` | Left on disk, not deleted. Agent stops writing it. Old-version rollback can still read it. |
| Global `helper_status.yaml` | Left on disk. Becomes stale. Agent ignores it once migrated. |
| `sessions/` tree | Persistent. Old session dirs left on disk (harmless). |
| LaunchAgent plist (macOS) | **Removed** during migration. Recreated by rollback if needed. |
| Registry Run key (Windows) | **Removed** during migration. Recreated by rollback if needed. |
| XDG autostart (Linux) | **Removed** during migration. Recreated by rollback if needed. |

## Testing

### Unit tests

**Manager internals (`helper/manager_test.go`):**
- Mock `SessionEnumerator` with controlled session lists
- Mock `helperRunningFunc` / `helperStopFunc` (existing pattern)
- Reconcile scenarios:
  - 0 → 1 session: config written, helper spawned
  - 2 → 1 session: stale session stopped, state removed
  - Enabled → disabled: all sessions stopped
  - Disabled → enabled: all sessions started
  - Session reappears after removal: fresh state
- Config write skip when content unchanged
- Per-session watcher lifecycle
- `allSessionsIdle()` aggregation
- Migration detection and first-run path

**Session state (`helper/session_state_test.go`):**
- Config/status path derivation
- PID tracking with mock `processExists`

**Platform spawn/stop (build-tagged):**
- `--config` flag passed to spawn commands
- Kill-by-PID instead of kill-by-name

### Integration tests

- Spawn two helpers with different `--config` paths to temp dirs
- Verify independent `helper_status.yaml` writes
- Kill one — verify only that one restarts
- Migration: global config exists, no `sessions/` dir → `Apply()` creates per-session layout

### Manual QA (not CI-automatable)

- Multi-user Windows RDP: two sessions, independent Assist instances
- macOS Fast User Switching: verify session suspension/resume
- Rollback: downgrade agent, verify global config still works

## Scope & Non-Goals

### In scope

1. Per-session `sessionState` map inside Manager
2. Per-session config/status file layout under `sessions/<key>/`
3. `SessionEnumerator` interface with platform implementations
4. Reconcile loop: start missing, stop stale, reap disappeared
5. Per-session watcher (liveness monitor)
6. Per-session spawn (`--config` flag) and stop (by PID)
7. `allSessionsIdle()` gating for binary updates
8. Helper `--config` CLI flag with global-path fallback
9. First-run migration from global to per-session layout
10. Removal of global runtime state (`lastEnabled`, single `configPath`, single `watcher`, `isHelperRunning()` by process name)

### Not in scope

- Per-session API settings (API returns one `HelperSettings` per device)
- Per-user Assist policy (enable for user A, disable for user B)
- Desktop `LifecycleManager` changes (stays as-is)
- Helper UI changes (no new screens or session awareness in Tauri app)
- Session directory cleanup (old dirs left on disk)
- LaunchAgent plist rewrite (stays, provides login fallback)

## Files Changed

| File | Change |
|------|--------|
| `agent/internal/helper/manager.go` | Replace global state with `sessions` map, reconcile logic, `SessionEnumerator` dependency |
| `agent/internal/helper/session_state.go` | **New** — `sessionState` struct, per-session config/status/watcher methods |
| `agent/internal/helper/watcher.go` | Minor — instantiated per session instead of once |
| `agent/internal/helper/status.go` | Unchanged — `ReadStatus`/`IsIdle` already take a path parameter |
| `agent/internal/helper/process.go` | **New** — `isOurProcess()`, `processExePath()` with platform implementations |
| `agent/internal/helper/install_darwin.go` | PID-based stop, `--config` flag on spawn |
| `agent/internal/helper/install_windows.go` | PID-based stop, `--config` flag on spawn args |
| `agent/internal/helper/install_linux.go` | PID-based stop, `--config` flag on spawn |
| `agent/internal/helper/enumerator_windows.go` | **New** — WTS-based `SessionEnumerator` |
| `agent/internal/helper/enumerator_darwin.go` | **New** — `utmpx`/console-based `SessionEnumerator` |
| `agent/internal/helper/enumerator_linux.go` | **New** — `loginctl`-based `SessionEnumerator` |
| `agent/internal/helper/migrate.go` | **New** — first-run migration logic |
| `agent/internal/heartbeat/heartbeat.go` | Minimal — pass `SessionEnumerator` to Manager constructor |
| Breeze Helper (Tauri) | Add `--config` CLI flag, derive status path from config path |
