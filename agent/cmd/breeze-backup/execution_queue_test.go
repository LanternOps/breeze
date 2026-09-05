package main

import (
	"context"
	"encoding/json"
	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupExecutionQueueFIFOAndCancellation(t *testing.T) {
	q := newBackupExecutionQueue()
	c := newActiveCommandCanceller()
	first := q.enqueue("files", c)
	second := q.enqueue("sql", c)
	third := q.enqueue("hyperv", c)
	if err := first.wait(func() {}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-second.previous:
		t.Fatal("SQL admitted while files active")
	default:
	}
	c.mu.Lock()
	c.cancels["sql"]()
	c.mu.Unlock()
	if err := second.wait(func() {}); err != context.Canceled {
		t.Fatalf("wait: %v", err)
	}
	second.release()
	select {
	case <-third.previous:
		t.Fatal("Hyper-V bypassed active files")
	default:
	}
	first.release()
	if err := third.wait(func() {}); err != nil {
		t.Fatal(err)
	}
	third.release()
	if c.cancelAll() {
		t.Fatal("finished commands retained")
	}
}

func TestBackupExecutionQueueStopAndDisconnect(t *testing.T) {
	for _, reason := range []string{"stop", "disconnect"} {
		t.Run(reason, func(t *testing.T) {
			q := newBackupExecutionQueue()
			c := newActiveCommandCanceller()
			first := q.enqueue("active", c)
			second := q.enqueue("waiting", c)
			if !c.cancelAll() {
				t.Fatal("no tracked commands")
			}
			for _, ticket := range []*backupExecutionTicket{first, second} {
				if err := ticket.wait(func() {}); err != context.Canceled {
					t.Fatalf("wait: %v", err)
				}
				ticket.release()
			}
			next := q.enqueue("next", c)
			if err := next.wait(func() {}); err != nil {
				t.Fatal(err)
			}
			next.release()
		})
	}
}

func TestBackupExecutionQueueWorkloads(t *testing.T) {
	for _, command := range []string{"backup_run", "mssql_backup", "hyperv_backup"} {
		if !isBackupWorkload(command) {
			t.Fatalf("%s bypasses queue", command)
		}
	}
	for _, command := range []string{"backup_stop", "backup_list", "vault_status", "mssql_discover", "hyperv_vm_state"} {
		if isBackupWorkload(command) {
			t.Fatalf("%s blocks behind queue", command)
		}
	}
}

func TestBackupStopTargetsQueuedJob(t *testing.T) {
	q := newBackupExecutionQueue()
	c := newActiveCommandCanceller()
	first := q.enqueue("active", c)
	second := q.enqueue("waiting", c)
	result := executeCommand(backupipc.BackupCommandRequest{CommandType: "backup_stop", Payload: []byte(`{"jobId":"waiting"}`)}, nil, nil, nil, c)
	if !result.Success {
		t.Fatalf("stop: %+v", result)
	}
	if first.ctx.Err() != nil {
		t.Fatal("targeted stop cancelled unrelated active job")
	}
	if second.ctx.Err() != context.Canceled {
		t.Fatal("queued target not cancelled")
	}
	second.release()
	first.release()
}

func TestBackupExecutionQueueDeduplicatesAdmissions(t *testing.T) {
	q := newBackupExecutionQueue()
	c := newActiveCommandCanceller()
	first := q.enqueue("same-job", c)
	if duplicate := q.enqueue("same-job", c); duplicate != nil {
		t.Fatal("duplicate admitted")
	}
	if err := first.wait(func() {}); err != nil {
		t.Fatal(err)
	}
	first.release()
	next := q.enqueue("new-job", c)
	if err := next.wait(func() {}); err != nil {
		t.Fatal(err)
	}
	next.release()
}

func TestQueueAsyncAdmissionAndStartProtocol(t *testing.T) {
	for _, command := range []string{"backup_run", "mssql_backup", "hyperv_backup"} {
		t.Run(command, func(t *testing.T) {
			agentSide, helperSide := net.Pipe()
			defer agentSide.Close()
			defer helperSide.Close()
			conn := ipc.NewConn(helperSide)
			envelopes := startEnvelopeReader(ipc.NewConn(agentSide))
			req := backupipc.BackupCommandRequest{CommandID: command, CommandType: command, Async: true, QueueAsync: true, Payload: []byte(`{}`)}
			payload, err := json.Marshal(req)
			if err != nil {
				t.Fatal(err)
			}
			canceller := newActiveCommandCanceller()
			ticket := newBackupExecutionQueue().enqueue(command, canceller)
			done := make(chan struct{})
			go func() {
				defer close(done)
				handleBackupCommand(conn, &ipc.Envelope{ID: command, Payload: payload}, nil, nil, canceller, ticket)
			}()
			ackEnv := nextBackupResult(t, envelopes)
			var ack backupipc.BackupCommandResult
			if err := json.Unmarshal(ackEnv.Payload, &ack); err != nil {
				t.Fatal(err)
			}
			if ackEnv.ID != command || !ack.Success || ack.Stdout != `{"queued":true}` {
				t.Fatalf("bad admission: %+v", ack)
			}
			finalEnv := nextBackupResult(t, envelopes)
			if finalEnv.ID == command {
				t.Fatal("terminal result reused admission ID")
			}
			<-done
		})
	}
}

func TestNativeBackupHeartbeatStopsBeforeTerminal(t *testing.T) {
	ticks := make(chan time.Time)
	heartbeats := make(chan struct{})
	stop := startBackupHeartbeat(ticks, func() { heartbeats <- struct{}{} })
	for i := 0; i < 3; i++ {
		ticks <- time.Now()
		<-heartbeats
	}
	stop()
	select {
	case ticks <- time.Now():
		t.Fatal("heartbeat receiver remained after terminal completion")
	default:
	}
}

func TestBackupStopCancelsQueuedWorkThroughCommandHandler(t *testing.T) {
	queue := newBackupExecutionQueue()
	canceller := newActiveCommandCanceller()
	first := queue.enqueue("active", canceller)
	second := queue.enqueue("queued", canceller)
	result := executeCommand(backupipc.BackupCommandRequest{CommandType: "backup_stop"}, nil, nil, nil, canceller)
	if !result.Success {
		t.Fatal(result.Stderr)
	}
	first.release()
	if err := second.wait(func() {}); err != context.Canceled {
		t.Fatalf("queued workload not cancelled: %v", err)
	}
	second.release()
}

// Hold the configured manager inside cancellation cleanup. This exposes the
// ordering bug where Stop waits for cleanup before cancelling FIFO waiters.
type stopOrderProvider struct {
	*blockingRunProvider
	release chan struct{}
}

func (p *stopOrderProvider) UploadContext(ctx context.Context, _, _ string) error {
	p.once.Do(func() { close(p.started) })
	<-ctx.Done()
	<-p.release
	return ctx.Err()
}

func TestConfiguredBackupStopCancelsWaitersBeforeManagerUnwinds(t *testing.T) {
	provider := &stopOrderProvider{blockingRunProvider: newBlockingRunProvider(), release: make(chan struct{})}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, Paths: []string{dir}})
	queue := newBackupExecutionQueue()
	canceller := newActiveCommandCanceller()
	active := queue.enqueue("active", canceller)
	waiting := queue.enqueue("waiting", canceller)
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		defer active.release()
		_, _ = mgr.RunBackupContext(active.ctx, nil)
	}()
	t.Cleanup(func() {
		canceller.cancelAll()
		close(provider.release)
		<-runDone
		waiting.release()
	})
	select {
	case <-provider.started:
	case <-time.After(5 * time.Second):
		t.Fatal("configured backup never entered upload")
	}
	stopDone := make(chan backupipc.BackupCommandResult, 1)
	go func() {
		stopDone <- executeCommand(backupipc.BackupCommandRequest{CommandType: "backup_stop"}, mgr, nil, nil, canceller)
	}()
	select {
	case <-waiting.ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("queued workload was not cancelled while manager Stop waited for cleanup")
	}
	select {
	case <-stopDone:
		t.Fatal("Stop returned before the configured manager finished cleanup")
	default:
	}
}
