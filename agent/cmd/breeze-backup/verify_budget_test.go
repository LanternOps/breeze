package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
)

// stallingSnapshotProvider serves a manifest of n small files; the object at
// index stall blocks until its download context ends.
type stallingSnapshotProvider struct {
	snapshotID string
	manifest   []byte
	files      map[string][]byte
	stall      string
}

func newStallingSnapshotProvider(t *testing.T, snapshotID string, n, stall int) *stallingSnapshotProvider {
	t.Helper()
	p := &stallingSnapshotProvider{snapshotID: snapshotID, files: map[string][]byte{}}
	snap := backup.Snapshot{ID: snapshotID}
	for i := 0; i < n; i++ {
		data := []byte(fmt.Sprintf("object-%d", i))
		key := path.Join("snapshots", snapshotID, "files", fmt.Sprintf("f%d.txt", i))
		p.files[key] = data
		if i == stall {
			p.stall = key
		}
		snap.Files = append(snap.Files, backup.SnapshotFile{
			SourcePath: fmt.Sprintf("/data/f%d.txt", i),
			BackupPath: key,
			Size:       int64(len(data)),
		})
	}
	var err error
	if p.manifest, err = json.Marshal(snap); err != nil {
		t.Fatal(err)
	}
	return p
}

func (p *stallingSnapshotProvider) Upload(string, string) error   { return nil }
func (p *stallingSnapshotProvider) List(string) ([]string, error) { return nil, nil }
func (p *stallingSnapshotProvider) Delete(string) error           { return nil }
func (p *stallingSnapshotProvider) Download(remotePath, localPath string) error {
	return p.DownloadContext(context.Background(), remotePath, localPath)
}

func (p *stallingSnapshotProvider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	if remotePath == path.Join("snapshots", p.snapshotID, "manifest.json") {
		return os.WriteFile(localPath, p.manifest, 0o644)
	}
	if remotePath == p.stall {
		<-ctx.Done()
		return ctx.Err()
	}
	data, ok := p.files[remotePath]
	if !ok {
		return os.ErrNotExist
	}
	return os.WriteFile(localPath, data, 0o644)
}

func withVerifyRunBudget(t *testing.T, d time.Duration) {
	t.Helper()
	old := verifyRunBudget
	verifyRunBudget = d
	t.Cleanup(func() { verifyRunBudget = old })
}

// #6598: a verify that outlives its budget must answer the agent with a
// SUCCESSFUL command result carrying the partial counts. The API only parses
// the verification body from a completed command; a failed one is recorded
// as "0 files ok 0 files failed".
func TestExecBackupVerify_BudgetExhaustedReturnsPartialCounts(t *testing.T) {
	withVerifyRunBudget(t, 300*time.Millisecond)
	provider := newStallingSnapshotProvider(t, "budget-verify", 4, 3)
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	done := make(chan struct{})
	var res struct {
		Success bool
		Stdout  string
		Stderr  string
	}
	go func() {
		defer close(done)
		r := execBackupVerifyContext(context.Background(), "cmd-verify", json.RawMessage(`{"snapshotId":"budget-verify"}`), mgr, nil, nil)
		res.Success, res.Stdout, res.Stderr = r.Success, r.Stdout, r.Stderr
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("verify did not stop at its run budget")
	}

	if !res.Success {
		t.Fatalf("result not successful (stderr=%q): the partial counts would be discarded", res.Stderr)
	}
	var body backup.VerifyResult
	if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil {
		t.Fatalf("stdout is not a verify result: %v (%q)", err, res.Stdout)
	}
	if body.Status != "partial" || body.FilesVerified != 3 || body.FilesUnchecked != 1 {
		t.Fatalf("result = %+v, want partial with 3 verified and 1 unchecked", body)
	}
}

func TestExecBackupTestRestore_BudgetExhaustedReturnsPartialCounts(t *testing.T) {
	withVerifyRunBudget(t, 300*time.Millisecond)
	originalWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = originalWorkRoot })

	provider := newStallingSnapshotProvider(t, "budget-restore", 4, 0)
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

	done := make(chan struct{})
	var success bool
	var stdout, stderr string
	go func() {
		defer close(done)
		r := execBackupTestRestoreContext(context.Background(), "cmd-restore", json.RawMessage(`{"snapshotId":"budget-restore"}`), mgr, nil, nil)
		success, stdout, stderr = r.Success, r.Stdout, r.Stderr
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("test restore did not stop at its run budget")
	}

	if !success {
		t.Fatalf("result not successful (stderr=%q)", stderr)
	}
	var body backup.TestRestoreResult
	if err := json.Unmarshal([]byte(stdout), &body); err != nil {
		t.Fatalf("stdout is not a test-restore result: %v (%q)", err, stdout)
	}
	if body.Status != "partial" || body.FilesVerified != 3 || body.FilesUnchecked != 1 || !body.CleanedUp {
		t.Fatalf("result = %+v, want partial with 3 verified, 1 unchecked, cleaned up", body)
	}
}
