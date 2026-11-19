// Package backupipc defines shared IPC message types for communication between
// the main breeze-agent and the breeze-backup helper binary.
package backupipc

import (
	"encoding/json"
	"math"
	"time"
)

// IPC message types for backup helper communication.
const (
	TypeBackupCommand  = "backup_command"
	TypeBackupResult   = "backup_result"
	TypeBackupProgress = "backup_progress"
	TypeBackupReady    = "backup_ready"
	TypeBackupShutdown = "backup_shutdown"

	HelperRoleBackup = "backup"
)

// BackupCapabilities reported by the backup helper on connect.
type BackupCapabilities struct {
	SupportsVSS         bool     `json:"supportsVss"`
	SupportsMSSQL       bool     `json:"supportsMssql"`
	SupportsHyperV      bool     `json:"supportsHyperv"`
	SupportsSystemState bool     `json:"supportsSystemState"`
	SupportsVault       bool     `json:"supportsVault"`
	Providers           []string `json:"providers"` // s3, local, azure, gcs, b2
}

// ProtocolInfoFlag is the breeze-backup flag that prints ProtocolInfo as one
// JSON object and exits. The main agent runs the INSTALLED helper with it to
// learn which storage protocols that binary implements; a helper that
// predates the flag exits non-zero, which the agent reads as version 0.
const ProtocolInfoFlag = "protocol-info"

// ProtocolInfo is the --protocol-info output.
type ProtocolInfo struct {
	// BackupReadProtocolVersion is the brokered storage-read protocol the
	// helper implements (0 = none).
	BackupReadProtocolVersion int `json:"backupReadProtocolVersion"`
	// BackupIntegrityProtocolVersion is the snapshot integrity protocol the
	// helper implements (0 = none).
	BackupIntegrityProtocolVersion int `json:"backupIntegrityProtocolVersion"`
	// BackupWriteProtocolVersion is the brokered storage-write protocol the
	// helper implements (0 = none).
	BackupWriteProtocolVersion int `json:"backupWriteProtocolVersion"`
}

// BackupCommandRequest is sent from the agent to the backup helper.
type BackupCommandRequest struct {
	CommandID   string          `json:"commandId"`
	CommandType string          `json:"commandType"`
	Payload     json.RawMessage `json:"payload"`
	TimeoutMs   int64           `json:"timeoutMs"`
	// Async, when set on a backup_run request, tells the helper to reply to
	// the request envelope immediately with {"started":true} and send the
	// real result later as an unsolicited TypeBackupResult envelope. Only
	// set when the connected server has advertised the backup_run_async
	// capability (see websocket.Client.HasServerCapability) — an old server
	// would otherwise parse the ack as a malformed terminal result.
	Async bool `json:"async,omitempty"`
	// QueueAsync requires backup_queue_async server capability. It extends async
	// delivery to SQL/Hyper-V and acknowledges admission with {"queued":true}.
	// The helper then emits a "queued" progress phase while waiting and a
	// "starting" phase once it has acquired the device slot, immediately
	// before execution begins. Without it the helper executes the command
	// directly (pre-queue behaviour) so a non-queue-aware server's synchronous
	// round trip never blocks behind another workload.
	QueueAsync bool `json:"queueAsync,omitempty"`
}

// Queued workload command types. Only these occupy the per-device execution
// slot; control/status commands (backup_stop, backup_list, ...) never wait.
// Shared by the agent forwarder and the helper so the two lists cannot drift.
const (
	CommandBackupRun    = "backup_run"
	CommandMSSQLBackup  = "mssql_backup"
	CommandHypervBackup = "hyperv_backup"
)

// IsQueuedWorkload reports whether commandType is serialized through the
// per-device backup execution queue.
func IsQueuedWorkload(commandType string) bool {
	switch commandType {
	case CommandBackupRun, CommandMSSQLBackup, CommandHypervBackup:
		return true
	}
	return false
}

// BackupCommandResult is sent from the backup helper to the agent.
type BackupCommandResult struct {
	CommandID  string `json:"commandId"`
	Success    bool   `json:"success"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
}

// BackupProgress is streamed from the backup helper during long operations.
//
// Current/Total are bytes for backup_run; restore keeps its existing meaning
// (see RestoreFromSnapshotContext's progress callback). FilesDone/FilesTotal
// are populated for backup_run, backup_verify and backup_test_restore;
// restore progress doesn't report a file count, hence omitempty. Verify and
// test-restore progress (phase "verifying" / "test_restore") carry manifest
// entries finished in both Current/Total and FilesDone/FilesTotal.
type BackupProgress struct {
	CommandID  string `json:"commandId"`
	Phase      string `json:"phase"`
	Current    int64  `json:"current"` // bytes done (backup_run) — restore keeps its existing meaning
	Total      int64  `json:"total"`   // bytes total
	FilesDone  int    `json:"filesDone,omitempty"`
	FilesTotal int    `json:"filesTotal,omitempty"`
	// VerifiedFiles/VerifiedBytes (backup_run only) count files, and their
	// source bytes, the run has finished checking before deciding whether to
	// upload them: the resume pass over the checkpoint journal and the
	// dedupe pre-pass's re-hash of a file whose modification time moved. They
	// are separate from Current/FilesDone, whose meaning is unchanged; the
	// API counts their movement as progress so a multi-hour check pass is
	// not reaped as wedged (#11014). Cumulative for the run.
	VerifiedFiles int    `json:"verifiedFiles,omitempty"`
	VerifiedBytes int64  `json:"verifiedBytes,omitempty"`
	Message       string `json:"message,omitempty"`
	// SnapshotID is the backup_run snapshot currently being written. Empty
	// until the snapshot is created (pre-scan keepalives) and always empty for
	// restore progress. Sent so the server can persist backup_jobs.snapshot_id
	// while the run is in flight (#3006) instead of learning it only from the
	// terminal result — a result that can be lost in transit (#3001, #2998),
	// stranding the uploaded objects with no restore point.
	SnapshotID string `json:"snapshotId,omitempty"`
}

// VerifyCommandTimeout is the BASE time the agent waits for the helper to
// answer a backup_verify or backup_test_restore: the API's 2 h base budget
// (BACKUP_VERIFY_BASE_BUDGET_MS, apps/api/src/services/backupVerifyBudget.ts),
// used when the command payload carries no timeBudgetSeconds.
//
// VerifyMaxCommandTimeout is the ceiling on that wait. The API scales each
// verification's budget with its snapshot (file count and size) into
// [VerifyCommandTimeout, VerifyMaxCommandTimeout] and sends it as the
// payload's timeBudgetSeconds; ClampVerifyCommandTimeout applies the same
// clamp on this side.
//
// VerifyRunMargin is how much shorter than its wait the helper's run budget
// is: the helper stops each run at (wait - VerifyRunMargin) and reports the
// counts it has so far. The margin leaves room for in-flight downloads to
// unwind, the test-restore directory (possibly hundreds of thousands of files)
// to be removed and the result to cross IPC. Otherwise the agent's wait
// expires first, the late result is discarded, and the server records
// "command timed out" with 0 files ok and 0 failed however much was checked
// (#6598). The helper derives its budget from the IPC request's TimeoutMs, so
// an agent that sends the base wait gets VerifyRunBudget.
// Pinned by types_test.go.
const (
	VerifyCommandTimeout    = 2 * time.Hour
	VerifyMaxCommandTimeout = 12 * time.Hour
	VerifyRunMargin         = 10 * time.Minute
	VerifyRunBudget         = VerifyCommandTimeout - VerifyRunMargin
)

// ClampVerifyCommandTimeout turns a verification command's timeBudgetSeconds
// into the agent's forward wait: clamped to [VerifyCommandTimeout,
// VerifyMaxCommandTimeout]; zero, negative, NaN or infinite is the base.
func ClampVerifyCommandTimeout(budgetSeconds float64) time.Duration {
	if math.IsNaN(budgetSeconds) || math.IsInf(budgetSeconds, 0) || budgetSeconds <= 0 {
		return VerifyCommandTimeout
	}
	// Compare in seconds before converting, so a huge value cannot overflow
	// time.Duration.
	if budgetSeconds >= VerifyMaxCommandTimeout.Seconds() {
		return VerifyMaxCommandTimeout
	}
	d := time.Duration(budgetSeconds * float64(time.Second))
	if d < VerifyCommandTimeout {
		return VerifyCommandTimeout
	}
	return d
}

// BareMetalRebuildForwardTimeout is how long the agent waits for the helper
// to answer a bare_metal_rebuild. It stays under the API's 24 h
// WHOLE_MACHINE_RESTORE_TIMEOUT_MS reaper (commandTimeouts.ts) so the
// helper's own result, not a reaper timeout, is what the server records.
//
// BareMetalRebuildRunBudget is the helper's absolute ceiling on one rebuild.
// It is a backstop, not the usual way a rebuild stops: the helper also
// stops a rebuild that makes no progress for its stall window
// (cmd/breeze-backup/rebuild_budget.go). It MUST stay below the forward
// timeout with room for the engine to unwind, the terminal progress post
// and the result to cross IPC. A fixed 4 h budget here aborted every
// restore of more than about 130k files (#6664).
const (
	BareMetalRebuildForwardTimeout = 23 * time.Hour
	BareMetalRebuildRunBudget      = BareMetalRebuildForwardTimeout - 10*time.Minute
)

// Helper-side run budgets for the long-running VM restore commands. The
// helper bounds each run with its budget (cmd/breeze-backup); the agent's
// forwarder waits the budget plus HelperResultGrace, so the helper's own
// terminal result, not a forwarder timeout, is what the server records. A
// forwarder wait at or below the budget reports "failed" while the restore
// keeps running in the helper. Pinned by heartbeat/handlers_bmr_test.go, which
// also pins BareMetalRebuildForwardTimeout against BareMetalRebuildRunBudget.
const (
	VMRestoreFromBackupRunBudget = 2 * time.Hour
	VMInstantBootRunBudget       = 30 * time.Minute
	HelperResultGrace            = 5 * time.Minute
)

// BackupStopForwardTimeout is how long the agent waits for the helper's
// backup_stop reply. BackupStopDrainTimeout is how long the helper may block
// joining a cancelled workload's unwind before replying; it MUST stay below
// the forward timeout or every drained stop reads as a failed command on the
// server (the reply then arrives unsolicited). Pinned by types_test.go.
const (
	BackupStopForwardTimeout = 30 * time.Second
	BackupStopDrainTimeout   = 20 * time.Second
)
