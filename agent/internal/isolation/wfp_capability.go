package isolation

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

// A heartbeat reads only this cache. Startup and the pre-apply boundary refresh
// it; an old successful result expires rather than advertising stale readiness.
const readinessMaxAge = 5 * time.Minute

// readinessRefreshAge is when the periodic (one-minute) tick re-probes. It is
// well inside readinessMaxAge so a healthy result never ages out between
// ticks, and the previous result stays readable while a probe runs.
const readinessRefreshAge = readinessMaxAge / 2

func wfpCapability(in readinessInputs, activated bool) Capability {
	c := Capability{Mechanism: "wfp"}
	switch {
	case !activated:
		c.UnsupportedReason = "not_activated"
	case in.engineErr != nil:
		c.UnsupportedReason = "bfe_unavailable"
	case errors.Is(in.recoveryErr, recoveryinstall.ErrUntrusted):
		c.UnsupportedReason = reasonRecoveryUntrusted
	case in.recoveryErr != nil:
		c.UnsupportedReason = "recovery_unavailable"
	case in.schedulerUntrusted:
		c.UnsupportedReason = reasonRecoveryUntrusted
	case !in.schedulerReady:
		c.UnsupportedReason = "scheduler_unavailable"
	default:
		c.Version = 1
		c.Ready = true
		// Mechanism is a closed enum server-side, so the trust path rides in
		// the free-text detail. Authenticode keeps the empty detail it had.
		if in.recoveryTrust == recoveryinstall.TrustManifestHash {
			c.UnsupportedReason = readyDetailManifestHash
		}
	}
	return c
}

// readinessInputs is one probe of the three readiness prerequisites.
type readinessInputs struct {
	engineErr, recoveryErr error
	schedulerReady         bool
	schedulerReason        string
	// schedulerUntrusted: the scheduler refused the journal's recovery
	// executable on trust, not on task state.
	schedulerUntrusted bool
	// recoveryTrust is the path that accepted the executable the tasks run.
	recoveryTrust recoveryinstall.TrustPath
}

type readinessCache struct {
	refreshMu sync.Mutex
	mu        sync.Mutex
	now       func() time.Time
	probe     func(context.Context) readinessInputs
	checkedAt time.Time
	in        readinessInputs
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
	prev, probed := c.in, !c.checkedAt.IsZero()
	c.mu.Unlock()
	if probe == nil || (!force && fresh) {
		return
	}
	in := probe(ctx)
	c.mu.Lock()
	c.in = in
	c.checkedAt = c.clock()
	c.mu.Unlock()
	logReadinessChange(prev, in, probed)
}

// logReadinessChange records why readiness changed, once per change. The
// heartbeat carries only the reason code, so the underlying error text (which
// manifest check failed, which task read back wrong) lives only here.
func logReadinessChange(prev, in readinessInputs, probed bool) {
	was, now := wfpCapability(prev, true), wfpCapability(in, true)
	if probed && was == now {
		return
	}
	if now.Ready {
		log.Info("isolation readiness: ready", "detail", now.UnsupportedReason, "recoveryTrust", string(in.recoveryTrust))
		return
	}
	log.Warn("isolation readiness: not ready", "reason", now.UnsupportedReason,
		"engineError", errString(in.engineErr), "recoveryError", errString(in.recoveryErr), "scheduler", in.schedulerReason)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (c *readinessCache) capability(activated bool) Capability {
	c.mu.Lock()
	defer c.mu.Unlock()
	elapsed := c.clock().Sub(c.checkedAt)
	if c.checkedAt.IsZero() || elapsed < 0 || elapsed >= readinessMaxAge {
		return wfpCapability(readinessInputs{recoveryErr: errors.New("readiness needs refresh")}, activated)
	}
	return wfpCapability(c.in, activated)
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
