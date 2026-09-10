package mssql

import (
	"strings"
	"testing"
)

// D25 (proven live on SQL Server 2025 Express): restoring a backup under a
// database name different from the one it was taken from, on the same
// instance where the source database is still attached, failed with
// "Msg 1834 ... cannot be overwritten. It is being used by database
// <source>" — RESTORE DATABASE without a MOVE clause tries to recreate the
// backup's logical files at their original physical paths, which the
// still-attached source database owns. These tests exercise
// resolveRestoreQuery, the tag-neutral orchestration function RunRestore
// (restore.go, windows-only) delegates to.

const fakeFileListOnlyOneDataOneLog = "AssureDB|D:\\SQLData\\AssureDB.mdf|D|\n" +
	"AssureDB_log|D:\\SQLData\\AssureDB_log.ldf|L|\n" +
	"\n(2 rows affected)\n"

const fakeFileListOnlyTwoData = "AssureDB|D:\\SQLData\\AssureDB.mdf|D|\n" +
	"AssureDB2|D:\\SQLData\\AssureDB2.ndf|D|\n" +
	"AssureDB_log|D:\\SQLData\\AssureDB_log.ldf|L|\n" +
	"\n(3 rows affected)\n"

const fakeInstanceDefaultDataPath = "D:\\SQLData\\\n\n(1 rows affected)\n"
const fakeInstanceDefaultLogPath = "L:\\SQLLogs\\\n\n(1 rows affected)\n"

// (a) FILELISTONLY output with one data + one log file: the assembled
// RESTORE statement contains both MOVE clauses, using the resolved default
// data/log paths and "<target>_<logical>" file names.
func TestResolveRestoreQuery_DifferentTargetAddsMoveClausesForDataAndLog(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte(fakeFileListOnlyOneDataOneLog)},
		{out: []byte(fakeInstanceDefaultDataPath)},
		{out: []byte(fakeInstanceDefaultLogPath)},
	}}
	withRecordingRunner(t, r)

	query, err := resolveRestoreQuery(
		`.\SQLEXPRESS`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		"AssureDB_restored",
		"AssureDB_restored",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	wantData := `MOVE 'AssureDB' TO 'D:\SQLData\AssureDB_restored_AssureDB.mdf'`
	wantLog := `MOVE 'AssureDB_log' TO 'L:\SQLLogs\AssureDB_restored_AssureDB_log.ldf'`
	if !strings.Contains(query, wantData) {
		t.Fatalf("query = %q, want to contain data MOVE clause %q", query, wantData)
	}
	if !strings.Contains(query, wantLog) {
		t.Fatalf("query = %q, want to contain log MOVE clause %q", query, wantLog)
	}
	if !strings.Contains(query, "REPLACE") || !strings.Contains(query, "STATS=10") || !strings.Contains(query, "RECOVERY") {
		t.Fatalf("query = %q, must still contain REPLACE, STATS=10, RECOVERY", query)
	}
	if len(r.calls) != 3 {
		t.Fatalf("expected exactly 3 sqlcmd calls (FILELISTONLY + 2 SERVERPROPERTY), got %d: %v", len(r.calls), r.calls)
	}
}

// (b) two data files: the first gets .mdf, the second gets .ndf.
func TestResolveRestoreQuery_SecondDataFileGetsNdfExtension(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte(fakeFileListOnlyTwoData)},
		{out: []byte(fakeInstanceDefaultDataPath)},
		{out: []byte(fakeInstanceDefaultLogPath)},
	}}
	withRecordingRunner(t, r)

	query, err := resolveRestoreQuery(
		`.\SQLEXPRESS`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		"AssureDB_restored",
		"AssureDB_restored",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	wantFirst := `MOVE 'AssureDB' TO 'D:\SQLData\AssureDB_restored_AssureDB.mdf'`
	wantSecond := `MOVE 'AssureDB2' TO 'D:\SQLData\AssureDB_restored_AssureDB2.ndf'`
	if !strings.Contains(query, wantFirst) {
		t.Fatalf("query = %q, want first data file to get .mdf: %q", query, wantFirst)
	}
	if !strings.Contains(query, wantSecond) {
		t.Fatalf("query = %q, want second data file to get .ndf: %q", query, wantSecond)
	}
	if strings.Contains(query, "AssureDB2.mdf") {
		t.Fatalf("query = %q, must not give a second data file a .mdf extension", query)
	}
}

// (c) restoring under the SAME name the backup was taken from must produce
// today's pre-D25 statement unchanged: no MOVE clause, and — since the
// names already match — no sqlcmd round trip at all (regression guard).
func TestResolveRestoreQuery_SameNameRestoreHasNoMoveClause(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{}
	withRecordingRunner(t, r)

	query, err := resolveRestoreQuery(
		`.\SQLEXPRESS`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		"AssureDB",
		"AssureDB",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := `RESTORE DATABASE [AssureDB] FROM DISK='D:\Backups\AssureDB_full_20260909_120000.bak' WITH RECOVERY, REPLACE, STATS=10`
	if query != want {
		t.Fatalf("query = %q, want exactly %q (today's pre-D25 statement, unchanged)", query, want)
	}
	if strings.Contains(query, "MOVE") {
		t.Fatalf("query = %q, must not contain a MOVE clause for a same-name restore", query)
	}
	if len(r.calls) != 0 {
		t.Fatalf("expected no sqlcmd calls for a same-name restore, got %d: %v", len(r.calls), r.calls)
	}
}

// (d) a FILELISTONLY failure (T-SQL error riding home on a successful
// sqlcmd exit) surfaces an error that names the failing step, instead of
// silently falling back to a MOVE-less restore under a new name — which
// would just re-trigger Msg 1834.
func TestResolveRestoreQuery_FilelistonlyFailureNamesTheStep(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("Msg 3201, Level 16, State 1, Server X, Line 1\nCannot open backup device 'D:\\Backups\\AssureDB_full_20260909_120000.bak'. Operating system error 2.\n")},
	}}
	withRecordingRunner(t, r)

	_, err := resolveRestoreQuery(
		`.\SQLEXPRESS`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		"AssureDB_restored",
		"AssureDB_restored",
		"RECOVERY",
	)
	if err == nil {
		t.Fatal("expected an error when FILELISTONLY fails")
	}
	if !strings.Contains(err.Error(), "FILELISTONLY") {
		t.Fatalf("error = %q, want it to mention FILELISTONLY", err.Error())
	}
}

// (e) NORECOVERY is preserved alongside MOVE clauses.
func TestResolveRestoreQuery_NoRecoveryPreservedWithMoveClauses(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte(fakeFileListOnlyOneDataOneLog)},
		{out: []byte(fakeInstanceDefaultDataPath)},
		{out: []byte(fakeInstanceDefaultLogPath)},
	}}
	withRecordingRunner(t, r)

	query, err := resolveRestoreQuery(
		`.\SQLEXPRESS`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		"AssureDB_restored",
		"AssureDB_restored",
		"NORECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(query, "NORECOVERY") {
		t.Fatalf("query = %q, want NORECOVERY preserved", query)
	}
	if strings.Contains(query, "WITH RECOVERY") {
		t.Fatalf("query = %q, must not also contain RECOVERY when NORECOVERY was requested", query)
	}
	if !strings.Contains(query, "MOVE 'AssureDB'") {
		t.Fatalf("query = %q, want MOVE clauses still present alongside NORECOVERY", query)
	}
}

// sourceDatabaseNameFromBackupFile recovers the source database name from
// RunBackup's own filename convention (backup.go: "<database>_<type>_
// <timestamp><ext>"), and reports ok=false for anything that doesn't match
// so callers fall back to the pre-D25 no-MOVE statement instead of
// guessing.
func TestSourceDatabaseNameFromBackupFile(t *testing.T) {
	cases := []struct {
		name   string
		file   string
		wantDB string
		wantOK bool
	}{
		{"full backup", `D:\Backups\AssureDB_full_20260909_120000.bak`, "AssureDB", true},
		{"differential backup", `D:\Backups\AssureDB_differential_20260909_120000.bak`, "AssureDB", true},
		{"log backup", `D:\Backups\AssureDB_log_20260909_120000.trn`, "AssureDB", true},
		{"database name with underscore", `D:\Backups\Assure_DB_full_20260909_120000.bak`, "Assure_DB", true},
		{"unrecognized filename", `D:\Backups\some-random-file.bak`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, ok := sourceDatabaseNameFromBackupFile(tc.file)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if db != tc.wantDB {
				t.Fatalf("db = %q, want %q", db, tc.wantDB)
			}
		})
	}
}
