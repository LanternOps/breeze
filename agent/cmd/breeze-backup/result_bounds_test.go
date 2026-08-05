package main

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
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

// Building and marshalling a 60k-entry manifest costs ~5s under -race, and
// several tests need the identical input, so the marshalled stdout is built
// once per package run. The fixtures are treated strictly read-only (Go strings
// are immutable and fitBackupResultToIPC takes its argument by value).
var (
	oversizeRunOnce   sync.Once
	oversizeRunStdout string
	fieldRunOnce      sync.Once
	fieldRunJob       *backup.BackupJob
)

// oversizeRunResult returns a backup_run result whose marshalled manifest is
// comfortably past ipc.MaxMessageSize (~25 MB).
func oversizeRunResult(t *testing.T) backupipc.BackupCommandResult {
	t.Helper()
	oversizeRunOnce.Do(func() {
		data, err := json.Marshal(buildLargeRunJob(oversizeFileCount, fieldReportErrorCount))
		if err != nil {
			panic(err)
		}
		oversizeRunStdout = string(data)
	})
	return backupipc.BackupCommandResult{
		CommandID: "822e0c7f-7e35-43e6-b0fc-0912a5c0d221",
		Success:   true,
		Stdout:    oversizeRunStdout,
	}
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
	fieldRunOnce.Do(func() { fieldRunJob = buildLargeRunJob(fieldReportFileCount, fieldReportErrorCount) })
	job := fieldRunJob
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
	fitted, degraded := fitBackupResultToIPC(oversizeRunResult(t))

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
	fitted, _ := fitBackupResultToIPC(oversizeRunResult(t))

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
	// Pin that TIER 1 did this, not tier 4's last-resort clamp. Without these
	// two assertions the test passes with tier 1 deleted — tier 4 rescues it
	// at a 16x smaller cap — and tier 1 is the "bound the detail before
	// marshalling" half of the fix, so it must be independently required.
	if len(fitted.Stderr) < maxResultTextBytes {
		t.Errorf("expected ~%d bytes of stderr retained by tier 1, got %d (tier 4 clamp?)",
			maxResultTextBytes, len(fitted.Stderr))
	}
	if !strings.HasPrefix(degraded, "stderr truncated") {
		t.Errorf("expected the tier-1 stderr note, got %q", degraded)
	}
}

// TestFitBackupResultAlwaysFits is the total-postcondition test: no matter how
// pathological the payload, the returned result fits the frame, because a
// terminal status must always land.
func TestFitBackupResultAlwaysFits(t *testing.T) {
	cases := map[string]struct {
		in backupipc.BackupCommandResult
		// summarisable is true when the body is a JSON object, so the tiers can
		// reduce it while keeping Success. A body that is not an object cannot
		// be summarised and is deliberately delivered as an explicit failure
		// rather than as a success with an empty body.
		summarisable bool
	}{
		"non-json stdout": {
			in: backupipc.BackupCommandResult{
				CommandID: "cmd-1",
				Success:   true,
				Stdout:    strings.Repeat("x", ipc.MaxMessageSize+1024),
			},
		},
		"json array stdout": {
			in: backupipc.BackupCommandResult{
				CommandID: "cmd-2",
				Success:   true,
				Stdout:    "[" + strings.Repeat(`"`+strings.Repeat("y", 1024)+`",`, 20000) + `"tail"]`,
			},
		},
		"giant warning only": {
			in: backupipc.BackupCommandResult{
				CommandID: "cmd-3",
				Success:   true,
				Stdout:    `{"status":"completed","snapshot":{"id":"snap-1"},"warning":"` + strings.Repeat("w", ipc.MaxMessageSize) + `"}`,
			},
			summarisable: true,
		},
		"empty": {
			in:           backupipc.BackupCommandResult{CommandID: "cmd-4", Success: true},
			summarisable: true,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			fitted, _ := fitBackupResultToIPC(tc.in)
			if got := payloadSize(t, fitted); got > resultPayloadBudget {
				t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
			}
			if fitted.CommandID != tc.in.CommandID {
				t.Errorf("expected commandId %q to survive, got %q", tc.in.CommandID, fitted.CommandID)
			}
			if tc.summarisable && !fitted.Success {
				t.Error("expected a summarisable body to keep its success status")
			}
			if !tc.summarisable && fitted.Success {
				t.Error("expected an unsummarisable oversize body to degrade to a failure")
			}
		})
	}
}

// TestSendBackupResultDeliversOversizeRun is the end-to-end proof over a real
// ipc.Conn pair: before the fix conn.SendTyped returned "message too large" and
// the agent received nothing at all. Now a terminal result arrives.
func TestSendBackupResultDeliversOversizeRun(t *testing.T) {
	serverNC, clientNC := net.Pipe()
	defer func() { _ = serverNC.Close() }()
	defer func() { _ = clientNC.Close() }()

	sender := ipc.NewConn(clientNC)
	receiver := ipc.NewConn(serverNC)

	result := oversizeRunResult(t)

	sendErr := make(chan error, 1)
	go func() { sendErr <- sendBackupResult(sender, "env-1", result) }()

	if err := receiver.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
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

// TestFitBackupResultPreservesRestoreScalars is the regression guard for the
// review finding that an enumerated keep-list would silently zero the counters
// the server persists. A partial restore's oversize failedFiles array must be
// dropped WITHOUT zeroing filesRestored / bytesRestored / filesFailed, which
// restoreResultPersistence reads straight into the restore job row.
func TestFitBackupResultPreservesRestoreScalars(t *testing.T) {
	failed := make([]string, 0, 200000)
	for i := 0; i < 200000; i++ {
		failed = append(failed, fmt.Sprintf(`C:\Users\jdoe\Documents\archive\report_%06d.docx: access is denied`, i))
	}
	restore := backup.RestoreResult{
		SnapshotID:    "snapshot-20260801T125517Z-5edfcd7e",
		Status:        "partial",
		FilesRestored: 98211,
		BytesRestored: 27412998811,
		FilesFailed:   len(failed),
		FailedFiles:   failed,
		Error:         "restore completed partially",
	}
	data, err := json.Marshal(restore)
	if err != nil {
		t.Fatalf("marshal restore result: %v", err)
	}
	in := backupipc.BackupCommandResult{CommandID: "restore-1", Success: true, Stdout: string(data)}

	fitted, degraded := fitBackupResultToIPC(in)
	if degraded == "" {
		t.Fatal("expected an oversize restore result to be reported as degraded")
	}
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if !fitted.Success {
		t.Error("a restore that ran must not be flipped to failure just because its detail was oversize")
	}

	var out backup.RestoreResult
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if out.Status != "partial" {
		t.Errorf("expected status partial, got %q", out.Status)
	}
	if out.SnapshotID != "snapshot-20260801T125517Z-5edfcd7e" {
		t.Errorf("expected snapshotId to survive, got %q", out.SnapshotID)
	}
	if out.FilesRestored != 98211 {
		t.Errorf("expected filesRestored 98211 to survive, got %d", out.FilesRestored)
	}
	if out.BytesRestored != 27412998811 {
		t.Errorf("expected bytesRestored to survive, got %d", out.BytesRestored)
	}
	if out.FilesFailed != 200000 {
		t.Errorf("expected filesFailed 200000 to survive, got %d", out.FilesFailed)
	}
	if len(out.FailedFiles) != 0 {
		t.Errorf("expected the failedFiles array to be dropped, got %d entries", len(out.FailedFiles))
	}
	if out.Error != "restore completed partially" {
		t.Errorf("expected the error scalar to survive, got %q", out.Error)
	}
}

// TestFitBackupResultRejectsUnsummarisableBody pins that a body we cannot
// summarise (backup_list returns a top-level JSON ARRAY) degrades to an
// explicit failure rather than an empty success. An empty snapshot list read as
// "this device has no backups" is worse than a loud error.
func TestFitBackupResultRejectsUnsummarisableBody(t *testing.T) {
	entry := `{"id":"snapshot-20260801T125517Z-5edfcd7e","size":35421941515},`
	in := backupipc.BackupCommandResult{
		CommandID: "list-1",
		Success:   true,
		Stdout:    "[" + strings.Repeat(entry, 400000) + `{"id":"tail"}]`,
	}

	fitted, degraded := fitBackupResultToIPC(in)
	if degraded == "" {
		t.Fatal("expected an oversize list result to be reported as degraded")
	}
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if fitted.Success {
		t.Error("an unsummarisable oversize body must not be delivered as a success")
	}
	if fitted.Stdout != "" {
		t.Errorf("expected an empty stdout, got %.80q", fitted.Stdout)
	}
	if !strings.Contains(fitted.Stderr, "IPC limit") {
		t.Errorf("expected the stderr to explain the oversize, got %.120q", fitted.Stderr)
	}
}

// TestEmptySnapshotFilesKeepsTheFilesKey pins that the dropped index is an
// EMPTY ARRAY, not an absent key. The server's stale-row cleanup is gated on
// key presence (`if (snapshot && result.snapshot?.files)`), so omitting the key
// would leave a previous delivery's backup_snapshot_files rows in place while
// hasIndexedFiles flipped to false — two states that then disagree.
func TestEmptySnapshotFilesKeepsTheFilesKey(t *testing.T) {
	fitted, _ := fitBackupResultToIPC(oversizeRunResult(t))

	var out map[string]json.RawMessage
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	var snap map[string]json.RawMessage
	if err := json.Unmarshal(out["snapshot"], &snap); err != nil {
		t.Fatalf("fitted snapshot is not valid JSON: %v", err)
	}
	raw, present := snap["files"]
	if !present {
		t.Fatal("expected snapshot.files to be present as an empty array, not omitted")
	}
	var files []json.RawMessage
	if err := json.Unmarshal(raw, &files); err != nil {
		t.Fatalf("snapshot.files is not an array: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected snapshot.files to be empty, got %d entries", len(files))
	}
}

// TestFitBackupResultDropsOversizeSystemStateManifest covers a system_image run
// whose bulk is the system-state manifest rather than the file index: it must
// be dropped, and the drop must be recorded in the warning the server persists
// — a BMR restore point with a silently-null manifest is not usable.
func TestFitBackupResultDropsOversizeSystemStateManifest(t *testing.T) {
	manifest := `{"platform":"windows","artifacts":[` +
		strings.Repeat(`{"name":"registry-hive","path":"C:\\Windows\\System32\\config\\SOFTWARE","bytes":123456},`, 200000) +
		`{"name":"tail"}]}`
	stdout := `{"id":"job-1","status":"completed","filesBackedUp":12,"bytesBackedUp":345,` +
		`"snapshot":{"id":"snapshot-1","size":345},"systemStateManifest":` + manifest + `}`
	in := backupipc.BackupCommandResult{CommandID: "sysimage-1", Success: true, Stdout: stdout}

	fitted, degraded := fitBackupResultToIPC(in)
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if !strings.Contains(degraded, "systemStateManifest") {
		t.Errorf("expected the degradation note to name systemStateManifest, got %q", degraded)
	}
	var out struct {
		Status              string          `json:"status"`
		Warning             string          `json:"warning"`
		SystemStateManifest json.RawMessage `json:"systemStateManifest"`
		Snapshot            struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if len(out.SystemStateManifest) != 0 {
		t.Error("expected the oversize systemStateManifest to be dropped")
	}
	if out.Status != "completed" || out.Snapshot.ID != "snapshot-1" {
		t.Errorf("terminal status did not survive: status=%q snapshotId=%q", out.Status, out.Snapshot.ID)
	}
	if !strings.Contains(out.Warning, "systemStateManifest") {
		t.Errorf("expected the persisted warning to name the dropped manifest, got %q", out.Warning)
	}
}

// TestFitBackupResultReducesToScalars exercises TIER 3, which tier 2 hides
// whenever the bulk sits in one big container. Here the bulk is spread across
// many containers that are each individually under bulkFieldThreshold, so tier
// 2 drops nothing and tier 3 is what has to save the terminal status.
//
// Without this the whole reduceToScalars path is unexecuted: it could return an
// empty object, or lose status/snapshotId/errorCount, with the suite still green.
func TestFitBackupResultReducesToScalars(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"id":"job-1","status":"completed","filesBackedUp":42,"bytesBackedUp":999,` +
		`"errorCount":317,"snapshot":{"id":"snapshot-1","size":999}`)
	// Each container is just under the bulk threshold, so tier 2 skips them all.
	chunk := strings.Repeat(`"x",`, 800) + `"x"`
	for i := 0; i < 6000; i++ {
		fmt.Fprintf(&b, `,"detail%04d":[%s]`, i, chunk)
	}
	b.WriteString("}")
	in := backupipc.BackupCommandResult{CommandID: "cmd-scalars", Success: true, Stdout: b.String()}
	if len(in.Stdout) <= resultPayloadBudget {
		t.Fatalf("fixture must be oversize, got %d bytes", len(in.Stdout))
	}

	fitted, degraded := fitBackupResultToIPC(in)
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if !strings.Contains(degraded, "summary scalars") {
		t.Fatalf("expected tier 3 to be the tier that fired, got %q", degraded)
	}
	if !fitted.Success {
		t.Error("expected success to survive tier 3")
	}
	var out struct {
		ID            string          `json:"id"`
		Status        string          `json:"status"`
		FilesBackedUp int             `json:"filesBackedUp"`
		BytesBackedUp int64           `json:"bytesBackedUp"`
		ErrorCount    int             `json:"errorCount"`
		Warning       string          `json:"warning"`
		Detail0000    json.RawMessage `json:"detail0000"`
		Snapshot      struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if out.Status != "completed" || out.ID != "job-1" || out.Snapshot.ID != "snapshot-1" {
		t.Errorf("terminal identity did not survive tier 3: id=%q status=%q snapshotId=%q",
			out.ID, out.Status, out.Snapshot.ID)
	}
	if out.FilesBackedUp != 42 || out.BytesBackedUp != 999 {
		t.Errorf("counters did not survive tier 3: files=%d bytes=%d", out.FilesBackedUp, out.BytesBackedUp)
	}
	if out.ErrorCount != 317 {
		t.Errorf("expected errorCount 317 to survive tier 3, got %d", out.ErrorCount)
	}
	if len(out.Detail0000) != 0 {
		t.Error("expected the container fields to be dropped by tier 3")
	}
	if !strings.Contains(out.Warning, "detail0000") {
		t.Errorf("expected tier 3 to record the omitted fields in the persisted warning, got %.120q", out.Warning)
	}
}

// TestFitBackupResultLastResortRecoversStatus exercises TIER 4's salvage branch
// on an object body. Every existing tier-4 case has non-object stdout, so
// lastResortStdout's recovery loop never runs and could return nothing at all
// with the suite still green — yet recovering status/snapshotId is the entire
// reason tier 4 exists.
//
// The fixture survives tier 3 because it is all scalars: tier 3 keeps every
// scalar (clamped to maxResultTextBytes), and thousands of clamped scalars are
// still over budget.
func TestFitBackupResultLastResortRecoversStatus(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"id":"job-9","status":"completed","snapshotId":"snapshot-9"`)
	blob := strings.Repeat("z", 12*1024)
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&b, `,"note%04d":"%s"`, i, blob)
	}
	b.WriteString("}")
	in := backupipc.BackupCommandResult{CommandID: "cmd-lastresort", Success: true, Stdout: b.String()}

	fitted, degraded := fitBackupResultToIPC(in)
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	if !strings.Contains(degraded, "minimal terminal status") {
		t.Fatalf("expected tier 4 to be the tier that fired, got %q", degraded)
	}
	var out struct {
		ID         string `json:"id"`
		Status     string `json:"status"`
		SnapshotID string `json:"snapshotId"`
		Warning    string `json:"warning"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if out.Status != "completed" {
		t.Errorf("expected tier 4 to recover status, got %q", out.Status)
	}
	if out.SnapshotID != "snapshot-9" {
		t.Errorf("expected tier 4 to recover snapshotId, got %q", out.SnapshotID)
	}
	if out.ID != "job-9" {
		t.Errorf("expected tier 4 to recover the job id, got %q", out.ID)
	}
	if !strings.Contains(out.Warning, "IPC limit") {
		t.Errorf("expected tier 4 to explain itself in the warning, got %q", out.Warning)
	}
}

// TestSendBackupResultReportsSendFailure pins that a residual send failure is
// still returned (and therefore logged) rather than swallowed. Both call sites
// discard the error with `_ =`, so this log line is the only remaining evidence
// that a terminal status never reached the server.
func TestSendBackupResultReportsSendFailure(t *testing.T) {
	serverNC, clientNC := net.Pipe()
	if err := serverNC.Close(); err != nil {
		t.Fatalf("close receiver: %v", err)
	}
	if err := clientNC.Close(); err != nil {
		t.Fatalf("close sender: %v", err)
	}

	err := sendBackupResult(ipc.NewConn(clientNC), "env-dead", backupipc.BackupCommandResult{
		CommandID: "cmd-dead",
		Success:   true,
		Stdout:    `{"status":"completed","snapshot":{"id":"snapshot-1"}}`,
	})
	if err == nil {
		t.Fatal("expected a send over a closed connection to return an error, not be swallowed")
	}
}
