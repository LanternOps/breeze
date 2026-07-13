package heartbeat

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

// Tests for the worker-pool wedge gauges (issue #2400): the in-flight command
// tracker behind the heartbeat's agentRuntime.commandsInFlight /
// commandsOverdue fields, and the two-tier in-flight watchdog interval.

// TestCommandWarnAfterTierSelection verifies the two watchdog tiers:
// ephemeral commands (terminal/tunnel/desktop data) get the short tier,
// everything else the generous default, and each tier's test override applies
// only within its own tier.
func TestCommandWarnAfterTierSelection(t *testing.T) {
	t.Parallel()

	h := &Heartbeat{}
	if got := h.commandWarnAfter(tools.CmdTerminalData); got != defaultEphemeralCommandInFlightWarnAfter {
		t.Errorf("ephemeral default tier = %v, want %v", got, defaultEphemeralCommandInFlightWarnAfter)
	}
	if got := h.commandWarnAfter(tools.CmdTunnelData); got != defaultEphemeralCommandInFlightWarnAfter {
		t.Errorf("tunnel_data tier = %v, want %v", got, defaultEphemeralCommandInFlightWarnAfter)
	}
	if got := h.commandWarnAfter(tools.CmdDesktopInput); got != defaultEphemeralCommandInFlightWarnAfter {
		t.Errorf("desktop input tier = %v, want %v", got, defaultEphemeralCommandInFlightWarnAfter)
	}
	if got := h.commandWarnAfter("run_script"); got != defaultCommandInFlightWarnAfter {
		t.Errorf("non-ephemeral default tier = %v, want %v", got, defaultCommandInFlightWarnAfter)
	}

	// Overrides apply within their own tier only.
	hOverride := &Heartbeat{
		commandInFlightWarnAfter:          time.Minute,
		ephemeralCommandInFlightWarnAfter: time.Second,
	}
	if got := hOverride.commandWarnAfter(tools.CmdTerminalData); got != time.Second {
		t.Errorf("ephemeral override tier = %v, want %v", got, time.Second)
	}
	if got := hOverride.commandWarnAfter("run_script"); got != time.Minute {
		t.Errorf("non-ephemeral override tier = %v, want %v", got, time.Minute)
	}

	// The non-ephemeral override must NOT leak into the ephemeral tier.
	hPartial := &Heartbeat{commandInFlightWarnAfter: 5 * time.Hour}
	if got := hPartial.commandWarnAfter(tools.CmdTerminalData); got != defaultEphemeralCommandInFlightWarnAfter {
		t.Errorf("ephemeral tier with only non-ephemeral override set = %v, want %v",
			got, defaultEphemeralCommandInFlightWarnAfter)
	}
}

// TestInFlightCommandStatsOverdueTiers drives the overdue computation with an
// injected `now` (no sleeping): a command crosses into overdue exactly when
// its own tier's interval elapses, so an ephemeral command wedged for minutes
// counts as overdue while a long-running script under the 2h tier does not.
func TestInFlightCommandStatsOverdueTiers(t *testing.T) {
	t.Parallel()

	h := &Heartbeat{}
	now := time.Now()

	// One ephemeral-tier command started 90s ago (past its 60s tier), one
	// standard-tier command started 10min ago (well inside its 2h tier).
	h.trackInFlight(now.Add(-90*time.Second), defaultEphemeralCommandInFlightWarnAfter)
	h.trackInFlight(now.Add(-10*time.Minute), defaultCommandInFlightWarnAfter)

	inFlight, overdue := h.inFlightCommandStats(now)
	if inFlight != 2 || overdue != 1 {
		t.Fatalf("mixed tiers: inFlight=%d overdue=%d, want 2/1", inFlight, overdue)
	}

	// Three hours later both have crossed their tiers.
	inFlight, overdue = h.inFlightCommandStats(now.Add(3 * time.Hour))
	if inFlight != 2 || overdue != 2 {
		t.Fatalf("after 3h: inFlight=%d overdue=%d, want 2/2", inFlight, overdue)
	}

	// A command still inside its tier is in flight but not overdue.
	hFresh := &Heartbeat{}
	hFresh.trackInFlight(now.Add(-30*time.Second), defaultEphemeralCommandInFlightWarnAfter)
	inFlight, overdue = hFresh.inFlightCommandStats(now)
	if inFlight != 1 || overdue != 0 {
		t.Fatalf("inside tier: inFlight=%d overdue=%d, want 1/0", inFlight, overdue)
	}

	// Untracking removes the entry from both gauges.
	hGone := &Heartbeat{}
	key := hGone.trackInFlight(now.Add(-3*time.Hour), defaultCommandInFlightWarnAfter)
	hGone.untrackInFlight(key)
	inFlight, overdue = hGone.inFlightCommandStats(now)
	if inFlight != 0 || overdue != 0 {
		t.Fatalf("after untrack: inFlight=%d overdue=%d, want 0/0", inFlight, overdue)
	}
}

// TestInFlightGaugeReflectsPoolState verifies executeCommandViaPool registers
// a command in the in-flight gauge for exactly the duration of its execution:
// 1 while the handler is blocked, back to 0 once the result is returned.
//
// MUST NOT call t.Parallel(): mutates handlerRegistry.
func TestInFlightGaugeReflectsPoolState(t *testing.T) {
	const blockType = "test_2400_blocking_command"
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)

	handlerRegistry[blockType] = func(h *Heartbeat, cmd Command) tools.CommandResult {
		<-release
		return tools.CommandResult{Status: "completed", Stdout: "blocked-ok"}
	}
	t.Cleanup(func() { delete(handlerRegistry, blockType) })

	h := &Heartbeat{
		stopChan: make(chan struct{}),
		pool:     workerpool.New(1, 1),
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.pool.Shutdown(ctx)
	})

	done := make(chan tools.CommandResult, 1)
	go func() {
		done <- h.executeCommandViaPool(Command{
			ID:      "inflight-gauge-1",
			Type:    blockType,
			Payload: map[string]any{},
		})
	}()

	// The command must show up in the gauge while its handler is blocked.
	waitForInFlight(t, h, 1)

	// It is not overdue yet — the default (non-ephemeral) tier is hours away.
	if _, overdue := h.inFlightCommandStats(time.Now()); overdue != 0 {
		t.Fatalf("fresh command counted as overdue: %d", overdue)
	}
	// But the same snapshot taken far in the future crosses the tier.
	if _, overdue := h.inFlightCommandStats(time.Now().Add(defaultCommandInFlightWarnAfter + time.Minute)); overdue != 1 {
		t.Fatal("command past its tier not counted as overdue")
	}

	unblock()
	result := <-done
	if result.Status != "completed" || result.Stdout != "blocked-ok" {
		t.Fatalf("unexpected result: status=%q stdout=%q error=%q", result.Status, result.Stdout, result.Error)
	}

	// Once the dispatch loop returns, the gauge must drop back to zero.
	waitForInFlight(t, h, 0)
}

// TestEphemeralShortTierIsLogOnly verifies the short ephemeral tier behaves
// exactly like the 2h tier: it warns but never fails or abandons the command,
// even after the interval elapses several times.
//
// MUST NOT call t.Parallel(): mutates handlerRegistry.
func TestEphemeralShortTierIsLogOnly(t *testing.T) {
	if !isEphemeralCommand(tools.CmdTerminalData) {
		t.Fatalf("precondition: %s must be ephemeral", tools.CmdTerminalData)
	}

	orig, hadOrig := handlerRegistry[tools.CmdTerminalData]
	handlerRegistry[tools.CmdTerminalData] = func(h *Heartbeat, cmd Command) tools.CommandResult {
		time.Sleep(120 * time.Millisecond) // several short-tier intervals
		return tools.CommandResult{Status: "completed", Stdout: "slow-ephemeral-ok"}
	}
	t.Cleanup(func() {
		if hadOrig {
			handlerRegistry[tools.CmdTerminalData] = orig
		} else {
			delete(handlerRegistry, tools.CmdTerminalData)
		}
	})

	h := &Heartbeat{
		stopChan:                          make(chan struct{}),
		pool:                              workerpool.New(1, 1),
		ephemeralCommandInFlightWarnAfter: 20 * time.Millisecond,
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.pool.Shutdown(ctx)
	})

	result := h.executeCommandViaPool(Command{
		ID:      "ephemeral-watchdog-1",
		Type:    tools.CmdTerminalData,
		Payload: map[string]any{},
	})

	if result.Status != "completed" {
		t.Fatalf("short tier must not fail a slow ephemeral command: status=%q error=%q", result.Status, result.Error)
	}
	if result.Stdout != "slow-ephemeral-ok" {
		t.Fatalf("expected the handler's real result, got stdout=%q", result.Stdout)
	}
}

// waitForInFlight polls the in-flight gauge until it reports want, failing
// the test after a generous deadline.
func waitForInFlight(t *testing.T, h *Heartbeat, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		inFlight, _ := h.inFlightCommandStats(time.Now())
		if inFlight == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("in-flight gauge never reached %d (last: %d)", want, inFlight)
		}
		time.Sleep(2 * time.Millisecond)
	}
}
