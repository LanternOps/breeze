package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

type flakyRestoreProvider struct {
	*providers.LocalProvider
	failOnce   string
	callCounts map[string]int
}

func (p *flakyRestoreProvider) Download(key, dest string) error {
	p.callCounts[key]++
	if key == p.failOnce && p.callCounts[key] == 1 {
		return os.ErrNotExist
	}
	return p.LocalProvider.Download(key, dest)
}

func TestExecBackupRestoreWithProgressTreatsPartialRestoreAsFailure(t *testing.T) {
	baseDir := t.TempDir()
	localProvider := providers.NewLocalProvider(baseDir)
	snapshotID := "restore-partial-1"
	prefix := filepath.Join("snapshots", snapshotID)

	srcDir := t.TempDir()
	file1 := filepath.Join(srcDir, "a.txt")
	file2 := filepath.Join(srcDir, "b.txt")
	if err := os.WriteFile(file1, []byte("alpha"), 0o644); err != nil {
		t.Fatalf("write file1: %v", err)
	}
	if err := os.WriteFile(file2, []byte("beta"), 0o644); err != nil {
		t.Fatalf("write file2: %v", err)
	}

	backupPath1 := filepath.ToSlash(filepath.Join(prefix, "files", "a.txt.gz"))
	backupPath2 := filepath.ToSlash(filepath.Join(prefix, "files", "b.txt.gz"))
	if err := localProvider.Upload(file1, backupPath1); err != nil {
		t.Fatalf("upload file1: %v", err)
	}
	if err := localProvider.Upload(file2, backupPath2); err != nil {
		t.Fatalf("upload file2: %v", err)
	}

	manifest := backup.Snapshot{
		ID: snapshotID,
		Files: []backup.SnapshotFile{
			{SourcePath: "/original/a.txt", BackupPath: backupPath1, Size: 5},
			{SourcePath: "/original/b.txt", BackupPath: backupPath2, Size: 4},
		},
		Size: 9,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if err := localProvider.Upload(manifestPath, filepath.ToSlash(filepath.Join(prefix, "manifest.json"))); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}

	provider := &flakyRestoreProvider{
		LocalProvider: localProvider,
		failOnce:      backupPath2,
		callCounts:    make(map[string]int),
	}
	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider: provider,
		Paths:    []string{srcDir},
	})

	payload, err := json.Marshal(map[string]any{
		"snapshotId": snapshotID,
		"targetPath": t.TempDir(),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	result := execBackupRestoreWithProgress(context.Background(), "restore-cmd-1", payload, mgr, nil, nil)
	if result.Success {
		t.Fatal("expected partial restore to report command failure")
	}
	if result.Stderr != "restore completed partially" {
		t.Fatalf("stderr = %q, want partial restore message", result.Stderr)
	}

	var restoreResult backup.RestoreResult
	if err := json.Unmarshal([]byte(result.Stdout), &restoreResult); err != nil {
		t.Fatalf("unmarshal restore result: %v", err)
	}
	if restoreResult.Status != "partial" {
		t.Fatalf("restore status = %q, want partial", restoreResult.Status)
	}
	if restoreResult.Error != "" {
		t.Fatalf("restore error = %q, want empty for partial restore", restoreResult.Error)
	}
}
