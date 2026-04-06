# Backup Binary Split Design

## Context

The enterprise backup implementation (Phases 1-7) added VSS, system state, MSSQL, Hyper-V, BMR, and three cloud storage SDKs (Azure, GCS, B2) to the Go agent. This bloats the main agent binary from ~15MB to ~30MB+ and adds code that only ~20% of deployed agents need. The backup functionality should be extracted to a separate `breeze-backup` binary that the main agent spawns on demand via IPC.

## Architecture

### Two Binaries

| Binary | Entry Point | Size | Deployed To |
|--------|------------|------|-------------|
| `breeze-agent` | `cmd/breeze-agent/main.go` | ~15MB (no backup imports) | All devices |
| `breeze-backup` | `cmd/breeze-backup/main.go` | ~15-20MB (all backup packages + SDKs) | Devices with backup policies |

### Shared IPC Package

`agent/internal/backupipc/` — imported by both binaries, contains only:
- Message type constants (`backup_command`, `backup_result`, `backup_progress`)
- Request/result structs (`BackupCommandRequest`, `BackupCommandResult`, `BackupProgress`)
- No heavy dependencies — just `encoding/json` and basic types

## Command Flow

```
API → WebSocket → breeze-agent (heartbeat handler)
  → Detects backup command
  → Spawns or connects to breeze-backup via IPC
  → Forwards command payload
  → breeze-backup executes (VSS, file collect, MSSQL, Hyper-V, etc.)
  → Progress updates streamed back via IPC → relayed to API via WebSocket
  → Final result via IPC → reported to API
```

## Spawning Strategy

Follows the existing userhelper pattern (`internal/sessionbroker/`):

- Main agent spawns `breeze-backup` as a **long-running helper** (not per-command)
- Backup helper connects back via IPC socket, authenticates with HMAC
- Stays alive while backup schedule is active; exits after **30 min idle timeout**
- Re-spawned on next backup command if not running
- **Crash recovery**: main agent detects IPC disconnect, re-spawns on next command
- Only one backup helper instance at a time (mutex in broker)

## What Moves to breeze-backup

| Package | Description |
|---------|-------------|
| `backup/` | BackupManager, snapshot, compression |
| `backup/vss/` | VSS COM requestor, writer enumeration |
| `backup/providers/` | Local, S3, Azure, GCS, B2 |
| `backup/systemstate/` | OS state collectors (Windows/macOS/Linux) |
| `backup/bmr/` | Bare metal recovery orchestrator |
| `backup/mssql/` | SQL Server discovery, backup, restore |
| `backup/hyperv/` | Hyper-V VM discovery, export, import |

## What Stays in breeze-agent

| Component | Purpose |
|-----------|---------|
| `internal/backupipc/` | Shared IPC message types (tiny, no SDK deps) |
| Heartbeat handlers | Thin IPC forwarders — receive command, forward to backup binary, relay result |
| Config fields | `BackupEnabled`, `BackupBinaryPath` |
| Session broker extension | Backup helper connection management (follows existing helper pattern) |

## Heartbeat Handler Refactor

Current handlers call backup packages directly. After the split, they become IPC forwarders:

```go
// Before (direct call):
func handleBackupRun(h *Heartbeat, cmd Command) tools.CommandResult {
    job, err := h.backupMgr.RunBackup()
    // ...
}

// After (IPC forward):
func handleBackupRun(h *Heartbeat, cmd Command) tools.CommandResult {
    session, err := h.getOrSpawnBackupHelper()
    if err != nil {
        return tools.NewErrorResult(err, 0)
    }
    return session.ForwardCommand(cmd, 10*time.Minute)
}
```

All backup-specific logic moves to the backup binary's command loop.

## breeze-backup Binary Structure

```go
// cmd/breeze-backup/main.go
func main() {
    // 1. Read agent config (for IPC socket path, server URL, auth token)
    // 2. Connect to main agent via IPC
    // 3. Authenticate (HMAC handshake)
    // 4. Report capabilities (backup types supported)
    // 5. Enter command loop — receive commands, execute, return results
    // 6. Idle timeout → graceful exit
}
```

The command loop routes by command type:
- `backup_run` → BackupManager.RunBackup() (with VSS if Windows)
- `backup_restore` → restore flow
- `backup_verify`, `backup_test_restore` → verification
- `vss_status`, `vss_writer_list` → VSS queries
- `mssql_*` → MSSQL operations
- `hyperv_*` → Hyper-V operations
- `system_state_collect`, `hardware_profile` → system state
- `bmr_recover`, `vm_restore_*` → BMR operations

## IPC Message Types

```go
// agent/internal/backupipc/types.go
package backupipc

const (
    TypeBackupCommand  = "backup_command"   // agent → backup: execute a command
    TypeBackupResult   = "backup_result"    // backup → agent: command result
    TypeBackupProgress = "backup_progress"  // backup → agent: progress update
    TypeBackupReady    = "backup_ready"     // backup → agent: ready to accept commands
    TypeBackupShutdown = "backup_shutdown"  // agent → backup: graceful shutdown
)

type BackupCommandRequest struct {
    CommandID   string          `json:"commandId"`
    CommandType string          `json:"commandType"`
    Payload     json.RawMessage `json:"payload"`
    TimeoutMs   int64           `json:"timeoutMs"`
}

type BackupCommandResult struct {
    CommandID string `json:"commandId"`
    Success   bool   `json:"success"`
    Stdout    string `json:"stdout"`
    Stderr    string `json:"stderr"`
    DurationMs int64 `json:"durationMs"`
}

type BackupProgress struct {
    CommandID string  `json:"commandId"`
    Phase     string  `json:"phase"`
    Current   int64   `json:"current"`
    Total     int64   `json:"total"`
    Message   string  `json:"message,omitempty"`
}
```

## Broker Extension

Extend `internal/sessionbroker/broker.go` to manage backup helper:

```go
func (b *Broker) GetOrSpawnBackupHelper() (*Session, error)
func (b *Broker) SpawnBackupHelper() error
func (b *Broker) StopBackupHelper() error
```

The backup helper gets a dedicated session type (not mixed with user/system helpers). Auth follows the same HMAC handshake, binary hash verification, and sequence number validation.

## Config Changes

```go
// agent/internal/config/config.go
BackupBinaryPath string `mapstructure:"backup_binary_path"` // default: adjacent to agent binary
BackupHelperIdleTimeoutMinutes int `mapstructure:"backup_helper_idle_timeout_minutes"` // default: 30
```

## Build System

```makefile
build:
	go build -o bin/breeze-agent ./cmd/breeze-agent
	go build -o bin/breeze-backup ./cmd/breeze-backup

build-all:
	# Cross-platform builds for both binaries
	GOOS=windows GOARCH=amd64 go build -o bin/breeze-agent.exe ./cmd/breeze-agent
	GOOS=windows GOARCH=amd64 go build -o bin/breeze-backup.exe ./cmd/breeze-backup
	GOOS=darwin GOARCH=arm64 go build -o bin/breeze-agent-darwin ./cmd/breeze-agent
	GOOS=darwin GOARCH=arm64 go build -o bin/breeze-backup-darwin ./cmd/breeze-backup
	GOOS=linux GOARCH=amd64 go build -o bin/breeze-agent-linux ./cmd/breeze-agent
	GOOS=linux GOARCH=amd64 go build -o bin/breeze-backup-linux ./cmd/breeze-backup
```

## Deployment

- Agent installer always includes `breeze-agent`
- `breeze-backup` is an optional component, installed when backup feature is enabled via policy
- API pushes `breeze-backup` binary via the existing agent update mechanism
- Default path: same directory as `breeze-agent` (auto-detected)
- Override via config: `backup_binary_path`

## Implementation Sequence

| Step | What | Files |
|------|------|-------|
| 1 | Create `internal/backupipc/` shared types package | `types.go` |
| 2 | Create `cmd/breeze-backup/main.go` entry point | IPC client, command loop, idle timeout |
| 3 | Refactor heartbeat handlers to IPC forwarders | All `handlers_backup*.go`, `handlers_vss*.go`, `handlers_mssql*.go`, `handlers_hyperv*.go`, `handlers_systemstate.go`, `handlers_bmr.go` |
| 4 | Extend session broker for backup helper | `broker.go` additions |
| 5 | Add config fields | `config.go` |
| 6 | Update Makefile | Build targets for both binaries |
| 7 | Remove direct backup imports from main agent | Verify `breeze-agent` no longer imports heavy packages |
| 8 | Test: build both binaries, verify sizes, IPC round-trip | Integration test |

## Verification

- `breeze-agent` binary does NOT import `azure-sdk`, `cloud.google.com/go`, `blazer`, `go-ole` (for VSS COM)
- `breeze-backup` binary includes all backup functionality
- IPC round-trip: agent sends backup_command → backup binary executes → returns result
- Idle timeout: backup binary exits after 30 min with no commands
- Crash recovery: kill backup binary mid-operation → agent re-spawns on next command
