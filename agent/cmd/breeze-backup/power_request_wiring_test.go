package main

import (
	"encoding/json"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12193: a backup workload holds a system-required power request while it
// executes, so Windows does not idle-sleep the device mid-run, and lets go of
// it on every way the run ends.

type fakePowerRequests struct {
	mu       sync.Mutex
	held     int
	acquired int
	released int
	reasons  []string
	err      error
}

func (f *fakePowerRequests) hold(reason string) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	f.held++
	f.acquired++
	f.reasons = append(f.reasons, reason)
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.held--
			f.released++
		})
	}, nil
}

func (f *fakePowerRequests) snapshot() (held, acquired, released int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.held, f.acquired, f.released
}

func installFakePowerRequests(t *testing.T) *fakePowerRequests {
	t.Helper()
	fake := &fakePowerRequests{}
	orig := holdSystemAwake
	holdSystemAwake = fake.hold
	t.Cleanup(func() { holdSystemAwake = orig })
	return fake
}

func runHandleBackupCommand(t *testing.T, req backupipc.BackupCommandRequest, ticket *backupExecutionTicket, canceller *activeCommandCanceller) {
	t.Helper()
	agentSide, helperSide := net.Pipe()
	defer func() { _ = agentSide.Close() }()
	defer func() { _ = helperSide.Close() }()
	envelopes := startEnvelopeReader(ipc.NewConn(agentSide))
	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		handleBackupCommand(ipc.NewConn(helperSide), &ipc.Envelope{ID: req.CommandID, Payload: payload}, nil, nil, canceller, ticket)
	}()
	if req.Async {
		nextBackupResult(t, envelopes) // admission ack
	}
	nextBackupResult(t, envelopes) // terminal result
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handleBackupCommand did not return")
	}
}

func TestBackupWorkloadHoldsPowerRequestWhileExecuting(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  backupipc.BackupCommandRequest
	}{
		{"queue-aware backup_run", backupipc.BackupCommandRequest{CommandID: "q-run", CommandType: "backup_run", Async: true, QueueAsync: true, Payload: []byte(`{}`)}},
		{"async backup_run", backupipc.BackupCommandRequest{CommandID: "a-run", CommandType: "backup_run", Async: true, Payload: []byte(`{}`)}},
		{"synchronous backup_run", backupipc.BackupCommandRequest{CommandID: "s-run", CommandType: "backup_run", Payload: []byte(`{}`)}},
		{"queue-aware mssql_backup", backupipc.BackupCommandRequest{CommandID: "q-sql", CommandType: "mssql_backup", Async: true, QueueAsync: true, Payload: []byte(`{}`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := installFakePowerRequests(t)
			canceller := newActiveCommandCanceller()
			var ticket *backupExecutionTicket
			if tc.req.QueueAsync {
				ticket = newBackupExecutionQueue().enqueue(tc.req.CommandID, canceller)
			}
			runHandleBackupCommand(t, tc.req, ticket, canceller)

			held, acquired, released := fake.snapshot()
			if acquired != 1 {
				t.Fatalf("power requests acquired = %d, want 1", acquired)
			}
			if released != 1 || held != 0 {
				t.Fatalf("power request not released when the run ended: released=%d held=%d", released, held)
			}
		})
	}
}

// A run that never leaves the queue never executes, so it must not hold the
// device awake.
func TestQueuedWorkloadCancelledBeforeStartHoldsNoPowerRequest(t *testing.T) {
	fake := installFakePowerRequests(t)
	canceller := newActiveCommandCanceller()
	queue := newBackupExecutionQueue()
	blocker := queue.enqueue("blocker", canceller)
	defer blocker.release()
	ticket := queue.enqueue("waiting", canceller)

	req := backupipc.BackupCommandRequest{CommandID: "waiting", CommandType: "backup_run", Async: true, QueueAsync: true, Payload: []byte(`{}`)}
	// Cancelled before it runs: the blocker keeps the queue closed, so the
	// ticket wait can only end on the cancellation, deterministically. A hold
	// taken anywhere before the wait would show up as an acquisition.
	if !canceller.cancel("waiting") {
		t.Fatal("queued run was not tracked for cancellation")
	}
	runHandleBackupCommand(t, req, ticket, canceller)

	if _, acquired, _ := fake.snapshot(); acquired != 0 {
		t.Fatalf("a run cancelled while queued acquired %d power request(s)", acquired)
	}
}

func TestNonWorkloadCommandHoldsNoPowerRequest(t *testing.T) {
	fake := installFakePowerRequests(t)
	req := backupipc.BackupCommandRequest{CommandID: "stop-1", CommandType: "backup_stop", Payload: []byte(`{}`)}
	runHandleBackupCommand(t, req, nil, newActiveCommandCanceller())
	if _, acquired, _ := fake.snapshot(); acquired != 0 {
		t.Fatalf("backup_stop acquired %d power request(s)", acquired)
	}
}

// The power request is best effort: a device that refuses it still backs up.
// The run's outcome must be exactly what it is when the request is granted.
func TestPowerRequestFailureDoesNotFailTheRun(t *testing.T) {
	runOnce := func(holdErr error) backupipc.BackupCommandResult {
		t.Helper()
		fake := installFakePowerRequests(t)
		fake.err = holdErr
		req := backupipc.BackupCommandRequest{CommandID: "s-run", CommandType: "backup_run", Payload: []byte(`{}`)}
		agentSide, helperSide := net.Pipe()
		defer func() { _ = agentSide.Close() }()
		defer func() { _ = helperSide.Close() }()
		envelopes := startEnvelopeReader(ipc.NewConn(agentSide))
		payload, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		go handleBackupCommand(ipc.NewConn(helperSide), &ipc.Envelope{ID: req.CommandID, Payload: payload}, nil, nil, newActiveCommandCanceller())
		var result backupipc.BackupCommandResult
		if err := json.Unmarshal(nextBackupResult(t, envelopes).Payload, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	granted := runOnce(nil)
	refused := runOnce(errors.New("access denied"))
	if refused.Success != granted.Success || refused.Stderr != granted.Stderr {
		t.Fatalf("a refused power request changed the run's outcome: granted=%+v refused=%+v", granted, refused)
	}
}
