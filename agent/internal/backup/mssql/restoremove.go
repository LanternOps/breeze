package mssql

import (
	"fmt"
	"regexp"
	"strings"
)

// This file builds the WITH MOVE clauses RunRestore (restore.go, windows-
// only) needs for D25 — restoring a backup under a database name different
// from the one it was taken from, on the same instance where the source
// database is still attached. It carries no build tag so the file-list
// parsing and query-building logic has real unit test coverage on every
// platform, same rationale as sqlcmd.go and backupcompression.go.
//
// D25 (proven live on SQL Server 2025 Express): POST /backup/mssql/restore
// {targetDatabase:"AssureDB_restored"} failed with "Msg 1834 ... the file
// ...\AssureDB.mdf cannot be overwritten. It is being used by database
// 'AssureDB'". Without a MOVE clause, RESTORE DATABASE tries to recreate
// the backup's logical files at the *original* physical paths recorded
// when the backup was taken — which the still-attached source database
// owns whenever the target name differs from the source. A same-name
// (in-place) restore is unaffected, since the database being replaced
// already owns those paths, so that path's statement is left byte-for-byte
// identical to what RunRestore produced before D25.

// restoreFileListEntry is one row of `RESTORE FILELISTONLY` output — just
// enough to build a MOVE clause.
type restoreFileListEntry struct {
	LogicalName string
	Type        string // "D" data, "L" log, "F"/"S" filestream/full-text
}

// parseFileListOnly parses `RESTORE FILELISTONLY` output as returned by
// runSqlcmd's `-h -1 -W -s "|"` formatting: one pipe-delimited row per
// backup file. LogicalName (column 1) and Type (column 3) are the two
// oldest, most stable columns in FILELISTONLY's result set — present since
// SQL Server 2000 — chosen deliberately over deep column-position parsing
// keyed to a specific SQL Server version, which is exactly what makes
// parseLSNInfo's HEADERONLY parsing (backup.go) fragile.
func parseFileListOnly(output string) ([]restoreFileListEntry, error) {
	var entries []restoreFileListEntry
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "(") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}
		logicalName := strings.TrimSpace(parts[0])
		if logicalName == "" {
			continue
		}
		entries = append(entries, restoreFileListEntry{
			LogicalName: logicalName,
			Type:        strings.ToUpper(strings.TrimSpace(parts[2])),
		})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("no files found in FILELISTONLY output")
	}
	return entries, nil
}

// backupFilenamePattern matches RunBackup's own file naming convention
// (backup.go: `fmt.Sprintf("%s_%s_%s%s", database, backupType, timestamp,
// ext)` with timestamp "20060102_150405"): "<database>_<full|
// differential|log>_<YYYYMMDD>_<HHMMSS><.bak|.trn>". The greedy `(.+)`
// backtracks past any underscores in the database name itself to find the
// last valid backupType+timestamp suffix.
var backupFilenamePattern = regexp.MustCompile(`^(.+)_(?:full|differential|log)_\d{8}_\d{6}\.(?:bak|trn)$`)

// sourceDatabaseNameFromBackupFile recovers the database name a backup
// file was taken from, from its filename — RunBackup's own convention,
// which every backup this package restores was produced under (the
// basename survives upload, the snapshot manifest, and download
// unchanged; see downloadMSSQLArtifact in cmd/breeze-backup). Returns
// ok=false for a file that doesn't match (e.g. a hand-placed .bak from
// outside Breeze, or a caller-supplied absolute path with a custom name):
// callers must treat that as "can't prove this is a same-name restore"
// and fall back to the pre-D25 no-MOVE statement rather than guess wrong.
func sourceDatabaseNameFromBackupFile(backupFile string) (string, bool) {
	base := windowsBaseName(backupFile)
	m := backupFilenamePattern.FindStringSubmatch(base)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// windowsBaseName returns the last path segment of a Windows path.
// path/filepath.Base is the wrong tool here: every path this package
// builds or receives for SQL Server is a Windows path even when this file
// is compiled and unit-tested on a non-Windows GOOS, where filepath.Base
// only splits on "/" and would return the whole "C:\foo\bar.bak" string
// unchanged instead of "bar.bak" — the same reasoning winJoin's doc
// comment (backuptarget.go) gives for avoiding path/filepath there.
func windowsBaseName(path string) string {
	if idx := strings.LastIndexAny(path, `\/`); idx >= 0 {
		return path[idx+1:]
	}
	return path
}

// sanitizeRestoreFileNameComponent strips characters that are unsafe in a
// Windows file name before it's used to build a physical file path for a
// MOVE clause.
func sanitizeRestoreFileNameComponent(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// buildMoveClauses builds one `MOVE 'logical' TO 'path'` clause per backup
// file: data files (Type "D", and any other/unknown type — filestream/
// full-text "F"/"S" included, so every FILELISTONLY row is accounted for
// instead of silently dropping one and leaving RESTORE to reject an
// incomplete file list) go under dataPath, log files (Type "L") go under
// logPath. Every file name is "<target>_<logicalName>.<ext>": the first
// data file gets ".mdf" (SQL Server allows only one primary data file per
// database), every subsequent data file gets ".ndf", every log file gets
// ".ldf".
func buildMoveClauses(entries []restoreFileListEntry, targetDB, dataPath, logPath string) []string {
	safeTarget := sanitizeRestoreFileNameComponent(targetDB)
	clauses := make([]string, 0, len(entries))
	dataFileIndex := 0
	for _, e := range entries {
		dir, ext := dataPath, ".ndf"
		switch e.Type {
		case "L":
			dir, ext = logPath, ".ldf"
		default:
			if dataFileIndex == 0 {
				ext = ".mdf"
			}
			dataFileIndex++
		}
		fileName := fmt.Sprintf("%s_%s%s", safeTarget, sanitizeRestoreFileNameComponent(e.LogicalName), ext)
		physicalPath := winJoin(dir, fileName)
		escapedLogical := strings.ReplaceAll(e.LogicalName, "'", "''")
		escapedPath := strings.ReplaceAll(physicalPath, "'", "''")
		clauses = append(clauses, fmt.Sprintf("MOVE '%s' TO '%s'", escapedLogical, escapedPath))
	}
	return clauses
}

// buildRestoreQuery assembles the final RESTORE DATABASE statement. With
// no moveClauses, this is byte-for-byte the pre-D25 statement RunRestore
// always produced (the same-name / regression-guarded path).
func buildRestoreQuery(escapedDB, escapedFile, recoveryOption string, moveClauses []string) string {
	withClauses := make([]string, 0, len(moveClauses)+3)
	withClauses = append(withClauses, moveClauses...)
	withClauses = append(withClauses, recoveryOption, "REPLACE", "STATS=10")
	return fmt.Sprintf(
		"RESTORE DATABASE [%s] FROM DISK='%s' WITH %s",
		escapedDB, escapedFile, strings.Join(withClauses, ", "),
	)
}

// queryInstanceDefaultPath resolves one of the instance's default file
// paths (InstanceDefaultDataPath / InstanceDefaultLogPath) — the same
// SERVERPROPERTY-and-parseSqlcmdSingleValue pattern resolveBackupTargetDir
// (backuptarget.go) already uses for InstanceDefaultBackupPath.
func queryInstanceDefaultPath(serverName, property string) (string, error) {
	out, err := runSqlcmd(serverName, fmt.Sprintf("SELECT CAST(SERVERPROPERTY('%s') AS nvarchar(512))", property))
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", property, err)
	}
	if containsSqlError(out) {
		return "", fmt.Errorf("resolve %s: %s", property, extractSqlError(out))
	}
	value := parseSqlcmdSingleValue(out)
	if value == "" {
		return "", fmt.Errorf("resolve %s: returned no usable value", property)
	}
	return value, nil
}

// resolveRestoreQuery builds the T-SQL RESTORE DATABASE statement
// RunRestore (restore.go, windows-only) executes. When targetDB matches
// the backup's own source database name (or that name can't be
// determined), it returns today's pre-D25 statement unchanged and makes
// no sqlcmd calls at all. Otherwise it queries FILELISTONLY and the
// instance's default data/log paths to build MOVE clauses that place the
// restored files somewhere the still-attached source database can't
// already own (D25).
//
// If FILELISTONLY or the default-path queries fail, this returns an error
// naming the failing step rather than falling back to a MOVE-less
// statement under the new name, which would just re-trigger Msg 1834.
func resolveRestoreQuery(serverName, backupFile, escapedFile, targetDB, escapedDB, recoveryOption string) (string, error) {
	sourceDB, ok := sourceDatabaseNameFromBackupFile(backupFile)
	if !ok || strings.EqualFold(sourceDB, targetDB) {
		return buildRestoreQuery(escapedDB, escapedFile, recoveryOption, nil), nil
	}

	flOut, err := runSqlcmd(serverName, fmt.Sprintf("RESTORE FILELISTONLY FROM DISK='%s'", escapedFile))
	if err != nil {
		return "", fmt.Errorf("restore FILELISTONLY: %w", err)
	}
	if containsSqlError(flOut) {
		return "", fmt.Errorf("restore FILELISTONLY: %s", extractSqlError(flOut))
	}
	entries, err := parseFileListOnly(flOut)
	if err != nil {
		return "", fmt.Errorf("restore FILELISTONLY: %w", err)
	}

	dataPath, err := queryInstanceDefaultPath(serverName, "InstanceDefaultDataPath")
	if err != nil {
		return "", err
	}
	logPath, err := queryInstanceDefaultPath(serverName, "InstanceDefaultLogPath")
	if err != nil {
		return "", err
	}

	moveClauses := buildMoveClauses(entries, targetDB, dataPath, logPath)
	return buildRestoreQuery(escapedDB, escapedFile, recoveryOption, moveClauses), nil
}
