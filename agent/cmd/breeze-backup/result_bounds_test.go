package main

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	// fieldReportFileCount / fieldReportErrorCount are the customer's actual
	// numbers from #3001 (123,284 files / 35.4 GB / 317 per-file errors), used
	// by the reproduction test.
	fieldReportFileCount  = 123284
	fieldReportErrorCount = 317
	// oversizeFileCount is the smaller fixture the behavioural tests use: it
	// still marshals well past ipc.MaxMessageSize (~25 MB) while keeping these
	// tests off multi-megabyte re-marshals under -race.
	oversizeFileCount = 60000
)

// buildLargeRunJob synthesises a completed backup_run job shaped like the field
// report in issue #3001: backed-up files each carrying an absolute Windows
// source path, a snapshot-prefixed backup path and a SHA-256 checksum, plus a
// few hundred per-file upload failures.
func buildLargeRunJob(files, failures int) *backup.BackupJob {
	snap := &backup.Snapshot{
		ID:            "snapshot-20260801T125517Z-5edfcd7e",
		Timestamp:     time.Date(2026, 8, 1, 12, 55, 17, 0, time.UTC),
		Size:          35421941515,
		FormatVersion: 2,
		Files:         make([]backup.SnapshotFile, 0, files),
	}
	for i := 0; i < files; i++ {
		src := fmt.Sprintf(`C:\Users\jdoe\AppData\Local\Microsoft\Edge\User Data\Default\Cache\Cache_Data\f_%06x`, i)
		snap.Files = append(snap.Files, backup.SnapshotFile{
			SourcePath: src,
			BackupPath: "snapshot-20260801T125517Z-5edfcd7e/C_/Users/jdoe/AppData/Local/Microsoft/Edge/User Data/Default/Cache/Cache_Data/f_" + fmt.Sprintf("%06x", i),
			Size:       int64(4096 + i),
			ModTime:    time.Date(2026, 7, 14, 9, 12, 33, 0, time.UTC),
			Checksum:   strings.Repeat("a", 64),
		})
	}
	uploadFailures := make([]error, 0, failures)
	for i := 0; i < failures; i++ {
		uploadFailures = append(uploadFailures, fmt.Errorf(
			`upload %s: The process cannot access the file because it is being used by another process.`,
			fmt.Sprintf(`C:\Users\jdoe\AppData\Local\Packages\Microsoft.Windows.Search_cw5n1h2txyewy\LocalState\AppIconCache\100\locked_%04d.dat`, i)))
	}
	snap.UploadFailures = uploadFailures

	job := &backup.BackupJob{
		ID:              "job-20260801T125454Z-1f91465e",
		StartedAt:       time.Date(2026, 8, 1, 12, 54, 54, 0, time.UTC),
		CompletedAt:     time.Date(2026, 8, 1, 16, 36, 3, 0, time.UTC),
		Snapshot:        snap,
		FilesBackedUp:   files,
		BytesBackedUp:   35421941515,
		Status:          "completed",
		ErrorCount:      failures,
		Warning:         fmt.Sprintf("%d of %d files failed to upload: ...", failures, files),
		ReferencedFiles: 121798,
		ReferencedBytes: 34929299357,
	}
	return job
}

func mustRunResult(t *testing.T, job *backup.BackupJob) backupipc.BackupCommandResult {
	t.Helper()
	data, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal job: %v", err)
	}
	return backupipc.BackupCommandResult{
		CommandID: "822e0c7f-7e35-43e6-b0fc-0912a5c0d221",
		Success:   true,
		Stdout:    string(data),
	}
}

func payloadSize(t *testing.T, result backupipc.BackupCommandResult) int {
	t.Helper()
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	return len(data)
}

// TestUnboundedRunResultExceedsIPCLimit reproduces #3001: the terminal result
// for a large run does not fit the IPC frame, so conn.Send rejects it and the
// backup_jobs row is left `running` until the stale-backup reaper fails it —
// even though the run succeeded.
//
// It also pins WHICH field is responsible. The issue text blames the 317-entry
// per-file failure list, but Snapshot.UploadFailures is `json:"-"` and never
// reaches the wire; the payload is dominated by the per-file snapshot manifest
// (Snapshot.Files), one entry per backed-up file.
func TestUnboundedRunResultExceedsIPCLimit(t *testing.T) {
	job := buildLargeRunJob(fieldReportFileCount, fieldReportErrorCount)
	result := mustRunResult(t, job)

	if got := payloadSize(t, result); got <= ipc.MaxMessageSize {
		t.Fatalf("expected the unbounded result to exceed the IPC cap, got %d <= %d", got, ipc.MaxMessageSize)
	}

	// Failure detail is not what blows the budget: with the file index removed
	// the same job marshals comfortably under the cap.
	noFiles := *job
	snapCopy := *job.Snapshot
	snapCopy.Files = nil
	noFiles.Snapshot = &snapCopy
	if got := payloadSize(t, mustRunResult(t, &noFiles)); got > ipc.MaxMessageSize {
		t.Fatalf("expected the file index to be the dominant field, but the result is still %d bytes without it", got)
	}
}

// TestFitBackupResultBoundsLargeRun is the core contract: whatever the run
// produced, the result handed to conn.Send fits the frame.
func TestFitBackupResultBoundsLargeRun(t *testing.T) {
	job := buildLargeRunJob(oversizeFileCount, fieldReportErrorCount)
	fitted, degraded := fitBackupResultToIPC(mustRunResult(t, job))

	if degraded == "" {
		t.Fatal("expected fitBackupResultToIPC to report that it degraded the payload")
	}
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
}

// TestFitBackupResultPreservesTerminalStatus pins the fields that decide
// whether the server records a completed job with a usable restore point:
// terminal status, snapshot id, and the byte/file counters must all survive
// truncation. Losing error detail is acceptable; losing the fact that the
// backup succeeded is not.
func TestFitBackupResultPreservesTerminalStatus(t *testing.T) {
	job := buildLargeRunJob(oversizeFileCount, fieldReportErrorCount)
	fitted, _ := fitBackupResultToIPC(mustRunResult(t, job))

	if !fitted.Success {
		t.Error("expected Success to survive truncation")
	}
	if fitted.CommandID != "822e0c7f-7e35-43e6-b0fc-0912a5c0d221" {
		t.Errorf("expected commandId to survive truncation, got %q", fitted.CommandID)
	}

	var out struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		FilesBackedUp int    `json:"filesBackedUp"`
		BytesBackedUp int64  `json:"bytesBackedUp"`
		ErrorCount    int    `json:"errorCount"`
		Warning       string `json:"warning"`
		Snapshot      struct {
			ID   string `json:"id"`
			Size int64  `json:"size"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if out.Status != "completed" {
		t.Errorf("expected status completed, got %q", out.Status)
	}
	if out.Snapshot.ID != "snapshot-20260801T125517Z-5edfcd7e" {
		t.Errorf("expected snapshot id to survive, got %q", out.Snapshot.ID)
	}
	if out.ID != "job-20260801T125454Z-1f91465e" {
		t.Errorf("expected job id to survive, got %q", out.ID)
	}
	if out.FilesBackedUp != oversizeFileCount {
		t.Errorf("expected filesBackedUp %d, got %d", oversizeFileCount, out.FilesBackedUp)
	}
	if out.BytesBackedUp != 35421941515 {
		t.Errorf("expected bytesBackedUp 35421941515, got %d", out.BytesBackedUp)
	}
	if out.Snapshot.Size != 35421941515 {
		t.Errorf("expected snapshot size to survive, got %d", out.Snapshot.Size)
	}
	// The total error count is the whole point of the errorCount column: it
	// must survive even when every individual failure detail is dropped.
	if out.ErrorCount != fieldReportErrorCount {
		t.Errorf("expected errorCount %d to survive, got %d", fieldReportErrorCount, out.ErrorCount)
	}
	// The user must be able to tell that the file index was dropped rather
	// than silently believe the snapshot has no indexed files.
	if !strings.Contains(out.Warning, "file index") {
		t.Errorf("expected the warning to record the dropped file index, got %q", out.Warning)
	}
}

// TestFitBackupResultKeepsFileIndexWhenItFits guards against over-truncation:
// an ordinary run must still ship its per-file index, which is what the server
// turns into the browsable restore file list.
func TestFitBackupResultKeepsFileIndexWhenItFits(t *testing.T) {
	job := buildLargeRunJob(500, 0)
	fitted, degraded := fitBackupResultToIPC(mustRunResult(t, job))

	if degraded != "" {
		t.Errorf("expected no degradation for a small run, got %q", degraded)
	}
	var out struct {
		Snapshot struct {
			Files []struct {
				SourcePath string `json:"sourcePath"`
			} `json:"files"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if len(out.Snapshot.Files) != 500 {
		t.Errorf("expected all 500 file entries to survive, got %d", len(out.Snapshot.Files))
	}
}

// TestFitBackupResultBoundsOversizeStderr covers the failure-path twin of the
// same bug: a hard failure returns errors.Join of every per-file error through
// fail(err.Error()), which is unbounded for the same reason.
func TestFitBackupResultBoundsOversizeStderr(t *testing.T) {
	huge := strings.Repeat("open C:\\Users\\jdoe\\file.dat: access is denied; ", 900000)
	result := backupipc.BackupCommandResult{CommandID: "cmd-1", Success: false, Stderr: huge}

	fitted, degraded := fitBackupResultToIPC(result)
	if degraded == "" {
		t.Error("expected an oversize stderr to be reported as degraded")
	}
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if fitted.Stderr == "" {
		t.Error("expected a truncated stderr, not an empty one")
	}
	if !strings.HasPrefix(fitted.Stderr, "open C:\\Users\\jdoe\\file.dat") {
		t.Errorf("expected the leading stderr detail to be kept, got %.80q", fitted.Stderr)
	}
}

// TestFitBackupResultAlwaysFits is the total-postcondition test: no matter how
// pathological the payload, the returned result fits the frame, because a
// terminal status must always land.
func TestFitBackupResultAlwaysFits(t *testing.T) {
	cases := map[string]backupipc.BackupCommandResult{
		"non-json stdout": {
			CommandID: "cmd-1",
			Success:   true,
			Stdout:    strings.Repeat("x", ipc.MaxMessageSize+1024),
		},
		"json array stdout": {
			CommandID: "cmd-2",
			Success:   true,
			Stdout:    "[" + strings.Repeat(`"`+strings.Repeat("y", 1024)+`",`, 20000) + `"tail"]`,
		},
		"giant warning only": {
			CommandID: "cmd-3",
			Success:   true,
			Stdout:    `{"status":"completed","snapshot":{"id":"snap-1"},"warning":"` + strings.Repeat("w", ipc.MaxMessageSize) + `"}`,
		},
		"empty": {CommandID: "cmd-4", Success: true},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			fitted, _ := fitBackupResultToIPC(in)
			if got := payloadSize(t, fitted); got > resultPayloadBudget {
				t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
			}
			if fitted.CommandID != in.CommandID {
				t.Errorf("expected commandId %q to survive, got %q", in.CommandID, fitted.CommandID)
			}
			if fitted.Success != in.Success {
				t.Errorf("expected success %v to survive, got %v", in.Success, fitted.Success)
			}
		})
	}
}

// TestSendBackupResultDeliversOversizeRun is the end-to-end proof over a real
// ipc.Conn pair: before the fix conn.SendTyped returned "message too large" and
// the agent received nothing at all. Now a terminal result arrives.
func TestSendBackupResultDeliversOversizeRun(t *testing.T) {
	serverNC, clientNC := net.Pipe()
	defer serverNC.Close()
	defer clientNC.Close()

	sender := ipc.NewConn(clientNC)
	receiver := ipc.NewConn(serverNC)

	job := buildLargeRunJob(oversizeFileCount, fieldReportErrorCount)
	result := mustRunResult(t, job)

	sendErr := make(chan error, 1)
	go func() { sendErr <- sendBackupResult(sender, "env-1", result) }()

	receiver.SetReadDeadline(time.Now().Add(30 * time.Second))
	env, err := receiver.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if err := <-sendErr; err != nil {
		t.Fatalf("sendBackupResult: %v", err)
	}
	if env.Type != backupipc.TypeBackupResult {
		t.Fatalf("expected %s envelope, got %s", backupipc.TypeBackupResult, env.Type)
	}

	var got backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &got); err != nil {
		t.Fatalf("unmarshal result payload: %v", err)
	}
	if !got.Success {
		t.Error("expected the delivered result to report success")
	}
	var out struct {
		Status     string `json:"status"`
		ErrorCount int    `json:"errorCount"`
		Snapshot   struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(got.Stdout), &out); err != nil {
		t.Fatalf("delivered stdout is not valid JSON: %v", err)
	}
	if out.Status != "completed" || out.Snapshot.ID == "" || out.ErrorCount != fieldReportErrorCount {
		t.Errorf("terminal status did not survive delivery: status=%q snapshotId=%q errorCount=%d",
			out.Status, out.Snapshot.ID, out.ErrorCount)
	}
}
