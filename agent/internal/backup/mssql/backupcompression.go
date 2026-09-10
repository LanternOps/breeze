package mssql

import (
	"fmt"
	"strings"
)

// This file holds the backup-compression decision logic shared by
// backup.go (windows-only). It carries no build tag so it has real unit
// test coverage on every platform, same rationale as sqlcmd.go.
//
// SQL Server Express Edition does not support backup compression at all:
// BACKUP ... WITH COMPRESSION fails there with "Msg 1844 ... BACKUP
// DATABASE WITH COMPRESSION is not supported on Express Edition." (D23,
// second anticipated defect). We try to avoid the failed attempt by
// checking SERVERPROPERTY('Edition') up front, but SERVERPROPERTY output
// isn't the only signal worth trusting — so regardless of what the edition
// check says, a Msg 1844 response always triggers exactly one retry
// without COMPRESSION.

// isExpressEdition reports whether a SERVERPROPERTY('Edition') value names
// an Express edition (including "Express Edition with Advanced Services").
func isExpressEdition(edition string) bool {
	return strings.Contains(strings.ToLower(edition), "express")
}

// looksLikeCompressionUnsupportedError reports whether sqlcmd output shows
// SQL Server error 1844, which means the instance doesn't support backup
// compression (Express Edition) — as opposed to any other BACKUP failure.
func looksLikeCompressionUnsupportedError(output string) bool {
	return strings.Contains(output, "Msg 1844")
}

// buildBackupQuery constructs the T-SQL BACKUP statement. includeCompression
// controls whether WITH COMPRESSION is added; every other clause (INIT,
// STATS=10, DIFFERENTIAL for differential backups) is unconditional.
func buildBackupQuery(database, backupFile, backupType string, includeCompression bool) string {
	escapedDB := strings.ReplaceAll(database, "]", "]]")
	escapedFile := strings.ReplaceAll(backupFile, "'", "''")

	var withClauses []string
	switch backupType {
	case "full":
		// no type-specific clause
	case "differential":
		withClauses = append(withClauses, "DIFFERENTIAL")
	case "log":
		// no type-specific clause
	default:
		return ""
	}
	if includeCompression {
		withClauses = append(withClauses, "COMPRESSION")
	}
	withClauses = append(withClauses, "INIT", "STATS=10")

	verb := "DATABASE"
	if backupType == "log" {
		verb = "LOG"
	}

	return fmt.Sprintf(
		"BACKUP %s [%s] TO DISK='%s' WITH %s",
		verb, escapedDB, escapedFile, strings.Join(withClauses, ", "),
	)
}

// queryEdition returns the instance's SERVERPROPERTY('Edition') value,
// e.g. "Express Edition (64-bit)".
func queryEdition(serverName string) (string, error) {
	out, err := runSqlcmd(serverName, "SELECT SERVERPROPERTY('Edition')")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(parseSqlcmdSingleValue(out)), nil
}

// executeBackupStatement issues a BACKUP DATABASE/LOG statement via
// sqlcmd. If includeCompression is set and SQL Server responds with Msg
// 1844 (compression unsupported), it retries exactly once without
// COMPRESSION — this is the safety net for editions queryEdition didn't
// catch (or wasn't asked to check). Returns the sqlcmd output that should
// be inspected for other errors, whether the statement that succeeded
// included COMPRESSION, and any sqlcmd/exec error.
func executeBackupStatement(serverName, database, backupFile, backupType string, includeCompression bool) (out string, compressed bool, err error) {
	query := buildBackupQuery(database, backupFile, backupType, includeCompression)
	out, err = runSqlcmd(serverName, query)
	if err == nil && includeCompression && looksLikeCompressionUnsupportedError(out) {
		includeCompression = false
		query = buildBackupQuery(database, backupFile, backupType, includeCompression)
		out, err = runSqlcmd(serverName, query)
	}
	return out, includeCompression, err
}
