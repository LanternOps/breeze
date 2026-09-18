package desktop

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// These tests stand in for the fleet-wide shape that shipped broken: on a
// Windows service / macOS daemon install the capture session runs inside the
// user helper, whose SessionManager has NO command WebSocket of its own. Its
// RequestRevocationLeaseRenew was nil, so the watchdog asked for nothing, no
// answer ever arrived, and every helper-hosted session died at
// expiresAt+grace — 60s+90s = 150s after start, fleet-wide.
//
// The watchdog runs on a virtual clock here (see watchdogClock): each step
// advances the clock by the production tick interval and fires exactly one
// watchdog tick, so the lease state machine — renew cadence, expiry, grace —
// is exercised at its real timings without a single wall-clock sleep. The
// wall-clock version of this file flaked under -race whenever a loaded CI
// runner stalled the first tick past expiresAt+grace (#5891).
const (
	helperLeaseTTL   = 60 * time.Second
	helperRenewEvery = 25 * time.Second
	helperGrace      = 90 * time.Second
	// Comfortably past expiresAt+grace (150s): an unrenewed session is dead
	// several times over once this much virtual time has elapsed.
	helperRunFor = 10 * time.Minute
)

// virtualClock is a deterministic watchdogClock: `now` only moves when the
// test says so, and a tick fires only when the test sends one.
type virtualClock struct {
	mu    sync.Mutex
	now   time.Time
	ticks chan time.Time
	// observed receives one value per watchdog read of the clock, so the
	// harness can wait until the watchdog has taken its timestamp for a tick
	// before moving the clock on — otherwise the next advance races the read.
	observed chan struct{}
	// onViolation reports a harness misuse from the watchdog's own goroutine.
	// t.Errorf is safe there (unlike t.Fatal, which may only be called from
	// the test goroutine).
	onViolation func(msg string)
}

func newVirtualClock(onViolation func(string)) *virtualClock {
	return &virtualClock{
		onViolation: onViolation,
		// Truncate strips the monotonic reading, so every comparison between a
		// virtual instant and a MonotonicDeadline-derived one (which carries a
		// real monotonic reading) falls back to wall-clock arithmetic — the
		// only frame the two share.
		now:      time.Now().Truncate(time.Millisecond),
		ticks:    make(chan time.Time),
		observed: make(chan struct{}, 1),
	}
}

func (c *virtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// watchdogNow is the hook handed to the watchdog: Now plus the observed
// signal. The signal is a NON-blocking send: the harness pairs every tick with
// exactly one awaitClockRead, so the buffer is always empty here — but that
// pairing is a convention across fireTick/step/settle, not something the type
// enforces. A blocking send would wedge the watchdog goroutine inside this
// function, before it can ever reach the select that watches session.done, so
// a future helper that fires an undrained tick would hang the package instead
// of failing. Fail loudly instead; onViolation is the test's Errorf.
func (c *virtualClock) watchdogNow() time.Time {
	now := c.Now()
	select {
	case c.observed <- struct{}{}:
	default:
		c.onViolation("virtual clock read with an undrained observed signal: a tick was fired without a paired awaitClockRead")
	}
	return now
}

func (c *virtualClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func (c *virtualClock) watchdogClock() *watchdogClock {
	return &watchdogClock{
		now: c.watchdogNow,
		ticks: func(time.Duration) (<-chan time.Time, func()) {
			return c.ticks, func() {}
		},
	}
}

// helperHarness is one helper-hosted session under a virtual-clock watchdog.
type helperHarness struct {
	t       *testing.T
	clock   *virtualClock
	mgr     *SessionManager
	session *Session
	sent    atomic.Int64
}

// newHelperHarness wires the two halves of the IPC lease bridge around a
// helper-hosted SessionManager and starts one session under its watchdog.
// `answer` plays the agent: it is handed the session id the helper asked to
// renew and returns the update the agent forwards back (nil = the agent never
// answered). The answer is applied synchronously, so it lands before the
// watchdog evaluates the same tick — the in-flight case is not what is under
// test here; the wiring is.
func newHelperHarness(t *testing.T, id string, answer func(sessionID string) *ipc.DesktopLeaseUpdate) *helperHarness {
	t.Helper()
	h := &helperHarness{t: t, mgr: NewSessionManager()}
	h.clock = newVirtualClock(func(msg string) { t.Errorf("%s", msg) })
	h.mgr.clock = h.clock.watchdogClock()

	// The real helper wiring: renewals leave as ipc.TypeDesktopLeaseRenew over
	// the broker connection.
	h.mgr.WireHelperRevocationLease(func(msgType string, payload any) error {
		if msgType != ipc.TypeDesktopLeaseRenew {
			t.Errorf("helper sent %q, want %q", msgType, ipc.TypeDesktopLeaseRenew)
			return nil
		}
		req, ok := payload.(ipc.DesktopLeaseRenewRequest)
		if !ok {
			t.Errorf("helper renew payload is %T, want ipc.DesktopLeaseRenewRequest", payload)
			return nil
		}
		h.sent.Add(1)
		if update := answer(req.SessionID); update != nil {
			h.mgr.ApplyLeaseUpdate(*update)
		}
		return nil
	})

	now := h.clock.Now()
	lease := RevocationLease{
		Token:        "lease-token",
		ExpiresAt:    now.Add(helperLeaseTTL),
		HardDeadline: now.Add(time.Hour),
		Grace:        helperGrace,
		RenewEvery:   helperRenewEvery,
	}
	h.session = newWatchdogTestSession(id, lease)
	h.mgr.mu.Lock()
	h.mgr.sessions[id] = h.session
	h.mgr.mu.Unlock()
	t.Cleanup(h.session.Stop)

	go h.mgr.watchSessionLifetime(id, h.session, SessionPolicy{
		MaxDuration:     time.Hour,
		RevocationLease: &lease,
	}, watchdogTickInterval)
	// The watchdog reads the clock once at start (startWall); consume that
	// read so the per-tick accounting in fireTick starts from zero.
	h.awaitClockRead()
	return h
}

func (h *helperHarness) awaitClockRead() {
	h.t.Helper()
	select {
	case <-h.clock.observed:
	case <-time.After(10 * time.Second):
		h.t.Fatal("watchdog never read the virtual clock")
	}
}

// renewedExpiry is the agent's healthy answer: a fresh lease TTL from now.
//
// Note for anyone extending this harness: the answer travels through
// MonotonicDeadline, so the stored expiresAt carries a real monotonic reading.
// applyRenewal's forward-only ratchet therefore compares two monotonic-bearing
// instants, which Go resolves on the monotonic component alone — i.e. on real
// call order, not on the virtual expiry each answer names. An out-of-order /
// stale-renewal rejection test cannot be written against this harness; it
// needs ApplyRevocationLease called directly with constructed times.
func (h *helperHarness) renewedExpiry(sessionID string) *ipc.DesktopLeaseUpdate {
	return &ipc.DesktopLeaseUpdate{
		SessionID:       sessionID,
		ExpiresAtUnixMs: h.clock.Now().Add(helperLeaseTTL).UnixMilli(),
	}
}

// fireTick sends one watchdog tick at the current virtual time and waits for
// the watchdog to take its timestamp for it. It reports whether the session
// was still alive to receive the tick. The tick channel is unbuffered, so a
// send completing proves the watchdog looped back to its select, i.e. it
// finished the PREVIOUS tick in full and decided "continue"; when the select
// below instead resolves via session.done, that previous decision was "stop".
//
// So a stop surfaces one call late by construction. run() relies on exactly
// that: the elapsed value it returns excludes the tick it is firing, which is
// the one whose decision it is actually reading. Do not "fix" that into an
// off-by-one.
func (h *helperHarness) fireTick() bool {
	h.t.Helper()
	select {
	case h.clock.ticks <- h.clock.Now():
		h.awaitClockRead()
		return true
	case <-h.session.done:
		return false
	case <-time.After(10 * time.Second):
		h.t.Fatal("watchdog neither consumed a tick nor stopped the session")
		return false
	}
}

// step advances the virtual clock by one watchdog interval and fires one tick.
func (h *helperHarness) step() bool {
	h.t.Helper()
	h.clock.advance(watchdogTickInterval)
	return h.fireTick()
}

// settle waits for the watchdog to finish acting on the last tick fired. It
// does so by firing a duplicate tick at the SAME virtual time — a no-op for
// the state machine (nothing is newly due), whose acceptance proves the
// previous tick's decision landed.
func (h *helperHarness) settle() {
	h.t.Helper()
	h.fireTick()
}

// run steps virtual time forward by `d`, returning how much elapsed before the
// session stopped, or d if it survived the whole span.
func (h *helperHarness) run(d time.Duration) time.Duration {
	h.t.Helper()
	for elapsed := time.Duration(0); elapsed < d; elapsed += watchdogTickInterval {
		if !h.step() {
			return elapsed
		}
	}
	return d
}

func (h *helperHarness) stopped() bool {
	select {
	case <-h.session.done:
		return true
	default:
		return false
	}
}

func TestHelperHostedSessionSurvivesPastLeaseExpiryWhenRenewalsSucceed(t *testing.T) {
	var h *helperHarness
	h = newHelperHarness(t, "helper-alive", func(sessionID string) *ipc.DesktopLeaseUpdate {
		return h.renewedExpiry(sessionID)
	})

	lived := h.run(helperRunFor)
	h.settle()
	if lived < helperRunFor || h.stopped() {
		t.Fatalf("helper-hosted session was killed after %v despite renewals landing over the IPC bridge", lived)
	}
	// 10min / 25s: the helper must have kept asking on the lease's cadence,
	// not just once at start.
	if got, want := h.sent.Load(), int64(helperRunFor/helperRenewEvery); got < want {
		t.Fatalf("the helper asked its agent to renew %d times, want at least %d", got, want)
	}
}

// The negative control for the test above: with the bridge in place but the
// agent never answering, the SAME session dies at expiresAt+grace. Without this
// the test above could pass on a watchdog that never enforces anything.
func TestHelperHostedSessionStillDiesWhenNoAnswerEverArrives(t *testing.T) {
	h := newHelperHarness(t, "helper-silent", func(string) *ipc.DesktopLeaseUpdate { return nil })

	lived := h.run(helperRunFor)
	h.settle()
	if !h.stopped() {
		t.Fatal("an unrenewed helper-hosted session must stop at expiresAt+grace")
	}
	// Dead on the first tick at or after expiresAt+grace (150s), not before —
	// the grace window is the outage budget and must be honoured in full.
	if want := helperLeaseTTL + helperGrace; lived < want || lived >= want+watchdogTickInterval {
		t.Fatalf("session stopped after %v of virtual time, want the first tick in [%v, %v)", lived, want, want+watchdogTickInterval)
	}
	if h.sent.Load() == 0 {
		t.Fatal("the helper never asked its agent to renew the lease")
	}
}

func TestHelperHostedSessionStopsWhenTheAgentForwardsARevocation(t *testing.T) {
	var h *helperHarness
	var revoke atomic.Bool
	h = newHelperHarness(t, "helper-revoked", func(sessionID string) *ipc.DesktopLeaseUpdate {
		if revoke.Load() {
			return &ipc.DesktopLeaseUpdate{
				SessionID: sessionID,
				Revoked:   true,
				Reason:    "membership_removed",
			}
		}
		return h.renewedExpiry(sessionID)
	})

	// Healthy first, so the stop below is attributable to the revocation and
	// not to a lease that was already lapsing.
	healthy := h.run(3 * helperRenewEvery)
	h.settle()
	if healthy < 3*helperRenewEvery || h.stopped() {
		t.Fatal("session stopped before the revocation was issued")
	}
	revoke.Store(true)
	// The revocation rides on the next renew answer, which is at most one renew
	// interval away; the watchdog acts on it within the same tick.
	lived := h.run(helperRenewEvery + watchdogTickInterval)
	h.settle()
	if !h.stopped() {
		t.Fatalf("a revocation forwarded by the agent must stop the helper-hosted session (survived %v after revoke)", lived)
	}
	if got := h.session.leaseState.snapshot().revokedReason; got != "membership_removed" {
		t.Fatalf("revoked reason = %q, want membership_removed", got)
	}
}

// Wall-clock deadlines let an NTP step or a hostile local clock extend a lease.
// Converting to a TTL at receipt and storing it against the monotonic clock is
// what makes the watchdog immune, so the conversion must be lossless in the
// normal case and must carry a monotonic reading.
func TestRevocationLeaseDeadlinesAreMonotonic(t *testing.T) {
	wall := time.Now().Add(90 * time.Second)
	got := MonotonicDeadline(wall.UnixMilli())
	if got.IsZero() {
		t.Fatal("a positive epoch must produce a deadline")
	}
	if delta := got.Sub(wall); delta > 50*time.Millisecond || delta < -50*time.Millisecond {
		t.Fatalf("deadline drifted %v from the wall-clock value it was derived from", delta)
	}
	// time.Time.Round(0) strips the monotonic reading. Equal() compares
	// instants and is therefore ALWAYS true across that strip — only the
	// formatted form differs, because String() renders a monotonic reading as a
	// trailing " m=+<seconds>". So the format comparison is the whole test.
	if got.String() == got.Round(0).String() {
		t.Fatal("deadline carries no monotonic reading, so a clock step would move it")
	}
	if !MonotonicDeadline(0).IsZero() || !MonotonicDeadline(-1).IsZero() {
		t.Fatal("a non-positive epoch must produce the zero time")
	}
}
