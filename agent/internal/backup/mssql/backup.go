//go:build windows

package mssql

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// RunBackup executes a SQL Server backup via sqlcmd.
//
// Supported backupType values: "full", "differential", "log".
// outputPath is the directory where the .bak/.trn file will be written.
// Returns a BackupResult with file location and LSN chain info.
func RunBackup(instance, database, backupType, outputPath string) (*BackupResult, error) {
	if instance == "" {
		return nil, fmt.Errorf("%w: instance name is required", ErrBackupFailed)
	}
	if database == "" {
		return nil, fmt.Errorf("%w: database name is required", ErrBackupFailed)
	}
	if outputPath == "" {
		return nil, fmt.Errorf("%w: output path is required", ErrBackupFailed)
	}

	start := time.Now()
	serverName := buildServerName(instance)

	// Build backup filename
	timestamp := time.Now().Format("20060102_150405")
	var ext string
	switch backupType {
	case "full":
		ext = ".bak"
	case "differential":
		ext = ".bak"
	case "log":
		ext = ".trn"
	default:
		return nil, fmt.Errorf("%w: unsupported backup type %q", ErrBackupFailed, backupType)
	}
	filename := fmt.Sprintf("%s_%s_%s%s", database, backupType, timestamp, ext)
	backupFile := filepath.Join(outputPath, filename)

	// Ensure output directory exists
	if err := os.MkdirAll(outputPath, 0o755); err != nil {
		return nil, fmt.Errorf("%w: create output dir: %v", ErrBackupFailed, err)
	}

	// Build T-SQL
	query := buildBackupQuery(database, backupFile, backupType)
	slog.Info("mssql backup starting",
		"instance", instance,
		"database", database,
		"type", backupType,
		"file", backupFile,
	)

	out, err := runSqlcmd(serverName, query)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBackupFailed, err)
	}

	// Check for errors in output
	if containsSqlError(out) {
		return nil, fmt.Errorf("%w: %s", ErrBackupFailed, extractSqlError(out))
	}

	duration := time.Since(start)

	// Get file size
	var sizeBytes int64
	if info, statErr := os.Stat(backupFile); statErr == nil {
		sizeBytes = info.Size()
	}

	result := &BackupResult{
		InstanceName: instance,
		DatabaseName: database,
		BackupType:   backupType,
		BackupFile:   backupFile,
		SizeBytes:    sizeBytes,
		Compressed:   true,
		DurationMs:   duration.Milliseconds(),
	}

	// Query LSN information from backup header
	lsnQuery := fmt.Sprintf(
		`RESTORE HEADERONLY FROM DISK='%s'`,
		strings.ReplaceAll(backupFile, "'", "''"),
	)
	lsnOut, lsnErr := runSqlcmd(serverName, lsnQuery)
	if lsnErr == nil {
		parseLSNInfo(lsnOut, result)
	}

	slog.Info("mssql backup completed",
		"instance", instance,
		"database", database,
		"type", backupType,
		"file", backupFile,
		"sizeBytes", sizeBytes,
		"durationMs", duration.Milliseconds(),
	)

	return result, nil
}

// buildBackupQuery constructs the T-SQL BACKUP statement.
func buildBackupQuery(database, backupFile, backupType string) string {
	escapedDB := strings.ReplaceAll(database, "]", "]]")
	escapedFile := strings.ReplaceAll(backupFile, "'", "''")

	switch backupType {
	case "full":
		return fmt.Sprintf(
			"BACKUP DATABASE [%s] TO DISK='%s' WITH COMPRESSION, INIT, STATS=10",
			escapedDB, escapedFile,
		)
	case "differential":
		return fmt.Sprintf(
			"BACKUP DATABASE [%s] TO DISK='%s' WITH DIFFERENTIAL, COMPRESSION, INIT, STATS=10",
			escapedDB, escapedFile,
		)
	case "log":
		return fmt.Sprintf(
			"BACKUP LOG [%s] TO DISK='%s' WITH COMPRESSION, INIT, STATS=10",
			escapedDB, escapedFile,
		)
	default:
		return ""
	}
}

// containsSqlError checks sqlcmd output for error indicators.
func containsSqlError(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "msg ") && strings.Contains(lower, "level ") && strings.Contains(lower, "state ")
}

// extractSqlError pulls the first error message from sqlcmd output.
func extractSqlError(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		if strings.Contains(lower, "msg ") && strings.Contains(lower, "level ") {
			return line
		}
	}
	return "unknown SQL error"
}

// parseLSNInfo extracts LSN values from RESTORE HEADERONLY output.
func parseLSNInfo(output string, result *BackupResult) {
	// RESTORE HEADERONLY returns a wide row; we parse by column header position.
	// The key columns: FirstLSN, LastLSN, DatabaseBackupLSN
	lines := strings.Split(output, "\n")
	if len(lines) < 2 {
		return
	}

	// With -s "|" separator, find column indices from header row
	// Simplified: just look for numeric LSN patterns in the data line
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "(") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 30 {
			continue
		}
		// HEADERONLY standard column positions (0-indexed):
		// FirstLSN=18, LastLSN=19, DatabaseBackupLSN=28
		if len(parts) > 19 {
			result.FirstLSN = strings.TrimSpace(parts[18])
			result.LastLSN = strings.TrimSpace(parts[19])
		}
		if len(parts) > 28 {
			result.DatabaseLSN = strings.TrimSpace(parts[28])
		}
		break
	}
}

// ListBackups queries msdb for backup history of a given database.
func ListBackups(instance, database string, limit int) ([]BackupResult, error) {
	if instance == "" {
		return nil, fmt.Errorf("%w: instance name is required", ErrBackupFailed)
	}

	serverName := buildServerName(instance)

	if limit <= 0 {
		limit = 20
	}

	escapedDB := strings.ReplaceAll(database, "'", "''")
	whereClause := ""
	if database != "" {
		whereClause = fmt.Sprintf("WHERE bs.database_name = '%s'", escapedDB)
	}

	query := fmt.Sprintf(`SELECT TOP %d
		bs.database_name,
		CASE bs.type WHEN 'D' THEN 'full' WHEN 'I' THEN 'differential' WHEN 'L' THEN 'log' ELSE 'other' END,
		bmf.physical_device_name,
		CAST(bs.backup_size AS BIGINT),
		bs.compressed_backup_size,
		CAST(bs.first_lsn AS VARCHAR(50)),
		CAST(bs.last_lsn AS VARCHAR(50)),
		CAST(bs.database_backup_lsn AS VARCHAR(50)),
		DATEDIFF(ms, bs.backup_start_date, bs.backup_finish_date)
	FROM msdb.dbo.backupset bs
	JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
	%s
	ORDER BY bs.backup_start_date DESC`,
		limit, whereClause,
	)

	out, err := runSqlcmd(serverName, query)
	if err != nil {
		return nil, fmt.Errorf("list backups: %w", err)
	}

	var results []BackupResult
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "(") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 9 {
			continue
		}

		sizeBytes, _ := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		compressedSize, _ := strconv.ParseInt(strings.TrimSpace(parts[4]), 10, 64)
		durationMs, _ := strconv.ParseInt(strings.TrimSpace(parts[8]), 10, 64)

		results = append(results, BackupResult{
			InstanceName: instance,
			DatabaseName: strings.TrimSpace(parts[0]),
			BackupType:   strings.TrimSpace(parts[1]),
			BackupFile:   strings.TrimSpace(parts[2]),
			SizeBytes:    sizeBytes,
			Compressed:   compressedSize > 0 && compressedSize < sizeBytes,
			FirstLSN:     strings.TrimSpace(parts[5]),
			LastLSN:      strings.TrimSpace(parts[6]),
			DatabaseLSN:  strings.TrimSpace(parts[7]),
			DurationMs:   durationMs,
		})
	}

	return results, nil
}
