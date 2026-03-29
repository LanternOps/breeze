// Package mssql provides MSSQL Server backup and restore operations.
// Discovery, backup, and restore are Windows-only; non-Windows platforms
// receive stubs that return ErrMSSQLNotSupported.
package mssql

import "errors"

// Sentinel errors returned by the MSSQL package.
var (
	ErrMSSQLNotSupported = errors.New("mssql: not supported on this platform")
	ErrInstanceNotFound  = errors.New("mssql: SQL Server instance not found")
	ErrBackupFailed      = errors.New("mssql: backup operation failed")
	ErrRestoreFailed     = errors.New("mssql: restore operation failed")
	ErrVerifyFailed      = errors.New("mssql: backup verification failed")
	ErrSqlcmdNotFound    = errors.New("mssql: sqlcmd.exe not found on PATH")
)

// SQLInstance describes a discovered SQL Server instance.
type SQLInstance struct {
	Name      string        `json:"name"`      // e.g. "MSSQLSERVER" or "SQLEXPRESS"
	Version   string        `json:"version"`
	Edition   string        `json:"edition"`
	Port      int           `json:"port"`
	AuthType  string        `json:"authType"`  // windows, sql, mixed
	Databases []SQLDatabase `json:"databases"`
	Status    string        `json:"status"`    // online, offline, unknown
}

// SQLDatabase describes a database within a SQL Server instance.
type SQLDatabase struct {
	Name          string `json:"name"`
	SizeMB        int64  `json:"sizeMb"`
	RecoveryModel string `json:"recoveryModel"` // FULL, SIMPLE, BULK_LOGGED
	TDEEnabled    bool   `json:"tdeEnabled"`
	CompatLevel   int    `json:"compatLevel"`
}

// BackupResult holds the outcome of a MSSQL backup operation.
type BackupResult struct {
	InstanceName string `json:"instanceName"`
	DatabaseName string `json:"databaseName"`
	BackupType   string `json:"backupType"` // full, differential, log
	BackupFile   string `json:"backupFile"`
	SizeBytes    int64  `json:"sizeBytes"`
	Compressed   bool   `json:"compressed"`
	FirstLSN     string `json:"firstLsn"`
	LastLSN      string `json:"lastLsn"`
	DatabaseLSN  string `json:"databaseBackupLsn"`
	DurationMs   int64  `json:"durationMs"`
}

// RestoreResult holds the outcome of a MSSQL restore operation.
type RestoreResult struct {
	DatabaseName  string `json:"databaseName"`
	RestoredAs    string `json:"restoredAs"`
	Status        string `json:"status"` // completed, failed
	FilesRestored int    `json:"filesRestored"`
	DurationMs    int64  `json:"durationMs"`
	Error         string `json:"error,omitempty"`
}

// VerifyResult holds the outcome of a RESTORE VERIFYONLY.
type VerifyResult struct {
	BackupFile string `json:"backupFile"`
	Valid      bool   `json:"valid"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"durationMs"`
}

// ChainState tracks LSN chain continuity for differential / log backup chains.
type ChainState struct {
	InstanceName   string `json:"instanceName"`
	DatabaseName   string `json:"databaseName"`
	LastFullLSN    string `json:"lastFullLsn"`
	LastDiffLSN    string `json:"lastDiffLsn,omitempty"`
	LastLogLSN     string `json:"lastLogLsn,omitempty"`
	FullSnapshotID string `json:"fullSnapshotId"`
	IsActive       bool   `json:"isActive"`
}
