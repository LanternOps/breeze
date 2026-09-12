package mssql

import (
	"os"
	"strings"
	"testing"
)

// withMkdirAllRecorder substitutes mkdirAllFn with a no-op that records the
// paths it was asked to create, instead of touching the real filesystem —
// the directories resolveBackupTargetDir builds are Windows paths that mean
// nothing on a non-Windows test runner.
func withMkdirAllRecorder(t *testing.T) *[]string {
	t.Helper()
	var calls []string
	orig := mkdirAllFn
	mkdirAllFn = func(path string, _ os.FileMode) error {
		calls = append(calls, path)
		return nil
	}
	t.Cleanup(func() { mkdirAllFn = orig })
	return &calls
}

// withRecordingIcacls substitutes the package's icacls exec seam for the
// duration of the test.
func withRecordingIcacls(t *testing.T, r *recordingRunner) {
	t.Helper()
	orig := icaclsRunner
	icaclsRunner = r.run
	t.Cleanup(func() { icaclsRunner = orig })
}

// (a) the target path is built from the resolved InstanceDefaultBackupPath
// and is never under the temp dir (D23: os.TempDir() resolves to
// C:\Windows\SystemTemp when the helper runs as SYSTEM, which the SQL
// Server service account cannot open).
func TestResolveBackupTargetDir_UsesInstanceDefaultBackupPath(t *testing.T) {
	resetTrustCertProbe(t)
	mkdirCalls := withMkdirAllRecorder(t)

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("C:\\Program Files\\Microsoft SQL Server\\MSSQL17.SQLEXPRESS\\MSSQL\\Backup\n\n(1 rows affected)\n")},
	}}
	withRecordingRunner(t, r)

	dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := `C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQL\Backup\breeze`
	if dir != want {
		t.Fatalf("dir = %q, want %q", dir, want)
	}
	if strings.Contains(strings.ToLower(dir), "temp") {
		t.Fatalf("resolved dir must never be under a temp directory, got %q", dir)
	}
	if len(*mkdirCalls) != 1 || (*mkdirCalls)[0] != want {
		t.Fatalf("expected mkdirAllFn to be called once with %q, got %v", want, *mkdirCalls)
	}

	// Only one sqlcmd call (the property query) — no ProgramData fallback
	// path should have been taken, so icacls must never run.
	if len(r.calls) != 1 {
		t.Fatalf("expected exactly 1 sqlcmd call, got %d: %v", len(r.calls), r.calls)
	}
}

// (b) when the property query fails, the fallback dir is under the
// ProgramData staging root and the icacls grant is invoked with the right
// service account — for a named instance and for the default instance.
func TestResolveBackupTargetDir_FallsBackToProgramDataAndGrantsServiceAccount(t *testing.T) {
	resetTrustCertProbe(t)
	withMkdirAllRecorder(t)

	ir := &recordingRunner{}
	withRecordingIcacls(t, ir)

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("Msg 208, Level 16, State 1, Server X, Line 1\nInvalid object name 'SERVERPROPERTY'.\n"), err: nil},
	}}
	withRecordingRunner(t, r)

	dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantDir := winJoin(programDataDir(), "Breeze", "mssql-staging", "SQLEXPRESS")
	if dir != wantDir {
		t.Fatalf("dir = %q, want %q", dir, wantDir)
	}
	if strings.Contains(strings.ToLower(dir), "temp") {
		t.Fatalf("fallback dir must never be under a temp directory, got %q", dir)
	}
	if len(ir.calls) != 1 {
		t.Fatalf("expected exactly 1 icacls invocation, got %d: %v", len(ir.calls), ir.calls)
	}
	if !strings.Contains(ir.calls[0], `NT SERVICE\MSSQL$SQLEXPRESS`) {
		t.Fatalf("expected icacls call to grant NT SERVICE\\MSSQL$SQLEXPRESS, got %q", ir.calls[0])
	}

	// Default instance uses NT SERVICE\MSSQLSERVER, not a "MSSQL$" account.
	r2 := &recordingRunner{responses: []fakeResponse{
		{out: []byte(""), err: nil},
	}}
	withRecordingRunner(t, r2)

	dir2, err2 := resolveBackupTargetDir("MSSQLSERVER", ".")
	if err2 != nil {
		t.Fatalf("unexpected error: %v", err2)
	}
	wantDir2 := winJoin(programDataDir(), "Breeze", "mssql-staging", "MSSQLSERVER")
	if dir2 != wantDir2 {
		t.Fatalf("dir2 = %q, want %q", dir2, wantDir2)
	}
	if len(ir.calls) != 2 {
		t.Fatalf("expected exactly 2 icacls invocations total, got %d: %v", len(ir.calls), ir.calls)
	}
	if !strings.Contains(ir.calls[1], `NT SERVICE\MSSQLSERVER`) {
		t.Fatalf("expected icacls call to grant NT SERVICE\\MSSQLSERVER, got %q", ir.calls[1])
	}
	if strings.Contains(ir.calls[1], `MSSQL$MSSQLSERVER`) {
		t.Fatalf("default instance must not use a MSSQL$ named-instance account, got %q", ir.calls[1])
	}
}

// The property query returning an empty value (no error, but nothing
// usable) must also trigger the ProgramData fallback, not a path joined
// from an empty string.
func TestResolveBackupTargetDir_EmptyPropertyValueFallsBack(t *testing.T) {
	resetTrustCertProbe(t)
	withMkdirAllRecorder(t)
	withRecordingIcacls(t, &recordingRunner{})

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("\n\n(0 rows affected)\n")},
	}}
	withRecordingRunner(t, r)

	dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantDir := winJoin(programDataDir(), "Breeze", "mssql-staging", "SQLEXPRESS")
	if dir != wantDir {
		t.Fatalf("dir = %q, want %q", dir, wantDir)
	}
}
