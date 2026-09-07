package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// Admission occurs in the IPC receive loop, preserving arrival order across goroutines.
type backupExecutionQueue struct {
	mu      sync.Mutex
	tail    <-chan struct{}
	entries map[string]*backupExecutionTicket
}
type backupExecutionTicket struct {
	previous <-chan struct{}
	done     chan struct{}
	ctx      context.Context
	cleanup  func()
	once     sync.Once
}

// isBackupWorkload reports whether a command occupies the device execution
// slot. The list lives in backupipc, shared with the agent forwarder.
func isBackupWorkload(command string) bool {
	return backupipc.IsQueuedWorkload(command)
}

func newBackupExecutionQueue() *backupExecutionQueue {
	ready := make(chan struct{})
	close(ready)
	return &backupExecutionQueue{tail: ready, entries: make(map[string]*backupExecutionTicket)}
}
func (q *backupExecutionQueue) enqueue(id string, canceller *activeCommandCanceller) *backupExecutionTicket {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, exists := q.entries[id]; exists {
		slog.Warn("duplicate backup admission ignored", "commandId", id)
		return nil
	}
	ctx, cleanup := canceller.track(id)
	ticket := &backupExecutionTicket{previous: q.tail, done: make(chan struct{}), ctx: ctx, cleanup: cleanup}
	q.entries[id] = ticket
	ticket.cleanup = func() {
		q.mu.Lock()
		defer q.mu.Unlock()
		cleanup()
		delete(q.entries, id)
	}
	q.tail = ticket.done
	slog.Info("backup workload admitted to execution queue", "commandId", id, "queued", len(q.entries)-1)
	return ticket
}
func (t *backupExecutionTicket) wait(heartbeat func()) error {
	timer := time.NewTicker(15 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-t.ctx.Done():
			slog.Info("queued backup workload cancelled before execution", "error", t.ctx.Err().Error())
			return t.ctx.Err()
		case <-t.previous:
			return t.ctx.Err()
		case <-timer.C:
			heartbeat()
		}
	}
}
func (t *backupExecutionTicket) release() {
	t.once.Do(func() {
		t.cleanup()
		// Cancelling a waiter must not let its successor bypass the active command.
		// The deferred close costs one parked goroutine per cancelled waiter until
		// the active workload returns; native SQL/Hyper-V exports cannot be
		// interrupted, so that can be minutes. Bounded by queue depth.
		select {
		case <-t.previous:
			close(t.done)
		default:
			go func() { <-t.previous; close(t.done) }()
		}
	})
}

// Stop joins the sender before the terminal result, preventing late liveness
// from racing completion. A supplied tick channel keeps the contract testable.
func startBackupHeartbeat(ticks <-chan time.Time, send func()) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			case <-ticks:
				send()
			}
		}
	}()
	return func() { close(stop); <-done }
}
