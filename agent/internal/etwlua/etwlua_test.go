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
}

func (f *fakeHB) SendElevationRequest(req Event) error {
	if remaining := f.failNext.Load(); remaining > 0 {
		f.failNext.Add(-1)
		if f.failErr != nil {
			return f.failErr
		}
		return errors.New("fakeHB: forced failure")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.received = append(f.received, req)
	return nil
}

func (f *fakeHB) Received() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Event, len(f.received))
	copy(out, f.received)
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
		handleEvent(ev, limiter, hb, nil)
	}

	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post after 5 identical events, got %d", got)
	}
}

func TestHandleEventDifferentKeysBothPost(t *testing.T) {
	hb := &fakeHB{}
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	handleEvent(sampleEvent("alice", `C:\foo.exe`), limiter, hb, nil)
	handleEvent(sampleEvent("bob", `C:\foo.exe`), limiter, hb, nil)
	handleEvent(sampleEvent("alice", `C:\bar.exe`), limiter, hb, nil)

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
	handleEvent(ev, limiter, hb, q)

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
	handleEvent(live, limiter, hb, q)

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
		done <- Start(ctx, sub, hb)
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
