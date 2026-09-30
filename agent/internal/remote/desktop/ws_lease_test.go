package desktop

import (
	"errors"
	"image"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The WebSocket fallback stream carries the same server-issued revocation
// lease as a WebRTC session and keeps it alive the same way. These pin the
// three things that follows from:
//
//   - a revoked lease ends the capture (the control plane ended the session);
//   - a lease nobody renews ends the capture at expiresAt+grace — which is also
//     what ends a capture nobody is watching (a start that ran after its stop);
//   - a healthy lease keeps the stream alive indefinitely.
//
// Same virtual-clock harness as the helper-hosted lease tests: each step
// advances the clock by one watchdog interval and fires exactly one tick.

type wsLeaseHarness struct {
	t       *testing.T
	clock   *virtualClock
	mgr     *WsSessionManager
	session *WsStreamSession
	renews  atomic.Int64

	mu      sync.Mutex
	stopped []string // "<sessionID>:<reason>" from OnSessionStopped
	stopCh  chan struct{}
}

func newWsLeaseHarness(t *testing.T, id string, answer func(h *wsLeaseHarness, sessionID string)) *wsLeaseHarness {
	t.Helper()
	h := &wsLeaseHarness{t: t, mgr: NewWsSessionManager(), stopCh: make(chan struct{}, 4)}
	h.clock = newVirtualClock(func(msg string) { t.Errorf("%s", msg) })
	h.mgr.clock = h.clock.watchdogClock()
	h.mgr.RequestRevocationLeaseRenew = func(sessionID string) {
		h.renews.Add(1)
		if answer != nil {
			answer(h, sessionID)
		}
	}
	h.mgr.OnSessionStopped = func(sessionID, reason string) {
		h.mu.Lock()
		h.stopped = append(h.stopped, sessionID+":"+reason)
		h.mu.Unlock()
		h.stopCh <- struct{}{}
	}

	now := h.clock.Now()
	lease := RevocationLease{
		Token:        "lease-token",
		ExpiresAt:    now.Add(helperLeaseTTL),
		HardDeadline: now.Add(time.Hour),
		Grace:        helperGrace,
		RenewEvery:   helperRenewEvery,
	}
	h.session = newWsStreamSession(id, nil, nil, nil, DefaultStreamConfig())
	h.mgr.mu.Lock()
	h.mgr.sessions[id] = h.session
	h.mgr.mu.Unlock()
	t.Cleanup(h.session.Stop)

	h.mgr.startLeaseWatchdog(id, h.session, &lease)
	return h
}

func (h *wsLeaseHarness) awaitClockRead() {
	h.t.Helper()
	select {
	case <-h.clock.observed:
	case <-time.After(10 * time.Second):
		h.t.Fatal("watchdog never read the virtual clock")
	}
}

func (h *wsLeaseHarness) fireTick() bool {
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

func (h *wsLeaseHarness) step() bool {
	h.t.Helper()
	h.clock.advance(watchdogTickInterval)
	return h.fireTick()
}

func (h *wsLeaseHarness) run(d time.Duration) time.Duration {
	h.t.Helper()
	for elapsed := time.Duration(0); elapsed < d; elapsed += watchdogTickInterval {
		if !h.step() {
			return elapsed
		}
	}
	return d
}

func (h *wsLeaseHarness) awaitStopCallback() string {
	h.t.Helper()
	select {
	case <-h.stopCh:
	case <-time.After(10 * time.Second):
		h.t.Fatal("OnSessionStopped was never called")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stopped[len(h.stopped)-1]
}

func (h *wsLeaseHarness) inManager(id string) bool {
	h.mgr.mu.RLock()
	defer h.mgr.mu.RUnlock()
	return h.mgr.sessions[id] == h.session
}

func TestWsStreamSessionSurvivesWhileLeaseRenewalsSucceed(t *testing.T) {
	h := newWsLeaseHarness(t, "ws-alive", func(h *wsLeaseHarness, sessionID string) {
		h.mgr.ApplyRevocationLease(sessionID, h.clock.Now().Add(helperLeaseTTL), time.Time{})
	})

	if lived := h.run(helperRunFor); lived != helperRunFor {
		t.Fatalf("stream stopped after %s although every renewal succeeded", lived)
	}
	if !h.inManager("ws-alive") {
		t.Fatal("a healthy stream must stay registered with the manager")
	}
	// One renewal immediately, then one per renew interval.
	if got, min := h.renews.Load(), int64(helperRunFor/helperRenewEvery); got < min {
		t.Fatalf("renewals requested = %d, want at least %d", got, min)
	}
}

func TestWsStreamSessionStopsWhenLeaseRevoked(t *testing.T) {
	h := newWsLeaseHarness(t, "ws-revoked", nil)

	h.mgr.RevokeSession("ws-revoked", "session_ended")
	// The tick after the revocation decides to stop; the one after it finds
	// the stream gone (fireTick reports a stop one call late by construction).
	h.step()
	if h.step() {
		t.Fatal("a revoked stream must stop on the next watchdog tick")
	}
	if got := h.awaitStopCallback(); got != "ws-revoked:"+StopReasonLeaseRevoked {
		t.Fatalf("OnSessionStopped = %q, want ws-revoked:%s", got, StopReasonLeaseRevoked)
	}
	if h.inManager("ws-revoked") {
		t.Fatal("a revoked stream must be removed from the manager")
	}
}

// A capture nobody renews for — the control plane never answers, or the
// session it belongs to no longer exists — ends at expiresAt+grace. This is
// the bound on a stream that started after the stop meant to cancel it.
func TestWsStreamSessionStopsWhenLeaseIsNeverRenewed(t *testing.T) {
	h := newWsLeaseHarness(t, "ws-orphan", nil)

	lived := h.run(helperRunFor)
	if lived >= helperRunFor {
		t.Fatal("an unrenewed stream must stop once its lease expires past the grace window")
	}
	if min := helperLeaseTTL + helperGrace - watchdogTickInterval; lived < min {
		t.Fatalf("stream stopped after %s, before expiresAt+grace (%s)", lived, helperLeaseTTL+helperGrace)
	}
	if got := h.awaitStopCallback(); got != "ws-orphan:"+StopReasonLeaseExpired {
		t.Fatalf("OnSessionStopped = %q, want ws-orphan:%s", got, StopReasonLeaseExpired)
	}
}

func TestWsStreamSessionStopsWhenFirstRenewalIsUnavailable(t *testing.T) {
	h := newWsLeaseHarness(t, "ws-unavailable", func(h *wsLeaseHarness, sessionID string) {
		h.mgr.NoteLeaseUnavailable(sessionID)
	})

	if lived := h.run(time.Minute); lived >= time.Minute {
		t.Fatal("a stream whose first renewal the control plane could not answer must stop")
	}
	if got := h.awaitStopCallback(); got != "ws-unavailable:"+StopReasonLeaseRevoked {
		t.Fatalf("OnSessionStopped = %q, want ws-unavailable:%s", got, StopReasonLeaseRevoked)
	}
}

func TestWsSessionManagerStartSessionRefusesWithoutRevocationLease(t *testing.T) {
	mgr := NewWsSessionManager()
	_, _, _, err := mgr.StartSession("ws-no-lease", 0, DefaultStreamConfig(), nil, func(string, []byte) error { return nil })
	if !errors.Is(err, ErrRevocationLeaseRequired) {
		t.Fatalf("StartSession without a lease: err = %v, want ErrRevocationLeaseRequired", err)
	}
	if mgr.ActiveCount() != 0 {
		t.Fatal("no stream may be registered without a lease")
	}
}

func TestWsLeaseAnswersForUnknownSessionsAreIgnored(t *testing.T) {
	mgr := NewWsSessionManager()
	// Must not panic or register anything.
	mgr.ApplyRevocationLease("nope", time.Now().Add(time.Minute), time.Time{})
	mgr.NoteLeaseUnavailable("nope")
	mgr.RevokeSession("nope", "x")
	if mgr.ActiveCount() != 0 {
		t.Fatal("lease answers must never create sessions")
	}
}

// fakeWsCapturer is a capturer with no screen: every Capture reports "no new
// frame". Enough to run a real WsSessionManager.StartSession end to end.
type fakeWsCapturer struct{ closed atomic.Bool }

func (c *fakeWsCapturer) Capture() (*image.RGBA, error) { return nil, nil }
func (c *fakeWsCapturer) CaptureRegion(int, int, int, int) (*image.RGBA, error) {
	return nil, nil
}
func (c *fakeWsCapturer) GetScreenBounds() (int, int, error) { return 1280, 720, nil }
func (c *fakeWsCapturer) Close() error                       { c.closed.Store(true); return nil }

// The lease safety only exists if StartSession actually attaches the lease and
// runs its watchdog. Drive the real StartSession and prove a revocation stops
// the capture it created.
func TestWsSessionManagerStartSessionRunsTheLeaseWatchdog(t *testing.T) {
	capturer := &fakeWsCapturer{}
	mgr := NewWsSessionManagerForTest(func() ScreenCapturer { return capturer })
	clock := newVirtualClock(func(msg string) { t.Errorf("%s", msg) })
	mgr.clock = clock.watchdogClock()
	stopped := make(chan string, 1)
	mgr.OnSessionStopped = func(id, reason string) { stopped <- id + ":" + reason }

	now := clock.Now()
	lease := &RevocationLease{
		ExpiresAt:    now.Add(helperLeaseTTL),
		HardDeadline: now.Add(time.Hour),
		Grace:        helperGrace,
		RenewEvery:   helperRenewEvery,
	}
	w, h, stream, err := mgr.StartSession("ws-real", 0, DefaultStreamConfig(), lease, func(string, []byte) error { return nil })
	if err != nil || w != 1280 || h != 720 || stream == nil {
		t.Fatalf("StartSession = %d,%d,%v,%v", w, h, stream, err)
	}
	t.Cleanup(stream.Stop)
	if !mgr.IsCurrent("ws-real", stream) {
		t.Fatal("the started stream must be the current one")
	}

	mgr.RevokeSession("ws-real", "session_ended")
	clock.advance(watchdogTickInterval)
	select {
	case clock.ticks <- clock.Now():
	case <-time.After(5 * time.Second):
		t.Fatal("StartSession started no lease watchdog: nothing consumed the tick")
	}
	select {
	case <-clock.observed:
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog never read the clock")
	}
	select {
	case got := <-stopped:
		if got != "ws-real:"+StopReasonLeaseRevoked {
			t.Fatalf("OnSessionStopped = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a revoked lease must stop the stream StartSession created")
	}
	if mgr.ActiveCount() != 0 || !capturer.closed.Load() {
		t.Fatalf("stream not torn down: active=%d closed=%v", mgr.ActiveCount(), capturer.closed.Load())
	}
}

func TestWsSessionManagerLeaseStatusReflectsAnswers(t *testing.T) {
	mgr := NewWsSessionManagerForTest(func() ScreenCapturer { return &fakeWsCapturer{} })
	clock := newVirtualClock(func(msg string) { t.Errorf("%s", msg) })
	mgr.clock = clock.watchdogClock() // never ticked: answers only
	now := clock.Now()
	lease := &RevocationLease{ExpiresAt: now.Add(time.Minute), HardDeadline: now.Add(time.Hour), Grace: helperGrace, RenewEvery: helperRenewEvery}
	_, _, stream, err := mgr.StartSession("ws-status", 0, DefaultStreamConfig(), lease, func(string, []byte) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stream.Stop)

	later := now.Add(10 * time.Minute)
	mgr.ApplyRevocationLease("ws-status", later, time.Time{})
	st, ok := mgr.LeaseStatus("ws-status")
	if !ok || !st.ExpiresAt.Equal(later) || st.Revoked {
		t.Fatalf("after renewal: %+v ok=%v", st, ok)
	}
	mgr.RevokeSession("ws-status", "x")
	if st, _ := mgr.LeaseStatus("ws-status"); !st.Revoked {
		t.Fatal("RevokeSession must mark the stream's lease revoked")
	}
	if _, ok := mgr.LeaseStatus("nope"); ok {
		t.Fatal("unknown session must report no lease")
	}
}

// A superseded start must only ever tear down the stream IT created: a newer
// start that already replaced it under the same id keeps running.
func TestWsSessionManagerStopExactLeavesAReplacementRunning(t *testing.T) {
	mgr := NewWsSessionManagerForTest(func() ScreenCapturer { return &fakeWsCapturer{} })
	mgr.clock = newVirtualClock(func(msg string) { t.Errorf("%s", msg) }).watchdogClock()
	lease := func() *RevocationLease {
		n := time.Now()
		return &RevocationLease{ExpiresAt: n.Add(time.Minute), HardDeadline: n.Add(time.Hour), Grace: helperGrace, RenewEvery: helperRenewEvery}
	}
	send := func(string, []byte) error { return nil }
	_, _, older, err := mgr.StartSession("ws-x", 0, DefaultStreamConfig(), lease(), send)
	if err != nil {
		t.Fatal(err)
	}
	_, _, newer, err := mgr.StartSession("ws-x", 0, DefaultStreamConfig(), lease(), send)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(newer.Stop)

	if mgr.StopExact("ws-x", older) {
		t.Fatal("stopping the replaced stream must not report removing the current one")
	}
	if !mgr.IsCurrent("ws-x", newer) || mgr.ActiveCount() != 1 {
		t.Fatal("the newer stream must keep running")
	}
	if !mgr.StopExact("ws-x", newer) || mgr.ActiveCount() != 0 {
		t.Fatal("stopping the current stream must remove it")
	}
}
