package mssql

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"
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

var fakeInstanceDefaultDataPath = serverPathOutput(`D:\SQLData\`)
var fakeInstanceDefaultLogPath = serverPathOutput(`L:\SQLLogs\`)

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
		"AssureDB_restored",
		"AssureDB_restored",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	moves := moveTargets(t, query)
	if got, want := moves["AssureDB"], `D:\SQLData\AssureDB_restored_AssureDB.mdf`; got != want {
		t.Fatalf("query = %q, data file MOVE target = %q, want %q", query, got, want)
	}
	if got, want := moves["AssureDB_log"], `L:\SQLLogs\AssureDB_restored_AssureDB_log.ldf`; got != want {
		t.Fatalf("query = %q, log file MOVE target = %q, want %q", query, got, want)
	}
	if len(moves) != 2 {
		t.Fatalf("query = %q, MOVE targets = %v", query, moves)
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
		"AssureDB_restored",
		"AssureDB_restored",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	moves := moveTargets(t, query)
	if got, want := moves["AssureDB"], `D:\SQLData\AssureDB_restored_AssureDB.mdf`; got != want {
		t.Fatalf("first data file MOVE target = %q, want .mdf %q", got, want)
	}
	if got, want := moves["AssureDB2"], `D:\SQLData\AssureDB_restored_AssureDB2.ndf`; got != want {
		t.Fatalf("second data file MOVE target = %q, want .ndf %q", got, want)
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
		"AssureDB",
		"AssureDB",
		"RECOVERY",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	binding, err := bindBackupFile(`D:\Backups\AssureDB_full_20260909_120000.bak`)
	if err != nil {
		t.Fatal(err)
	}
	want := binding + ` RESTORE DATABASE [AssureDB] FROM DISK=@backup_file WITH RECOVERY, REPLACE, STATS=10`
	if query != want {
		t.Fatalf("query = %q, want exactly %q (the pre-D25 WITH options, unchanged)", query, want)
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
	if _, ok := moveTargets(t, query)["AssureDB"]; !ok {
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

// bindingFromQuery returns the value a statement binds to @backup_file,
// decoded from the hex UTF-16LE literal it is carried in.
func bindingFromQuery(t *testing.T, query string) string {
	t.Helper()
	m := regexp.MustCompile(`SET @backup_file = CAST\(0x([0-9A-F]*) AS nvarchar\(4000\)\)`).FindStringSubmatch(query)
	if m == nil {
		t.Fatalf("query %q does not bind @backup_file", query)
	}
	raw, err := hex.DecodeString(m[1])
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("binding %q: %v", m[1], err)
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	return string(utf16.Decode(units))
}

// The backup file path never appears in the statement text: it is bound to
// a variable from its encoded form, so quoting and line structure do not
// depend on its contents. This holds for the restore statement and for the
// FILELISTONLY probe a renamed restore runs first.
func TestResolveRestoreQueryBindsBackupFileOutsideStatementText(t *testing.T) {
	paths := []string{
		`D:\Backups\AssureDB_full_20260909_120000.bak`,
		`D:\Backups\o'brien $(name) [x] 日本語.bak`,
		`D:\Backups\AssureDB_full_20260909_120000.bak' WITH FILE=1 --`,
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			resetTrustCertProbe(t)
			r := &recordingRunner{}
			withRecordingRunner(t, r)
			query, err := resolveRestoreQuery(`.\SQLEXPRESS`, p, "AssureDB", "AssureDB", "RECOVERY")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if strings.Contains(query, p) || strings.Contains(query, strings.ReplaceAll(p, "'", "''")) || strings.Contains(query, "$(") {
				t.Fatalf("query carries the path text: %q", query)
			}
			if !strings.Contains(query, "RESTORE DATABASE [AssureDB] FROM DISK=@backup_file WITH RECOVERY, REPLACE, STATS=10") {
				t.Fatalf("query = %q", query)
			}
			if got := bindingFromQuery(t, query); got != p {
				t.Fatalf("bound %q, want %q", got, p)
			}
		})
	}

	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte(fakeFileListOnlyOneDataOneLog)},
		{out: []byte(fakeInstanceDefaultDataPath)},
		{out: []byte(fakeInstanceDefaultLogPath)},
	}}
	withRecordingRunner(t, r)
	p := `D:\Backups\AssureDB_full_20260909_120000.bak`
	query, err := resolveRestoreQuery(`.\SQLEXPRESS`, p, "AssureDB_restored", "AssureDB_restored", "RECOVERY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(r.calls) != 3 {
		t.Fatalf("calls=%v", r.calls)
	}
	if strings.Contains(r.calls[0], p) || !strings.Contains(r.calls[0], "RESTORE FILELISTONLY FROM DISK=@backup_file") {
		t.Fatalf("FILELISTONLY call = %q", r.calls[0])
	}
	if strings.Contains(query, p) || bindingFromQuery(t, query) != p {
		t.Fatalf("query = %q", query)
	}
}

// A backup file path holding a control character is refused before any
// statement is built or any sqlcmd call is made.
func TestResolveRestoreQueryRefusesControlCharactersInBackupFile(t *testing.T) {
	for _, p := range []string{
		"D:\\Backups\\AssureDB_full_20260909_120000.bak\nrest",
		"D:\\Backups\\AssureDB_full_20260909_120000.bak\rrest",
		"D:\\Backups\\Assure\x00DB_full_20260909_120000.bak",
		"D:\\Backups\\Assure\tDB.bak",
		"D:\\Backups\\Assure\u0085DB.bak",
		"D:\\Backups\\Assure\u2028DB.bak",
	} {
		for _, target := range []string{"AssureDB", "Other"} {
			t.Run(fmt.Sprintf("%q/%s", p, target), func(t *testing.T) {
				resetTrustCertProbe(t)
				r := &recordingRunner{}
				withRecordingRunner(t, r)
				query, err := resolveRestoreQuery(`.\SQLEXPRESS`, p, target, target, "RECOVERY")
				if err == nil || query != "" {
					t.Fatalf("query=%q err=%v", query, err)
				}
				if len(r.calls) != 0 {
					t.Fatalf("sqlcmd ran: %v", r.calls)
				}
			})
		}
	}
}
