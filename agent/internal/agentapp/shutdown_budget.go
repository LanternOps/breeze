package agentapp

import (
	"context"
	"time"
)

// Shutdown timing contract
// ------------------------
//
// shutdownAgent tears components down SEQUENTIALLY (runWithTimeout blocks the
// caller before the next stage starts), so per-stage timeouts are ADDITIVE,
// not concurrent. Before #3323 the stage budgets summed to 17s on an ordinary
// enrolled Linux agent while the systemd unit capped the stop at
// TimeoutStopSec=15 — so systemd escalated SIGTERM to SIGKILL mid-teardown.
// The three ungated stages alone (drain 5s + websocket 3s + heartbeat 5s) are
// a 13s floor, leaving only 2s for every optional component, which is why the
// failure looked intermittent: a plain agent squeaked under the cap and one
// with a UniFi collector landed exactly on it.
//
// Two layers keep that from recurring:
//
//  1. shutdownBudget is a hard wall-clock cap the agent enforces on ITSELF, on
//     every platform — systemd, launchd and the Windows SCM each impose their
//     own stop deadline, so bounding agent-side is what makes the guarantee
//     portable. Every stage runs for min(its own budget, time remaining), so a
//     stage added later can never push the total past the cap; it just gets
//     squeezed (and, if the budget is already spent, skipped with a warning).
//
//  2. The systemd unit's TimeoutStopSec sits well ABOVE the agent's own budget
//     rather than at it, leaving shutdownTailSlack for the UNTIMED tail —
//     the stopping-state file write, the watchdog IPC notify, secure-token
//     zeroing, process exit — plus systemd's own SIGTERM delivery latency.
//
// TestShutdownStageBudgetsFitShutdownBudget and
// TestShutdownBudgetFitsUnitTimeoutStopSec assert both layers against the
// embedded unit, so the numbers can never silently drift apart again. That is
// the regression the old "Total worst case is bounded by the sum of per-stage
// timeouts; the unit file caps the outer wait at 15s" comment failed to
// prevent: the claim was literally true and still wrong, because nothing
// checked that the sum actually fit under the cap.
const (
	// shutdownBudget caps every timed stage in shutdownAgent, combined. The
	// nominal stage budgets below sum to 17s, leaving 3s of slack before the
	// clamp starts truncating real work.
	shutdownBudget = 20 * time.Second

	// componentStopBudget is a shared sub-budget for the OPTIONAL component
	// stop stages (etwlua, unifi, workspace index, watchdog supervisor).
	// These are the stages that vary by platform and configuration and they
	// run ahead of the ungated core teardown, so without a sub-budget a
	// single wedged optional component could consume the budget the core
	// stages need. Each stage is additionally capped at componentStopStage.
	componentStopBudget = 4 * time.Second
	componentStopStage  = 2 * time.Second

	// Core teardown stages. The ORDER these are invoked in is load-bearing:
	// drain must stay ahead of the two transport stops, because draining
	// after the websocket and heartbeat are torn down would strand whatever
	// is in flight. That constraint is why the stages are budgeted rather
	// than fanned out concurrently.
	drainStageBudget    = 5 * time.Second
	websocketStopBudget = 3 * time.Second
	heartbeatStopBudget = 5 * time.Second

	// drainCtxGrace makes the drain context outlive its stage cap slightly so
	// ordering stays deterministic: the stage timer fires and logs the stage
	// first, then the still-running goroutine's ctx aborts. Preserved from
	// the original fixed 6s-inner/5s-outer pairing now that the outer cap is
	// dynamic.
	drainCtxGrace = 1 * time.Second

	// shipperFlushBudget bounds logging.StopShipper, which runs AFTER
	// shutdownAgent returns and waits on the shipper goroutine with no
	// deadline of its own. An in-flight log-ship POST sits on the shipper's
	// 30s HTTP timeout (internal/logging/shipper.go) — twice the entire stop
	// window — on exactly the hosts this issue is about: ones whose network
	// went down during OS shutdown. Unbounded, it defeats the whole budget.
	shipperFlushBudget = 2 * time.Second

	// shutdownTailSlack is the margin the systemd unit must leave ABOVE
	// shutdownBudget + shipperFlushBudget. It covers the parts of shutdown
	// that are deliberately not timed (local state-file write, watchdog IPC
	// notify, secure-token zeroing, process exit) plus systemd's own signal
	// delivery latency. Asserted against the unit by
	// TestShutdownBudgetFitsUnitTimeoutStopSec.
	shutdownTailSlack = 5 * time.Second
)

// shutdownClock hands out per-stage timeouts clamped to a shared deadline, so
// a sequence of sequential stages can never overrun the budget they share.
//
// It is deliberately not a context: the stages abandon work rather than
// cancel it (runWithTimeout leaves fn running on a goroutine that dies with
// the process), and several of them take no context at all.
type shutdownClock struct {
	deadline time.Time
}

// newShutdownClock starts a clock that expires budget from now.
func newShutdownClock(budget time.Duration) *shutdownClock {
	return &shutdownClock{deadline: time.Now().Add(budget)}
}

// sub derives a nested clock for a group of stages that share a smaller
// sub-budget. It never extends past the parent's deadline, so a sub-budget can
// only ever tighten the bound.
func (c *shutdownClock) sub(budget time.Duration) *shutdownClock {
	deadline := time.Now().Add(budget)
	if deadline.After(c.deadline) {
		deadline = c.deadline
	}
	return &shutdownClock{deadline: deadline}
}

// stageTimeout returns the effective cap for a stage: min(budget, remaining).
// A result <= 0 means the shared budget is spent and the stage must be skipped.
func (c *shutdownClock) stageTimeout(budget time.Duration) time.Duration {
	if remaining := time.Until(c.deadline); remaining < budget {
		return remaining
	}
	return budget
}

// run executes fn under min(budget, remaining). Reports whether the stage ran;
// a false return means the shared budget was already exhausted and the stage
// was skipped entirely (logged, never silent — a skipped teardown stage is a
// real signal that something upstream wedged).
func (c *shutdownClock) run(name string, budget time.Duration, fn func()) bool {
	d := c.stageTimeout(budget)
	if d <= 0 {
		log.Warn("shutdown budget exhausted, skipping stage", "stage", name)
		return false
	}
	runWithTimeout(name, d, fn)
	return true
}

// runCtx is run for stages that need a context to abort their own inner work.
// The context deadline is the stage cap plus grace, so the stage timer fires
// (and logs) before the context aborts — see drainCtxGrace.
func (c *shutdownClock) runCtx(name string, budget, grace time.Duration, fn func(context.Context)) bool {
	d := c.stageTimeout(budget)
	if d <= 0 {
		log.Warn("shutdown budget exhausted, skipping stage", "stage", name)
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), d+grace)
	defer cancel()
	runWithTimeout(name, d, func() { fn(ctx) })
	return true
}
