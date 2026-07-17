// Package backupipc defines shared IPC message types for communication between
// the main breeze-agent and the breeze-backup helper binary.
package backupipc

import "encoding/json"

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
// are populated for backup_run only — restore progress doesn't report a file
// count, hence omitempty.
type BackupProgress struct {
	CommandID  string `json:"commandId"`
	Phase      string `json:"phase"`
	Current    int64  `json:"current"` // bytes done (backup_run) — restore keeps its existing meaning
	Total      int64  `json:"total"`   // bytes total
	FilesDone  int    `json:"filesDone,omitempty"`
	FilesTotal int    `json:"filesTotal,omitempty"`
	Message    string `json:"message,omitempty"`
}
