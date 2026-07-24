package sessionbroker

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// pidLivenessStub is an injectable, race-safe PID-liveness probe for the
// bounded ownership-retention tests (#2530).
type pidLivenessStub struct {
	mu    sync.Mutex
	alive bool
	known bool
}

func (s *pidLivenessStub) set(alive, known bool) {
	s.mu.Lock()
	s.alive, s.known = alive, known
	s.mu.Unlock()
}

func (s *pidLivenessStub) probe(uint32) (bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.alive, s.known
}

// scheduledOwnerWithFailedKill installs a scheduled (non-lifecycle) helper that
// owns key, then makes TerminateHelperKey fail so ownership-retention engages.
// It returns the manager (with key desired) and the spawner so callers can
// assert whether a proactive respawn fires.
func scheduledOwnerWithFailedKill(t *testing.T, b *Broker, key HelperKey, pid uint32) (*HelperLifecycleManager, *fakeHelperSpawner) {
	t.Helper()
	proc := newFakeOwnedPeerProcess(pid)
	proc.terminateErr = errors.New("access denied") // kill fails; process survives
	newOwnedSession(t, b, key, proc)

	spawner := &fakeHelperSpawner{}
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{}, nil, spawner)
	m.gracePeriod = 0
	m.finalWait = 0
	m.mu.Lock()
	m.desired[key] = true
	m.mu.Unlock()
	t.Cleanup(func() {
		m.Stop()
		b.Close()
	})

	b.TerminateHelperKey(key)

	if b.helperByKey[key] != nil {
		t.Fatal("failed kill should still clear the authenticated owner from helperByKey")
	}
	return m, spawner
}

func TestFailedKillRetainsKeyWhileScheduledHelperStillAlive(t *testing.T) {
	b := New("retain-alive-"+t.Name(), nil)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	liveness := &pidLivenessStub{alive: true, known: true}
	b.helperKeyPIDAliveFn = liveness.probe

	m, spawner := scheduledOwnerWithFailedKill(t, b, key, 4050)

	if !b.helperKeySpawnBlocked(key) {
		t.Fatal("respawn must be blocked while the survived PID is still alive")
	}
	m.spawnKey(key)
	if got := spawner.SpawnCount(key); got != 0 {
		t.Fatalf("proactive respawn fired despite live retained helper: spawn count = %d, want 0", got)
	}

	// The original process finally dies: retention must self-clear and allow a
	// single fresh spawn on the next reconcile.
	liveness.set(false, true)
	if b.helperKeySpawnBlocked(key) {
		t.Fatal("retention should self-clear once the retained PID is confirmed dead")
	}
	m.spawnKey(key)
	if got := spawner.SpawnCount(key); got != 1 {
		t.Fatalf("respawn after confirmed death: spawn count = %d, want 1", got)
	}
}

func TestFailedKillRetentionEndsAtDeadlineWhenLivenessUnknown(t *testing.T) {
	b := New("retain-unknown-"+t.Name(), nil)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	// Liveness can never be determined (e.g. OpenProcess access-denied): the
	// deadline cap is the only clearing mechanism.
	liveness := &pidLivenessStub{alive: false, known: false}
	b.helperKeyPIDAliveFn = liveness.probe

	base := time.Unix(1_700_000_000, 0)
	nowVal := base
	b.nowFn = func() time.Time { return nowVal }

	m, spawner := scheduledOwnerWithFailedKill(t, b, key, 4050)

	// Just before the cap: still blocked, no duplicate.
	nowVal = base.Add(b.helperKeyRetentionTTL - time.Second)
	if !b.helperKeySpawnBlocked(key) {
		t.Fatal("indeterminate liveness must fail closed before the deadline cap")
	}
	m.spawnKey(key)
	if got := spawner.SpawnCount(key); got != 0 {
		t.Fatalf("respawn fired before deadline cap: spawn count = %d, want 0", got)
	}

	// Past the cap: retention is guaranteed to end so the key can never wedge.
	nowVal = base.Add(b.helperKeyRetentionTTL + time.Second)
	if b.helperKeySpawnBlocked(key) {
		t.Fatal("retention must end once the deadline cap elapses")
	}
	m.spawnKey(key)
	if got := spawner.SpawnCount(key); got != 1 {
		t.Fatalf("respawn after deadline cap: spawn count = %d, want 1", got)
	}
}

func TestFailedKillRetentionYieldsToFreshAuthenticatedOwner(t *testing.T) {
	b := New("retain-fresh-owner-"+t.Name(), nil)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	// Liveness indeterminate so only owner-precedence (not death) can clear it.
	liveness := &pidLivenessStub{alive: false, known: false}
	b.helperKeyPIDAliveFn = liveness.probe

	_, spawner := scheduledOwnerWithFailedKill(t, b, key, 4050)
	if !b.helperKeySpawnBlocked(key) {
		t.Fatal("retention should be active immediately after a failed kill")
	}

	// A fresh scheduled helper reconnects and claims the key. The live owner
	// must supersede the stale retention entry, which is then discarded.
	fresh := newFakeOwnedPeerProcess(4099)
	newOwnedSession(t, b, key, fresh)
	if !b.helperKeySpawnBlocked(key) {
		t.Fatal("a live authenticated owner must block respawn")
	}
	b.mu.Lock()
	_, retained := b.helperKeyRetention[key]
	b.mu.Unlock()
	if retained {
		t.Fatal("stale retention entry should be cleared once a live owner exists")
	}
	if got := spawner.SpawnCount(key); got != 0 {
		t.Fatalf("no respawn expected while owned: spawn count = %d, want 0", got)
	}
}
