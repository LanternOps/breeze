package sessionbroker

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #11044: the keepalive closed every helper session, the backup helper
// included, whenever the agent's own ticker fired late after a system suspend
// or a whole-machine stall. A late tick means the agent was not running, so the
// pong age it reads is not evidence that the helper stopped answering. These
// tests drive runKeepalive with a fake session clock and hand-delivered ticks,
// so "ten minutes asleep" is one Advance call, not a sleep.

// fakeKeepaliveClock is a settable clock for Session.clock.
type fakeKeepaliveClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeKeepaliveClock() *fakeKeepaliveClock {
	return &fakeKeepaliveClock{now: time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)}
}

func (c *fakeKeepaliveClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeKeepaliveClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// keepaliveRig runs the real runKeepalive against a paired session whose clock
// and ticks the test controls. The helper end records pings and never answers
// on its own; a test models a helper reply with answer().
type keepaliveRig struct {
	t       *testing.T
	clock   *fakeKeepaliveClock
	session *Session
	ticks   chan time.Time
	pings   chan struct{}
	exited  chan struct{}
}

const keepaliveRigWait = 10 * time.Second

func newKeepaliveRig(t *testing.T) *keepaliveRig {
	t.Helper()
	interval, timeout := 30*time.Second, 45*time.Second
	session, clientIPC := newPairedSession(t, "resume-1", "4000")
	t.Cleanup(func() { _ = clientIPC.Close() })

	clock := newFakeKeepaliveClock()
	session.clock = clock.Now
	session.NotePong() // re-seed on the fake clock

	rig := &keepaliveRig{
		t:       t,
		clock:   clock,
		session: session,
		ticks:   make(chan time.Time),
		pings:   make(chan struct{}, 16),
		exited:  make(chan struct{}),
	}
	go func() {
		for {
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			if env.Type == ipc.TypePing {
				rig.pings <- struct{}{}
			}
		}
	}()

	b := &Broker{
		sessions:                  map[string]*Session{session.SessionID: session},
		byIdentity:                map[string][]*Session{session.IdentityKey: {session}},
		keepaliveIntervalOverride: interval,
		keepaliveTimeoutOverride:  timeout,
		keepaliveTicker: func(time.Duration) (<-chan time.Time, func()) {
			return rig.ticks, func() {}
		},
	}
	go func() {
		b.runKeepalive(session)
		close(rig.exited)
	}()
	t.Cleanup(func() {
		_ = session.Close()
		<-rig.exited
	})
	// A zero-gap tick the loop must take before any test advances the clock:
	// it proves runKeepalive has read its start time, so every later gap is
	// measured from the fake clock's starting point.
	if got := rig.tickAfter(0); got != "ping" {
		t.Fatalf("priming tick: keepalive %s, want ping", got)
	}
	return rig
}

// tickAfter advances the clock by d, delivers one tick, and reports what the
// loop did with it: "ping" (kept the session and pinged) or "closed".
func (r *keepaliveRig) tickAfter(d time.Duration) string {
	r.t.Helper()
	r.clock.Advance(d)
	select {
	case r.ticks <- r.clock.Now():
	case <-r.exited:
		return "closed"
	case <-time.After(keepaliveRigWait):
		r.t.Fatal("keepalive loop did not take the tick")
	}
	select {
	case <-r.pings:
		return "ping"
	case <-r.exited:
		if !r.session.IsClosed() {
			r.t.Fatal("keepalive loop exited without closing the session")
		}
		return "closed"
	case <-time.After(keepaliveRigWait):
		r.t.Fatal("keepalive tick produced neither a ping nor a close")
		return ""
	}
}

// answer models the helper's pong arriving now.
func (r *keepaliveRig) answer() { r.session.NotePong() }

func requireTick(t *testing.T, step, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: keepalive %s, want %s", step, got, want)
	}
}

// The headline: a ten-minute suspend between two ticks must not close a helper
// that answered every ping it was given a chance to answer.
func TestKeepaliveLateTickAfterResumeRePingsInsteadOfClosing(t *testing.T) {
	r := newKeepaliveRig(t)

	requireTick(t, "first on-time tick", r.tickAfter(30*time.Second), "ping")
	r.answer()

	requireTick(t, "first tick after a 10-minute suspend", r.tickAfter(10*time.Minute), "ping")
	r.answer()

	requireTick(t, "on-time tick after the helper answered", r.tickAfter(30*time.Second), "ping")
	if r.session.IsClosed() {
		t.Fatal("session closed after resume although the helper answered")
	}
}

// The machine can suspend in the instant between a ping and its pong. The
// helper then had no observable time to answer, so the first tick after resume
// still owes it a fresh ping.
func TestKeepaliveSuspendBetweenPingAndPongStillRePings(t *testing.T) {
	r := newKeepaliveRig(t)

	requireTick(t, "on-time tick", r.tickAfter(30*time.Second), "ping")
	// No answer: the suspend lands before the pong.
	requireTick(t, "first tick after resume", r.tickAfter(10*time.Minute), "ping")
	r.answer()
	requireTick(t, "next on-time tick", r.tickAfter(30*time.Second), "ping")
}

// The resume grace is one observation window, not an exemption: a helper that
// stays silent through an on-time window after resume is still wedged.
func TestKeepaliveClosesHelperSilentAfterResumeGrace(t *testing.T) {
	r := newKeepaliveRig(t)

	requireTick(t, "on-time tick", r.tickAfter(30*time.Second), "ping")
	r.answer()
	requireTick(t, "tick after resume", r.tickAfter(10*time.Minute), "ping")
	// The resume ping went unanswered for a whole on-time interval: the same
	// verdict an on-time helper gets one interval after a missed ping.
	requireTick(t, "first on-time tick after resume", r.tickAfter(30*time.Second), "closed")

	if reason := r.session.CloseReason(); !strings.Contains(reason, "keepalive timeout") {
		t.Fatalf("CloseReason = %q, want it to name the keepalive timeout", reason)
	}
}

// Regression for the genuine wedge (#443): ticks on time, pongs stopped.
func TestKeepaliveOnTimeTicksStillCloseSilentHelper(t *testing.T) {
	r := newKeepaliveRig(t)

	requireTick(t, "first tick", r.tickAfter(30*time.Second), "ping")
	requireTick(t, "second tick", r.tickAfter(30*time.Second), "closed")
	if reason := r.session.CloseReason(); !strings.Contains(reason, "keepalive timeout") {
		t.Fatalf("CloseReason = %q, want it to name the keepalive timeout", reason)
	}
}

// An agent that is persistently starved (every tick late) must not shield a
// silent helper forever: the late-tick exemption is bounded.
func TestKeepaliveEveryTickLateStillClosesSilentHelperEventually(t *testing.T) {
	r := newKeepaliveRig(t)

	for i := 1; i <= keepaliveMaxLateTicks+2; i++ {
		if got := r.tickAfter(2 * time.Minute); got == "closed" {
			if i != keepaliveMaxLateTicks+1 {
				t.Fatalf("closed on late tick %d, want exactly tick %d (the first past the bound)", i, keepaliveMaxLateTicks+1)
			}
			return
		}
	}
	t.Fatalf("silent helper survived %d consecutive late ticks", keepaliveMaxLateTicks+2)
}

// A helper that keeps answering is never closed, however late the ticks are.
func TestKeepaliveEveryTickLateKeepsAnsweringHelper(t *testing.T) {
	r := newKeepaliveRig(t)

	for i := 1; i <= keepaliveMaxLateTicks+3; i++ {
		requireTick(t, "late tick", r.tickAfter(2*time.Minute), "ping")
		r.answer()
	}
}

// When the keepalive does close the backup helper's session, the run in flight
// must be failed with what happened — the agent closed the session — not
// "backup helper exited unexpectedly", which sent the #11044 investigation
// looking for a helper crash that never happened.
func TestBackupHelperDeath_KeepaliveClose_ReportsAgentClosedSession(t *testing.T) {
	rig := newBufferedBackupDeathRig(t)
	clock := newFakeKeepaliveClock()
	rig.session.clock = clock.Now
	rig.session.NotePong()

	ticks := make(chan time.Time)
	rig.broker.keepaliveIntervalOverride = 30 * time.Second
	rig.broker.keepaliveTimeoutOverride = 45 * time.Second
	rig.broker.keepaliveTicker = func(time.Duration) (<-chan time.Time, func()) {
		return ticks, func() {}
	}

	rig.startAsyncRun(t, "cmd-run-ka", true)

	keepaliveDone := make(chan struct{})
	go func() {
		rig.broker.runKeepalive(rig.session)
		close(keepaliveDone)
	}()
	// Two on-time ticks with no pong: the genuine-wedge close.
	for i := range 2 {
		clock.Advance(30 * time.Second)
		select {
		case ticks <- clock.Now():
		case <-time.After(backupDeathWait):
			t.Fatalf("keepalive loop did not take tick %d", i+1)
		}
	}
	select {
	case <-keepaliveDone:
	case <-time.After(backupDeathWait):
		t.Fatal("keepalive did not close the silent backup helper session")
	}

	result := decodeBackupResult(t, rig.nextForwarded(t))
	if result.CommandID != "cmd-run-ka" || result.Success {
		t.Fatalf("result = %+v, want a failure for cmd-run-ka", result)
	}
	if !strings.HasPrefix(result.Stderr, backupHelperSessionClosedError) {
		t.Fatalf("Stderr = %q, want it to start with %q", result.Stderr, backupHelperSessionClosedError)
	}
	if !strings.Contains(result.Stderr, "keepalive timeout") {
		t.Fatalf("Stderr = %q, want it to name the keepalive timeout", result.Stderr)
	}
	if strings.Contains(result.Stderr, backupHelperDiedError) {
		t.Fatalf("Stderr = %q still claims the helper exited", result.Stderr)
	}
}

// CloseWithReason records its reason only when it is the call that closes the
// session; a session already closed (the helper hung up first) keeps none, so
// its teardown still reports a helper exit.
func TestCloseWithReason_RecordsOnlyWhenItCloses(t *testing.T) {
	t.Run("closes an open session", func(t *testing.T) {
		session, clientIPC := newPairedSession(t, "reason-1", "5000")
		defer func() { _ = clientIPC.Close() }()
		if err := session.CloseWithReason("first"); err != nil {
			t.Fatalf("CloseWithReason: %v", err)
		}
		_ = session.CloseWithReason("second")
		if got := session.CloseReason(); got != "first" {
			t.Fatalf("CloseReason = %q, want %q", got, "first")
		}
	})
	t.Run("already closed session keeps no reason", func(t *testing.T) {
		session, clientIPC := newPairedSession(t, "reason-2", "5001")
		defer func() { _ = clientIPC.Close() }()
		_ = session.Close()
		_ = session.CloseWithReason("too late")
		if got := session.CloseReason(); got != "" {
			t.Fatalf("CloseReason = %q, want none for a session closed elsewhere first", got)
		}
	})
	t.Run("broker-owned session", func(t *testing.T) {
		session, clientIPC := newPairedSession(t, "reason-3", "5002")
		defer func() { _ = clientIPC.Close() }()
		b := &Broker{
			sessions:   map[string]*Session{session.SessionID: session},
			byIdentity: map[string][]*Session{session.IdentityKey: {session}},
		}
		session.broker = b
		_ = session.CloseWithReason("via broker")
		if got := session.CloseReason(); got != "via broker" {
			t.Fatalf("CloseReason = %q, want %q", got, "via broker")
		}
		if _, still := b.sessions[session.SessionID]; still {
			t.Fatal("CloseWithReason left the session registered with the broker")
		}
	})
}

// A keepalive close that lands while a backup_run forward still awaits its ack:
// the forwarder owns that failure, and it must name the agent's close rather
// than the bare "session closed" that classifies as nothing.
func TestBackupForward_AgentCloseBeforeAck_NamesTheClose(t *testing.T) {
	rig := newBackupDeathRig(t)

	done := make(chan error, 1)
	go func() {
		_, err := rig.broker.ForwardBackupCommand("cmd-unacked-ka", "backup_run", nil, backupDeathWait, true)
		done <- err
	}()
	if _, err := rig.helper.Recv(); err != nil {
		t.Fatalf("helper Recv: %v", err)
	}
	_ = rig.session.CloseWithReason("keepalive timeout: no reply from the helper for 1m0s")

	select {
	case err := <-done:
		requireSessionClosedError(t, err, "the forward of an unacked run")
		want := backupHelperSessionClosedError + " (keepalive timeout: no reply from the helper for 1m0s)"
		if !strings.HasPrefix(err.Error(), want) {
			t.Fatalf("forward error = %q, want it to start with %q", err.Error(), want)
		}
	case <-time.After(backupDeathWait):
		t.Fatal("timed out waiting for the forward to fail")
	}
	select {
	case <-rig.disconnected:
	case <-time.After(backupDeathWait):
		t.Fatal("timed out waiting for the session teardown")
	}
	rig.expectNoForwarded(t)
}

// The doomed-tombstone branch of ForwardBackupCommand reports the same way.
func TestBackupSessionEndedError(t *testing.T) {
	plain, c1 := newPairedSession(t, "ended-1", "6000")
	defer func() { _ = c1.Close() }()
	_ = plain.Close()
	if got := backupSessionEndedError(plain); got != backupHelperDiedError {
		t.Fatalf("plain close: %q, want %q", got, backupHelperDiedError)
	}

	closedByAgent, c2 := newPairedSession(t, "ended-2", "6001")
	defer func() { _ = c2.Close() }()
	_ = closedByAgent.CloseWithReason("x")
	if got, want := backupSessionEndedError(closedByAgent), backupHelperSessionClosedError+" (x)"; got != want {
		t.Fatalf("agent close: %q, want %q", got, want)
	}
	if got := backupSessionEndedError(nil); got != backupHelperDiedError {
		t.Fatalf("nil session: %q, want %q", got, backupHelperDiedError)
	}
}
