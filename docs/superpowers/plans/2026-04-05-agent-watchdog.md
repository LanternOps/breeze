# Agent Watchdog Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight `breeze-watchdog` service that independently monitors the primary `breeze-agent`, recovers it from crashes/hangs, and provides a failover API connection when the agent is down.

**Architecture:** Separate Go binary sharing the agent's IPC protocol, config loader, and updater packages. Connects to the agent's IPC socket as a `"watchdog"` role client. Runs layered health checks (process → IPC ping → heartbeat staleness) with escalating recovery. Falls back to direct HTTP API polling when recovery fails.

**Tech Stack:** Go, existing IPC protocol (HMAC-SHA256 envelopes), Cobra CLI, platform service managers (launchd/systemd/SCM), Hono API routes, Drizzle ORM, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-04-05-agent-watchdog-design.md`

---

## File Structure

### New files (watchdog binary)

| File | Responsibility |
|------|---------------|
| `agent/cmd/breeze-watchdog/main.go` | CLI entry point: `run`, `status`, `health-journal`, `trigger-failover`, `trigger-recovery`, `service` subcommands |
| `agent/cmd/breeze-watchdog/service_cmd_darwin.go` | macOS launchd plist template, install/uninstall/start/stop |
| `agent/cmd/breeze-watchdog/service_cmd_linux.go` | Linux systemd unit template, install/uninstall/start/stop |
| `agent/cmd/breeze-watchdog/service_cmd_windows.go` | Windows SCM service registration |
| `agent/cmd/breeze-watchdog/service_unix.go` | Shared Unix service detection (isService, hasConsole) |
| `agent/cmd/breeze-watchdog/service_windows.go` | Windows SCM handler (svc.Handler) |
| `agent/internal/watchdog/watchdog.go` | State machine: CONNECTING → MONITORING → RECOVERING → STANDBY → FAILOVER |
| `agent/internal/watchdog/watchdog_test.go` | State machine transition tests |
| `agent/internal/watchdog/checks.go` | Tier 1 (process), Tier 2 (IPC ping), Tier 3 (heartbeat staleness) |
| `agent/internal/watchdog/checks_test.go` | Health check tests with mocked interfaces |
| `agent/internal/watchdog/recovery.go` | Service manager restart, force kill, cooldown tracking |
| `agent/internal/watchdog/recovery_darwin.go` | macOS: launchctl kickstart/bootout |
| `agent/internal/watchdog/recovery_linux.go` | Linux: systemctl restart |
| `agent/internal/watchdog/recovery_windows.go` | Windows: SCM stop/start |
| `agent/internal/watchdog/failover.go` | HTTP API client: heartbeat, command poll, log shipping |
| `agent/internal/watchdog/failover_test.go` | Failover client tests with httptest |
| `agent/internal/watchdog/journal.go` | Rolling health journal (file-based, capped size) |
| `agent/internal/watchdog/journal_test.go` | Journal rotation tests |
| `agent/internal/watchdog/ipcclient.go` | IPC connection to agent as watchdog role |

### New files (shared/state)

| File | Responsibility |
|------|---------------|
| `agent/internal/state/state.go` | State file (`agent.state`) types, read/write with atomic operations |
| `agent/internal/state/state_test.go` | State file serialization tests |

### New files (API)

| File | Responsibility |
|------|---------------|
| `apps/api/migrations/NNNN-watchdog-columns.sql` | Add watchdog_status, watchdog_last_seen, watchdog_version to devices; add target_role to device_commands |
| `apps/api/src/routes/agents/watchdogLogs.ts` | `GET /devices/:id/watchdog-logs` endpoint |

### Modified files

| File | Change |
|------|--------|
| `agent/internal/ipc/message.go` | Add watchdog message type constants and payload structs |
| `agent/internal/config/config.go` | Add `Watchdog` config section |
| `agent/internal/sessionbroker/broker.go` | Accept `HelperRole: "watchdog"`, define watchdog scopes, handle watchdog messages |
| `agent/internal/heartbeat/heartbeat.go` | Write state file on heartbeat success, send shutdown_intent before stop |
| `agent/cmd/breeze-agent/main.go` | Write state file on startup, update on shutdown |
| `agent/Makefile` | Add watchdog build targets, dev-push-watchdog, dev-push-both |
| `apps/api/src/db/schema/devices.ts` | Add watchdog columns to devices table, target_role to device_commands |
| `apps/api/src/db/schema/enums.ts` | Add watchdog_status enum |
| `apps/api/src/routes/agents/heartbeat.ts` | Handle watchdog heartbeats, return watchdogUpgradeTo |
| `apps/api/src/routes/agents/commands.ts` | Filter by target_role on command poll |
| `scripts/install/install-darwin.sh` | Copy watchdog binary, install watchdog plist |
| `scripts/install/install-linux.sh` | Copy watchdog binary, install watchdog systemd unit |

---

## Task 1: IPC Message Types for Watchdog

**Files:**
- Modify: `agent/internal/ipc/message.go`

- [ ] **Step 1: Add watchdog message type constants**

Add after the existing `TypeTCCStatus` constant block in `agent/internal/ipc/message.go`:

```go
// Watchdog
TypeWatchdogPing          = "watchdog_ping"
TypeWatchdogPong          = "watchdog_pong"
TypeShutdownIntent        = "shutdown_intent"
TypeTokenUpdate           = "token_update"
TypeWatchdogCommand       = "watchdog_command"
TypeWatchdogCommandResult = "watchdog_command_result"
TypeStateSync             = "state_sync"

// Tamper protection (v2 — defined, not implemented)
TypeIntegrityCheck  = "integrity_check"
TypeIntegrityResult = "integrity_result"
TypeTamperAlert     = "tamper_alert"
```

- [ ] **Step 2: Add watchdog helper role constant**

Add to the helper role constants block:

```go
HelperRoleWatchdog = "watchdog"
```

- [ ] **Step 3: Add watchdog payload structs**

Add after the existing payload structs:

```go
// WatchdogPing is sent by the watchdog to probe agent health.
type WatchdogPing struct {
	RequestHealthSummary bool `json:"requestHealthSummary"`
}

// WatchdogPong is the agent's response to a watchdog ping.
type WatchdogPong struct {
	Healthy       bool           `json:"healthy"`
	HealthSummary map[string]any `json:"healthSummary,omitempty"`
	Uptime        int64          `json:"uptimeSeconds"`
}

// ShutdownIntent signals the watchdog that the agent is stopping intentionally.
type ShutdownIntent struct {
	Reason           string `json:"reason"` // "user_stop", "update", "config_reload"
	ExpectedDuration int    `json:"expectedDurationSeconds,omitempty"`
}

// TokenUpdate relays a rotated auth token to the watchdog.
type TokenUpdate struct {
	Token string `json:"token"`
}

// WatchdogCommand relays an API-originated command to the watchdog.
type WatchdogCommand struct {
	CommandID string         `json:"commandId"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload,omitempty"`
}

// WatchdogCommandResult is the watchdog's response to a relayed command.
type WatchdogCommandResult struct {
	CommandID string `json:"commandId"`
	Status    string `json:"status"` // "completed", "failed"
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

// StateSync is periodically sent by the agent to keep the watchdog informed.
type StateSync struct {
	AgentVersion string `json:"agentVersion"`
	ConfigHash   string `json:"configHash"`
	Connected    bool   `json:"connected"`    // WS connected to API
	LastHeartbeat string `json:"lastHeartbeat"` // RFC3339
}

// IntegrityCheck is a request from watchdog to verify binary/config hashes (v2).
type IntegrityCheck struct {
	Targets []string `json:"targets"` // "binary", "config", "secrets"
}

// IntegrityResult is the agent's response to an integrity check (v2).
type IntegrityResult struct {
	Results map[string]string `json:"results"` // target → sha256 hash
}
```

- [ ] **Step 4: Verify build**

Run: `cd agent && go build ./internal/ipc/...`
Expected: clean build, no errors

- [ ] **Step 5: Commit**

```bash
git add agent/internal/ipc/message.go
git commit -m "feat(ipc): add watchdog message types and payload structs"
```

---

## Task 2: State File Package

**Files:**
- Create: `agent/internal/state/state.go`
- Create: `agent/internal/state/state_test.go`

- [ ] **Step 1: Write failing test for state file serialization**

Create `agent/internal/state/state_test.go`:

```go
package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.state")

	now := time.Now().Truncate(time.Second)
	s := &AgentState{
		Status:        StatusRunning,
		PID:           12345,
		Version:       "0.12.1",
		LastHeartbeat: now,
		Timestamp:     now,
	}

	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if got.Status != StatusRunning {
		t.Errorf("Status = %q, want %q", got.Status, StatusRunning)
	}
	if got.PID != 12345 {
		t.Errorf("PID = %d, want 12345", got.PID)
	}
	if got.Version != "0.12.1" {
		t.Errorf("Version = %q, want %q", got.Version, "0.12.1")
	}
}

func TestWriteStopping(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.state")

	s := &AgentState{
		Status:    StatusStopping,
		Reason:    ReasonUpdate,
		PID:       12345,
		Version:   "0.12.1",
		Timestamp: time.Now(),
	}

	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}

	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if got.Status != StatusStopping {
		t.Errorf("Status = %q, want %q", got.Status, StatusStopping)
	}
	if got.Reason != ReasonUpdate {
		t.Errorf("Reason = %q, want %q", got.Reason, ReasonUpdate)
	}
}

func TestReadMissing(t *testing.T) {
	got, err := Read("/nonexistent/agent.state")
	if err != nil {
		t.Fatalf("Read: unexpected error %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for missing file, got %+v", got)
	}
}

func TestReadCorrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.state")
	os.WriteFile(path, []byte("not json"), 0644)

	_, err := Read(path)
	if err == nil {
		t.Fatal("expected error for corrupt file")
	}
}

func TestUpdateHeartbeat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.state")

	s := &AgentState{
		Status:    StatusRunning,
		PID:       1,
		Version:   "0.1.0",
		Timestamp: time.Now(),
	}
	Write(path, s)

	now := time.Now().Truncate(time.Second)
	if err := UpdateHeartbeat(path, now); err != nil {
		t.Fatalf("UpdateHeartbeat: %v", err)
	}

	got, _ := Read(path)
	if got.LastHeartbeat.Truncate(time.Second) != now {
		t.Errorf("LastHeartbeat = %v, want %v", got.LastHeartbeat, now)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/state/... -v`
Expected: compilation error — package doesn't exist yet

- [ ] **Step 3: Implement state package**

Create `agent/internal/state/state.go`:

```go
package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const FileName = "agent.state"

// Status values
const (
	StatusRunning  = "running"
	StatusStopping = "stopping"
	StatusStopped  = "stopped"
)

// Reason values for StatusStopping
const (
	ReasonUserStop     = "user_stop"
	ReasonUpdate       = "update"
	ReasonConfigReload = "config_reload"
)

// AgentState is the on-disk state file shared between agent and watchdog.
type AgentState struct {
	Status        string    `json:"status"`
	Reason        string    `json:"reason,omitempty"`
	PID           int       `json:"pid"`
	Version       string    `json:"version"`
	LastHeartbeat time.Time `json:"last_heartbeat,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
}

// Write atomically writes the state file as JSON.
func Write(path string, s *AgentState) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write temp state: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename state file: %w", err)
	}

	return nil
}

// Read reads the state file. Returns nil, nil if the file doesn't exist.
func Read(path string) (*AgentState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}

	var s AgentState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("unmarshal state: %w", err)
	}

	return &s, nil
}

// UpdateHeartbeat updates only the last_heartbeat field in the state file.
func UpdateHeartbeat(path string, t time.Time) error {
	s, err := Read(path)
	if err != nil {
		return err
	}
	if s == nil {
		return fmt.Errorf("state file not found")
	}
	s.LastHeartbeat = t
	s.Timestamp = time.Now()
	return Write(path, s)
}

// PathInDir returns the full path to agent.state in the given config directory.
func PathInDir(configDir string) string {
	return filepath.Join(configDir, FileName)
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/state/... -v`
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add agent/internal/state/
git commit -m "feat(state): add agent state file package for watchdog coordination"
```

---

## Task 3: Watchdog Config Section

**Files:**
- Modify: `agent/internal/config/config.go`

- [ ] **Step 1: Add WatchdogConfig struct and defaults**

Add the struct definition near the top of `config.go`, after the main Config struct:

```go
// WatchdogConfig holds settings for the breeze-watchdog service.
type WatchdogConfig struct {
	Enabled                 bool          `mapstructure:"enabled" yaml:"enabled"`
	ProcessCheckInterval    time.Duration `mapstructure:"process_check_interval" yaml:"process_check_interval"`
	IPCProbeInterval        time.Duration `mapstructure:"ipc_probe_interval" yaml:"ipc_probe_interval"`
	HeartbeatStaleThreshold time.Duration `mapstructure:"heartbeat_stale_threshold" yaml:"heartbeat_stale_threshold"`
	MaxRecoveryAttempts     int           `mapstructure:"max_recovery_attempts" yaml:"max_recovery_attempts"`
	RecoveryCooldown        time.Duration `mapstructure:"recovery_cooldown" yaml:"recovery_cooldown"`
	StandbyTimeout          time.Duration `mapstructure:"standby_timeout" yaml:"standby_timeout"`
	FailoverPollInterval    time.Duration `mapstructure:"failover_poll_interval" yaml:"failover_poll_interval"`
	HealthJournalMaxSizeMB  int           `mapstructure:"health_journal_max_size_mb" yaml:"health_journal_max_size_mb"`
	HealthJournalMaxFiles   int           `mapstructure:"health_journal_max_files" yaml:"health_journal_max_files"`
}
```

- [ ] **Step 2: Add Watchdog field to Config struct**

Add to the Config struct:

```go
Watchdog WatchdogConfig `mapstructure:"watchdog" yaml:"watchdog"`
```

- [ ] **Step 3: Add defaults in Default() function**

Add in the `Default()` function:

```go
Watchdog: WatchdogConfig{
	Enabled:                 true,
	ProcessCheckInterval:    5 * time.Second,
	IPCProbeInterval:        30 * time.Second,
	HeartbeatStaleThreshold: 3 * time.Minute,
	MaxRecoveryAttempts:     3,
	RecoveryCooldown:        10 * time.Minute,
	StandbyTimeout:          30 * time.Minute,
	FailoverPollInterval:    30 * time.Second,
	HealthJournalMaxSizeMB:  10,
	HealthJournalMaxFiles:   3,
},
```

- [ ] **Step 4: Verify build**

Run: `cd agent && go build ./internal/config/...`
Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go
git commit -m "feat(config): add watchdog configuration section with defaults"
```

---

## Task 4: Agent State File Integration

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`

- [ ] **Step 1: Write state file on agent startup**

In `agent/cmd/breeze-agent/main.go`, in the `runAgent()` function (or equivalent startup path), after config is loaded and before the heartbeat loop starts, add:

```go
import "github.com/breeze-rmm/agent/internal/state"

// Write initial state file
statePath := state.PathInDir(config.ConfigDir())
agentState := &state.AgentState{
	Status:    state.StatusRunning,
	PID:       os.Getpid(),
	Version:   version,
	Timestamp: time.Now(),
}
if err := state.Write(statePath, agentState); err != nil {
	slog.Warn("failed to write state file", "error", err.Error())
}
```

- [ ] **Step 2: Write state file on graceful shutdown**

In the `shutdownAgent()` function (or equivalent), before `StopAcceptingCommands()`:

```go
// Signal watchdog: intentional shutdown
statePath := state.PathInDir(config.ConfigDir())
agentState := &state.AgentState{
	Status:    state.StatusStopping,
	Reason:    state.ReasonUserStop,
	PID:       os.Getpid(),
	Version:   version,
	Timestamp: time.Now(),
}
if err := state.Write(statePath, agentState); err != nil {
	slog.Warn("failed to write shutdown state", "error", err.Error())
}
```

- [ ] **Step 3: Update state file after each successful heartbeat**

In `agent/internal/heartbeat/heartbeat.go`, after the successful heartbeat POST response is processed, add:

```go
import "github.com/breeze-rmm/agent/internal/state"

// Update state file with heartbeat timestamp
if err := state.UpdateHeartbeat(state.PathInDir(config.ConfigDir()), time.Now()); err != nil {
	slog.Warn("failed to update heartbeat state", "error", err.Error())
}
```

Note: The exact location depends on where `config.ConfigDir()` is accessible. Pass the state file path into the Heartbeat struct if needed.

- [ ] **Step 4: Verify build**

Run: `cd agent && go build ./cmd/breeze-agent/...`
Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/main.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): write state file on startup, shutdown, and heartbeat"
```

---

## Task 5: Agent Broker — Watchdog Role Support

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go`

- [ ] **Step 1: Add watchdog scopes**

Add near the existing `systemHelperScopes` and `userHelperScopes` vars:

```go
var watchdogHelperScopes = []string{"watchdog"}
```

- [ ] **Step 2: Handle watchdog role in authentication**

In the `handleConnection` function, in the role validation section (around lines 737-770 where HelperRoleSystem and HelperRoleUser are handled), add a case for the watchdog:

```go
case ipc.HelperRoleWatchdog:
	// Watchdog must run as root/SYSTEM
	if runtime.GOOS == "windows" {
		if authReq.SID != "S-1-5-18" {
			// Reject non-SYSTEM watchdog on Windows
			sendAuthReject(conn, authReq, "watchdog must run as SYSTEM")
			return
		}
	} else {
		if peerUID != 0 {
			sendAuthReject(conn, authReq, "watchdog must run as root")
			return
		}
	}
	allowedScopes = watchdogHelperScopes
```

- [ ] **Step 3: Handle watchdog messages in dispatch**

In the RecvLoop message dispatch (around line 851), add handling for watchdog-specific messages:

```go
case ipc.TypeWatchdogPing:
	// Respond with health summary
	var ping ipc.WatchdogPing
	if err := json.Unmarshal(env.Payload, &ping); err != nil {
		slog.Warn("bad watchdog_ping payload", "error", err.Error())
		break
	}
	pong := ipc.WatchdogPong{
		Healthy: true,
		Uptime:  int64(time.Since(startTime).Seconds()),
	}
	if ping.RequestHealthSummary && healthMonitor != nil {
		pong.HealthSummary = healthMonitor.Summary()
	}
	sess.SendNotify(env.ID, ipc.TypeWatchdogPong, pong)

case ipc.TypeWatchdogCommandResult:
	// Forward to onMessage handler
	if session.HasScope("watchdog") {
		b.onMessage(session, env)
	}
```

Note: `startTime` and `healthMonitor` need to be accessible — pass them to the Broker constructor or via a callback. The exact wiring depends on where they live; follow the existing pattern used for `onMessage`.

- [ ] **Step 4: Add shouldForwardUnsolicitedHelperMessage for watchdog**

In `shouldForwardUnsolicitedHelperMessage`, add:

```go
case ipc.TypeWatchdogCommandResult:
	return session.HasScope("watchdog")
```

- [ ] **Step 5: Verify build**

Run: `cd agent && go build ./internal/sessionbroker/...`
Expected: clean build

- [ ] **Step 6: Commit**

```bash
git add agent/internal/sessionbroker/broker.go
git commit -m "feat(broker): accept watchdog IPC role with health ping/pong support"
```

---

## Task 6: Agent Shutdown Intent via IPC

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (or the shutdown path in `main.go`)

- [ ] **Step 1: Send shutdown_intent to watchdog before stopping**

In the shutdown path, before stopping the heartbeat loop, send the IPC message to any connected watchdog session. This requires access to the session broker:

```go
// Notify watchdog of intentional shutdown
if broker != nil {
	if sess := broker.PreferredSessionWithScope("watchdog"); sess != nil {
		intent := ipc.ShutdownIntent{
			Reason: reason, // "user_stop", "update", "config_reload"
		}
		if reason == state.ReasonUpdate {
			intent.ExpectedDuration = 1800 // 30 minutes
		} else if reason == state.ReasonConfigReload {
			intent.ExpectedDuration = 300 // 5 minutes
		}
		if err := sess.SendNotify("", ipc.TypeShutdownIntent, intent); err != nil {
			slog.Warn("failed to send shutdown_intent to watchdog", "error", err.Error())
		}
	}
}
```

- [ ] **Step 2: Add state_sync periodic send**

In the heartbeat loop (where periodic work is done), add a state sync to the watchdog every 60 seconds:

```go
// Sync state to watchdog
if broker != nil {
	if sess := broker.PreferredSessionWithScope("watchdog"); sess != nil {
		sync := ipc.StateSync{
			AgentVersion:  version,
			ConfigHash:    configHash, // compute from agent.yaml SHA-256
			Connected:     wsClient.IsConnected(),
			LastHeartbeat: lastHeartbeatTime.Format(time.RFC3339),
		}
		sess.SendNotify("", ipc.TypeStateSync, sync)
	}
}
```

- [ ] **Step 3: Relay token rotation to watchdog**

In the heartbeat response handler where `RotateToken` is processed, after saving the new token:

```go
// Relay new token to watchdog
if broker != nil {
	if sess := broker.PreferredSessionWithScope("watchdog"); sess != nil {
		sess.SendNotify("", ipc.TypeTokenUpdate, ipc.TokenUpdate{Token: newToken})
	}
}
```

- [ ] **Step 4: Verify build**

Run: `cd agent && go build ./cmd/breeze-agent/...`
Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/cmd/breeze-agent/main.go
git commit -m "feat(agent): send shutdown_intent, state_sync, and token_update to watchdog"
```

---

## Task 7: Watchdog Health Journal

**Files:**
- Create: `agent/internal/watchdog/journal.go`
- Create: `agent/internal/watchdog/journal_test.go`

- [ ] **Step 1: Write failing test**

Create `agent/internal/watchdog/journal_test.go`:

```go
package watchdog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJournalWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir, 1, 2) // 1MB max, 2 files
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer j.Close()

	j.Log(LevelInfo, "agent_healthy", map[string]any{"pid": 1234})
	j.Log(LevelWarn, "ipc_timeout", map[string]any{"consecutive": 2})

	entries := j.Recent(10)
	if len(entries) != 2 {
		t.Fatalf("Recent(10) = %d entries, want 2", len(entries))
	}
	if entries[0].Event != "agent_healthy" {
		t.Errorf("entries[0].Event = %q, want %q", entries[0].Event, "agent_healthy")
	}
	if entries[1].Level != LevelWarn {
		t.Errorf("entries[1].Level = %q, want %q", entries[1].Level, LevelWarn)
	}
}

func TestJournalRecentLimit(t *testing.T) {
	dir := t.TempDir()
	j, _ := NewJournal(dir, 1, 2)
	defer j.Close()

	for i := 0; i < 20; i++ {
		j.Log(LevelInfo, "tick", map[string]any{"i": i})
	}

	entries := j.Recent(5)
	if len(entries) != 5 {
		t.Fatalf("Recent(5) = %d entries, want 5", len(entries))
	}
	// Should be the last 5
	if entries[4].Data["i"] != float64(19) {
		t.Errorf("last entry i = %v, want 19", entries[4].Data["i"])
	}
}

func TestJournalRotation(t *testing.T) {
	dir := t.TempDir()
	// Tiny max size to force rotation
	j, _ := NewJournal(dir, 0, 3) // 0 = use minSize (4KB for testing)
	defer j.Close()

	// Write enough to trigger rotation
	longMsg := strings.Repeat("x", 500)
	for i := 0; i < 20; i++ {
		j.Log(LevelInfo, longMsg, nil)
	}

	// Should have created rotated files
	files, _ := filepath.Glob(filepath.Join(dir, "watchdog-journal*"))
	if len(files) < 2 {
		t.Errorf("expected at least 2 journal files, got %d", len(files))
	}
	if len(files) > 3 {
		t.Errorf("expected at most 3 journal files, got %d", len(files))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestJournal`
Expected: compilation error

- [ ] **Step 3: Implement journal**

Create `agent/internal/watchdog/journal.go`:

```go
package watchdog

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"

	journalFileName = "watchdog-journal.log"
	minRotateSize   = 4096 // minimum rotation size for testing
)

// JournalEntry is a single health journal record.
type JournalEntry struct {
	Time  time.Time      `json:"time"`
	Level string         `json:"level"`
	Event string         `json:"event"`
	Data  map[string]any `json:"data,omitempty"`
}

// Journal is a rolling, append-only health log.
type Journal struct {
	mu       sync.Mutex
	dir      string
	maxBytes int64
	maxFiles int
	file     *os.File
	written  int64
	recent   []JournalEntry
}

// NewJournal creates or opens a health journal in the given directory.
func NewJournal(dir string, maxSizeMB int, maxFiles int) (*Journal, error) {
	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if maxBytes < minRotateSize {
		maxBytes = minRotateSize
	}

	path := filepath.Join(dir, journalFileName)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("open journal: %w", err)
	}

	info, _ := f.Stat()
	written := int64(0)
	if info != nil {
		written = info.Size()
	}

	j := &Journal{
		dir:      dir,
		maxBytes: maxBytes,
		maxFiles: maxFiles,
		file:     f,
		written:  written,
	}

	return j, nil
}

// Log writes an entry to the journal.
func (j *Journal) Log(level, event string, data map[string]any) {
	entry := JournalEntry{
		Time:  time.Now(),
		Level: level,
		Event: event,
		Data:  data,
	}

	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')

	j.mu.Lock()
	defer j.mu.Unlock()

	// Keep recent entries in memory
	j.recent = append(j.recent, entry)
	if len(j.recent) > 1000 {
		j.recent = j.recent[len(j.recent)-1000:]
	}

	n, _ := j.file.Write(line)
	j.written += int64(n)

	if j.written >= j.maxBytes {
		j.rotate()
	}
}

// Recent returns the last n journal entries from memory.
func (j *Journal) Recent(n int) []JournalEntry {
	j.mu.Lock()
	defer j.mu.Unlock()

	if n >= len(j.recent) {
		result := make([]JournalEntry, len(j.recent))
		copy(result, j.recent)
		return result
	}

	start := len(j.recent) - n
	result := make([]JournalEntry, n)
	copy(result, j.recent[start:])
	return result
}

// ReadFromDisk reads all entries from journal files on disk (for diagnostic export).
func (j *Journal) ReadFromDisk() ([]JournalEntry, error) {
	j.mu.Lock()
	defer j.mu.Unlock()

	files, err := filepath.Glob(filepath.Join(j.dir, "watchdog-journal*"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)

	var entries []JournalEntry
	for _, f := range files {
		file, err := os.Open(f)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var entry JournalEntry
			if err := json.Unmarshal([]byte(line), &entry); err != nil {
				continue
			}
			entries = append(entries, entry)
		}
		file.Close()
	}

	return entries, nil
}

func (j *Journal) rotate() {
	j.file.Close()

	currentPath := filepath.Join(j.dir, journalFileName)
	rotatedPath := filepath.Join(j.dir, fmt.Sprintf("watchdog-journal.%d.log", time.Now().UnixMilli()))
	os.Rename(currentPath, rotatedPath)

	// Clean up old files
	files, _ := filepath.Glob(filepath.Join(j.dir, "watchdog-journal.*"))
	sort.Strings(files)
	for len(files) >= j.maxFiles {
		os.Remove(files[0])
		files = files[1:]
	}

	// Open new file
	j.file, _ = os.OpenFile(currentPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	j.written = 0
}

// Close closes the journal file.
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.file != nil {
		return j.file.Close()
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestJournal`
Expected: all 3 journal tests pass

- [ ] **Step 5: Commit**

```bash
git add agent/internal/watchdog/journal.go agent/internal/watchdog/journal_test.go
git commit -m "feat(watchdog): add rolling health journal with rotation"
```

---

## Task 8: Watchdog State Machine

**Files:**
- Create: `agent/internal/watchdog/watchdog.go`
- Create: `agent/internal/watchdog/watchdog_test.go`

- [ ] **Step 1: Write failing tests for state transitions**

Create `agent/internal/watchdog/watchdog_test.go`:

```go
package watchdog

import (
	"testing"
	"time"
)

func TestInitialState(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	if w.State() != StateConnecting {
		t.Errorf("initial state = %q, want %q", w.State(), StateConnecting)
	}
}

func TestConnectingToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	if w.State() != StateMonitoring {
		t.Errorf("state = %q, want %q", w.State(), StateMonitoring)
	}
}

func TestMonitoringToRecovering(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventAgentUnhealthy)
	if w.State() != StateRecovering {
		t.Errorf("state = %q, want %q", w.State(), StateRecovering)
	}
}

func TestMonitoringToStandby(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventShutdownIntent)
	if w.State() != StateStandby {
		t.Errorf("state = %q, want %q", w.State(), StateStandby)
	}
}

func TestRecoveringToFailover(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventAgentUnhealthy)
	w.HandleEvent(EventRecoveryExhausted)
	if w.State() != StateFailover {
		t.Errorf("state = %q, want %q", w.State(), StateFailover)
	}
}

func TestRecoveringToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventAgentUnhealthy)
	w.HandleEvent(EventAgentRecovered)
	if w.State() != StateMonitoring {
		t.Errorf("state = %q, want %q", w.State(), StateMonitoring)
	}
}

func TestFailoverToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventAgentUnhealthy)
	w.HandleEvent(EventRecoveryExhausted)
	w.HandleEvent(EventAgentRecovered)
	if w.State() != StateMonitoring {
		t.Errorf("state = %q, want %q", w.State(), StateMonitoring)
	}
}

func TestStandbyToFailover(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventShutdownIntent)
	w.HandleEvent(EventStandbyTimeout)
	if w.State() != StateFailover {
		t.Errorf("state = %q, want %q", w.State(), StateFailover)
	}
}

func TestStandbyToMonitoring(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventShutdownIntent)
	w.HandleEvent(EventAgentRecovered)
	if w.State() != StateMonitoring {
		t.Errorf("state = %q, want %q", w.State(), StateMonitoring)
	}
}

func TestConnectingToRecovering(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventAgentNotFound)
	if w.State() != StateRecovering {
		t.Errorf("state = %q, want %q", w.State(), StateRecovering)
	}
}

func TestInvalidTransitionIgnored(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	// Sending EventIPCConnected again while in MONITORING is a no-op
	w.HandleEvent(EventIPCConnected)
	if w.State() != StateMonitoring {
		t.Errorf("state = %q, want %q", w.State(), StateMonitoring)
	}
}

func TestStateHistory(t *testing.T) {
	w := NewWatchdog(DefaultTestConfig())
	w.HandleEvent(EventIPCConnected)
	w.HandleEvent(EventAgentUnhealthy)
	w.HandleEvent(EventRecoveryExhausted)

	history := w.StateHistory()
	if len(history) != 4 { // CONNECTING -> MONITORING -> RECOVERING -> FAILOVER
		t.Fatalf("history len = %d, want 4", len(history))
	}
	if history[0].State != StateConnecting {
		t.Errorf("history[0] = %q, want %q", history[0].State, StateConnecting)
	}
	if history[3].State != StateFailover {
		t.Errorf("history[3] = %q, want %q", history[3].State, StateFailover)
	}
}

func DefaultTestConfig() Config {
	return Config{
		ProcessCheckInterval:    5 * time.Second,
		IPCProbeInterval:        30 * time.Second,
		HeartbeatStaleThreshold: 3 * time.Minute,
		MaxRecoveryAttempts:     3,
		RecoveryCooldown:        10 * time.Minute,
		StandbyTimeout:          30 * time.Minute,
		FailoverPollInterval:    30 * time.Second,
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestState`
Expected: compilation error

- [ ] **Step 3: Implement state machine**

Create `agent/internal/watchdog/watchdog.go`:

```go
package watchdog

import (
	"sync"
	"time"
)

// States
const (
	StateConnecting = "CONNECTING"
	StateMonitoring = "MONITORING"
	StateRecovering = "RECOVERING"
	StateStandby    = "STANDBY"
	StateFailover   = "FAILOVER"
)

// Events
const (
	EventIPCConnected      = "ipc_connected"
	EventAgentNotFound     = "agent_not_found"
	EventAgentUnhealthy    = "agent_unhealthy"
	EventAgentRecovered    = "agent_recovered"
	EventShutdownIntent    = "shutdown_intent"
	EventRecoveryExhausted = "recovery_exhausted"
	EventStandbyTimeout    = "standby_timeout"
	EventStartAgent        = "start_agent" // API command from STANDBY
)

// Config holds watchdog runtime configuration.
type Config struct {
	ProcessCheckInterval    time.Duration
	IPCProbeInterval        time.Duration
	HeartbeatStaleThreshold time.Duration
	MaxRecoveryAttempts     int
	RecoveryCooldown        time.Duration
	StandbyTimeout          time.Duration
	FailoverPollInterval    time.Duration
}

// StateRecord tracks a state transition.
type StateRecord struct {
	State     string    `json:"state"`
	EnteredAt time.Time `json:"enteredAt"`
	Event     string    `json:"event,omitempty"` // event that caused the transition
}

// Watchdog is the core state machine.
type Watchdog struct {
	mu      sync.RWMutex
	state   string
	config  Config
	history []StateRecord
}

// transition table: current state + event → next state
var transitions = map[string]map[string]string{
	StateConnecting: {
		EventIPCConnected:   StateMonitoring,
		EventAgentNotFound:  StateRecovering,
		EventAgentUnhealthy: StateRecovering,
	},
	StateMonitoring: {
		EventAgentUnhealthy: StateRecovering,
		EventShutdownIntent: StateStandby,
	},
	StateRecovering: {
		EventAgentRecovered:    StateMonitoring,
		EventRecoveryExhausted: StateFailover,
	},
	StateStandby: {
		EventAgentRecovered: StateMonitoring,
		EventStandbyTimeout: StateFailover,
		EventStartAgent:     StateRecovering,
	},
	StateFailover: {
		EventAgentRecovered: StateMonitoring,
	},
}

// NewWatchdog creates a new watchdog state machine.
func NewWatchdog(cfg Config) *Watchdog {
	w := &Watchdog{
		state:  StateConnecting,
		config: cfg,
		history: []StateRecord{
			{State: StateConnecting, EnteredAt: time.Now()},
		},
	}
	return w
}

// State returns the current state.
func (w *Watchdog) State() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.state
}

// HandleEvent processes an event and transitions state if valid.
// Returns the new state and whether a transition occurred.
func (w *Watchdog) HandleEvent(event string) (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	stateTransitions, ok := transitions[w.state]
	if !ok {
		return w.state, false
	}

	nextState, ok := stateTransitions[event]
	if !ok {
		return w.state, false
	}

	w.state = nextState
	w.history = append(w.history, StateRecord{
		State:     nextState,
		EnteredAt: time.Now(),
		Event:     event,
	})

	return nextState, true
}

// StateHistory returns a copy of the state transition history.
func (w *Watchdog) StateHistory() []StateRecord {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]StateRecord, len(w.history))
	copy(result, w.history)
	return result
}

// LastTransitionTime returns when the current state was entered.
func (w *Watchdog) LastTransitionTime() time.Time {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if len(w.history) == 0 {
		return time.Time{}
	}
	return w.history[len(w.history)-1].EnteredAt
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/watchdog/... -v -run "TestState|TestInitial|TestConnecting|TestMonitoring|TestRecovering|TestFailover|TestStandby|TestInvalid"`
Expected: all 11 tests pass

- [ ] **Step 5: Commit**

```bash
git add agent/internal/watchdog/watchdog.go agent/internal/watchdog/watchdog_test.go
git commit -m "feat(watchdog): implement state machine with transition table"
```

---

## Task 9: Health Checks

**Files:**
- Create: `agent/internal/watchdog/checks.go`
- Create: `agent/internal/watchdog/checks_test.go`

- [ ] **Step 1: Write failing tests**

Create `agent/internal/watchdog/checks_test.go`:

```go
package watchdog

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// Mock process checker
type mockProcessChecker struct {
	alive  bool
	zombie bool
}

func (m *mockProcessChecker) IsAlive(pid int) bool { return m.alive }
func (m *mockProcessChecker) IsZombie(pid int) bool { return m.zombie }

// Mock IPC prober
type mockIPCProber struct {
	healthy bool
	err     error
}

func (m *mockIPCProber) Ping() (bool, error) { return m.healthy, m.err }

func TestTier1ProcessAlive(t *testing.T) {
	checker := &mockProcessChecker{alive: true, zombie: false}
	c := &HealthChecker{process: checker}
	result := c.CheckProcess(1234)
	if result != CheckOK {
		t.Errorf("CheckProcess = %v, want CheckOK", result)
	}
}

func TestTier1ProcessDead(t *testing.T) {
	checker := &mockProcessChecker{alive: false}
	c := &HealthChecker{process: checker}
	result := c.CheckProcess(1234)
	if result != CheckProcessGone {
		t.Errorf("CheckProcess = %v, want CheckProcessGone", result)
	}
}

func TestTier1ProcessZombie(t *testing.T) {
	checker := &mockProcessChecker{alive: true, zombie: true}
	c := &HealthChecker{process: checker}
	result := c.CheckProcess(1234)
	if result != CheckProcessGone {
		t.Errorf("CheckProcess = %v, want CheckProcessGone for zombie", result)
	}
}

func TestTier2IPCHealthy(t *testing.T) {
	prober := &mockIPCProber{healthy: true}
	c := &HealthChecker{ipc: prober}
	result := c.CheckIPC()
	if result != CheckOK {
		t.Errorf("CheckIPC = %v, want CheckOK", result)
	}
	if c.IPCFailCount() != 0 {
		t.Errorf("IPCFailCount = %d, want 0", c.IPCFailCount())
	}
}

func TestTier2IPCFailure(t *testing.T) {
	prober := &mockIPCProber{healthy: false}
	c := &HealthChecker{ipc: prober}

	// First two failures → CheckDegraded
	c.CheckIPC()
	c.CheckIPC()
	result := c.CheckIPC()
	if result != CheckIPCFailed {
		t.Errorf("after 3 failures, CheckIPC = %v, want CheckIPCFailed", result)
	}
}

func TestTier2IPCRecovery(t *testing.T) {
	prober := &mockIPCProber{healthy: false}
	c := &HealthChecker{ipc: prober}

	c.CheckIPC()
	c.CheckIPC()

	// Agent recovers
	prober.healthy = true
	result := c.CheckIPC()
	if result != CheckOK {
		t.Errorf("after recovery, CheckIPC = %v, want CheckOK", result)
	}
	if c.IPCFailCount() != 0 {
		t.Errorf("IPCFailCount after recovery = %d, want 0", c.IPCFailCount())
	}
}

func TestTier3HeartbeatFresh(t *testing.T) {
	c := &HealthChecker{staleThreshold: 3 * time.Minute}
	s := &state.AgentState{
		LastHeartbeat: time.Now().Add(-1 * time.Minute),
	}
	result := c.CheckHeartbeatStaleness(s)
	if result != CheckOK {
		t.Errorf("CheckHeartbeatStaleness = %v, want CheckOK", result)
	}
}

func TestTier3HeartbeatStale(t *testing.T) {
	c := &HealthChecker{staleThreshold: 3 * time.Minute}
	s := &state.AgentState{
		LastHeartbeat: time.Now().Add(-5 * time.Minute),
	}
	result := c.CheckHeartbeatStaleness(s)
	if result != CheckHeartbeatStale {
		t.Errorf("CheckHeartbeatStaleness = %v, want CheckHeartbeatStale", result)
	}
}

func TestTier3HeartbeatNeverSet(t *testing.T) {
	c := &HealthChecker{staleThreshold: 3 * time.Minute}
	s := &state.AgentState{} // LastHeartbeat is zero
	result := c.CheckHeartbeatStaleness(s)
	// Zero time = agent just started, give it grace
	if result != CheckOK {
		t.Errorf("CheckHeartbeatStaleness (zero) = %v, want CheckOK", result)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestTier`
Expected: compilation error

- [ ] **Step 3: Implement health checks**

Create `agent/internal/watchdog/checks.go`:

```go
package watchdog

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
)

// Check results
const (
	CheckOK             = "ok"
	CheckProcessGone    = "process_gone"
	CheckIPCDegraded    = "ipc_degraded"
	CheckIPCFailed      = "ipc_failed"
	CheckHeartbeatStale = "heartbeat_stale"
)

const ipcFailThreshold = 3

// ProcessChecker checks if a process is alive.
type ProcessChecker interface {
	IsAlive(pid int) bool
	IsZombie(pid int) bool
}

// IPCProber sends pings over the IPC socket.
type IPCProber interface {
	Ping() (bool, error)
}

// HealthChecker runs layered health checks.
type HealthChecker struct {
	process        ProcessChecker
	ipc            IPCProber
	staleThreshold time.Duration
	ipcFailCount   int
}

// NewHealthChecker creates a HealthChecker with the given dependencies.
func NewHealthChecker(process ProcessChecker, ipc IPCProber, staleThreshold time.Duration) *HealthChecker {
	return &HealthChecker{
		process:        process,
		ipc:            ipc,
		staleThreshold: staleThreshold,
	}
}

// CheckProcess is Tier 1: verify the agent PID is alive and not zombie.
func (h *HealthChecker) CheckProcess(pid int) string {
	if !h.process.IsAlive(pid) {
		return CheckProcessGone
	}
	if h.process.IsZombie(pid) {
		return CheckProcessGone
	}
	return CheckOK
}

// CheckIPC is Tier 2: send IPC ping and track consecutive failures.
func (h *HealthChecker) CheckIPC() string {
	healthy, err := h.ipc.Ping()
	if err != nil || !healthy {
		h.ipcFailCount++
		if h.ipcFailCount >= ipcFailThreshold {
			return CheckIPCFailed
		}
		return CheckIPCDegraded
	}

	h.ipcFailCount = 0
	return CheckOK
}

// CheckHeartbeatStaleness is Tier 3: check if the agent's last heartbeat is stale.
func (h *HealthChecker) CheckHeartbeatStaleness(s *state.AgentState) string {
	if s == nil {
		return CheckHeartbeatStale
	}

	// Zero time = agent just started, hasn't heartbeated yet
	if s.LastHeartbeat.IsZero() {
		return CheckOK
	}

	age := time.Since(s.LastHeartbeat)
	if age > h.staleThreshold {
		return CheckHeartbeatStale
	}

	return CheckOK
}

// IPCFailCount returns the current consecutive IPC failure count.
func (h *HealthChecker) IPCFailCount() int {
	return h.ipcFailCount
}

// ResetIPCFails resets the IPC failure counter.
func (h *HealthChecker) ResetIPCFails() {
	h.ipcFailCount = 0
}

// OSProcessChecker is the real implementation of ProcessChecker.
type OSProcessChecker struct{}

// IsAlive checks if the given PID exists.
func (o *OSProcessChecker) IsAlive(pid int) bool {
	if runtime.GOOS == "windows" {
		return isAliveWindows(pid)
	}
	// Unix: signal 0 checks existence without sending a signal
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}

// IsZombie checks if the given PID is a zombie process.
func (o *OSProcessChecker) IsZombie(pid int) bool {
	if runtime.GOOS == "windows" {
		return false // Windows doesn't have zombies
	}
	return isZombieUnix(pid)
}

func isZombieUnix(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return false // /proc not available (macOS) — can't detect zombies this way
	}
	// Look for "State: Z"
	for _, line := range splitLines(data) {
		if len(line) > 7 && line[:6] == "State:" {
			return len(line) > 7 && (line[7] == 'Z' || line[7] == 'z')
		}
	}
	return false
}

func splitLines(data []byte) []string {
	var lines []string
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, string(data[start:i]))
			start = i + 1
		}
	}
	if start < len(data) {
		lines = append(lines, string(data[start:]))
	}
	return lines
}
```

- [ ] **Step 4: Add Windows process check stub**

Create `agent/internal/watchdog/checks_windows.go`:

```go
//go:build windows

package watchdog

import "golang.org/x/sys/windows"

func isAliveWindows(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)

	var exitCode uint32
	if err := windows.GetExitCodeProcess(h, &exitCode); err != nil {
		return false
	}
	return exitCode == 259 // STILL_ACTIVE
}
```

Create `agent/internal/watchdog/checks_notwindows.go`:

```go
//go:build !windows

package watchdog

func isAliveWindows(_ int) bool {
	return false
}
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestTier`
Expected: all 8 tests pass

- [ ] **Step 6: Commit**

```bash
git add agent/internal/watchdog/checks.go agent/internal/watchdog/checks_test.go agent/internal/watchdog/checks_windows.go agent/internal/watchdog/checks_notwindows.go
git commit -m "feat(watchdog): implement layered health checks (process, IPC, heartbeat)"
```

---

## Task 10: Recovery Logic

**Files:**
- Create: `agent/internal/watchdog/recovery.go`
- Create: `agent/internal/watchdog/recovery_darwin.go`
- Create: `agent/internal/watchdog/recovery_linux.go`
- Create: `agent/internal/watchdog/recovery_windows.go`

- [ ] **Step 1: Implement recovery coordinator**

Create `agent/internal/watchdog/recovery.go`:

```go
package watchdog

import (
	"fmt"
	"log/slog"
	"os"
	"syscall"
	"time"
)

// RecoveryManager tracks recovery attempts and executes escalating recovery.
type RecoveryManager struct {
	maxAttempts int
	cooldown    time.Duration
	attempts    int
	lastAttempt time.Time
	windowStart time.Time
}

// NewRecoveryManager creates a new recovery manager.
func NewRecoveryManager(maxAttempts int, cooldown time.Duration) *RecoveryManager {
	return &RecoveryManager{
		maxAttempts: maxAttempts,
		cooldown:    cooldown,
	}
}

// CanAttempt returns true if recovery can be attempted (within cooldown limits).
func (r *RecoveryManager) CanAttempt() bool {
	now := time.Now()

	// Reset window if cooldown has passed
	if now.Sub(r.windowStart) > r.cooldown {
		r.attempts = 0
		r.windowStart = now
	}

	return r.attempts < r.maxAttempts
}

// Attempt executes one recovery step. Returns true if the agent started.
func (r *RecoveryManager) Attempt(pid int) (bool, error) {
	if !r.CanAttempt() {
		return false, fmt.Errorf("recovery attempts exhausted (%d/%d in window)", r.attempts, r.maxAttempts)
	}

	r.attempts++
	r.lastAttempt = time.Now()

	if r.windowStart.IsZero() {
		r.windowStart = time.Now()
	}

	step := r.attempts

	switch {
	case step == 1:
		// Step 1: Graceful restart via service manager
		slog.Info("recovery step 1: graceful service restart")
		return false, restartAgentService()

	case step == 2:
		// Step 2: Force kill + service start
		slog.Info("recovery step 2: force kill + service start", "pid", pid)
		if pid > 0 {
			forceKillProcess(pid)
		}
		return false, startAgentService()

	default:
		// Step 3+: Last resort — just try starting
		slog.Info("recovery step 3+: start service", "attempt", step)
		return false, startAgentService()
	}
}

// Attempts returns the current attempt count.
func (r *RecoveryManager) Attempts() int {
	return r.attempts
}

// Reset resets the recovery counter (called when agent recovers).
func (r *RecoveryManager) Reset() {
	r.attempts = 0
	r.windowStart = time.Time{}
}

func forceKillProcess(pid int) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = proc.Signal(syscall.SIGKILL)
}
```

- [ ] **Step 2: Implement macOS recovery**

Create `agent/internal/watchdog/recovery_darwin.go`:

```go
//go:build darwin

package watchdog

import (
	"fmt"
	"os/exec"
)

const agentServiceLabel = "com.breeze.agent"

func restartAgentService() error {
	// Try kickstart -k (kill + restart) first
	cmd := exec.Command("launchctl", "kickstart", "-k", "system/"+agentServiceLabel)
	if err := cmd.Run(); err != nil {
		// Fallback: bootout then bootstrap
		exec.Command("launchctl", "bootout", "system/"+agentServiceLabel).Run()
		cmd2 := exec.Command("launchctl", "bootstrap", "system", "/Library/LaunchDaemons/"+agentServiceLabel+".plist")
		if err2 := cmd2.Run(); err2 != nil {
			return fmt.Errorf("launchctl restart failed: kickstart=%v, bootstrap=%v", err, err2)
		}
	}
	return nil
}

func startAgentService() error {
	// Check if loaded
	check := exec.Command("launchctl", "print", "system/"+agentServiceLabel)
	if check.Run() == nil {
		// Already loaded, just kickstart
		return exec.Command("launchctl", "kickstart", "system/"+agentServiceLabel).Run()
	}
	// Not loaded, bootstrap
	return exec.Command("launchctl", "bootstrap", "system", "/Library/LaunchDaemons/"+agentServiceLabel+".plist").Run()
}
```

- [ ] **Step 3: Implement Linux recovery**

Create `agent/internal/watchdog/recovery_linux.go`:

```go
//go:build linux

package watchdog

import (
	"fmt"
	"os/exec"
)

const agentServiceName = "breeze-agent"

func restartAgentService() error {
	cmd := exec.Command("systemctl", "restart", agentServiceName)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl restart failed: %w", err)
	}
	return nil
}

func startAgentService() error {
	cmd := exec.Command("systemctl", "start", agentServiceName)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl start failed: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Implement Windows recovery**

Create `agent/internal/watchdog/recovery_windows.go`:

```go
//go:build windows

package watchdog

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const agentWindowsServiceName = "BreezeAgent"

func restartAgentService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(agentWindowsServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	// Stop
	_, _ = s.Control(svc.Stop)

	// Wait for stop (up to 15s)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		status, err := s.Query()
		if err != nil {
			break
		}
		if status.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Start
	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

func startAgentService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(agentWindowsServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	return s.Start()
}
```

- [ ] **Step 5: Verify build**

Run: `cd agent && go build ./internal/watchdog/...`
Expected: clean build

- [ ] **Step 6: Commit**

```bash
git add agent/internal/watchdog/recovery*.go
git commit -m "feat(watchdog): implement platform-specific agent recovery (launchd/systemd/SCM)"
```

---

## Task 11: Failover HTTP Client

**Files:**
- Create: `agent/internal/watchdog/failover.go`
- Create: `agent/internal/watchdog/failover_test.go`

- [ ] **Step 1: Write failing test**

Create `agent/internal/watchdog/failover_test.go`:

```go
package watchdog

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFailoverHeartbeat(t *testing.T) {
	var receivedRole string
	var receivedBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedRole = r.Header.Get("X-Breeze-Role")
		json.NewDecoder(r.Body).Decode(&receivedBody)
		json.NewEncoder(w).Encode(map[string]any{
			"commands": []any{},
		})
	}))
	defer server.Close()

	client := NewFailoverClient(server.URL, "test-agent-id", "test-token", nil)
	resp, err := client.SendHeartbeat("0.12.1", StateFailover, nil)
	if err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}

	if receivedRole != "watchdog" {
		t.Errorf("X-Breeze-Role = %q, want %q", receivedRole, "watchdog")
	}
	if receivedBody["role"] != "watchdog" {
		t.Errorf("body.role = %v, want %q", receivedBody["role"], "watchdog")
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
}

func TestFailoverPollCommands(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("role") != "watchdog" {
			t.Errorf("query role = %q, want %q", r.URL.Query().Get("role"), "watchdog")
		}
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": "cmd-1", "type": "restart_agent", "payload": map[string]any{}},
		})
	}))
	defer server.Close()

	client := NewFailoverClient(server.URL, "test-agent-id", "test-token", nil)
	cmds, err := client.PollCommands()
	if err != nil {
		t.Fatalf("PollCommands: %v", err)
	}

	if len(cmds) != 1 {
		t.Fatalf("len(cmds) = %d, want 1", len(cmds))
	}
	if cmds[0].Type != "restart_agent" {
		t.Errorf("cmds[0].Type = %q, want %q", cmds[0].Type, "restart_agent")
	}
}

func TestFailoverSubmitResult(t *testing.T) {
	var receivedBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&receivedBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewFailoverClient(server.URL, "test-agent-id", "test-token", nil)
	err := client.SubmitCommandResult("cmd-1", "completed", map[string]any{"message": "restarted"}, "")
	if err != nil {
		t.Fatalf("SubmitCommandResult: %v", err)
	}

	if receivedBody["status"] != "completed" {
		t.Errorf("body.status = %v, want %q", receivedBody["status"], "completed")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestFailover`
Expected: compilation error

- [ ] **Step 3: Implement failover client**

Create `agent/internal/watchdog/failover.go`:

```go
package watchdog

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// FailoverCommand is a command received from the API during failover.
type FailoverCommand struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

// HeartbeatResponse is the API's response to a watchdog heartbeat.
type HeartbeatResponse struct {
	Commands          []FailoverCommand `json:"commands,omitempty"`
	WatchdogUpgradeTo string            `json:"watchdogUpgradeTo,omitempty"`
	UpgradeTo         string            `json:"upgradeTo,omitempty"`
}

// FailoverClient is the HTTP client used during failover mode.
type FailoverClient struct {
	baseURL  string
	agentID  string
	token    string
	client   *http.Client
}

// NewFailoverClient creates a failover HTTP client.
func NewFailoverClient(baseURL, agentID, token string, tlsConfig *tls.Config) *FailoverClient {
	transport := &http.Transport{}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}

	return &FailoverClient{
		baseURL: baseURL,
		agentID: agentID,
		token:   token,
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
	}
}

// UpdateToken sets a new auth token (after rotation).
func (f *FailoverClient) UpdateToken(token string) {
	f.token = token
}

// SendHeartbeat sends a watchdog heartbeat to the API.
func (f *FailoverClient) SendHeartbeat(watchdogVersion, currentState string, journalEntries []JournalEntry) (*HeartbeatResponse, error) {
	body := map[string]any{
		"role":            "watchdog",
		"agentVersion":    watchdogVersion,
		"watchdogState":   currentState,
		"journalExcerpt":  journalEntries,
		"timestamp":       time.Now().Format(time.RFC3339),
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal heartbeat: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", f.baseURL, f.agentID)
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	f.setHeaders(req)

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("heartbeat POST: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("heartbeat returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode heartbeat response: %w", err)
	}

	return &result, nil
}

// PollCommands polls for watchdog-targeted commands.
func (f *FailoverClient) PollCommands() ([]FailoverCommand, error) {
	url := fmt.Sprintf("%s/api/v1/agents/%s/commands?role=watchdog", f.baseURL, f.agentID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	f.setHeaders(req)

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("poll commands: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("poll commands returned %d", resp.StatusCode)
	}

	var cmds []FailoverCommand
	if err := json.NewDecoder(resp.Body).Decode(&cmds); err != nil {
		return nil, fmt.Errorf("decode commands: %w", err)
	}

	return cmds, nil
}

// SubmitCommandResult submits a command result to the API.
func (f *FailoverClient) SubmitCommandResult(commandID, status string, result any, errMsg string) error {
	body := map[string]any{
		"status": status,
		"result": result,
		"error":  errMsg,
	}

	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", f.baseURL, f.agentID, commandID)
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	f.setHeaders(req)

	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("submit result: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result returned %d", resp.StatusCode)
	}

	return nil
}

// ShipLogs uploads watchdog and agent diagnostic logs to the API.
func (f *FailoverClient) ShipLogs(entries []JournalEntry) error {
	data, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("marshal logs: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", f.baseURL, f.agentID)
	req, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	f.setHeaders(req)
	req.Header.Set("Content-Encoding", "identity")

	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("ship logs: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("ship logs returned %d", resp.StatusCode)
	}

	return nil
}

func (f *FailoverClient) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+f.token)
	req.Header.Set("X-Breeze-Role", "watchdog")
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/watchdog/... -v -run TestFailover`
Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add agent/internal/watchdog/failover.go agent/internal/watchdog/failover_test.go
git commit -m "feat(watchdog): implement failover HTTP client for API communication"
```

---

## Task 12: Watchdog IPC Client

**Files:**
- Create: `agent/internal/watchdog/ipcclient.go`

- [ ] **Step 1: Implement IPC client**

Create `agent/internal/watchdog/ipcclient.go`:

```go
package watchdog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// IPCClient connects to the agent's IPC socket as a watchdog client.
type IPCClient struct {
	mu         sync.Mutex
	socketPath string
	conn       *ipc.Conn
	connected  bool
	onMessage  func(*ipc.Envelope)
	stopCh     chan struct{}
}

// NewIPCClient creates a new IPC client for the watchdog.
func NewIPCClient(socketPath string, onMessage func(*ipc.Envelope)) *IPCClient {
	return &IPCClient{
		socketPath: socketPath,
		onMessage:  onMessage,
		stopCh:     make(chan struct{}),
	}
}

// Connect attempts to connect and authenticate with the agent's IPC server.
func (c *IPCClient) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	conn, err := net.DialTimeout("unix", c.socketPath, 5*time.Second)
	if err != nil {
		return fmt.Errorf("dial IPC socket: %w", err)
	}

	ipcConn := ipc.NewConn(conn)

	// Build auth request
	binaryHash, _ := selfHash()
	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(os.Getuid()),
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
		HelperRole:      ipc.HelperRoleWatchdog,
	}

	// Send auth request (pre-HMAC, zero key)
	if err := ipcConn.SendTyped("auth", ipc.TypeAuthRequest, authReq); err != nil {
		conn.Close()
		return fmt.Errorf("send auth request: %w", err)
	}

	// Read auth response
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	env, err := ipcConn.Recv()
	if err != nil {
		conn.Close()
		return fmt.Errorf("recv auth response: %w", err)
	}
	conn.SetDeadline(time.Time{})

	if env.Type != ipc.TypeAuthResponse {
		conn.Close()
		return fmt.Errorf("unexpected response type: %s", env.Type)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		conn.Close()
		return fmt.Errorf("unmarshal auth response: %w", err)
	}

	if !authResp.Accepted {
		conn.Close()
		return fmt.Errorf("auth rejected: %s", authResp.Reason)
	}

	// Set session key for HMAC
	ipcConn.SetSessionKey(authResp.SessionKey)
	c.conn = ipcConn
	c.connected = true

	// Start read loop
	go c.readLoop()

	return nil
}

// Ping sends a watchdog_ping and waits for pong.
func (c *IPCClient) Ping() (bool, error) {
	c.mu.Lock()
	if !c.connected || c.conn == nil {
		c.mu.Unlock()
		return false, fmt.Errorf("not connected")
	}
	conn := c.conn
	c.mu.Unlock()

	ping := ipc.WatchdogPing{RequestHealthSummary: true}
	if err := conn.SendTyped("ping", ipc.TypeWatchdogPing, ping); err != nil {
		return false, fmt.Errorf("send ping: %w", err)
	}

	// Pong will arrive via readLoop → onMessage
	return true, nil
}

// IsConnected returns whether the IPC connection is active.
func (c *IPCClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// Close closes the IPC connection.
func (c *IPCClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	close(c.stopCh)
	if c.conn != nil {
		c.conn.SendTyped("", ipc.TypeDisconnect, nil)
	}
	c.connected = false
}

func (c *IPCClient) readLoop() {
	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		env, err := c.conn.Recv()
		if err != nil {
			slog.Warn("IPC read error", "error", err.Error())
			c.mu.Lock()
			c.connected = false
			c.mu.Unlock()
			return
		}

		if c.onMessage != nil {
			c.onMessage(env)
		}
	}
}

func selfHash() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}
```

- [ ] **Step 2: Verify build**

Run: `cd agent && go build ./internal/watchdog/...`
Expected: clean build

- [ ] **Step 3: Commit**

```bash
git add agent/internal/watchdog/ipcclient.go
git commit -m "feat(watchdog): implement IPC client for agent communication"
```

---

## Task 13: Watchdog CLI & Service Commands

**Files:**
- Create: `agent/cmd/breeze-watchdog/main.go`
- Create: `agent/cmd/breeze-watchdog/service_cmd_darwin.go`
- Create: `agent/cmd/breeze-watchdog/service_cmd_linux.go`
- Create: `agent/cmd/breeze-watchdog/service_cmd_windows.go`
- Create: `agent/cmd/breeze-watchdog/service_unix.go`
- Create: `agent/cmd/breeze-watchdog/service_windows.go`

- [ ] **Step 1: Create CLI entry point**

Create `agent/cmd/breeze-watchdog/main.go`:

```go
package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/watchdog"
	"github.com/spf13/cobra"
)

var version = "dev"

func main() {
	rootCmd := &cobra.Command{
		Use:   "breeze-watchdog",
		Short: "Breeze Agent Watchdog Service",
	}

	rootCmd.AddCommand(runCmd())
	rootCmd.AddCommand(statusCmd())
	rootCmd.AddCommand(healthJournalCmd())
	rootCmd.AddCommand(triggerFailoverCmd())
	rootCmd.AddCommand(triggerRecoveryCmd())
	rootCmd.AddCommand(serviceCmd())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runCmd() *cobra.Command {
	var devMode bool
	var agentPID int

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Start the watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWatchdog(devMode, agentPID)
		},
	}

	cmd.Flags().BoolVar(&devMode, "dev", false, "Enable dev mode (shorter intervals, verbose logging)")
	cmd.Flags().IntVar(&agentPID, "agent-pid", 0, "Monitor specific PID (dev mode)")

	return cmd
}

func runWatchdog(devMode bool, agentPID int) error {
	// Load agent config (shared)
	cfg, err := config.Load("")
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	wcfg := cfg.Watchdog
	if devMode {
		wcfg.ProcessCheckInterval = 2 * time.Second
		wcfg.IPCProbeInterval = 10 * time.Second
		wcfg.HeartbeatStaleThreshold = 30 * time.Second
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug})))
		slog.Info("watchdog starting in dev mode")
	}

	wdConfig := watchdog.Config{
		ProcessCheckInterval:    wcfg.ProcessCheckInterval,
		IPCProbeInterval:        wcfg.IPCProbeInterval,
		HeartbeatStaleThreshold: wcfg.HeartbeatStaleThreshold,
		MaxRecoveryAttempts:     wcfg.MaxRecoveryAttempts,
		RecoveryCooldown:        wcfg.RecoveryCooldown,
		StandbyTimeout:          wcfg.StandbyTimeout,
		FailoverPollInterval:    wcfg.FailoverPollInterval,
	}

	// Determine log directory
	logDir := config.LogDir()
	journal, err := watchdog.NewJournal(logDir, wcfg.HealthJournalMaxSizeMB, wcfg.HealthJournalMaxFiles)
	if err != nil {
		return fmt.Errorf("open journal: %w", err)
	}
	defer journal.Close()

	// State file path
	statePath := state.PathInDir(config.ConfigDir())

	// Create state machine
	wd := watchdog.NewWatchdog(wdConfig)

	journal.Log(watchdog.LevelInfo, "watchdog_started", map[string]any{
		"version": version,
		"devMode": devMode,
	})

	// Signal handling
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	slog.Info("watchdog started", "version", version, "state", wd.State())

	// Main loop
	processTicker := time.NewTicker(wdConfig.ProcessCheckInterval)
	ipcTicker := time.NewTicker(wdConfig.IPCProbeInterval)
	heartbeatTicker := time.NewTicker(wdConfig.HeartbeatStaleThreshold)
	defer processTicker.Stop()
	defer ipcTicker.Stop()
	defer heartbeatTicker.Stop()

	// Process checker
	processChecker := &watchdog.OSProcessChecker{}

	// IPC client setup
	socketPath := cfg.IPCSocketPath
	if socketPath == "" {
		socketPath = ipc.DefaultSocketPath()
	}

	var ipcClient *watchdog.IPCClient
	var failoverClient *watchdog.FailoverClient
	recovery := watchdog.NewRecoveryManager(wdConfig.MaxRecoveryAttempts, wdConfig.RecoveryCooldown)

	// Try initial connection
	ipcClient = watchdog.NewIPCClient(socketPath, func(env *ipc.Envelope) {
		handleIPCMessage(wd, journal, env, cfg)
	})
	if err := ipcClient.Connect(); err != nil {
		slog.Warn("initial IPC connection failed", "error", err.Error())
		// Check if agent process exists
		agentState, _ := state.Read(statePath)
		if agentState != nil && agentState.PID > 0 && processChecker.IsAlive(agentState.PID) {
			// Agent running but IPC not ready — stay in CONNECTING
		} else {
			wd.HandleEvent(watchdog.EventAgentNotFound)
		}
	} else {
		wd.HandleEvent(watchdog.EventIPCConnected)
	}

	healthChecker := watchdog.NewHealthChecker(processChecker, ipcClient, wdConfig.HeartbeatStaleThreshold)

	for {
		select {
		case <-sigCh:
			slog.Info("watchdog shutting down")
			journal.Log(watchdog.LevelInfo, "watchdog_stopped", nil)
			if ipcClient != nil {
				ipcClient.Close()
			}
			return nil

		case <-processTicker.C:
			agentState, _ := state.Read(statePath)
			currentState := wd.State()

			if currentState == watchdog.StateStandby {
				continue // Don't check process in STANDBY
			}

			pid := agentPID
			if pid == 0 && agentState != nil {
				pid = agentState.PID
			}
			if pid == 0 {
				continue
			}

			result := healthChecker.CheckProcess(pid)
			journal.Log(watchdog.LevelInfo, "process_check", map[string]any{"pid": pid, "result": result})

			if result == watchdog.CheckProcessGone {
				// Check state file for intentional shutdown
				if agentState != nil && agentState.Status == state.StatusStopping {
					wd.HandleEvent(watchdog.EventShutdownIntent)
				} else {
					wd.HandleEvent(watchdog.EventAgentUnhealthy)
				}
			}

		case <-ipcTicker.C:
			currentState := wd.State()
			if currentState != watchdog.StateMonitoring {
				continue
			}

			result := healthChecker.CheckIPC()
			journal.Log(watchdog.LevelInfo, "ipc_check", map[string]any{"result": result, "failCount": healthChecker.IPCFailCount()})

			if result == watchdog.CheckIPCFailed {
				wd.HandleEvent(watchdog.EventAgentUnhealthy)
			}

		case <-heartbeatTicker.C:
			currentState := wd.State()
			if currentState != watchdog.StateMonitoring {
				continue
			}

			agentState, _ := state.Read(statePath)
			result := healthChecker.CheckHeartbeatStaleness(agentState)
			journal.Log(watchdog.LevelInfo, "heartbeat_check", map[string]any{"result": result})

			if result == watchdog.CheckHeartbeatStale && healthChecker.IPCFailCount() > 0 {
				// Stale heartbeat + degraded IPC = force restart
				wd.HandleEvent(watchdog.EventAgentUnhealthy)
			}
		}

		// State-driven actions
		switch wd.State() {
		case watchdog.StateRecovering:
			agentState, _ := state.Read(statePath)
			pid := agentPID
			if agentState != nil {
				pid = agentState.PID
			}

			if recovery.CanAttempt() {
				journal.Log(watchdog.LevelWarn, "recovery_attempt", map[string]any{"attempt": recovery.Attempts() + 1})
				_, err := recovery.Attempt(pid)
				if err != nil {
					slog.Warn("recovery attempt failed", "error", err.Error())
				}
				// Wait before checking again
				time.Sleep(15 * time.Second)

				// Check if agent came back
				if ipcClient.Connect() == nil {
					wd.HandleEvent(watchdog.EventAgentRecovered)
					healthChecker.ResetIPCFails()
					recovery.Reset()
					journal.Log(watchdog.LevelInfo, "agent_recovered", nil)
				}
			} else {
				journal.Log(watchdog.LevelError, "recovery_exhausted", map[string]any{"attempts": recovery.Attempts()})
				wd.HandleEvent(watchdog.EventRecoveryExhausted)
			}

		case watchdog.StateFailover:
			if failoverClient == nil {
				failoverClient = watchdog.NewFailoverClient(cfg.ServerURL, cfg.AgentID, cfg.AuthToken.Reveal(), nil)
				journal.Log(watchdog.LevelWarn, "failover_started", nil)
			}

			// Heartbeat + poll in failover
			resp, err := failoverClient.SendHeartbeat(version, wd.State(), journal.Recent(20))
			if err != nil {
				slog.Warn("failover heartbeat failed", "error", err.Error())
			} else if resp != nil {
				for _, cmd := range resp.Commands {
					handleFailoverCommand(cmd, wd, journal, recovery, failoverClient, cfg)
				}
			}

			// Keep trying IPC reconnect in background
			if ipcClient.Connect() == nil {
				wd.HandleEvent(watchdog.EventAgentRecovered)
				healthChecker.ResetIPCFails()
				recovery.Reset()
				failoverClient = nil
				journal.Log(watchdog.LevelInfo, "agent_recovered_from_failover", nil)
			}

		case watchdog.StateStandby:
			// Check for timeout
			if time.Since(wd.LastTransitionTime()) > wdConfig.StandbyTimeout {
				journal.Log(watchdog.LevelWarn, "standby_timeout", nil)
				wd.HandleEvent(watchdog.EventStandbyTimeout)
			}
		}
	}
}

func handleIPCMessage(wd *watchdog.Watchdog, journal *watchdog.Journal, env *ipc.Envelope, cfg *config.Config) {
	switch env.Type {
	case ipc.TypeShutdownIntent:
		journal.Log(watchdog.LevelInfo, "shutdown_intent_received", nil)
		wd.HandleEvent(watchdog.EventShutdownIntent)

	case ipc.TypeTokenUpdate:
		var update ipc.TokenUpdate
		if err := json.Unmarshal(env.Payload, &update); err == nil {
			slog.Info("token rotated via IPC")
			cfg.AuthToken = secmem.NewSecureString(update.Token)
			if err := config.Save(cfg); err != nil {
				slog.Warn("failed to persist rotated token", "error", err.Error())
			}
		}

	case ipc.TypeStateSync:
		var sync ipc.StateSync
		if err := json.Unmarshal(env.Payload, &sync); err == nil {
			journal.Log(watchdog.LevelInfo, "state_sync", map[string]any{
				"version":   sync.AgentVersion,
				"connected": sync.Connected,
			})
		}

	case ipc.TypeWatchdogPong:
		// Health check response — logged by the caller
	}
}

func handleFailoverCommand(cmd watchdog.FailoverCommand, wd *watchdog.Watchdog, journal *watchdog.Journal, recovery *watchdog.RecoveryManager, client *watchdog.FailoverClient, cfg *config.Config) {
	journal.Log(watchdog.LevelInfo, "failover_command", map[string]any{"type": cmd.Type, "id": cmd.ID})

	switch cmd.Type {
	case "restart_agent":
		recovery.Reset()
		wd.HandleEvent(watchdog.EventAgentUnhealthy) // triggers RECOVERING from FAILOVER... actually we need to go to RECOVERING
		// Force a recovery attempt
		_, err := recovery.Attempt(0)
		result := "completed"
		errMsg := ""
		if err != nil {
			result = "failed"
			errMsg = err.Error()
		}
		client.SubmitCommandResult(cmd.ID, result, nil, errMsg)

	case "start_agent":
		wd.HandleEvent(watchdog.EventStartAgent)
		client.SubmitCommandResult(cmd.ID, "completed", nil, "")

	case "collect_diagnostics":
		entries, _ := journal.ReadFromDisk()
		client.ShipLogs(entries)
		client.SubmitCommandResult(cmd.ID, "completed", map[string]any{"entriesShipped": len(entries)}, "")

	case "update_agent":
		targetVersion, _ := cmd.Payload["version"].(string)
		if targetVersion == "" {
			client.SubmitCommandResult(cmd.ID, "failed", nil, "missing version in payload")
			return
		}
		u := &updater.Updater{Config: &updater.Config{
			ServerURL:      cfg.ServerURL,
			AuthToken:      cfg.AuthToken,
			CurrentVersion: "unknown",
			BinaryPath:     agentBinaryPath(), // platform-specific: /usr/local/bin/breeze-agent
			BackupPath:     agentBinaryPath() + ".backup",
		}}
		if err := u.UpdateTo(targetVersion); err != nil {
			client.SubmitCommandResult(cmd.ID, "failed", nil, err.Error())
			return
		}
		recovery.Reset()
		startAgentService()
		client.SubmitCommandResult(cmd.ID, "completed", map[string]any{"updatedTo": targetVersion}, "")

	case "update_watchdog":
		targetVersion, _ := cmd.Payload["version"].(string)
		if targetVersion == "" {
			client.SubmitCommandResult(cmd.ID, "failed", nil, "missing version in payload")
			return
		}
		u := &updater.Updater{Config: &updater.Config{
			ServerURL:      cfg.ServerURL,
			AuthToken:      cfg.AuthToken,
			CurrentVersion: version,
			BinaryPath:     watchdogBinaryPath(), // platform-specific: /usr/local/bin/breeze-watchdog
			BackupPath:     watchdogBinaryPath() + ".backup",
		}}
		if err := u.UpdateTo(targetVersion); err != nil {
			client.SubmitCommandResult(cmd.ID, "failed", nil, err.Error())
			return
		}
		client.SubmitCommandResult(cmd.ID, "completed", map[string]any{"updatedTo": targetVersion}, "")
		// Restart self via service manager (this process will be killed)
		restartWatchdogService()

	default:
		client.SubmitCommandResult(cmd.ID, "failed", nil, fmt.Sprintf("unknown command: %s", cmd.Type))
	}
}

func statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show watchdog status",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load("")
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}

			// Read agent state file
			statePath := state.PathInDir(config.ConfigDir())
			agentState, _ := state.Read(statePath)

			fmt.Println("=== Breeze Watchdog Status ===")
			fmt.Printf("Watchdog version:  %s\n", version)

			if agentState != nil {
				fmt.Printf("Agent status:      %s\n", agentState.Status)
				fmt.Printf("Agent PID:         %d\n", agentState.PID)
				fmt.Printf("Agent version:     %s\n", agentState.Version)
				if !agentState.LastHeartbeat.IsZero() {
					fmt.Printf("Last heartbeat:    %s (%s ago)\n", agentState.LastHeartbeat.Format(time.RFC3339), time.Since(agentState.LastHeartbeat).Round(time.Second))
				}
			} else {
				fmt.Println("Agent status:      unknown (no state file)")
			}

			// Check IPC socket
			socketPath := cfg.IPCSocketPath
			if socketPath == "" {
				socketPath = ipc.DefaultSocketPath()
			}
			if _, err := os.Stat(socketPath); err == nil {
				fmt.Printf("IPC socket:        %s (exists)\n", socketPath)
			} else {
				fmt.Printf("IPC socket:        %s (not found)\n", socketPath)
			}

			return nil
		},
	}
}

func healthJournalCmd() *cobra.Command {
	var count int

	cmd := &cobra.Command{
		Use:   "health-journal",
		Short: "Show recent health journal entries",
		RunE: func(cmd *cobra.Command, args []string) error {
			logDir := config.LogDir()
			j, err := watchdog.NewJournal(logDir, 10, 3)
			if err != nil {
				return err
			}
			defer j.Close()

			entries, err := j.ReadFromDisk()
			if err != nil {
				return err
			}

			start := 0
			if len(entries) > count {
				start = len(entries) - count
			}
			for _, e := range entries[start:] {
				fmt.Printf("[%s] %s: %s %v\n", e.Time.Format(time.RFC3339), e.Level, e.Event, e.Data)
			}
			return nil
		},
	}
	cmd.Flags().IntVarP(&count, "count", "n", 50, "Number of entries to show")
	return cmd
}

func triggerFailoverCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "trigger-failover",
		Short: "Force transition to FAILOVER state (dev/testing)",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println("trigger-failover: not implemented yet — requires IPC to running watchdog")
			return nil
		},
	}
}

func triggerRecoveryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "trigger-recovery",
		Short: "Force a recovery attempt (dev/testing)",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println("trigger-recovery: not implemented yet — requires IPC to running watchdog")
			return nil
		},
	}
}
```

Note: This file imports `encoding/json` and `fmt` — add those to the import block.

- [ ] **Step 2: Create macOS service commands**

Create `agent/cmd/breeze-watchdog/service_cmd_darwin.go`:

```go
//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

const (
	watchdogBinaryPath = "/usr/local/bin/breeze-watchdog"
	watchdogPlistDst   = "/Library/LaunchDaemons/com.breeze.watchdog.plist"
	watchdogLabel      = "com.breeze.watchdog"
)

const watchdogPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.breeze.watchdog</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/local/bin/breeze-watchdog</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>WorkingDirectory</key>
	<string>/Library/Application Support/Breeze</string>
	<key>StandardOutPath</key>
	<string>/Library/Logs/Breeze/watchdog.log</string>
	<key>StandardErrorPath</key>
	<string>/Library/Logs/Breeze/watchdog.err</string>
</dict>
</plist>`

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the watchdog system service",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "install",
		Short: "Install watchdog as a LaunchDaemon",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root")
			}

			// Stop existing if loaded
			exec.Command("launchctl", "bootout", "system/"+watchdogLabel).Run()

			// Copy binary
			src, err := os.Executable()
			if err != nil {
				return fmt.Errorf("get executable: %w", err)
			}
			data, err := os.ReadFile(src)
			if err != nil {
				return fmt.Errorf("read binary: %w", err)
			}
			if err := os.WriteFile(watchdogBinaryPath, data, 0755); err != nil {
				return fmt.Errorf("write binary: %w", err)
			}

			// Write plist
			if err := os.WriteFile(watchdogPlistDst, []byte(watchdogPlist), 0644); err != nil {
				return fmt.Errorf("write plist: %w", err)
			}

			// Load
			if err := exec.Command("launchctl", "bootstrap", "system", watchdogPlistDst).Run(); err != nil {
				exec.Command("launchctl", "load", watchdogPlistDst).Run()
			}

			fmt.Println("Watchdog service installed and started.")
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall watchdog LaunchDaemon",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root")
			}
			exec.Command("launchctl", "bootout", "system/"+watchdogLabel).Run()
			os.Remove(watchdogPlistDst)
			os.Remove(watchdogBinaryPath)
			fmt.Println("Watchdog service uninstalled.")
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use: "start", Short: "Start watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return exec.Command("launchctl", "kickstart", "system/"+watchdogLabel).Run()
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use: "stop", Short: "Stop watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return exec.Command("launchctl", "bootout", "system/"+watchdogLabel).Run()
		},
	})

	return cmd
}
```

- [ ] **Step 3: Create Linux service commands**

Create `agent/cmd/breeze-watchdog/service_cmd_linux.go`:

```go
//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

const (
	watchdogBinaryPath = "/usr/local/bin/breeze-watchdog"
	watchdogUnitDst    = "/etc/systemd/system/breeze-watchdog.service"
	watchdogServiceName = "breeze-watchdog"
)

const watchdogUnit = `[Unit]
Description=Breeze RMM Agent Watchdog
After=breeze-agent.service
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/usr/local/bin/breeze-watchdog run
WorkingDirectory=/etc/breeze
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-watchdog
LimitNOFILE=1024

[Install]
WantedBy=multi-user.target
`

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the watchdog system service",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "install",
		Short: "Install watchdog as a systemd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root")
			}

			// Copy binary
			src, err := os.Executable()
			if err != nil {
				return fmt.Errorf("get executable: %w", err)
			}
			data, err := os.ReadFile(src)
			if err != nil {
				return fmt.Errorf("read binary: %w", err)
			}
			if err := os.WriteFile(watchdogBinaryPath, data, 0755); err != nil {
				return fmt.Errorf("write binary: %w", err)
			}

			// Write unit
			if err := os.WriteFile(watchdogUnitDst, []byte(watchdogUnit), 0644); err != nil {
				return fmt.Errorf("write unit: %w", err)
			}

			exec.Command("systemctl", "daemon-reload").Run()
			exec.Command("systemctl", "enable", watchdogServiceName).Run()
			exec.Command("systemctl", "start", watchdogServiceName).Run()

			fmt.Println("Watchdog service installed and started.")
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall watchdog systemd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root")
			}
			exec.Command("systemctl", "stop", watchdogServiceName).Run()
			exec.Command("systemctl", "disable", watchdogServiceName).Run()
			os.Remove(watchdogUnitDst)
			exec.Command("systemctl", "daemon-reload").Run()
			os.Remove(watchdogBinaryPath)
			fmt.Println("Watchdog service uninstalled.")
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use: "start", Short: "Start watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return exec.Command("systemctl", "start", watchdogServiceName).Run()
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use: "stop", Short: "Stop watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			return exec.Command("systemctl", "stop", watchdogServiceName).Run()
		},
	})

	return cmd
}
```

- [ ] **Step 4: Create Windows service commands**

Create `agent/cmd/breeze-watchdog/service_cmd_windows.go`:

```go
//go:build windows

package main

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/sys/windows/svc/mgr"
)

const watchdogWindowsServiceName = "BreezeWatchdog"

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the watchdog Windows service",
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "install",
		Short: "Install watchdog as a Windows service",
		RunE: func(cmd *cobra.Command, args []string) error {
			exePath, _ := os.Executable()
			m, err := mgr.Connect()
			if err != nil {
				return fmt.Errorf("connect to SCM: %w", err)
			}
			defer m.Disconnect()

			s, err := m.CreateService(
				watchdogWindowsServiceName,
				exePath,
				mgr.Config{
					DisplayName:  "Breeze RMM Watchdog",
					Description:  "Monitors and recovers the Breeze RMM Agent",
					StartType:    mgr.StartAutomatic,
					ErrorControl: mgr.ErrorNormal,
				},
				"run",
			)
			if err != nil {
				return fmt.Errorf("create service: %w", err)
			}
			defer s.Close()

			s.SetRecoveryActions([]mgr.RecoveryAction{
				{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
				{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
				{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
			}, 86400)

			fmt.Println("Watchdog service installed.")
			return nil
		},
	})

	cmd.AddCommand(&cobra.Command{
		Use: "uninstall", Short: "Uninstall watchdog Windows service",
		RunE: func(cmd *cobra.Command, args []string) error {
			m, _ := mgr.Connect()
			defer m.Disconnect()
			s, _ := m.OpenService(watchdogWindowsServiceName)
			defer s.Close()
			return s.Delete()
		},
	})

	return cmd
}
```

- [ ] **Step 5: Verify build**

Run: `cd agent && go build ./cmd/breeze-watchdog/...`
Expected: clean build (may need to add missing imports — fix any errors)

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-watchdog/
git commit -m "feat(watchdog): add CLI entry point with service install/uninstall for all platforms"
```

---

## Task 14: Database Migration

**Files:**
- Create: `apps/api/migrations/NNNN-watchdog-columns.sql`
- Modify: `apps/api/src/db/schema/devices.ts`
- Modify: `apps/api/src/db/schema/enums.ts`

- [ ] **Step 1: Determine next migration number**

Run: `ls apps/api/migrations/*.sql | tail -5`
Use the next available 4-digit number.

- [ ] **Step 2: Write idempotent migration**

Create `apps/api/migrations/NNNN-watchdog-columns.sql` (replace NNNN with actual number):

```sql
-- Watchdog status enum
DO $$ BEGIN
    CREATE TYPE watchdog_status AS ENUM ('connected', 'failover', 'offline');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add watchdog columns to devices
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_status watchdog_status;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_last_seen timestamp;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_version varchar(50);

-- Add target_role to device_commands (defaults to 'agent' for backward compat)
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS target_role varchar(20) NOT NULL DEFAULT 'agent';

-- Index for command polling filtered by role
CREATE INDEX IF NOT EXISTS idx_device_commands_target_role ON device_commands (device_id, target_role, status) WHERE status = 'pending';
```

- [ ] **Step 3: Update Drizzle schema — enums**

In `apps/api/src/db/schema/enums.ts`, add:

```typescript
export const watchdogStatusEnum = pgEnum('watchdog_status', ['connected', 'failover', 'offline']);
```

- [ ] **Step 4: Update Drizzle schema — devices table**

In `apps/api/src/db/schema/devices.ts`, add columns to the `devices` table:

```typescript
watchdogStatus: watchdogStatusEnum('watchdog_status'),
watchdogLastSeen: timestamp('watchdog_last_seen'),
watchdogVersion: varchar('watchdog_version', { length: 50 }),
```

- [ ] **Step 5: Update Drizzle schema — device_commands table**

In `apps/api/src/db/schema/devices.ts`, add to `deviceCommands`:

```typescript
targetRole: varchar('target_role', { length: 20 }).notNull().default('agent'),
```

- [ ] **Step 6: Verify schema drift**

Run: `pnpm db:check-drift`
Expected: no drift

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/NNNN-watchdog-columns.sql apps/api/src/db/schema/devices.ts apps/api/src/db/schema/enums.ts
git commit -m "feat(db): add watchdog status columns and command target_role"
```

---

## Task 15: API Heartbeat & Command Routing

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`

- [ ] **Step 1: Handle watchdog heartbeats**

In `apps/api/src/routes/agents/heartbeat.ts`, in the heartbeat POST handler, after validating the device, add a check for watchdog role:

```typescript
const isWatchdog = data.role === 'watchdog';

if (isWatchdog) {
  // Update watchdog-specific columns only
  await db.update(devices)
    .set({
      watchdogStatus: data.watchdogState === 'FAILOVER' ? 'failover' : 'connected',
      watchdogLastSeen: new Date(),
      watchdogVersion: data.agentVersion,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  // Check for watchdog-targeted commands
  const commands = await db.select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, device.id),
        eq(deviceCommands.targetRole, 'watchdog'),
        eq(deviceCommands.status, 'pending'),
      )
    )
    .limit(10);

  // Check for watchdog upgrade
  let watchdogUpgradeTo: string | undefined;
  const latestWatchdog = await db.select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.component, 'watchdog'),
        eq(agentVersions.isLatest, true),
      )
    )
    .limit(1);
  if (latestWatchdog.length > 0 && data.agentVersion) {
    if (compareAgentVersions(data.agentVersion, latestWatchdog[0].version) < 0) {
      watchdogUpgradeTo = latestWatchdog[0].version;
    }
  }

  return c.json({
    commands: commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: cmd.payload,
    })),
    watchdogUpgradeTo,
  });
}

// ... existing agent heartbeat logic continues below
```

- [ ] **Step 2: Add watchdogUpgradeTo to agent heartbeat response**

In the existing agent heartbeat response (around line 282), add:

```typescript
// After helperUpgradeTo logic
let watchdogUpgradeTo: string | undefined;
const latestWatchdog = await db.select()
  .from(agentVersions)
  .where(
    and(
      eq(agentVersions.component, 'watchdog'),
      eq(agentVersions.isLatest, true),
    )
  )
  .limit(1);
if (latestWatchdog.length > 0) {
  const current = deviceUpdates.watchdogVersion as string | undefined;
  if (current && compareAgentVersions(current, latestWatchdog[0].version) < 0) {
    watchdogUpgradeTo = latestWatchdog[0].version;
  }
}
```

Add `watchdogUpgradeTo` to the response JSON.

- [ ] **Step 3: Filter commands by target_role**

In `apps/api/src/routes/agents/commands.ts`, update the command polling query to filter by role:

```typescript
// In the command claim/poll function
const targetRole = c.req.query('role') === 'watchdog' ? 'watchdog' : 'agent';

// Add to the WHERE clause:
eq(deviceCommands.targetRole, targetRole),
```

- [ ] **Step 4: Verify build**

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean (or only pre-existing errors)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/commands.ts
git commit -m "feat(api): handle watchdog heartbeats and filter commands by target_role"
```

---

## Task 16: Build System & Install Scripts

**Files:**
- Modify: `agent/Makefile`
- Modify: `scripts/install/install-darwin.sh`
- Modify: `scripts/install/install-linux.sh`

- [ ] **Step 1: Add Makefile targets**

Add to `agent/Makefile`:

```makefile
# Watchdog targets
build-watchdog:
	go build $(LDFLAGS) -o bin/breeze-watchdog ./cmd/breeze-watchdog

build-watchdog-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-linux-amd64 ./cmd/breeze-watchdog
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-watchdog-linux-arm64 ./cmd/breeze-watchdog

build-watchdog-darwin:
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-darwin-amd64 ./cmd/breeze-watchdog
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-watchdog-darwin-arm64 ./cmd/breeze-watchdog

build-watchdog-windows:
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-watchdog-windows-amd64.exe ./cmd/breeze-watchdog

dev-push-watchdog: build-watchdog
	@echo "dev-push-watchdog: uploading watchdog binary..."
	@# Same pattern as dev-push but with type=watchdog
	curl -s -X POST $(API_URL)/api/v1/dev/push \
		-H "Authorization: Bearer $(AUTH_TOKEN)" \
		-F "agentId=$(DEVICE)" \
		-F "version=$(DEV_VERSION)" \
		-F "type=watchdog" \
		-F "binary=@bin/breeze-watchdog" | python3 -m json.tool

dev-push-both:
	$(MAKE) dev-push DEVICE=$(DEVICE)
	$(MAKE) dev-push-watchdog DEVICE=$(DEVICE)
```

- [ ] **Step 2: Update macOS install script**

In `scripts/install/install-darwin.sh`, add after the agent binary copy:

```bash
# Install watchdog
if [ -f "bin/breeze-watchdog" ]; then
    echo "Installing watchdog..."
    sudo cp bin/breeze-watchdog /usr/local/bin/breeze-watchdog
    sudo chmod 755 /usr/local/bin/breeze-watchdog
    sudo cp installer/com.breeze.watchdog.plist /Library/LaunchDaemons/
    sudo launchctl bootstrap system /Library/LaunchDaemons/com.breeze.watchdog.plist || \
        sudo launchctl load /Library/LaunchDaemons/com.breeze.watchdog.plist
    echo "Watchdog installed."
fi
```

- [ ] **Step 3: Update Linux install script**

In `scripts/install/install-linux.sh`, add after the agent binary copy:

```bash
# Install watchdog
if [ -f "bin/breeze-watchdog" ]; then
    echo "Installing watchdog..."
    sudo cp bin/breeze-watchdog /usr/local/bin/breeze-watchdog
    sudo chmod 755 /usr/local/bin/breeze-watchdog
    sudo cp installer/breeze-watchdog.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable breeze-watchdog
    sudo systemctl start breeze-watchdog
    echo "Watchdog installed."
fi
```

- [ ] **Step 4: Verify Makefile**

Run: `cd agent && make build-watchdog`
Expected: `bin/breeze-watchdog` binary created

- [ ] **Step 5: Commit**

```bash
git add agent/Makefile scripts/install/install-darwin.sh scripts/install/install-linux.sh
git commit -m "feat(build): add watchdog build targets and update install scripts"
```

---

## Task 17: Watchdog Logs API Route

**Files:**
- Create: `apps/api/src/routes/agents/watchdogLogs.ts`
- Modify: `apps/api/src/routes/agents/index.ts` (or wherever routes are mounted)

- [ ] **Step 1: Create watchdog logs route**

Create `apps/api/src/routes/agents/watchdogLogs.ts`:

```typescript
import { Hono } from 'hono';
import { eq, and, desc, gte, lte, ilike } from 'drizzle-orm';
import { db } from '../../db';
import { agentLogs } from '../../db/schema/devices';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const watchdogLogsRoutes = new Hono();

const querySchema = z.object({
  component: z.string().optional(),
  level: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
});

watchdogLogsRoutes.get('/:id/watchdog-logs', zValidator('query', querySchema), async (c) => {
  const deviceId = c.req.param('id');
  const { component, level, since, until, search, limit } = c.req.valid('query');

  const conditions = [
    eq(agentLogs.deviceId, deviceId),
    eq(agentLogs.source, 'watchdog'),
  ];

  if (component) conditions.push(eq(agentLogs.component, component));
  if (level) conditions.push(eq(agentLogs.level, level));
  if (since) conditions.push(gte(agentLogs.timestamp, new Date(since)));
  if (until) conditions.push(lte(agentLogs.timestamp, new Date(until)));
  if (search) conditions.push(ilike(agentLogs.message, `%${search}%`));

  const logs = await db.select()
    .from(agentLogs)
    .where(and(...conditions))
    .orderBy(desc(agentLogs.timestamp))
    .limit(limit);

  return c.json({ logs, total: logs.length });
});
```

- [ ] **Step 2: Mount the route**

In the agents route index file, add:

```typescript
import { watchdogLogsRoutes } from './watchdogLogs';

// Mount alongside other device routes
app.route('/devices', watchdogLogsRoutes);
```

- [ ] **Step 3: Verify build**

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean (or only pre-existing errors)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/agents/watchdogLogs.ts apps/api/src/routes/agents/index.ts
git commit -m "feat(api): add GET /devices/:id/watchdog-logs endpoint"
```

---

## Summary

| Task | Description | Files Changed |
|------|-------------|---------------|
| 1 | IPC message types | `ipc/message.go` |
| 2 | State file package | `internal/state/` (new) |
| 3 | Watchdog config section | `config/config.go` |
| 4 | Agent state file integration | `main.go`, `heartbeat.go` |
| 5 | Broker watchdog role | `sessionbroker/broker.go` |
| 6 | Agent shutdown intent | `heartbeat.go`, `main.go` |
| 7 | Health journal | `internal/watchdog/journal.go` (new) |
| 8 | State machine | `internal/watchdog/watchdog.go` (new) |
| 9 | Health checks | `internal/watchdog/checks.go` (new) |
| 10 | Recovery logic | `internal/watchdog/recovery*.go` (new) |
| 11 | Failover HTTP client | `internal/watchdog/failover.go` (new) |
| 12 | IPC client | `internal/watchdog/ipcclient.go` (new) |
| 13 | CLI & service commands | `cmd/breeze-watchdog/` (new) |
| 14 | Database migration | migration SQL, schema TS |
| 15 | API heartbeat & commands | `heartbeat.ts`, `commands.ts` |
| 16 | Build system & install | `Makefile`, install scripts |
| 17 | Watchdog logs API | `watchdogLogs.ts` (new) |

**Dependencies:** Tasks 1-3 are foundational (no deps). Tasks 4-6 depend on 1-2. Tasks 7-12 depend on 1-3. Task 13 depends on 7-12. Tasks 14-15 are independent of Go work. Task 16 depends on 13. Task 17 depends on 14.
