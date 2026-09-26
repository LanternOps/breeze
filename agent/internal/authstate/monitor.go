package authstate

import (
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"
)

const (
	initialBackoff = 1 * time.Second
	// maxBackoff MUST stay above the heartbeat interval (default 60s, see
	// config.HeartbeatIntervalSeconds). ShouldSkip() is evaluated once per tick
	// and compares elapsed-since-last-failure against the backoff, so a cap at
	// or below the tick interval means the window has always expired by the next
	// tick and not one request is ever suppressed. At the old 30s cap the
	// machinery ran, logged itself as backing off, and removed nothing: a
	// permanently deauthorized agent still sent the full 1440 heartbeats/day.
	//
	// 30 minutes takes roughly an hour of sustained failure to reach by
	// doubling, so a transient rejection (a deploy or restore blip) only
	// escalates to ~60s and self-heals immediately, while a genuinely stranded
	// agent decays to ~48 requests/day. That distinction is load-bearing: an
	// agent whose tenant has been offboarded can no longer fetch an update, so
	// the shipped backoff curve is the only thing that will ever throttle it.
	maxBackoff    = 30 * time.Minute
	backoffFactor = 2.0
	jitterFrac    = 0.2
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

	// Backoff schedule. NewMonitor defaults these to the package constants
	// (the agent's schedule); options may override them.
	initialBackoff time.Duration
	maxBackoff     time.Duration
	// windowJitter, when > 0, randomises each skip window by +/- this
	// fraction of the backoff. Zero (the default) keeps the window equal to
	// the backoff exactly.
	windowJitter float64

	mu          sync.Mutex
	consecutive int32
	dead        bool
	backoff     time.Duration
	// window is the skip window currently in force: the backoff, jittered
	// by windowJitter when set. ShouldSkip compares against it.
	window      time.Duration
	lastFailure time.Time

	// now is the clock, injectable for tests. Use clock() to read it.
	now func() time.Time
}

// Option customises a Monitor. The agent uses the defaults; the watchdog's
// failover client supplies its own schedule (#2796).
type Option func(*Monitor)

// WithBackoff overrides the initial and maximum backoff. Non-positive values
// keep the default; max is raised to initial if it is smaller.
func WithBackoff(initial, max time.Duration) Option {
	return func(m *Monitor) {
		if initial > 0 {
			m.initialBackoff = initial
		}
		if max > 0 {
			m.maxBackoff = max
		}
		if m.maxBackoff < m.initialBackoff {
			m.maxBackoff = m.initialBackoff
		}
	}
}

// WithJitter randomises every skip window by +/- frac of the current backoff,
// so many clients that were rejected at the same moment do not retry in
// lockstep. frac is clamped to [0, 0.5].
func WithJitter(frac float64) Option {
	return func(m *Monitor) {
		if frac < 0 {
			frac = 0
		}
		if frac > 0.5 {
			frac = 0.5
		}
		m.windowJitter = frac
	}
}

// WithClock injects the clock (tests).
func WithClock(now func() time.Time) Option {
	return func(m *Monitor) {
		if now != nil {
			m.now = now
		}
	}
}

// NewMonitor creates an auth monitor that trips after `threshold`
// consecutive auth failures.
func NewMonitor(threshold int, opts ...Option) *Monitor {
	m := &Monitor{
		threshold:      int32(threshold),
		initialBackoff: initialBackoff,
		maxBackoff:     maxBackoff,
		now:            time.Now,
	}
	for _, opt := range opts {
		opt(m)
	}
	m.backoff = m.initialBackoff
	m.window = m.backoff
	return m
}

// setBackoffLocked sets the backoff and derives the skip window from it.
// Caller holds m.mu.
func (m *Monitor) setBackoffLocked(d time.Duration) {
	m.backoff = d
	m.window = d
	if m.windowJitter > 0 {
		j := float64(d) * m.windowJitter * (2*rand.Float64() - 1)
		m.window = time.Duration(float64(d) + j)
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
		m.setBackoffLocked(m.initialBackoff)
		slog.Warn("auth-dead: consecutive 401s reached threshold, backing off",
			"consecutive", m.consecutive, "threshold", m.threshold)
		return
	}

	// Already dead — a backoff-gated retry failed. Lengthen the backoff.
	next := time.Duration(float64(m.backoff) * backoffFactor)
	if next > m.maxBackoff {
		next = m.maxBackoff
	}
	m.setBackoffLocked(next)
}

// RecordSuccess clears the auth-dead state and resets the counter and backoff.
func (m *Monitor) RecordSuccess() {
	m.mu.Lock()
	wasDead := m.dead
	m.dead = false
	m.consecutive = 0
	m.setBackoffLocked(m.initialBackoff)
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
	return m.clock().Sub(m.lastFailure) < m.window
}

// RetryIn reports how long until ShouldSkip next returns false: the time
// remaining in the current skip window while auth-dead, zero otherwise.
func (m *Monitor) RetryIn() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.dead {
		return 0
	}
	if rem := m.window - m.clock().Sub(m.lastFailure); rem > 0 {
		return rem
	}
	return 0
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
