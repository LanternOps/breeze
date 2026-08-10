package agentapp

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"
)

// unitTimeoutStopSec reads the TimeoutStopSec directive out of the embedded
// systemd unit. Matching only a line that STARTS with the directive keeps the
// several prose mentions in the surrounding comment block from being picked up.
func unitTimeoutStopSec(t *testing.T) time.Duration {
	t.Helper()
	for _, line := range strings.Split(linuxUnit, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "TimeoutStopSec=") {
			continue
		}
		raw := strings.TrimPrefix(line, "TimeoutStopSec=")
		// The unit only ever uses a bare-seconds value; anything else means
		// someone switched notation and this parser needs revisiting rather
		// than silently returning a wrong number.
		secs, err := strconv.Atoi(raw)
		if err != nil {
			t.Fatalf("TimeoutStopSec=%q is not a bare seconds value; update this parser "+
				"(and re-check the shutdown budget arithmetic) before changing notation", raw)
		}
		return time.Duration(secs) * time.Second
	}
	t.Fatal("linuxUnit has no TimeoutStopSec directive — the agent's shutdown budget " +
		"would then race systemd's 90s default with nothing asserting the relationship")
	return 0
}

// nominalStageBudgets is the worst case shutdownAgent can ask for: the shared
// component sub-budget (which caps all four optional component stops however
// many apply) plus every ungated core stage.
func nominalStageBudgets() time.Duration {
	return componentStopBudget + drainStageBudget + websocketStopBudget + heartbeatStopBudget
}

// TestShutdownStageBudgetsFitShutdownBudget is the arithmetic the old comment
// asserted in prose and got wrong (#3323). shutdownAgent's stages run
// sequentially, so their budgets add up; if the nominal sum exceeds the shared
// budget the clamp starts truncating real teardown work — heartbeat stop, the
// last stage, would be the one starved.
func TestShutdownStageBudgetsFitShutdownBudget(t *testing.T) {
	if sum := nominalStageBudgets(); sum > shutdownBudget {
		t.Fatalf("shutdown stage budgets sum to %v, over shutdownBudget %v: the last stage "+
			"(heartbeat stop) would be clamped toward zero. Either lower a stage budget or "+
			"raise shutdownBudget — and if you raise it, TimeoutStopSec must move too.",
			sum, shutdownBudget)
	}
}

// TestShutdownBudgetFitsUnitTimeoutStopSec is the guard that would have caught
// #3323 at build time. The agent must finish its own shutdown, with slack to
// spare, before systemd escalates SIGTERM to SIGKILL — otherwise KillMode=mixed
// takes the whole cgroup down mid-teardown and helpers, tunnels and the audit
// log are never closed.
func TestShutdownBudgetFitsUnitTimeoutStopSec(t *testing.T) {
	unitStopTimeout := unitTimeoutStopSec(t)
	needed := shutdownBudget + shipperFlushBudget + shutdownTailSlack
	if needed > unitStopTimeout {
		t.Fatalf("agent needs %v (shutdownBudget %v + shipper flush %v + tail slack %v) but "+
			"the unit's TimeoutStopSec is %v — systemd would SIGKILL mid-shutdown (#3323). "+
			"Raise TimeoutStopSec in linuxUnit (and bump currentUnitVersion so deployed "+
			"hosts reconcile), or lower the agent-side budgets.",
			needed, shutdownBudget, shipperFlushBudget, shutdownTailSlack, unitStopTimeout)
	}
}

// TestShutdownBudgetLeavesRoomForUntimedTail pins the reason the slack term
// exists: the tail after the last timed stage (state-file write, watchdog IPC
// notify, secure-token zeroing, process exit) is deliberately untimed, so a
// zero-slack budget would be exactly as broken as the original 17s-vs-15s bug
// even with the arithmetic "balancing".
func TestShutdownBudgetLeavesRoomForUntimedTail(t *testing.T) {
	if shutdownTailSlack <= 0 {
		t.Fatal("shutdownTailSlack must be positive: the post-teardown tail is untimed")
	}
	if slack := unitTimeoutStopSec(t) - (shutdownBudget + shipperFlushBudget); slack < shutdownTailSlack {
		t.Fatalf("only %v of slack under TimeoutStopSec, want at least %v", slack, shutdownTailSlack)
	}
}

func TestShutdownClockClampsStageToRemaining(t *testing.T) {
	clock := &shutdownClock{deadline: time.Now().Add(100 * time.Millisecond)}
	if d := clock.stageTimeout(5 * time.Second); d > 100*time.Millisecond {
		t.Fatalf("stage timeout %v exceeded the clock's remaining budget", d)
	}
	// A stage that wants less than what's left keeps its own smaller budget.
	if d := clock.stageTimeout(10 * time.Millisecond); d != 10*time.Millisecond {
		t.Fatalf("stage timeout = %v, want the stage's own 10ms budget", d)
	}
}

func TestShutdownClockRunHonoursSharedDeadline(t *testing.T) {
	hang := make(chan struct{})
	defer close(hang)

	clock := &shutdownClock{deadline: time.Now().Add(80 * time.Millisecond)}
	start := time.Now()
	// Three stages that would each block for a minute. Under the pre-#3323
	// scheme they'd take 3x their individual budgets; sharing a deadline they
	// must collectively finish within it.
	for _, name := range []string{"a", "b", "c"} {
		clock.run(name, time.Minute, func() { <-hang })
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("three hung stages took %v; shared deadline was 80ms (stage budgets "+
			"are still additive)", elapsed)
	}
}

// TestShutdownClockStartsStageEvenWhenBudgetExhausted pins the contract that
// an exhausted budget means "start it, don't wait" and never "skip it". The
// stop functions handed to run are sync.Once-guarded (Heartbeat.Stop,
// websocket Client.Stop): a Once never fires twice, so declining to call one
// forgoes that teardown permanently rather than deferring it, leaving the
// session broker, helper lifecycle and audit log open.
func TestShutdownClockStartsStageEvenWhenBudgetExhausted(t *testing.T) {
	clock := &shutdownClock{deadline: time.Now().Add(-time.Second)}

	started := make(chan struct{})
	start := time.Now()
	waited := clock.run("spent", time.Second, func() { close(started) })
	elapsed := time.Since(start)

	if waited {
		t.Fatal("run reported it waited for the stage despite an exhausted budget")
	}
	if elapsed > time.Second {
		t.Fatalf("run blocked for %v on an exhausted budget; it must not wait", elapsed)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("stage was never started on an exhausted budget — a sync.Once-guarded " +
			"stop skipped here is forgone permanently, not merely deferred")
	}
}

// TestShutdownClockRunCtxStartsStageEvenWhenBudgetExhausted is the runCtx half
// of the same contract, and additionally checks the stage gets a live context
// rather than one cancelled out from under it as runCtx returns.
func TestShutdownClockRunCtxStartsStageEvenWhenBudgetExhausted(t *testing.T) {
	clock := &shutdownClock{deadline: time.Now().Add(-time.Second)}

	type ctxState struct{ hasDeadline, live bool }
	observed := make(chan ctxState, 1)

	waited := clock.runCtx("spent", time.Second, 500*time.Millisecond, func(ctx context.Context) {
		_, hasDeadline := ctx.Deadline()
		live := ctx.Err() == nil
		observed <- ctxState{hasDeadline: hasDeadline, live: live}
	})
	if waited {
		t.Fatal("runCtx reported it waited despite an exhausted budget")
	}

	select {
	case got := <-observed:
		if !got.hasDeadline {
			t.Error("stage context has no deadline; the abandoned goroutine would run unbounded")
		}
		if !got.live {
			t.Error("stage context was already cancelled when the stage started, so the " +
				"stage had no window at all to act on it")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stage was never started on an exhausted budget")
	}
}

// TestShutdownClockLogsSqueezedStage exercises the squeeze path: a stage that
// gets less than its nominal budget but still completes. It must not be
// silently indistinguishable from one that ran with its full allotment.
func TestShutdownClockLogsSqueezedStage(t *testing.T) {
	clock := &shutdownClock{deadline: time.Now().Add(50 * time.Millisecond)}
	granted := clock.stageTimeout(5 * time.Second)
	if granted <= 0 || granted > 50*time.Millisecond {
		t.Fatalf("expected a positive squeezed budget under 50ms, got %v", granted)
	}
	// logIfSqueezed is the observability seam; assert it fires on exactly the
	// squeeze condition and stays quiet otherwise.
	if !logIfSqueezed("squeezed", 5*time.Second, granted) {
		t.Fatal("a stage granted less than its budget must be reported as squeezed")
	}
	if logIfSqueezed("full", time.Second, time.Second) {
		t.Fatal("a stage granted its full budget must not be reported as squeezed")
	}
}

// TestShutdownClockSubNeverExceedsParent guards the component sub-budget: it
// may only tighten the bound, never extend it. A sub-budget larger than what
// the parent has left would let the optional component stops overrun the whole
// shutdown budget before the ungated core stages even start.
func TestShutdownClockSubNeverExceedsParent(t *testing.T) {
	parent := &shutdownClock{deadline: time.Now().Add(50 * time.Millisecond)}
	if sub := parent.sub(time.Hour); sub.deadline.After(parent.deadline) {
		t.Fatalf("sub-clock deadline %v is past the parent's %v", sub.deadline, parent.deadline)
	}
	if sub := parent.sub(10 * time.Millisecond); !sub.deadline.Before(parent.deadline) {
		t.Fatal("a smaller sub-budget must tighten the deadline")
	}
}

// TestShutdownClockRunCtxOutlivesStageCap pins the deliberate ordering the
// drain stage depends on: the stage timer must fire (and log the stage) before
// the inner context aborts, so a hung drain is reported as a stage timeout
// rather than surfacing as a context error from inside DrainAndWait.
func TestShutdownClockRunCtxOutlivesStageCap(t *testing.T) {
	clock := newShutdownClock(time.Minute)

	stageCap := 60 * time.Millisecond
	grace := 40 * time.Millisecond

	// The stage goroutine is abandoned when the cap fires and keeps running,
	// so the deadline is handed back over a channel rather than a shared
	// variable — the test must not read anything that goroutine still writes.
	deadlines := make(chan time.Time, 1)
	blocked := make(chan struct{})
	defer close(blocked)

	start := time.Now()
	clock.runCtx("drain", stageCap, grace, func(ctx context.Context) {
		d, _ := ctx.Deadline()
		deadlines <- d
		<-blocked
	})
	elapsed := time.Since(start)

	if elapsed < stageCap {
		t.Fatalf("stage returned after %v, before its %v cap", elapsed, stageCap)
	}

	var ctxDeadline time.Time
	select {
	case ctxDeadline = <-deadlines:
	case <-time.After(2 * time.Second):
		t.Fatal("stage never reported its context deadline")
	}
	if ctxDeadline.IsZero() {
		t.Fatal("runCtx handed the stage a context with no deadline")
	}
	if got := ctxDeadline.Sub(start); got <= stageCap {
		t.Fatalf("context deadline %v is not past the %v stage cap: the context would abort "+
			"before the stage timer fires, inverting the intended ordering", got, stageCap)
	}
}

// TestShutdownClockRunCtxCancelsContext ensures the context is released rather
// than leaked once the stage returns — the stage's goroutine is abandoned, so
// the context is the only thing left that can tell it to stop.
func TestShutdownClockRunCtxCancelsContext(t *testing.T) {
	clock := newShutdownClock(time.Minute)

	gotCtx := make(chan context.Context, 1)
	release := make(chan struct{})
	defer close(release)

	clock.runCtx("drain", 30*time.Millisecond, 10*time.Millisecond, func(ctx context.Context) {
		gotCtx <- ctx
		<-release
	})

	ctx := <-gotCtx
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("context still live after the stage returned; abandoned drain work would " +
			"keep running unbounded")
	}
}
