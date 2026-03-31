package heartbeat

import (
	"context"
	"testing"

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
	defer h.pool.Shutdown(context.Background())

	blocker := make(chan struct{})
	if !h.pool.Submit(func() { <-blocker }) {
		t.Fatal("expected first pool submission to succeed")
	}
	if !h.pool.Submit(func() { <-blocker }) {
		t.Fatal("expected second pool submission to fill queue")
	}

	result := h.HandleCommand(websocket.Command{
		ID:      "ws-overflow",
		Type:    tools.CmdTerminalStart,
		Payload: map[string]any{},
	})

	close(blocker)

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.Error != "command rejected, worker pool full" {
		t.Fatalf("unexpected error: %q", result.Error)
	}
}
