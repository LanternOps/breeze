package sessionbroker

import (
	"context"
	"time"
)

type HelperWaitStatus string

const (
	HelperWaitReady            HelperWaitStatus = "ready"
	HelperWaitFatalCooldown    HelperWaitStatus = "fatal-cooldown"
	HelperWaitRetriesExhausted HelperWaitStatus = "retries-exhausted"
	HelperWaitSessionGone      HelperWaitStatus = "session-gone"
	HelperWaitTimeout          HelperWaitStatus = "timeout"
	// HelperWaitSpawnerUnavailable means Job-Object init failed at startup and
	// the manager has no way to spawn a helper process. A live already-
	// connected helper still reports ready (see helperReadyCheck ordering);
	// this only fires for a lease that has nothing to attach to.
	HelperWaitSpawnerUnavailable HelperWaitStatus = "spawner-unavailable"
)

// HelperWaitResult is a typed answer for "is the helper for this key up?" —
// callers surface Status to the technician instead of a bare timeout.
type HelperWaitResult struct {
	Status     HelperWaitStatus
	RetryAfter time.Duration // >0 only for fatal-cooldown
	Session    *Session      // non-nil only for ready
}

const helperWaitPollInterval = 200 * time.Millisecond

// WaitForHelperReady blocks until the helper for key is authenticated AND has
// reported capabilities (auth alone is not enough: CanCapture arrives on a
// later message), or until a typed failure is known, or ctx ends. Callers
// bound the wait with their own ctx; helperStartupTimeout is the natural
// budget. In on-demand mode the key must hold a live lease — acquire first.
func (m *HelperLifecycleManager) WaitForHelperReady(ctx context.Context, key HelperKey) HelperWaitResult {
	ticker := time.NewTicker(helperWaitPollInterval)
	defer ticker.Stop()
	for {
		if res, done := m.helperReadyCheck(key); done {
			return res
		}
		select {
		case <-ctx.Done():
			return HelperWaitResult{Status: HelperWaitTimeout}
		case <-ticker.C:
		}
	}
}

func (m *HelperLifecycleManager) helperReadyCheck(key HelperKey) (HelperWaitResult, bool) {
	if m.currentMode() == LifecycleModeOnDemand {
		m.mu.Lock()
		_, leased := m.leases[key]
		m.mu.Unlock()
		if !leased {
			return HelperWaitResult{Status: HelperWaitSessionGone}, true
		}
	}
	if m.broker != nil {
		if sess := m.broker.HelperSessionByKey(key); sess != nil && sess.GetCapabilities() != nil {
			return HelperWaitResult{Status: HelperWaitReady, Session: sess}, true
		}
	}
	if m.spawner == nil {
		return HelperWaitResult{Status: HelperWaitSpawnerUnavailable}, true
	}
	now := m.now()
	diag := m.registry.diagnose(key, now)
	if diag.tracked {
		if !diag.fatalUntil.IsZero() && now.Before(diag.fatalUntil) {
			return HelperWaitResult{Status: HelperWaitFatalCooldown, RetryAfter: diag.fatalUntil.Sub(now)}, true
		}
		if diag.retriesExhausted {
			return HelperWaitResult{Status: HelperWaitRetriesExhausted}, true
		}
	}
	return HelperWaitResult{}, false
}
