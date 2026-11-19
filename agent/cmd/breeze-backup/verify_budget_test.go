package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"path"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
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
		r := execBackupVerifyContext(context.Background(), "cmd-verify", json.RawMessage(`{"snapshotId":"budget-verify"}`), mgr, nil, nil, 0)
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
		r := execBackupTestRestoreContext(context.Background(), "cmd-restore", json.RawMessage(`{"snapshotId":"budget-restore"}`), mgr, nil, nil, 0)
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

// The helper's run budget is the agent's forward wait (the IPC request's
// TimeoutMs) minus backupipc.VerifyRunMargin — never the command payload, so a
// helper paired with an old agent that waits the base 2h still stops at
// 1h50m. No timeout (0, or anything not usable) is the package default.
func TestVerifyRunBudgetFor(t *testing.T) {
	withVerifyRunBudget(t, 42*time.Second)
	cases := []struct {
		name      string
		timeoutMs int64
		want      time.Duration
	}{
		{"no timeout", 0, 42 * time.Second},
		{"negative", -1, 42 * time.Second},
		{"old agent base 2h", backupipc.VerifyCommandTimeout.Milliseconds(), backupipc.VerifyRunBudget},
		{"scaled 395m", (395 * time.Minute).Milliseconds(), 385 * time.Minute},
		{"12h cap", backupipc.VerifyMaxCommandTimeout.Milliseconds(), backupipc.VerifyMaxCommandTimeout - backupipc.VerifyRunMargin},
		{"above cap", (48 * time.Hour).Milliseconds(), backupipc.VerifyMaxCommandTimeout - backupipc.VerifyRunMargin},
		{"overflow-sized", math.MaxInt64, backupipc.VerifyMaxCommandTimeout - backupipc.VerifyRunMargin},
		// A wait no longer than the margin would leave no budget (and a zero
		// TimeBudget means "unbounded" to the verify loop): use the default.
		{"shorter than margin", (5 * time.Minute).Milliseconds(), 42 * time.Second},
		{"equal to margin", backupipc.VerifyRunMargin.Milliseconds(), 42 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := verifyRunBudgetFor(tc.timeoutMs)
			if got != tc.want {
				t.Fatalf("verifyRunBudgetFor(%d) = %v, want %v", tc.timeoutMs, got, tc.want)
			}
			if got <= 0 {
				t.Fatalf("verifyRunBudgetFor(%d) = %v, must be positive", tc.timeoutMs, got)
			}
		})
	}
}

// requestTimeoutFor gives a request whose derived run budget is d.
func requestTimeoutFor(d time.Duration) int64 {
	return (backupipc.VerifyRunMargin + d).Milliseconds()
}

// The production route: the agent's forward request reaches
// handleBackupCommand, whose verify/test-restore branch must stop the run at
// TimeoutMs - margin. The package default is set to an hour, so a route that
// ignored the request would hang past the test's deadline.
func TestHandleBackupCommand_VerifyRunBudgetFollowsRequestTimeout(t *testing.T) {
	withVerifyRunBudget(t, time.Hour)
	originalWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = originalWorkRoot })

	for _, commandType := range []string{"backup_verify", "backup_test_restore"} {
		t.Run(commandType, func(t *testing.T) {
			snapshotID := "route-" + commandType
			provider := newStallingSnapshotProvider(t, snapshotID, 4, 3)
			mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

			agentSide, helperSide := net.Pipe()
			defer func() { _ = agentSide.Close() }()
			defer func() { _ = helperSide.Close() }()

			req := backupipc.BackupCommandRequest{
				CommandID:   "route-cmd-" + commandType,
				CommandType: commandType,
				Payload:     json.RawMessage(fmt.Sprintf(`{"snapshotId":%q}`, snapshotID)),
				TimeoutMs:   requestTimeoutFor(300 * time.Millisecond),
			}
			raw, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			ch := startEnvelopeReader(ipc.NewConn(agentSide))
			go handleBackupCommand(ipc.NewConn(helperSide), &ipc.Envelope{ID: req.CommandID, Type: backupipc.TypeBackupCommand, Payload: raw}, mgr, nil, newActiveCommandCanceller())

			env := nextBackupResult(t, ch)
			var res backupipc.BackupCommandResult
			if err := json.Unmarshal(env.Payload, &res); err != nil {
				t.Fatal(err)
			}
			if !res.Success {
				t.Fatalf("result not successful (stderr=%q)", res.Stderr)
			}
			var body struct {
				Status         string `json:"status"`
				FilesUnchecked int    `json:"filesUnchecked"`
			}
			if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil {
				t.Fatalf("stdout: %v (%q)", err, res.Stdout)
			}
			if body.Status != "partial" || body.FilesUnchecked != 1 {
				t.Fatalf("result = %+v, want partial with 1 unchecked", body)
			}
		})
	}
}

// executeCommand's own verify/test-restore cases (reached with an agent.yaml
// manager) follow the request too.
func TestExecuteCommand_VerifyRunBudgetFollowsRequestTimeout(t *testing.T) {
	withVerifyRunBudget(t, time.Hour)
	originalWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = originalWorkRoot })

	for _, commandType := range []string{"backup_verify", "backup_test_restore"} {
		t.Run(commandType, func(t *testing.T) {
			snapshotID := "exec-" + commandType
			provider := newStallingSnapshotProvider(t, snapshotID, 4, 3)
			mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider})

			done := make(chan backupipc.BackupCommandResult, 1)
			go func() {
				done <- executeCommand(backupipc.BackupCommandRequest{
					CommandID:   "exec-cmd-" + commandType,
					CommandType: commandType,
					Payload:     json.RawMessage(fmt.Sprintf(`{"snapshotId":%q}`, snapshotID)),
					TimeoutMs:   requestTimeoutFor(300 * time.Millisecond),
				}, mgr, nil, nil, newActiveCommandCanceller())
			}()
			select {
			case res := <-done:
				if !res.Success {
					t.Fatalf("result not successful (stderr=%q)", res.Stderr)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("run did not stop at the budget derived from the request timeout")
			}
		})
	}
}
