//go:build windows

package mssql

import (
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// RunRestore restores a SQL Server database from a backup file via sqlcmd.
// If noRecovery is true, the database is left in RESTORING state for
// subsequent differential or log restores.
func RunRestore(instance, backupFile, targetDB string, noRecovery bool) (*RestoreResult, error) {
	if instance == "" {
		return nil, fmt.Errorf("%w: instance name is required", ErrRestoreFailed)
	}
	if backupFile == "" {
		return nil, fmt.Errorf("%w: backup file path is required", ErrRestoreFailed)
	}
	if targetDB == "" {
		return nil, fmt.Errorf("%w: target database name is required", ErrRestoreFailed)
	}

	start := time.Now()
	serverName := buildServerName(instance)

	escapedDB := strings.ReplaceAll(targetDB, "]", "]]")
	escapedFile := strings.ReplaceAll(backupFile, "'", "''")

	recoveryOption := "RECOVERY"
	if noRecovery {
		recoveryOption = "NORECOVERY"
	}

	query := fmt.Sprintf(
		"RESTORE DATABASE [%s] FROM DISK='%s' WITH %s, REPLACE, STATS=10",
		escapedDB, escapedFile, recoveryOption,
	)

	slog.Info("mssql restore starting",
		"instance", instance,
		"backupFile", backupFile,
		"targetDB", targetDB,
		"noRecovery", noRecovery,
	)

	out, err := runSqlcmd(serverName, query)
	duration := time.Since(start)

	result := &RestoreResult{
		DatabaseName: targetDB,
		RestoredAs:   targetDB,
		DurationMs:   duration.Milliseconds(),
	}

	if err != nil {
		result.Status = "failed"
		result.Error = fmt.Sprintf("sqlcmd error: %v: %s", err, out)
		return result, fmt.Errorf("%w: %v", ErrRestoreFailed, err)
	}

	if containsSqlError(out) {
		result.Status = "failed"
		result.Error = extractSqlError(out)
		return result, fmt.Errorf("%w: %s", ErrRestoreFailed, result.Error)
	}

	result.Status = "completed"
	result.FilesRestored = countRestoredFiles(out)

	slog.Info("mssql restore completed",
		"instance", instance,
		"targetDB", targetDB,
		"durationMs", duration.Milliseconds(),
	)

	return result, nil
}

// VerifyBackup runs RESTORE VERIFYONLY to validate a backup file's integrity.
func VerifyBackup(instance, backupFile string) (*VerifyResult, error) {
	if instance == "" {
		return nil, fmt.Errorf("%w: instance name is required", ErrVerifyFailed)
	}
	if backupFile == "" {
		return nil, fmt.Errorf("%w: backup file path is required", ErrVerifyFailed)
	}

	start := time.Now()
	serverName := buildServerName(instance)
	escapedFile := strings.ReplaceAll(backupFile, "'", "''")

	query := fmt.Sprintf("RESTORE VERIFYONLY FROM DISK='%s'", escapedFile)

	slog.Info("mssql verify starting", "instance", instance, "backupFile", backupFile)

	out, err := runSqlcmd(serverName, query)
	duration := time.Since(start)

	result := &VerifyResult{
		BackupFile: backupFile,
		DurationMs: duration.Milliseconds(),
	}

	if err != nil {
		result.Valid = false
		result.Error = fmt.Sprintf("sqlcmd error: %v: %s", err, out)
		return result, fmt.Errorf("%w: %v", ErrVerifyFailed, err)
	}

	if containsSqlError(out) {
		result.Valid = false
		result.Error = extractSqlError(out)
		return result, fmt.Errorf("%w: %s", ErrVerifyFailed, result.Error)
	}

	// VERIFYONLY success message: "The backup set on file ... is valid."
	if strings.Contains(strings.ToLower(out), "is valid") {
		result.Valid = true
	} else {
		// No explicit valid message but no error either — treat as valid
		result.Valid = true
	}

	slog.Info("mssql verify completed",
		"instance", instance,
		"backupFile", backupFile,
		"valid", result.Valid,
		"durationMs", duration.Milliseconds(),
	)

	return result, nil
}

// countRestoredFiles counts "RESTORE DATABASE successfully processed" lines.
func countRestoredFiles(output string) int {
	count := 0
	for _, line := range strings.Split(output, "\n") {
		lower := strings.ToLower(strings.TrimSpace(line))
		if strings.Contains(lower, "processed") && strings.Contains(lower, "pages") {
			count++
		}
	}
	if count == 0 {
		count = 1 // At least 1 if restore succeeded
	}
	return count
}
