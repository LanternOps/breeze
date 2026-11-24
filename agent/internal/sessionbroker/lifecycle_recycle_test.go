package sessionbroker

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestHelperRecycleAllowed(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	ago := func(ds ...time.Duration) (out []time.Time) {
		for _, d := range ds {
			out = append(out, now.Add(-d))
		}
		return out
	}
	cases := []struct {
		name    string
		history []time.Time
		want    bool
	}{
		{"none yet", nil, true},
		{"below the limit", ago(time.Hour, 2*time.Hour), true},
		{"at the limit", ago(time.Minute, time.Hour, 2*time.Hour), false},
		{"older ones have left the window", ago(helperRecycleWindow+time.Second, time.Hour, 2*time.Hour), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := helperRecycleAllowed(tc.history, now); got != tc.want {
				t.Errorf("helperRecycleAllowed = %v, want %v", got, tc.want)
			}
		})
	}
}

type recycleHarness struct {
	m       *HelperLifecycleManager
	b       *Broker
	key     HelperKey
	spawner *fakeHelperSpawner
	proc    *fakeHelperProcess    // what the lifecycle manager tracks
	peer    *fakeOwnedPeerProcess // the same process, as the broker owns it
	session *Session
}

// newRecycleHarness spawns a helper for session 7 and connects it, exactly as
// production does: one process, tracked by the registry and owned by the
// broker.
func newRecycleHarness(t *testing.T) *recycleHarness {
	t.Helper()
	h := &recycleHarness{key: HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleSystem}}
	h.proc = newFakeHelperProcess(4100)
	h.spawner = &fakeHelperSpawner{byKey: map[HelperKey]helperProcess{h.key: h.proc}}
	h.b = New("recycle-"+t.Name(), nil)
	h.m = newHelperLifecycleManager(h.b, fakeLifecycleDetector{sessions: []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}}, nil, h.spawner)
	h.m.gracePeriod = 200 * time.Millisecond
	h.m.finalWait = 200 * time.Millisecond
	t.Cleanup(func() {
		h.proc.markExited(1)
		h.m.Stop()
		h.b.Close()
	})
	h.m.reconcile()
	h.peer = newFakeOwnedPeerProcess(4100)
	h.session = newOwnedSession(t, h.b, h.key, terminatingPeer{h.peer, h.proc})
	h.m.sessionAuthenticated(h.session)
	return h
}

// terminatingPeer ends the tracked process when the broker terminates its peer
// handle: both are handles on one process.
type terminatingPeer struct {
	*fakeOwnedPeerProcess
	proc *fakeHelperProcess
}

func (p terminatingPeer) Terminate() error {
	err := p.fakeOwnedPeerProcess.Terminate()
	if err == nil {
		p.proc.markExited(1)
	}
	return err
}

func ready() error { return nil }

func TestRecycleHelperReplacesTheProcessAtOnce(t *testing.T) {
	h := newRecycleHarness(t)
	if err := h.m.RecycleHelper(h.session, "leaked", ready); err != nil {
		t.Fatalf("RecycleHelper: %v", err)
	}
	if terminated, _ := h.peer.counts(); terminated != 1 {
		t.Errorf("old process terminated %d times, want 1", terminated)
	}
	// Not left for the 30s reconcile tick: a start in that gap would fail.
	if n := h.spawner.SpawnCount(h.key); n != 2 {
		t.Errorf("spawn count = %d, want the replacement (2)", n)
	}
	if h.b.HelperSessionByKey(h.key) == h.session {
		t.Error("the old helper session still owns the key")
	}
	if pid := h.m.registry.processID(h.key); pid == 0 || pid == h.proc.pid {
		t.Errorf("registry tracks pid %d, want the replacement", pid)
	}
}

func TestRecycleHelperDoesNothingWhenTheHelperIsBusy(t *testing.T) {
	h := newRecycleHarness(t)
	busy := errors.New("remote desktop session active")
	for range helperRecycleLimit + 2 {
		if err := h.m.RecycleHelper(h.session, "leaked", func() error { return busy }); !errors.Is(err, busy) {
			t.Fatalf("err = %v, want the prepare error", err)
		}
	}
	if terminated, _ := h.peer.counts(); terminated != 0 {
		t.Fatal("a busy helper was terminated")
	}
	if h.b.HelperSessionByKey(h.key) != h.session {
		t.Fatal("a busy helper lost its session")
	}
	// Refusals cost no budget.
	if err := h.m.RecycleHelper(h.session, "leaked", ready); err != nil {
		t.Fatalf("after refusals: %v", err)
	}
}

func TestRecycleHelperIsBounded(t *testing.T) {
	h := newRecycleHarness(t)
	buf := captureLogs(t)

	now := time.Unix(1_000_000, 0)
	h.m.mu.Lock()
	h.m.now = func() time.Time { return now }
	h.m.recycles = map[HelperKey][]time.Time{h.key: {now.Add(-3 * time.Hour), now.Add(-2 * time.Hour), now.Add(-time.Hour)}}
	h.m.mu.Unlock()

	prepared := false
	for range 3 {
		err := h.m.RecycleHelper(h.session, "leaked", func() error { prepared = true; return nil })
		if !errors.Is(err, ErrHelperRecycleBudget) {
			t.Fatalf("err = %v, want ErrHelperRecycleBudget", err)
		}
	}
	if prepared {
		t.Error("a helper over budget was asked to stop taking work")
	}
	if terminated, _ := h.peer.counts(); terminated != 0 {
		t.Error("a helper over budget was terminated")
	}
	out := buf.String()
	if n := strings.Count(out, "level=WARN"); n != 1 {
		t.Errorf("%d warnings for one exhausted budget, want 1:\n%s", n, out)
	}
	if !strings.Contains(out, "leaked") {
		t.Errorf("the warning does not carry the reason:\n%s", out)
	}

	// The window moves on.
	now = now.Add(helperRecycleWindow - time.Hour)
	if err := h.m.RecycleHelper(h.session, "leaked", ready); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

// A request from a helper that has already been replaced must not touch its
// successor.
func TestRecycleHelperRefusesAStaleSession(t *testing.T) {
	h := newRecycleHarness(t)
	successorProc := newFakeOwnedPeerProcess(4200)
	successor := newOwnedSession(t, h.b, h.key, successorProc)
	if err := h.m.RecycleHelper(h.session, "leaked", ready); !errors.Is(err, ErrHelperRecycleStale) {
		t.Fatalf("err = %v, want ErrHelperRecycleStale", err)
	}
	// And when the swap happens while the helper is being prepared.
	h.b.mu.Lock()
	h.b.helperByKey[h.key] = h.session
	h.b.mu.Unlock()
	err := h.m.RecycleHelper(h.session, "leaked", func() error {
		h.b.mu.Lock()
		h.b.helperByKey[h.key] = successor
		h.b.mu.Unlock()
		return nil
	})
	if !errors.Is(err, ErrHelperRecycleStale) {
		t.Fatalf("err = %v, want ErrHelperRecycleStale", err)
	}
	if n, _ := successorProc.counts(); n != 0 {
		t.Error("the successor helper was terminated")
	}
}

func TestRecycleHelperOnlySystemHelpers(t *testing.T) {
	h := newRecycleHarness(t)
	user := &Session{PID: 1, WinSessionID: "7", HelperRole: ipc.HelperRoleUser}
	if err := h.m.RecycleHelper(user, "leaked", ready); !errors.Is(err, ErrHelperRecycleUnavailable) {
		t.Errorf("user helper: err = %v", err)
	}
	if err := h.m.RecycleHelper(nil, "leaked", ready); !errors.Is(err, ErrHelperRecycleUnavailable) {
		t.Errorf("nil session: err = %v", err)
	}
	h.m.mu.Lock()
	h.m.stopping = true
	h.m.mu.Unlock()
	if err := h.m.RecycleHelper(h.session, "leaked", ready); !errors.Is(err, ErrHelperRecycleUnavailable) {
		t.Errorf("stopping manager: err = %v", err)
	}
	h.m.mu.Lock()
	h.m.stopping = false
	h.m.mu.Unlock()
}

// Two notices for one helper must not run two recycles.
func TestRecycleHelperIsSingleFlight(t *testing.T) {
	h := newRecycleHarness(t)
	entered, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- h.m.RecycleHelper(h.session, "leaked", func() error { close(entered); <-release; return nil })
	}()
	<-entered
	if err := h.m.RecycleHelper(h.session, "leaked", ready); !errors.Is(err, ErrHelperRecycleInProgress) {
		t.Errorf("err = %v, want ErrHelperRecycleInProgress", err)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

// A kill that fails must not be reported as a replacement, and must not spawn
// a duplicate beside the survivor.
func TestRecycleHelperFailedKillDoesNotSpawnADuplicate(t *testing.T) {
	h := newRecycleHarness(t)
	h.peer.terminateErr = errors.New("access denied")
	h.proc.terminateExits = false
	h.b.mu.Lock()
	h.b.helperKeyPIDAliveFn = func(uint32) (bool, bool) { return true, true }
	h.b.mu.Unlock()
	if err := h.m.RecycleHelper(h.session, "leaked", ready); err == nil {
		t.Fatal("a failed kill was reported as a recycle")
	}
	if n := h.spawner.SpawnCount(h.key); n != 1 {
		t.Errorf("spawn count = %d, want no duplicate", n)
	}
}

func TestRecycleHelperWithoutALeaseLeavesNoHelper(t *testing.T) {
	h := newRecycleHarness(t)
	h.m.removeDesired(h.key) // on-demand host, lease already released
	if err := h.m.RecycleHelper(h.session, "leaked", ready); err != nil {
		t.Fatal(err)
	}
	if n := h.spawner.SpawnCount(h.key); n != 1 {
		t.Errorf("spawned %d helpers for a session nobody leases", n)
	}
}
