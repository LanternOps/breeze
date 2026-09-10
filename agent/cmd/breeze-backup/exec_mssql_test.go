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
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestExecMSSQLBackupEmitsStandardEnvelope(t *testing.T) {
	baseDir := t.TempDir()
	stagingDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: stagingDir,
	})

	backupBytes := []byte("mssql-backup-bytes")
	var backupFile string

	origRunMSSQLBackup := runMSSQLBackup
	t.Cleanup(func() {
		runMSSQLBackup = origRunMSSQLBackup
	})
	runMSSQLBackup = func(instance, database, backupType, outputPath string) (*mssql.BackupResult, error) {
		if instance != "MSSQLSERVER" {
			t.Fatalf("instance = %q", instance)
		}
		if database != "ProductionDB" {
			t.Fatalf("database = %q", database)
		}
		if backupType != "full" {
			t.Fatalf("backupType = %q", backupType)
		}
		if filepath.Dir(outputPath) != stagingDir {
			t.Fatalf("outputPath parent = %q, want %q", filepath.Dir(outputPath), stagingDir)
		}
		backupFile = filepath.Join(outputPath, "ProductionDB_full_20260331.bak")
		if err := os.WriteFile(backupFile, backupBytes, 0o644); err != nil {
			t.Fatalf("write backup file: %v", err)
		}
		return &mssql.BackupResult{
			InstanceName: "MSSQLSERVER",
			DatabaseName: "ProductionDB",
			BackupType:   "full",
			BackupFile:   backupFile,
			SizeBytes:    int64(len(backupBytes)),
			Compressed:   true,
			FirstLSN:     "100000000001200001",
			LastLSN:      "100000000001300001",
			DatabaseLSN:  "100000000001100001",
			DurationMs:   1234,
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"database":   "ProductionDB",
		"backupType": "full",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLBackup(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}

	var decoded struct {
		SnapshotID    string          `json:"snapshotId"`
		FilesBackedUp int             `json:"filesBackedUp"`
		BytesBackedUp int64           `json:"bytesBackedUp"`
		BackupType    string          `json:"backupType"`
		Metadata      map[string]any  `json:"metadata"`
		Snapshot      backup.Snapshot `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	if decoded.SnapshotID == "" {
		t.Fatal("expected snapshotId")
	}
	if decoded.FilesBackedUp != 1 {
		t.Fatalf("filesBackedUp = %d, want 1", decoded.FilesBackedUp)
	}
	if decoded.BytesBackedUp != int64(len(backupBytes)) {
		t.Fatalf("bytesBackedUp = %d, want %d", decoded.BytesBackedUp, len(backupBytes))
	}
	if decoded.BackupType != "database" {
		t.Fatalf("backupType = %q, want database", decoded.BackupType)
	}
	if decoded.Snapshot.ID != decoded.SnapshotID {
		t.Fatalf("snapshot.id = %q, want %q", decoded.Snapshot.ID, decoded.SnapshotID)
	}
	if len(decoded.Snapshot.Files) != 1 {
		t.Fatalf("snapshot.files = %d, want 1", len(decoded.Snapshot.Files))
	}
	if decoded.Snapshot.Files[0].BackupPath == "" {
		t.Fatal("expected snapshot file backupPath")
	}
	if got := decoded.Metadata["backupFile"]; got != decoded.Snapshot.Files[0].BackupPath {
		t.Fatalf("metadata.backupFile = %v, want %s", got, decoded.Snapshot.Files[0].BackupPath)
	}

	manifestKey := path.Join("snapshots", decoded.SnapshotID, "manifest.json")
	items, err := provider.List(path.Join("snapshots", decoded.SnapshotID))
	if err != nil {
		t.Fatalf("list snapshot items: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("snapshot item count = %d, want 2", len(items))
	}
	foundManifest := false
	foundBackup := false
	for _, item := range items {
		switch item {
		case manifestKey:
			foundManifest = true
		case decoded.Snapshot.Files[0].BackupPath:
			foundBackup = true
		}
	}
	if !foundManifest || !foundBackup {
		t.Fatalf("snapshot items missing manifest=%t backup=%t", foundManifest, foundBackup)
	}
}

func TestExecMSSQLRestoreStagesSnapshotArtifact(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-20260331"
	prefix := path.Join("snapshots", snapshotID)

	backupBytes := []byte("restore-source-bytes")
	srcPath := filepath.Join(t.TempDir(), "ProductionDB_full_20260331.bak")
	if err := os.WriteFile(srcPath, backupBytes, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	remoteBackupPath := path.Join(prefix, "files", filepath.Base(srcPath))
	if err := provider.Upload(srcPath, remoteBackupPath); err != nil {
		t.Fatalf("upload backup file: %v", err)
	}

	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{
				SourcePath: filepath.Base(srcPath),
				BackupPath: remoteBackupPath,
				Size:       int64(len(backupBytes)),
			},
		},
		Size: int64(len(backupBytes)),
	}
	if err := uploadMssqlSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return t.TempDir(), nil }

	origRunMSSQLRestore := runMSSQLRestore
	t.Cleanup(func() {
		runMSSQLRestore = origRunMSSQLRestore
	})

	var stagedPath string
	runMSSQLRestore = func(instance, backupFile, targetDB string, noRecovery bool) (*mssql.RestoreResult, error) {
		stagedPath = backupFile
		if _, err := os.Stat(backupFile); err != nil {
			t.Fatalf("staged backup file missing: %v", err)
		}
		data, err := os.ReadFile(backupFile)
		if err != nil {
			t.Fatalf("read staged backup: %v", err)
		}
		if string(data) != string(backupBytes) {
			t.Fatalf("staged backup contents = %q, want %q", data, backupBytes)
		}
		return &mssql.RestoreResult{
			DatabaseName:  targetDB,
			RestoredAs:    targetDB,
			Status:        "completed",
			FilesRestored: 1,
			DurationMs:    456,
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":       "MSSQLSERVER",
		"snapshotId":     snapshotID,
		"targetDatabase": "ProductionDB_Restore",
		"noRecovery":     true,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLRestore(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}
	if stagedPath == "" {
		t.Fatal("expected restore to receive a staged path")
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected staged path to be removed, stat err=%v", err)
	}
}

func TestExecMSSQLVerifyStagesSnapshotPrefixArtifact(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-20260331"
	prefix := path.Join("snapshots", snapshotID)

	backupBytes := []byte("verify-source-bytes")
	srcPath := filepath.Join(t.TempDir(), "ProductionDB_log_20260331.trn")
	if err := os.WriteFile(srcPath, backupBytes, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	remoteBackupPath := path.Join(prefix, "files", filepath.Base(srcPath))
	if err := provider.Upload(srcPath, remoteBackupPath); err != nil {
		t.Fatalf("upload backup file: %v", err)
	}

	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{
				SourcePath: filepath.Base(srcPath),
				BackupPath: remoteBackupPath,
				Size:       int64(len(backupBytes)),
			},
		},
		Size: int64(len(backupBytes)),
	}
	if err := uploadMssqlSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return t.TempDir(), nil }

	origRunMSSQLVerify := runMSSQLVerify
	t.Cleanup(func() {
		runMSSQLVerify = origRunMSSQLVerify
	})

	var stagedPath string
	runMSSQLVerify = func(instance, backupFile string) (*mssql.VerifyResult, error) {
		stagedPath = backupFile
		if _, err := os.Stat(backupFile); err != nil {
			t.Fatalf("staged backup file missing: %v", err)
		}
		data, err := os.ReadFile(backupFile)
		if err != nil {
			t.Fatalf("read staged backup: %v", err)
		}
		if string(data) != string(backupBytes) {
			t.Fatalf("staged backup contents = %q, want %q", data, backupBytes)
		}
		return &mssql.VerifyResult{
			BackupFile: backupFile,
			Valid:      true,
			DurationMs: 789,
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"backupFile": prefix,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLVerify(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}
	if stagedPath == "" {
		t.Fatal("expected verify to receive a staged path")
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected staged path to be removed, stat err=%v", err)
	}
}

// failingUploadProvider fakes providers.BackupProvider with an Upload that
// always fails, so execMSSQLBackup's upload-failure path can be exercised
// without a real remote backend. List/Delete are no-ops so
// cleanupMssqlSnapshot (called on the failure path) has nothing to do.
type failingUploadProvider struct{}

func (p *failingUploadProvider) Upload(_, _ string) error        { return errUploadFailedForTest }
func (p *failingUploadProvider) Download(_, _ string) error      { return nil }
func (p *failingUploadProvider) List(_ string) ([]string, error) { return nil, nil }
func (p *failingUploadProvider) Delete(_ string) error           { return nil }

var errUploadFailedForTest = fmt.Errorf("simulated upload failure")

// D23: after RunBackup stopped writing into the caller-supplied staging
// directory (it now resolves its own directory the SQL Server service
// account can write to), the staging dir's deferred os.RemoveAll no longer
// covers the real backup file — execMSSQLBackup must remove
// result.BackupFile itself once the upload attempt is done.
func TestExecMSSQLBackupRemovesLocalBackupFileAfterSuccessfulUpload(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	// The fake writes the backup file somewhere other than the staging
	// dir, mirroring D23's real fix: RunBackup now resolves its own
	// target directory instead of writing under outputPath.
	backupBytes := []byte("mssql-backup-bytes")
	backupFile := filepath.Join(t.TempDir(), "ProductionDB_full_20260331.bak")
	if err := os.WriteFile(backupFile, backupBytes, 0o644); err != nil {
		t.Fatalf("write backup file: %v", err)
	}

	origRunMSSQLBackup := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = origRunMSSQLBackup })
	runMSSQLBackup = func(_, _, _, _ string) (*mssql.BackupResult, error) {
		return &mssql.BackupResult{
			InstanceName: "MSSQLSERVER",
			DatabaseName: "ProductionDB",
			BackupType:   "full",
			BackupFile:   backupFile,
			SizeBytes:    int64(len(backupBytes)),
			Compressed:   true,
			DurationMs:   1234,
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"database":   "ProductionDB",
		"backupType": "full",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLBackup(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}

	if _, statErr := os.Stat(backupFile); !os.IsNotExist(statErr) {
		t.Fatalf("expected local backup file %q to be removed after upload, stat err=%v", backupFile, statErr)
	}
}

func TestExecMSSQLBackupRemovesLocalBackupFileWhenUploadFails(t *testing.T) {
	provider := &failingUploadProvider{}
	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	backupBytes := []byte("mssql-backup-bytes")
	backupFile := filepath.Join(t.TempDir(), "ProductionDB_full_20260331.bak")
	if err := os.WriteFile(backupFile, backupBytes, 0o644); err != nil {
		t.Fatalf("write backup file: %v", err)
	}

	origRunMSSQLBackup := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = origRunMSSQLBackup })
	runMSSQLBackup = func(_, _, _, _ string) (*mssql.BackupResult, error) {
		return &mssql.BackupResult{
			InstanceName: "MSSQLSERVER",
			DatabaseName: "ProductionDB",
			BackupType:   "full",
			BackupFile:   backupFile,
			SizeBytes:    int64(len(backupBytes)),
			Compressed:   true,
			DurationMs:   1234,
		}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"database":   "ProductionDB",
		"backupType": "full",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLBackup(payload, mgr)
	if result.Success {
		t.Fatal("expected failure when upload fails")
	}

	if _, statErr := os.Stat(backupFile); !os.IsNotExist(statErr) {
		t.Fatalf("expected local backup file %q to be removed even when upload fails, stat err=%v", backupFile, statErr)
	}
}

// setupMSSQLSnapshotFixture uploads a snapshot manifest + backup file to
// provider and returns the snapshot ID, for tests that only care about
// where the artifact gets staged / cleaned up, not backup content details.
func setupMSSQLSnapshotFixture(t *testing.T, provider providers.BackupProvider, snapshotID string, backupBytes []byte) {
	t.Helper()
	prefix := path.Join("snapshots", snapshotID)
	srcPath := filepath.Join(t.TempDir(), "ProductionDB_full_20260331.bak")
	if err := os.WriteFile(srcPath, backupBytes, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	remoteBackupPath := path.Join(prefix, "files", filepath.Base(srcPath))
	if err := provider.Upload(srcPath, remoteBackupPath); err != nil {
		t.Fatalf("upload backup file: %v", err)
	}
	manifest := backup.Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now().UTC(),
		Files: []backup.SnapshotFile{
			{SourcePath: filepath.Base(srcPath), BackupPath: remoteBackupPath, Size: int64(len(backupBytes))},
		},
		Size: int64(len(backupBytes)),
	}
	if err := uploadMssqlSnapshotManifest(provider, manifest); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
}

// D23b: RESTORE / RESTORE VERIFYONLY are executed by the SQL Server
// service account, exactly like BACKUP DATABASE/LOG (D23) — so the helper
// must download the artifact into the same SQL-readable directory the
// backup resolver returns, not its own process-local staging directory
// (which resolves under SystemTemp when the helper runs as SYSTEM).

// (a) the restore's local path is under the resolved dir, never under an
// ad-hoc staging tempdir.
func TestExecMSSQLRestoreDownloadsArtifactIntoResolvedTargetDir(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-restore-targetdir"
	backupBytes := []byte("restore-target-dir-bytes")
	setupMSSQLSnapshotFixture(t, provider, snapshotID, backupBytes)

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(), // must NOT be where the artifact lands
	})

	resolvedDir := t.TempDir()
	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(instance string) (string, error) {
		if instance != "MSSQLSERVER" {
			t.Fatalf("instance = %q", instance)
		}
		return resolvedDir, nil
	}

	origRunMSSQLRestore := runMSSQLRestore
	t.Cleanup(func() { runMSSQLRestore = origRunMSSQLRestore })
	var stagedPath string
	runMSSQLRestore = func(_, backupFile, targetDB string, _ bool) (*mssql.RestoreResult, error) {
		stagedPath = backupFile
		return &mssql.RestoreResult{DatabaseName: targetDB, RestoredAs: targetDB, Status: "completed", FilesRestored: 1}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":       "MSSQLSERVER",
		"snapshotId":     snapshotID,
		"targetDatabase": "ProductionDB_Restore",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLRestore(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}
	if stagedPath == "" {
		t.Fatal("expected restore to receive a staged path")
	}
	if got := filepath.Dir(stagedPath); got != resolvedDir {
		t.Fatalf("staged path dir = %q, want the resolved restore target dir %q (must never be an ad-hoc staging tempdir)", got, resolvedDir)
	}
}

// (b) the file is removed after a failed restore too (the success case is
// already covered by TestExecMSSQLRestoreStagesSnapshotArtifact above).
func TestExecMSSQLRestoreRemovesLocalArtifactWhenRestoreFails(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-restore-fails"
	backupBytes := []byte("restore-fails-bytes")
	setupMSSQLSnapshotFixture(t, provider, snapshotID, backupBytes)

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	resolvedDir := t.TempDir()
	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return resolvedDir, nil }

	origRunMSSQLRestore := runMSSQLRestore
	t.Cleanup(func() { runMSSQLRestore = origRunMSSQLRestore })
	var stagedPath string
	runMSSQLRestore = func(_, backupFile, _ string, _ bool) (*mssql.RestoreResult, error) {
		stagedPath = backupFile
		if _, err := os.Stat(backupFile); err != nil {
			t.Fatalf("staged backup file missing before simulated failure: %v", err)
		}
		return nil, fmt.Errorf("simulated restore failure")
	}

	payload, err := json.Marshal(map[string]any{
		"instance":       "MSSQLSERVER",
		"snapshotId":     snapshotID,
		"targetDatabase": "ProductionDB_Restore",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLRestore(payload, mgr)
	if result.Success {
		t.Fatal("expected failure")
	}
	if stagedPath == "" {
		t.Fatal("expected restore to receive a staged path before failing")
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected local artifact to be removed after a failed restore, stat err=%v", err)
	}
}

// (c) same for verify: local path under the resolved dir, and removed
// whether verify succeeds or fails.
func TestExecMSSQLVerifyDownloadsArtifactIntoResolvedTargetDir(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-verify-targetdir"
	backupBytes := []byte("verify-target-dir-bytes")
	setupMSSQLSnapshotFixture(t, provider, snapshotID, backupBytes)

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	resolvedDir := t.TempDir()
	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(instance string) (string, error) {
		if instance != "MSSQLSERVER" {
			t.Fatalf("instance = %q", instance)
		}
		return resolvedDir, nil
	}

	origRunMSSQLVerify := runMSSQLVerify
	t.Cleanup(func() { runMSSQLVerify = origRunMSSQLVerify })
	var stagedPath string
	runMSSQLVerify = func(_, backupFile string) (*mssql.VerifyResult, error) {
		stagedPath = backupFile
		return &mssql.VerifyResult{BackupFile: backupFile, Valid: true}, nil
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"snapshotId": snapshotID,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLVerify(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got stderr %q", result.Stderr)
	}
	if stagedPath == "" {
		t.Fatal("expected verify to receive a staged path")
	}
	if got := filepath.Dir(stagedPath); got != resolvedDir {
		t.Fatalf("staged path dir = %q, want the resolved restore target dir %q (must never be an ad-hoc staging tempdir)", got, resolvedDir)
	}
}

func TestExecMSSQLVerifyRemovesLocalArtifactWhenVerifyFails(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "mssql-prod-appdb-verify-fails"
	backupBytes := []byte("verify-fails-bytes")
	setupMSSQLSnapshotFixture(t, provider, snapshotID, backupBytes)

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:   provider,
		StagingDir: t.TempDir(),
	})

	resolvedDir := t.TempDir()
	origResolve := resolveMSSQLRestoreTargetDir
	t.Cleanup(func() { resolveMSSQLRestoreTargetDir = origResolve })
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return resolvedDir, nil }

	origRunMSSQLVerify := runMSSQLVerify
	t.Cleanup(func() { runMSSQLVerify = origRunMSSQLVerify })
	var stagedPath string
	runMSSQLVerify = func(_, backupFile string) (*mssql.VerifyResult, error) {
		stagedPath = backupFile
		if _, err := os.Stat(backupFile); err != nil {
			t.Fatalf("staged backup file missing before simulated failure: %v", err)
		}
		return nil, fmt.Errorf("simulated verify failure")
	}

	payload, err := json.Marshal(map[string]any{
		"instance":   "MSSQLSERVER",
		"snapshotId": snapshotID,
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execMSSQLVerify(payload, mgr)
	if result.Success {
		t.Fatal("expected failure")
	}
	if stagedPath == "" {
		t.Fatal("expected verify to receive a staged path before failing")
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected local artifact to be removed after a failed verify, stat err=%v", err)
	}
}
