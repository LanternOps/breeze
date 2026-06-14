package etwlua

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// fakeHB records every event it's asked to post and lets tests inject a
// custom error to simulate API outages.
type fakeHB struct {
	mu       sync.Mutex
	received []Event
	failNext atomic.Int32 // number of next posts to fail
	failErr  error
	disabled atomic.Bool      // simulates uacInterceptionEnabled=false from the server
	outcome  ElevationOutcome // returned on a successful post; zero value by default
}

func (f *fakeHB) IsUACInterceptionEnabled() bool {
	return !f.disabled.Load()
}

func (f *fakeHB) SendElevationRequest(req Event) (ElevationOutcome, error) {
	if remaining := f.failNext.Load(); remaining > 0 {
		f.failNext.Add(-1)
		if f.failErr != nil {
			return ElevationOutcome{}, f.failErr
		}
		return ElevationOutcome{}, errors.New("fakeHB: forced failure")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.received = append(f.received, req)
	return f.outcome, nil
}

func (f *fakeHB) Received() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Event, len(f.received))
	copy(out, f.received)
	return out
}

// fakePamRunner records every outcome RunPamFlow is invoked with so tests can
// assert the etwlua → broker edge fires exactly when expected.
type fakePamRunner struct {
	mu       sync.Mutex
	outcomes []ElevationOutcome
	// delay simulates a long-running flow (e.g. a blocking PAM dialog). When
	// longer than the dedupe window it lets a test prove the post-flow re-record
	// restarts the dedupe window from flow-end.
	delay time.Duration
}

func (f *fakePamRunner) RunPamFlow(_ context.Context, _ Event, outcome ElevationOutcome) {
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outcomes = append(f.outcomes, outcome)
}

func (f *fakePamRunner) Calls() []ElevationOutcome {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]ElevationOutcome, len(f.outcomes))
	copy(out, f.outcomes)
	return out
}

func sampleEvent(user, path string) Event {
	return Event{
		SubjectUsername:      user,
		TargetExecutablePath: path,
		TargetExecutableHash: "deadbeef",
		PID:                  4321,
		ObservedAt:           time.Now().UTC(),
	}
}

func TestDedupeKeyStableForSameUserAndPath(t *testing.T) {
	a := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	b := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	if dedupeKey(a) != dedupeKey(b) {
		t.Fatalf("dedupe key should match for same (user, path)")
	}

	c := sampleEvent("bob", `C:\Windows\System32\mmc.exe`)
	if dedupeKey(a) == dedupeKey(c) {
		t.Fatalf("dedupe key should differ when user differs")
	}

	d := sampleEvent("alice", `C:\Windows\System32\cmd.exe`)
	if dedupeKey(a) == dedupeKey(d) {
		t.Fatalf("dedupe key should differ when path differs")
	}
}

func TestHandleEventDedupesWithinWindow(t *testing.T) {
	hb := &fakeHB{}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev := sampleEvent("alice", `C:\Program Files\Foo\foo.exe`)

	for i := 0; i < 5; i++ {
		handleEvent(context.Background(), ev, limiter, hb, nil, nil)
	}

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post after 5 identical events, got %d", got)
	}
}

func TestHandleEventDifferentKeysBothPost(t *testing.T) {
	hb := &fakeHB{}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	handleEvent(context.Background(), sampleEvent("alice", `C:\foo.exe`), limiter, hb, nil, nil)
	handleEvent(context.Background(), sampleEvent("bob", `C:\foo.exe`), limiter, hb, nil, nil)
	handleEvent(context.Background(), sampleEvent("alice", `C:\bar.exe`), limiter, hb, nil, nil)

	if got := len(hb.Received()); got != 3 {
		t.Fatalf("expected 3 distinct posts, got %d", got)
	}
}

func TestHandleEventPostFailureEnqueues(t *testing.T) {
	hb := &fakeHB{}
	hb.failNext.Store(1)

	q, err := NewQueue(t.TempDir() + "/q.jsonl")
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev := sampleEvent("alice", `C:\foo.exe`)
	handleEvent(context.Background(), ev, limiter, hb, q, nil)

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 queued event after post failure, got %d", n)
	}
}

func TestHandleEventOpportunisticDrainAfterSuccess(t *testing.T) {
	hb := &fakeHB{}
	q, err := NewQueue(t.TempDir() + "/q.jsonl")
	if err != nil {
		t.Fatalf("NewQueue: %v", err)
	}

	// Pre-queue one event (simulate a prior failure).
	queued := sampleEvent("alice", `C:\queued.exe`)
	if err := q.Enqueue(queued); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	live := sampleEvent("alice", `C:\live.exe`)
	handleEvent(context.Background(), live, limiter, hb, q, nil)

	received := hb.Received()
	if len(received) != 2 {
		t.Fatalf("expected both live and drained event posted, got %d", len(received))
	}

	n, err := q.Len()
	if err != nil {
		t.Fatalf("Len: %v", err)
	}
	if n != 0 {
		t.Fatalf("queue should be empty after opportunistic drain, got %d", n)
	}
}

func TestHandleEventDroppedWhenInterceptionDisabled(t *testing.T) {
	// Reset package-level drop state so this test is independent of run order.
	dropLogged.Store(false)
	dropCounter.Store(0)

	hb := &fakeHB{}
	hb.disabled.Store(true)
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(context.Background(), ev, limiter, hb, nil, nil)
	if got := len(hb.Received()); got != 0 {
		t.Fatalf("expected 0 posts while interception disabled, got %d", got)
	}

	// Re-enable: dropping before limiter.Allow means the drop did not
	// consume a dedupe slot, so this first-occurrence event posts
	// immediately on re-enable. (An event that ALREADY posted within the
	// dedupe window before a disable would still be deduped — the guard
	// guarantees drops are free, not that re-enables always post.)
	hb.disabled.Store(false)
	handleEvent(context.Background(), ev, limiter, hb, nil, nil)
	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post after re-enable, got %d", got)
	}
}

// TestHandleEventDropCounterAndReenableReset verifies:
//   - dropCounter increments for every event dropped while disabled
//   - dropLogged is set to true after the first drop (one-shot)
//   - on re-enable (first enabled event), the counter resets to 0 and dropLogged resets to false
func TestHandleEventDropCounterAndReenableReset(t *testing.T) {
	// Reset package-level drop state so this test is independent of run order.
	dropLogged.Store(false)
	dropCounter.Store(0)

	hb := &fakeHB{}
	hb.disabled.Store(true)
	// Use a fresh limiter with a short window so re-enable events are not deduped.
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev1 := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	ev2 := sampleEvent("bob", `C:\Windows\System32\cmd.exe`)
	ev3 := sampleEvent("carol", `C:\foo.exe`)

	handleEvent(context.Background(), ev1, limiter, hb, nil, nil)
	handleEvent(context.Background(), ev2, limiter, hb, nil, nil)
	handleEvent(context.Background(), ev3, limiter, hb, nil, nil)

	if got := dropCounter.Load(); got != 3 {
		t.Fatalf("expected dropCounter=3 after 3 disabled drops, got %d", got)
	}
	if !dropLogged.Load() {
		t.Fatalf("expected dropLogged=true after first drop")
	}
	if got := len(hb.Received()); got != 0 {
		t.Fatalf("expected 0 posts while disabled, got %d", got)
	}

	// Re-enable and send a new (unique) event — this should post and reset drop state.
	hb.disabled.Store(false)
	evNew := sampleEvent("dave", `C:\unique.exe`)
	handleEvent(context.Background(), evNew, limiter, hb, nil, nil)

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post after re-enable, got %d", got)
	}
	if got := dropCounter.Load(); got != 0 {
		t.Fatalf("expected dropCounter reset to 0 after re-enable, got %d", got)
	}
	if dropLogged.Load() {
		t.Fatalf("expected dropLogged reset to false after re-enable")
	}
}

// TestStartReturnsOnContextCancel exercises the full Start loop with a
// fake subscriber. Requires the process to be "root" — true under linux
// CI runners and under macOS test runs done as root, but skipped
// otherwise to avoid flakes.
func TestStartReturnsOnContextCancel(t *testing.T) {
	sub := NewFakeSubscriber()
	hb := &fakeHB{}

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- Start(ctx, sub, hb, nil)
	}()

	// Inject one event so we exercise the dispatch path before cancelling.
	sub.Inject(sampleEvent("alice", `C:\foo.exe`))

	// Give the loop a moment, then cancel.
	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		// On non-root, Start returns ErrNotPrivileged immediately and
		// we never see the event — that's fine, just verify no surprise.
		if err != nil && !errors.Is(err, ErrNotPrivileged) {
			t.Fatalf("Start returned unexpected error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Start did not return after context cancel")
	}
}

// TestHandleEventInvokesPamRunnerOnSuccess verifies that after a successful
// post returning an actionable outcome, the PamRunner is invoked exactly once
// with that outcome.
func TestHandleEventInvokesPamRunnerOnSuccess(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r1", Status: "auto_approved"}}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(context.Background(), ev, limiter, hb, nil, pam)

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post, got %d", got)
	}
	calls := pam.Calls()
	if len(calls) != 1 {
		t.Fatalf("expected PamRunner invoked once, got %d", len(calls))
	}
	if calls[0].RequestID != "r1" || calls[0].Status != "auto_approved" {
		t.Fatalf("PamRunner got wrong outcome: %+v", calls[0])
	}
}

// TestHandleEventSkipsPamRunnerWhenIgnored verifies the runner is NOT invoked
// when the server suppressed the request (status "ignored", empty RequestID).
func TestHandleEventSkipsPamRunnerWhenIgnored(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "", Status: "ignored"}}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(context.Background(), ev, limiter, hb, nil, pam)

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post (post still happens), got %d", got)
	}
	if got := len(pam.Calls()); got != 0 {
		t.Fatalf("expected PamRunner NOT invoked for ignored outcome, got %d calls", got)
	}
}

// TestHandleEventSkipsPamRunnerWhenNil verifies a nil PamRunner is a no-op
// (detection + post only) and does not panic.
func TestHandleEventSkipsPamRunnerWhenNil(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r2", Status: "pending"}}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(context.Background(), ev, limiter, hb, nil, nil)

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post with nil runner, got %d", got)
	}
}

// TestHandleEventDoesNotInvokeRunnerOnPostFailure verifies the runner is NOT
// invoked when the post fails (the event is queued instead).
func TestHandleEventDoesNotInvokeRunnerOnPostFailure(t *testing.T) {
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r3", Status: "auto_approved"}}
	hb.failNext.Store(1)
	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	pam := &fakePamRunner{}

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(context.Background(), ev, limiter, hb, nil, pam)

	if got := len(pam.Calls()); got != 0 {
		t.Fatalf("expected PamRunner NOT invoked on post failure, got %d calls", got)
	}
}

// TestHandleEventReassertsDedupeAfterLongFlow proves the post-flow re-record:
// RunPamFlow can block longer than the dedupe window (a real PAM dialog waits
// up to ~90s, the window is 30s). Without re-recording the dedupe key at
// flow-end, the original arrival entry expires during the flow and a live event
// re-fired right after sails past the now-stale window and triggers a
// redundant second flow. We use a short window and a flow that outlasts it: the
// second handleEvent for the same key must be deduped by the flow-end re-record.
func TestHandleEventReassertsDedupeAfterLongFlow(t *testing.T) {
	const window = 60 * time.Millisecond
	hb := &fakeHB{outcome: ElevationOutcome{RequestID: "r-long", Status: "auto_approved"}}
	limiter := ipc.NewRateLimiter(1, window)
	// Flow outlasts the window: the arrival entry recorded at line 282 will have
	// expired by the time the flow returns, so the post-flow re-record is the
	// only thing that can suppress an immediate re-fire.
	pam := &fakePamRunner{delay: 2 * window}

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)

	// First event: posts, runs the (long) flow, and on return re-records the key.
	handleEvent(context.Background(), ev, limiter, hb, nil, pam)
	// Immediate re-fire of the SAME key: must be deduped by the flow-end record.
	handleEvent(context.Background(), ev, limiter, hb, nil, pam)

	if got := len(pam.Calls()); got != 1 {
		t.Fatalf("expected RunPamFlow invoked once (re-fire deduped by flow-end re-record), got %d", got)
	}
}
