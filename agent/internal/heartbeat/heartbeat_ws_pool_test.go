package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

func TestHandleCommandUsesWorkerPoolLimits(t *testing.T) {
	h := &Heartbeat{
		stopChan: make(chan struct{}),
		pool:     workerpool.New(1, 1),
	}
	h.accepting.Store(true)

	blocker := make(chan struct{})
	blockerClosed := false
	unblock := func() {
		if !blockerClosed {
			close(blocker)
			blockerClosed = true
		}
	}
	// Ensure the blocked tasks can always unblock, even if the test fails
	// early via t.Fatal. Otherwise the deferred Shutdown below would wait
	// forever on wg.Wait() inside Drain and leak the test binary.
	defer func() {
		unblock()
		// Bound the drain so a buggy test never hangs CI.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.pool.Shutdown(ctx)
	}()

	// Submit the first task and wait until the worker has actually picked
	// it up. Without this synchronization the test races the single worker:
	// if Submit #2 runs before the worker drains Submit #1 from the queue,
	// Submit #2 sees a full queue and fails.
	started := make(chan struct{})
	if !h.pool.Submit(func() {
		close(started)
		<-blocker
	}) {
		t.Fatal("expected first pool submission to succeed")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("first task never started running in the worker pool")
	}

	// Now the worker is busy and the queue is empty. Submit #2 fills the
	// queue (size 1). Submit #3 must be rejected.
	if !h.pool.Submit(func() { <-blocker }) {
		t.Fatal("expected second pool submission to fill queue")
	}

	result := h.HandleCommand(websocket.Command{
		ID:      "ws-overflow",
		Type:    tools.CmdTerminalStart,
		Payload: map[string]any{},
	})

	unblock()

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.Error != "command rejected, worker pool full" {
		t.Fatalf("unexpected error: %q", result.Error)
	}
}
