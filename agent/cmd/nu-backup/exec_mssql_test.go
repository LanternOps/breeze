package main

import (
	"encoding/json"
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
