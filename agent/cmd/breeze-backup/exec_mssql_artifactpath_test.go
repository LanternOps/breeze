package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// countTargetResolution replaces the restore-target lookup with one that
// counts its calls and returns dir.
func countTargetResolution(t *testing.T, dir string) *int {
	t.Helper()
	original := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = original })
	calls := 0
	resolveMSSQLRestoreTargetDir = func(string) (string, error) {
		calls++
		if dir == "" {
			return "", fmt.Errorf("target resolution should not run")
		}
		return dir, nil
	}
	return &calls
}

// A staged file name must be a single, printable path component; anything
// else is refused before the restore target directory is even resolved.
func TestMSSQLArtifactNameCheckedBeforeTargetResolution(t *testing.T) {
	calls := countTargetResolution(t, "")
	for _, name := range []string{"daily\nbackup.bak", "daily\rbackup.bak", "daily\x00backup.bak", "daily backup.bak", "../daily.bak", `folder\daily.bak`, "C:daily.bak", ".", ".."} {
		if _, _, _, err := downloadMSSQLArtifact("MSSQLSERVER", nil, "archive/daily.bak", name, integrity.Stored{}, nil); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, remote := range []string{"archive/daily\n.bak", "archive\r/daily.bak"} {
		if _, _, _, err := downloadMSSQLArtifact("MSSQLSERVER", nil, remote, "daily.bak", integrity.Stored{}, nil); err == nil {
			t.Fatalf("accepted remote %q", remote)
		}
	}
	if *calls != 0 {
		t.Fatalf("resolved target %d times", *calls)
	}
}

// An existing local file whose path holds a control character is not handed
// to the restore runner, on either the direct or the storage-session path.
func TestMSSQLLocalArtifactPathWithControlCharacterRefused(t *testing.T) {
	dir := t.TempDir()
	local := filepath.Join(dir, "AppDB_full_20260101_000000.bak\nrest")
	if err := os.WriteFile(local, []byte("bak"), 0o600); err != nil {
		t.Skipf("filesystem does not allow the name: %v", err)
	}
	calls := countTargetResolution(t, "")
	if got, _, _, err := resolveMSSQLBackupArtifact("MSSQLSERVER", nil, "", local, nil); err == nil || got != "" {
		t.Fatalf("direct: path=%q err=%v", got, err)
	}
	if got, _, _, err := resolveBrokeredMSSQLArtifact("MSSQLSERVER", nil, "", local, nil); err == nil || got != "" {
		t.Fatalf("storage session: path=%q err=%v", got, err)
	}
	if *calls != 0 {
		t.Fatalf("resolved target %d times", *calls)
	}
}

// A snapshot manifest that names a backup file with a control character is
// refused for restore and verify before anything is staged or run.
func TestMSSQLManifestArtifactNameWithControlCharacterRefused(t *testing.T) {
	provider := providers.NewLocalProvider(privateStoreTempDir(t))
	snapshotID := "mssql-prod-appdb-control-name"
	remote := path.Join("snapshots", snapshotID, "files", "AppDB_full_20260101_000000.bak\nrest")
	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files:     []backup.SnapshotFile{{SourcePath: "AppDB_full_20260101_000000.bak", BackupPath: remote, Size: 3}},
		Size:      3,
	}
	if _, err := uploadMssqlSnapshotManifest(provider, "", manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, StagingDir: t.TempDir()})
	calls := countTargetResolution(t, t.TempDir())

	origRestore, origVerify := runMSSQLRestore, runMSSQLVerify
	t.Cleanup(func() { runMSSQLRestore, runMSSQLVerify = origRestore, origVerify })
	ran := 0
	runMSSQLRestore = func(string, string, string, bool) (*mssql.RestoreResult, error) {
		ran++
		return &mssql.RestoreResult{}, nil
	}
	runMSSQLVerify = func(string, string) (*mssql.VerifyResult, error) { ran++; return &mssql.VerifyResult{}, nil }

	restorePayload, _ := json.Marshal(map[string]any{"instance": "MSSQLSERVER", "snapshotId": snapshotID, "targetDatabase": "AppDB"})
	verifyPayload, _ := json.Marshal(map[string]any{"instance": "MSSQLSERVER", "snapshotId": snapshotID})
	if res := execMSSQLRestore(restorePayload, mgr); res.Success {
		t.Fatal("restore succeeded")
	}
	if res := execMSSQLVerify(verifyPayload, mgr); res.Success {
		t.Fatal("verify succeeded")
	}
	if *calls != 0 || ran != 0 {
		t.Fatalf("target resolutions=%d runner calls=%d", *calls, ran)
	}
}
