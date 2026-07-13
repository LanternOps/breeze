package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// TestExecuteCommandViaPoolWatchdogIsLogOnly verifies the in-flight watchdog
// added for issue #2387 never fails or abandons a slow command: handlers that
// are long-running by design (scripts up to 1h, patch installs) must still
// return their real result even after the watchdog interval has elapsed
// multiple times.
//
// MUST NOT call t.Parallel(): mutates handlerRegistry.
func TestExecuteCommandViaPoolWatchdogIsLogOnly(t *testing.T) {
	const slowType = "test_2387_slow_command"
	handlerRegistry[slowType] = func(h *Heartbeat, cmd Command) tools.CommandResult {
		time.Sleep(120 * time.Millisecond) // several watchdog intervals
		return tools.CommandResult{Status: "completed", Stdout: "slow-ok"}
	}
	t.Cleanup(func() { delete(handlerRegistry, slowType) })

	h := &Heartbeat{
		stopChan:                 make(chan struct{}),
		pool:                     workerpool.New(1, 1),
		commandInFlightWarnAfter: 20 * time.Millisecond,
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.pool.Shutdown(ctx)
	})

	result := h.executeCommandViaPool(Command{
		ID:      "watchdog-slow-1",
		Type:    slowType,
		Payload: map[string]any{},
	})

	if result.Status != "completed" {
		t.Fatalf("watchdog must not fail a slow command: status=%q error=%q", result.Status, result.Error)
	}
	if result.Stdout != "slow-ok" {
		t.Fatalf("expected the handler's real result, got stdout=%q", result.Stdout)
	}
}
