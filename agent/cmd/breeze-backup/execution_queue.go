package main

import (
	"context"
	"sync"
	"time"
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

func isBackupWorkload(command string) bool {
	return command == "backup_run" || command == "mssql_backup" || command == "hyperv_backup"
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
	return ticket
}
func (t *backupExecutionTicket) wait(heartbeat func()) error {
	timer := time.NewTicker(15 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-t.ctx.Done():
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
