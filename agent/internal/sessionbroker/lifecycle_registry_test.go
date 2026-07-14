package sessionbroker

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestSessionAuthenticatedMarksOnlyCurrentBrokerOwnerConnected(t *testing.T) {
	b := New("current-owner-"+t.Name(), nil)
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{}, nil, &fakeHelperSpawner{})
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	proc := newFakeHelperProcess(4090)
	m.registry.attach(key, proc, "helper", "system-helper")
	session := &Session{PID: int(proc.pid), WinSessionID: "7", HelperRole: "system"}
	t.Cleanup(func() {
		proc.markExited(0)
		m.Stop()
		b.Close()
	})

	m.sessionAuthenticated(session)
	m.registry.mu.Lock()
	stateWithoutOwner := m.registry.current[key].state
	m.registry.mu.Unlock()
	if stateWithoutOwner == helperConnected {
		t.Fatal("non-owning authenticated callback marked registry connected")
	}

	b.mu.Lock()
	b.helperByKey[key] = session
	b.mu.Unlock()
	m.sessionAuthenticated(session)
	m.registry.mu.Lock()
	stateWithOwner := m.registry.current[key].state
	m.registry.mu.Unlock()
	if stateWithOwner != helperConnected {
		t.Fatalf("current owner state = %q, want connected", stateWithOwner)
	}
}

type fakeLifecycleDetector struct {
	sessions []DetectedSession
}

func (d fakeLifecycleDetector) ListSessions() ([]DetectedSession, error) {
	return append([]DetectedSession(nil), d.sessions...), nil
}

func (d fakeLifecycleDetector) WatchSessions(context.Context) <-chan SessionEvent {
	return make(chan SessionEvent)
}

type fakeHelperProcess struct {
	pid  uint32
	path string

	mu             sync.Mutex
	alive          bool
	exitCode       int
	exited         chan struct{}
	exitOnce       sync.Once
	waitCount      int
	terminateCount int
	closeCount     int
	terminateExits bool
}

func newFakeHelperProcess(pid uint32) *fakeHelperProcess {
	return &fakeHelperProcess{
		pid:            pid,
		path:           "breeze-user-helper.exe",
		alive:          true,
		exited:         make(chan struct{}),
		terminateExits: true,
	}
}

func (p *fakeHelperProcess) ProcessID() uint32      { return p.pid }
func (p *fakeHelperProcess) ExecutablePath() string { return p.path }

func (p *fakeHelperProcess) Alive() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.alive
}

func (p *fakeHelperProcess) Terminate() error {
	p.mu.Lock()
	p.terminateCount++
	exits := p.terminateExits
	p.mu.Unlock()
	if exits {
		p.markExited(1)
	}
	return nil
}

func TestTimedOutStopRetainsLiveGenerationAndSuppressesReplacement(t *testing.T) {
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	proc := newFakeHelperProcess(4075)
	proc.terminateExits = false
	spawner := &fakeHelperSpawner{byKey: map[HelperKey]helperProcess{key: proc}}
	m := newLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}, spawner)
	m.gracePeriod = time.Millisecond
	m.finalWait = time.Millisecond
	m.reconcile()
	m.registry.mu.Lock()
	m.registry.current[key].lastFailure = time.Now().Add(-time.Minute)
	m.registry.mu.Unlock()

	started := time.Now()
	m.stopKey(key)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("bounded stop took %v", elapsed)
	}
	if got := m.registry.processID(key); got != proc.pid {
		t.Fatalf("live stopping generation PID = %d, want %d", got, proc.pid)
	}
	m.spawnKey(key)
	if got := spawner.SpawnCount(key); got != 1 {
		t.Fatalf("spawn count with live stopping generation = %d, want 1", got)
	}

	proc.markExited(1)
}

func (p *fakeHelperProcess) Wait() (int, error) {
	p.mu.Lock()
	p.waitCount++
	p.mu.Unlock()
	<-p.exited
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCode, nil
}

func (p *fakeHelperProcess) Close() error {
	p.mu.Lock()
	p.closeCount++
	p.mu.Unlock()
	return nil
}

func (p *fakeHelperProcess) markExited(code int) {
	p.exitOnce.Do(func() {
		p.mu.Lock()
		p.alive = false
		p.exitCode = code
		p.mu.Unlock()
		close(p.exited)
	})
}

func (p *fakeHelperProcess) counts() (wait, terminate, close int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitCount, p.terminateCount, p.closeCount
}

type fakeHelperSpawner struct {
	mu        sync.Mutex
	processes []helperProcess
	byKey     map[HelperKey]helperProcess
	spawned   map[HelperKey]int
	closed    int
}

func (s *fakeHelperSpawner) Spawn(key HelperKey) (helperProcess, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.spawned == nil {
		s.spawned = make(map[HelperKey]int)
	}
	s.spawned[key]++
	if proc := s.byKey[key]; proc != nil {
		delete(s.byKey, key)
		return proc, nil
	}
	if len(s.processes) == 0 {
		return newFakeHelperProcess(uint32(5000 + s.spawned[key])), nil
	}
	proc := s.processes[0]
	s.processes = s.processes[1:]
	return proc, nil
}

func TestLifecycleBootstrapPublishesDesiredKeysBeforeSpawning(t *testing.T) {
	b := New("bootstrap-"+t.Name(), nil)
	spawner := &fakeHelperSpawner{}
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{sessions: []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}}, nil, spawner)
	t.Cleanup(func() {
		m.Stop()
		b.Close()
	})

	if err := m.Bootstrap(); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	for _, role := range []string{"system", "user"} {
		key := HelperKey{WindowsSessionID: 7, Role: role}
		if !b.helperKeyDesired(key) {
			t.Fatalf("%s key was not published by bootstrap", role)
		}
		if got := spawner.SpawnCount(key); got != 0 {
			t.Fatalf("%s spawn count during bootstrap = %d, want 0", role, got)
		}
	}
}

func TestReconcileDoesNotSpawnWhenScheduledHelperOwnsLogicalKey(t *testing.T) {
	b := New("scheduled-owner-"+t.Name(), nil)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	proc := newFakeOwnedPeerProcess(4050)
	newOwnedSession(t, b, key, proc)
	spawner := &fakeHelperSpawner{}
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{sessions: []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}}, nil, spawner)
	m.gracePeriod = 0
	m.finalWait = 0
	t.Cleanup(func() {
		m.Stop()
		b.Close()
	})

	m.reconcile()

	if got := spawner.SpawnCount(key); got != 0 {
		t.Fatalf("scheduled owner duplicate spawn count = %d, want 0", got)
	}
}

func (s *fakeHelperSpawner) Close() error {
	s.mu.Lock()
	s.closed++
	s.mu.Unlock()
	return nil
}

func (s *fakeHelperSpawner) SpawnCount(key HelperKey) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spawned[key]
}

func newLifecycleHarness(t *testing.T, sessions []DetectedSession, spawner helperSpawner) *HelperLifecycleManager {
	t.Helper()
	b := New("lifecycle-"+t.Name(), nil)
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{sessions: sessions}, nil, spawner)
	m.gracePeriod = 5 * time.Millisecond
	m.finalWait = 100 * time.Millisecond
	t.Cleanup(func() {
		m.Stop()
		b.Close()
	})
	return m
}

func TestReconcileDoesNotRespawnWhilePreAuthProcessLives(t *testing.T) {
	proc := newFakeHelperProcess(4100)
	spawner := &fakeHelperSpawner{processes: []helperProcess{proc}}
	m := newLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}, spawner)

	m.reconcile()
	m.reconcile()

	if got := spawner.SpawnCount(HelperKey{WindowsSessionID: 7, Role: "system"}); got != 1 {
		t.Fatalf("system spawn count = %d, want 1", got)
	}
}

func TestStaleExitCannotClearReplacement(t *testing.T) {
	oldProc := newFakeHelperProcess(4100)
	newProc := newFakeHelperProcess(4200)
	m := newLifecycleHarness(t, nil, &fakeHelperSpawner{})
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	oldGeneration := m.registry.attach(key, oldProc, "breeze-user-helper.exe", "system-helper")
	oldProc.markExited(0)
	if !m.registry.detach(key, oldGeneration) {
		t.Fatal("failed to detach observably exited generation")
	}
	m.registry.attach(key, newProc, "breeze-user-helper.exe", "system-helper")
	m.registry.noteExit(key, oldGeneration, 0)
	if got := m.registry.processID(key); got != 4200 {
		t.Fatalf("replacement PID = %d, want 4200", got)
	}
}

func TestStopSessionTerminatesBothRoles(t *testing.T) {
	m := newLifecycleHarness(t, nil, &fakeHelperSpawner{})
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "system"}, newFakeHelperProcess(1), "helper", "system-helper")
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "user"}, newFakeHelperProcess(2), "helper", "user-helper")
	m.stopSession(7)
	if got := m.registry.len(); got != 0 {
		t.Fatalf("registry len = %d, want 0", got)
	}
}

func TestConcurrentReconcileStopAndExitOwnsHandleOnce(t *testing.T) {
	proc := newFakeHelperProcess(4300)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	spawner := &fakeHelperSpawner{byKey: map[HelperKey]helperProcess{key: proc}}
	m := newLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}, spawner)

	var reconcileWG sync.WaitGroup
	for range 16 {
		reconcileWG.Add(1)
		go func() {
			defer reconcileWG.Done()
			m.reconcile()
		}()
	}
	reconcileWG.Wait()

	var raceWG sync.WaitGroup
	raceWG.Add(2)
	go func() {
		defer raceWG.Done()
		m.stopKey(key)
	}()
	go func() {
		defer raceWG.Done()
		proc.markExited(0)
	}()
	raceWG.Wait()

	deadline := time.Now().Add(time.Second)
	for {
		wait, _, closeCount := proc.counts()
		if wait == 1 && closeCount == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("process ownership counts wait=%d close=%d, want 1 each", wait, closeCount)
		}
		time.Sleep(time.Millisecond)
	}
	if got := spawner.SpawnCount(key); got != 1 {
		t.Fatalf("system spawn count = %d, want 1", got)
	}
}

func TestConcurrentStopKeyHasSingleTerminationOwner(t *testing.T) {
	m := newLifecycleHarness(t, nil, &fakeHelperSpawner{})
	m.gracePeriod = 20 * time.Millisecond
	m.finalWait = 0
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	process := newFakeHelperProcess(4400)
	m.registry.attach(key, process, "helper", "system-helper")

	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.stopKey(key)
		}()
	}
	wg.Wait()

	_, terminateCount, _ := process.counts()
	if terminateCount != 1 {
		t.Fatalf("terminate count = %d, want 1", terminateCount)
	}
}

func TestRegistryBeginStopGrantsOneOwnerPerGeneration(t *testing.T) {
	registry := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	registry.attach(key, newFakeHelperProcess(4500), "helper", "system-helper")
	if first := registry.beginStop(key); first == nil {
		t.Fatal("first beginStop did not claim generation")
	}
	if second := registry.beginStop(key); second != nil {
		t.Fatal("second beginStop claimed an already-stopping generation")
	}
	if got := registry.processID(key); got != 4500 {
		t.Fatalf("stopping generation PID = %d, want 4500", got)
	}
}

func TestLifecycleStopEndsStartLoop(t *testing.T) {
	m := NewHelperLifecycleManager(New("stop-loop-"+t.Name(), nil), nil)
	go m.Start(context.Background())
	m.Stop()
	select {
	case <-m.Done():
	case <-time.After(time.Second):
		t.Fatal("Start loop did not finish after Stop")
	}
}
