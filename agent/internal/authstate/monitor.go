package authstate

import (
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"
)

const (
	initialBackoff = 1 * time.Second
	maxBackoff     = 30 * time.Second
	backoffFactor  = 2.0
	jitterFrac     = 0.2
)

// Monitor tracks consecutive HTTP 401 responses across all agent HTTP
// callers. When the failure count reaches the threshold, the monitor enters
// an auth-dead state and ShouldSkip() returns true so callers back off.
//
// While auth-dead, ShouldSkip() is TIME-GATED: it returns true only until the
// current backoff has elapsed since the last failure, then returns false to
// let the next attempt through (a backoff-gated retry). A success on that
// retry clears the dead state (self-heal); another failure lengthens the
// backoff (exponential, capped at maxBackoff). This is what lets an agent
// recover on its own after a *transient* credential rejection (e.g. the
// server momentarily 401s during a deploy/restore). Without the time gate the
// agent would skip every tick forever and stay silent until the process is
// restarted — even after auth had recovered.
type Monitor struct {
	threshold int32

	mu          sync.Mutex
	consecutive int32
	dead        bool
	backoff     time.Duration
	lastFailure time.Time

	// now is the clock, injectable for tests. Use clock() to read it.
	now func() time.Time
}

// NewMonitor creates an auth monitor that trips after `threshold`
// consecutive 401 responses.
func NewMonitor(threshold int) *Monitor {
	return &Monitor{
		threshold: int32(threshold),
		backoff:   initialBackoff,
		now:       time.Now,
	}
}

func (m *Monitor) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// RecordAuthFailure records a 401 response. Below the threshold it only
// advances the consecutive counter. At/after the threshold the monitor is
// auth-dead; each subsequent (backoff-gated) failure lengthens the backoff so
// retries slow down, capped at maxBackoff.
func (m *Monitor) RecordAuthFailure() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.lastFailure = m.clock()

	if !m.dead {
		m.consecutive++
		if m.consecutive < m.threshold {
			return
		}
		m.dead = true
		m.backoff = initialBackoff
		slog.Warn("auth-dead: consecutive 401s reached threshold, backing off",
			"consecutive", m.consecutive, "threshold", m.threshold)
		return
	}

	// Already dead — a backoff-gated retry failed. Lengthen the backoff.
	m.backoff = time.Duration(float64(m.backoff) * backoffFactor)
	if m.backoff > maxBackoff {
		m.backoff = maxBackoff
	}
}

// RecordSuccess clears the auth-dead state and resets the counter and backoff.
func (m *Monitor) RecordSuccess() {
	m.mu.Lock()
	wasDead := m.dead
	m.dead = false
	m.consecutive = 0
	m.backoff = initialBackoff
	m.mu.Unlock()

	if wasDead {
		slog.Info("auth recovered, resuming normal cadence")
	}
}

// ShouldSkip reports whether the caller should skip its HTTP work this tick.
// When auth-dead it returns true only until the backoff has elapsed since the
// last failure; once elapsed it returns false so the next attempt goes through
// as a backoff-gated retry. This guarantees the agent keeps trying and can
// self-heal once auth recovers, instead of skipping forever.
func (m *Monitor) ShouldSkip() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.dead {
		return false
	}
	return m.clock().Sub(m.lastFailure) < m.backoff
}

// BackoffDuration returns the current backoff delay with jitter.
func (m *Monitor) BackoffDuration() time.Duration {
	m.mu.Lock()
	base := m.backoff
	m.mu.Unlock()

	jitter := float64(base) * jitterFrac * (2*rand.Float64() - 1)
	d := time.Duration(float64(base) + jitter)
	if d < 0 {
		return 0
	}
	return d
}
