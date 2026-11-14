//go:build windows

package mssql

import (
	"errors"
	"strings"
	"testing"
)

func TestRestoreEntryPointsCheckInputsBeforeSqlcmd(t *testing.T) {
	original := findSqlcmd
	t.Cleanup(func() { findSqlcmd = original })
	calls := 0
	findSqlcmd = func() (string, error) { calls++; return "", ErrSqlcmdNotFound }
	for _, value := range []string{"daily\nbackup.bak", "daily\rbackup.bak", "daily\x00backup.bak", "daily\u2028backup.bak"} {
		if _, err := RunRestore("MSSQLSERVER", value, "App", false); !errors.Is(err, ErrRestoreFailed) {
			t.Fatalf("restore: %v", err)
		}
		if _, err := VerifyBackup("MSSQLSERVER", value); !errors.Is(err, ErrVerifyFailed) {
			t.Fatalf("verify: %v", err)
		}
	}
	if _, err := VerifyBackup("../instance", `C:\b.bak`); !errors.Is(err, ErrVerifyFailed) {
		t.Fatalf("verify instance: %v", err)
	}
	if _, err := ResolveRestoreTargetDir("../instance"); !errors.Is(err, ErrRestoreFailed) {
		t.Fatalf("target: %v", err)
	}
	if calls != 0 {
		t.Fatalf("sqlcmd lookup called %d times", calls)
	}
}

// An instance name holding $ or # reaches sqlcmd only as the -S argument.
func TestInstanceNameWithDollarAndNumberSignIsAnArgument(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{{out: []byte("x"), err: errors.New("exit status 1")}}}
	withRecordingRunner(t, r)
	if _, err := VerifyBackup("SQL$EX#2", `C:\Backups\a.bak`); !errors.Is(err, ErrVerifyFailed) {
		t.Fatalf("verify: %v", err)
	}
	if len(r.calls) == 0 || !strings.Contains(r.calls[0], `-S .\SQL$EX#2 `) || strings.Count(r.calls[0], "SQL$EX#2") != 1 {
		t.Fatalf("calls = %q", r.calls)
	}
}

func TestListBackupsChecksInstanceBeforeSqlcmd(t *testing.T) {
	original := findSqlcmd
	t.Cleanup(func() { findSqlcmd = original })
	calls := 0
	findSqlcmd = func() (string, error) { calls++; return "", ErrSqlcmdNotFound }
	for _, bad := range []string{"..", "a/b", " SQLEXPRESS", "ABCDEFGHIJKLMNOPQ"} {
		if _, err := ListBackups(bad, "", 1); !errors.Is(err, ErrBackupFailed) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if calls != 0 {
		t.Fatalf("sqlcmd lookup called %d times", calls)
	}
}
