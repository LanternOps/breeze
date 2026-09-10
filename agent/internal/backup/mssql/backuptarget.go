package mssql

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

// This file resolves the directory BACKUP DATABASE/LOG should write into.
// It carries no build tag so the resolution logic has real unit test
// coverage on every platform, same rationale as sqlcmd.go.
//
// D23: the Breeze helper runs as SYSTEM, so a location chosen from the
// helper's own perspective (e.g. os.TempDir(), which resolves to
// C:\Windows\SystemTemp under SYSTEM) is not necessarily writable by the
// process that actually opens the backup file — the SQL Server service,
// running as NT SERVICE\MSSQL$<instance> or NT SERVICE\MSSQLSERVER. Every
// BACKUP DATABASE failed there with "Msg 3201 ... Operating system error
// 5(Access is denied.)". resolveBackupTargetDir always picks a directory
// from the SQL Server side of that boundary instead.

// mkdirAllFn creates a directory (and any missing parents). Tests replace
// it: the directories built here are always Windows paths, which mean
// nothing to create for real on a non-Windows test runner.
var mkdirAllFn = os.MkdirAll

// icaclsRunner is the exec seam used to grant the SQL Server service
// account access to the ProgramData fallback directory. Tests replace it,
// same pattern as sqlcmdRunner.
var icaclsRunner commandRunner = execCommandRunner

// programDataDir returns the root of the local machine's ProgramData tree.
// It reads %ProgramData% so a differently-configured Windows install is
// still respected, falling back to the standard default.
func programDataDir() string {
	if v := os.Getenv("ProgramData"); v != "" {
		return v
	}
	return `C:\ProgramData`
}

// winJoin joins path segments with a literal Windows backslash. Every path
// this package builds for SQL Server is a Windows path even when this file
// is compiled and unit-tested on a non-Windows GOOS, so path/filepath
// (whose separator follows the build OS, not the string's own shape) is
// the wrong tool here.
func winJoin(base string, parts ...string) string {
	result := strings.TrimRight(base, `\`)
	for _, p := range parts {
		result += `\` + strings.Trim(p, `\`)
	}
	return result
}

// serviceAccountFor returns the Windows service account that runs the
// named SQL Server instance: "NT SERVICE\MSSQLSERVER" for the default
// instance, "NT SERVICE\MSSQL$<instance>" for a named instance.
func serviceAccountFor(instance string) string {
	if strings.EqualFold(instance, "MSSQLSERVER") {
		return `NT SERVICE\MSSQLSERVER`
	}
	return `NT SERVICE\MSSQL$` + instance
}

// resolveBackupTargetDir determines the directory BACKUP DATABASE/LOG
// should write into, and makes sure the SQL Server service account can
// write there — see the file-level comment for why that's a different
// concern than "a directory the Breeze helper's own process can write to".
//
// Preferred: SQL Server's own default backup directory (queried via
// SERVERPROPERTY('InstanceDefaultBackupPath'), which the SQL Server
// service account can always write to), under a "breeze" subfolder.
//
// Fallback, when that query fails or returns empty: a per-instance
// directory under %ProgramData%\Breeze\mssql-staging, with the SQL Server
// service account explicitly granted modify rights via icacls — that
// directory is Breeze's own, so nothing grants the SQL Server service
// account access to it by default.
//
// Never returns a path under the OS temp directory.
func resolveBackupTargetDir(instance, serverName string) (string, error) {
	out, propErr := runSqlcmd(serverName, "SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(512))")
	if propErr == nil && containsSqlError(out) {
		propErr = fmt.Errorf("sqlcmd: %s", extractSqlError(out))
	}
	if propErr == nil {
		if base := parseSqlcmdSingleValue(out); base != "" {
			dir := winJoin(base, "breeze")
			if mkErr := mkdirAllFn(dir, 0o755); mkErr != nil {
				return "", fmt.Errorf("create backup target dir %q: %w", dir, mkErr)
			}
			slog.Info("mssql backup target directory resolved",
				"instance", instance, "dir", dir, "source", "InstanceDefaultBackupPath")
			return dir, nil
		}
		propErr = fmt.Errorf("InstanceDefaultBackupPath returned no usable value")
	}

	dir := winJoin(programDataDir(), "Breeze", "mssql-staging", instance)
	if mkErr := mkdirAllFn(dir, 0o755); mkErr != nil {
		return "", fmt.Errorf("create fallback backup target dir %q: %w", dir, mkErr)
	}
	account := serviceAccountFor(instance)
	if _, icaclsErr := icaclsRunner("icacls", dir, "/grant", account+":(OI)(CI)M"); icaclsErr != nil {
		return "", fmt.Errorf("grant %s access to %q: %w", account, dir, icaclsErr)
	}
	slog.Info("mssql backup target directory resolved",
		"instance", instance, "dir", dir, "source", "ProgramData fallback",
		"reason", propErr.Error(), "grantedTo", account)
	return dir, nil
}
