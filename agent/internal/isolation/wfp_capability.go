package isolation

import (
	"context"
	"errors"
	"sync"
	"time"
)

// A heartbeat reads only this cache. Startup and the pre-apply boundary refresh
// it; an old successful result expires rather than advertising stale readiness.
const readinessMaxAge = 5 * time.Minute

// readinessRefreshAge is when the periodic (one-minute) tick re-probes. It is
// well inside readinessMaxAge so a healthy result never ages out between
// ticks, and the previous result stays readable while a probe runs.
const readinessRefreshAge = readinessMaxAge / 2

func wfpCapability(engineErr, recoveryErr error, schedulerReady bool, _ string, activated bool) Capability {
	c := Capability{Mechanism: "wfp"}
	switch {
	case !activated:
		c.UnsupportedReason = "not_activated"
	case engineErr != nil:
		c.UnsupportedReason = "bfe_unavailable"
	case recoveryErr != nil:
		c.UnsupportedReason = "recovery_unavailable"
	case !schedulerReady:
		c.UnsupportedReason = "scheduler_unavailable"
	default:
		c.Version = 1
		c.Ready = true
	}
	return c
}

// readinessInputs is one probe of the three readiness prerequisites.
type readinessInputs struct {
	engineErr, recoveryErr error
	schedulerReady         bool
	schedulerReason        string
}

type readinessCache struct {
	refreshMu              sync.Mutex
	mu                     sync.Mutex
	now                    func() time.Time
	probe                  func(context.Context) readinessInputs
	checkedAt              time.Time
	engineErr, recoveryErr error
	schedulerReady         bool
	schedulerReason        string
}

func (c *readinessCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}
func (c *readinessCache) refresh(ctx context.Context, force bool) {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	c.mu.Lock()
	probe := c.probe
	now := c.clock()
	fresh := !c.checkedAt.IsZero() && now.Sub(c.checkedAt) >= 0 && now.Sub(c.checkedAt) < readinessRefreshAge
	c.mu.Unlock()
	if probe == nil || (!force && fresh) {
		return
	}
	in := probe(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.engineErr, c.recoveryErr, c.schedulerReady, c.schedulerReason = in.engineErr, in.recoveryErr, in.schedulerReady, in.schedulerReason
	c.checkedAt = c.clock()
}

func (c *readinessCache) capability(activated bool) Capability {
	c.mu.Lock()
	defer c.mu.Unlock()
	elapsed := c.clock().Sub(c.checkedAt)
	if c.checkedAt.IsZero() || elapsed < 0 || elapsed >= readinessMaxAge {
		return wfpCapability(nil, errors.New("readiness needs refresh"), false, "", activated)
	}
	return wfpCapability(c.engineErr, c.recoveryErr, c.schedulerReady, c.schedulerReason, activated)
}

// ConfigureRecoveryReadiness initializes the Windows-only dependencies at agent
// startup. Other platforms retain their existing unsupported capability.
func ConfigureRecoveryReadiness(ctx context.Context, iso Isolator, scheduler RecoveryScheduler, wantVersion string) {
	if configured, ok := iso.(interface {
		configureRecoveryReadiness(RecoveryScheduler, string)
	}); ok {
		configured.configureRecoveryReadiness(scheduler, wantVersion)
	}
	RefreshReadiness(ctx, iso)
}

// RefreshReadiness runs before apply, outside the machine lock. It deliberately
// does not gate recovery or release on the start-only activation capability.
func RefreshReadiness(ctx context.Context, iso Isolator) {
	if refresher, ok := iso.(interface{ RefreshReadiness(context.Context) }); ok {
		refresher.RefreshReadiness(ctx)
	}
}

// RefreshCachedReadiness is the periodic agent tick: expensive prerequisites are
// checked at most once per cache interval, independently of heartbeat reporting.
func RefreshCachedReadiness(ctx context.Context, iso Isolator) {
	if refresher, ok := iso.(interface{ refreshCachedReadiness(context.Context) }); ok {
		refresher.refreshCachedReadiness(ctx)
	}
}
