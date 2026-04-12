package authstate

import (
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

const (
	initialBackoff = 1 * time.Second
	maxBackoff     = 30 * time.Second
	backoffFactor  = 2.0
	jitterFrac     = 0.2
)

// Monitor tracks consecutive HTTP 401 responses across all agent HTTP
// callers. When the failure count reaches the threshold, ShouldSkip()
// returns true and callers should skip their HTTP work.
type Monitor struct {
	dead        atomic.Bool
	consecutive atomic.Int32
	threshold   int32

	mu      sync.Mutex
	backoff time.Duration
}

// NewMonitor creates an auth monitor that trips after `threshold`
// consecutive 401 responses.
func NewMonitor(threshold int32) *Monitor {
	return &Monitor{
		threshold: threshold,
		backoff:   initialBackoff,
	}
}

// RecordAuthFailure records a 401 response. If the consecutive count
// reaches the threshold, the monitor enters auth-dead state.
func (m *Monitor) RecordAuthFailure() {
	n := m.consecutive.Add(1)
	if n >= m.threshold {
		if m.dead.CompareAndSwap(false, true) {
			slog.Warn("auth-dead: consecutive 401s reached threshold, backing off",
				"consecutive", n, "threshold", m.threshold)
			// First trip: backoff stays at initialBackoff (1s).
			return
		}
		// Already dead: advance backoff for each additional failure.
		m.mu.Lock()
		m.backoff = time.Duration(float64(m.backoff) * backoffFactor)
		if m.backoff > maxBackoff {
			m.backoff = maxBackoff
		}
		m.mu.Unlock()
	}
}

// RecordSuccess clears the auth-dead state and resets the counter
// and backoff.
func (m *Monitor) RecordSuccess() {
	m.consecutive.Store(0)
	wasDead := m.dead.Swap(false)
	if wasDead {
		slog.Info("auth recovered, resuming normal cadence")
	}
	m.mu.Lock()
	m.backoff = initialBackoff
	m.mu.Unlock()
}

// ShouldSkip returns true if the agent is in auth-dead state.
// This is a single atomic read — safe to call on every tick.
func (m *Monitor) ShouldSkip() bool {
	return m.dead.Load()
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
