package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// refusedS3Body is an S3 error document; only its Code may surface.
const refusedS3Body = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Account detail that must not leak</Message><RequestId>REQ-NOT-FOR-LOGS</RequestId></Error>`

func writeSourceFiles(t *testing.T, n int) string {
	t.Helper()
	dir := t.TempDir()
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", i)), []byte(fmt.Sprintf("content %d", i)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// newUnpacedWriteEnv is newWriteEnv with control-plane pacing off: these runs
// make hundreds of resolve calls, which the production pacing spreads over
// minutes. newWriteEnv's cleanup restores the real options.
func newUnpacedWriteEnv(t *testing.T) *writeEnv {
	t.Helper()
	e := newWriteEnv(t)
	storageSessionOptions.ControlCallsPerMinute = -1
	return e
}

// backupResults reads every backup_result envelope off conn until it closes.
func backupResults(conn *ipc.Conn) <-chan *ipc.Envelope {
	ch := make(chan *ipc.Envelope, 4)
	go func() {
		defer close(ch)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
			env, err := conn.Recv()
			if err != nil {
				return
			}
			if env.Type == backupipc.TypeBackupResult {
				ch <- env
			}
		}
	}()
	return ch
}

// A store that refuses every request ends the backup_run with one
// destination-level error naming the store's code, after a bounded number of
// store requests, and the device's backup queue moves on to the next job
// (#11765). Before, the run skipped every file (30 s wait, one retry, skip)
// for as long as it had files, holding every later job behind it.
func TestBrokeredWrite_DestinationRefusingEveryRequestEndsTheRunAndFreesTheQueue(t *testing.T) {
	defer backup.SetUploadRetryDelaysForTest(time.Millisecond)()
	e := newUnpacedWriteEnv(t)
	var storeRequests atomic.Int64
	e.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		storeRequests.Add(1)
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(refusedS3Body))
		return true
	}
	const files = 200
	src := writeSourceFiles(t, files)
	payload := brokeredBackupRunPayload(t, e, func(p map[string]any) { p["paths"] = []string{src} })
	mgr, decoyDir := decoyStore(t)

	queue := newBackupExecutionQueue()
	canceller := newActiveCommandCanceller()
	first := queue.enqueue("refused-run", canceller)
	second := queue.enqueue("next-run", canceller)

	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()
	defer func() { _ = helperSide.Close() }()
	results := backupResults(ipc.NewConn(agentSide))
	raw, err := json.Marshal(backupipc.BackupCommandRequest{CommandID: "refused-run", CommandType: "backup_run", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		handleBackupCommand(ipc.NewConn(helperSide), &ipc.Envelope{ID: "refused-run", Payload: raw}, mgr, nil, canceller, first)
	}()

	var result backupipc.BackupCommandResult
	select {
	case env, ok := <-results:
		if !ok {
			t.Fatal("connection closed before the run's result")
		}
		if err := json.Unmarshal(env.Payload, &result); err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Minute):
		t.Fatal("the run against a refusing destination did not end")
	}
	if result.Success {
		t.Fatalf("a run the destination refused succeeded: %q", result.Stdout)
	}
	const want = "backup destination refused every request: storage answered status 403 (AccessDenied)"
	if !strings.Contains(result.Stderr, want) {
		t.Fatalf("stderr = %q, want it to contain %q", result.Stderr, want)
	}
	if n := strings.Count(result.Stderr, "storage answered status"); n != 1 {
		t.Fatalf("stderr names %d store answers, want exactly one error: %q", n, result.Stderr)
	}
	for _, leak := range []string{"Account detail", "REQ-NOT-FOR-LOGS", e.storage.URL} {
		if strings.Contains(result.Stderr, leak) {
			t.Fatalf("stderr leaks %q: %q", leak, result.Stderr)
		}
	}
	// Bounded: the threshold's worth of objects, each tried a few times,
	// and nothing at all for most of the files.
	if got := storeRequests.Load(); got > files {
		t.Fatalf("%d store requests for %d files; the run did not stop at the destination", got, files)
	}

	select {
	case <-handled:
	case <-time.After(30 * time.Second):
		t.Fatal("the command handler did not return after its result")
	}
	waited := make(chan error, 1)
	go func() { waited <- second.wait(func() {}) }()
	select {
	case err := <-waited:
		if err != nil {
			t.Fatalf("the queued job was not started: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the queued job is still waiting behind the refused run")
	}
	second.release()
	assertDirEmpty(t, decoyDir)
}

// A handful of objects the store refuses among successes are per-file
// failures, as before: the run completes and records them.
func TestBrokeredWrite_ScatteredStoreRefusalsDoNotEndTheRun(t *testing.T) {
	defer backup.SetUploadRetryDelaysForTest(time.Millisecond)()
	e := newUnpacedWriteEnv(t)
	e.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		k := r.URL.Query().Get("k")
		if r.Method == http.MethodPut && (strings.Contains(k, "f003") || strings.Contains(k, "f017") || strings.Contains(k, "f031")) {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(refusedS3Body))
			return true
		}
		return false
	}
	src := writeSourceFiles(t, 60)
	mgr, _ := decoyStore(t)
	result := executeCommand(backupipc.BackupCommandRequest{CommandID: "scattered", CommandType: "backup_run",
		Payload: brokeredBackupRunPayload(t, e, func(p map[string]any) { p["paths"] = []string{src} })}, mgr, nil, nil, newActiveCommandCanceller())
	if strings.Contains(result.Stderr, "backup destination refused every request") {
		t.Fatalf("three refused objects among successes ended the run: %q", result.Stderr)
	}
	var decoded struct {
		Snapshot *struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil || decoded.Snapshot == nil || decoded.Snapshot.ID != wiringIssuedSnapshotID {
		t.Fatalf("no published snapshot: success=%v stdout=%q stderr=%q", result.Success, result.Stdout, result.Stderr)
	}
}
