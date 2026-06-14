package monitoring

import (
	"sync"
	"testing"
	"time"
)

// --- Lifecycle integration tests ---

// waitForCallCount polls until the supplied counter reaches `want` (or more)
// within a generous deadline, then returns the observed count. The immediate
// check kicked off by ApplyConfig/Start runs asynchronously in the loop
// goroutine, so a fixed real-clock sleep races that goroutine — on a busy CI
// runner the check may not have fired yet when the sleep elapses (issue #1267).
// Polling lets timing pressure only slow the test, never fail it.
func waitForCallCount(t *testing.T, mu *sync.Mutex, callCount *int, want int) int {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := *callCount
		mu.Unlock()

		if count >= want {
			return count
		}
		if time.Now().After(deadline) {
			return count
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestMonitorRunsImmediateCheckOnStart(t *testing.T) {
	var mu sync.Mutex
	var callCount int

	m := New(func(results []CheckResult) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	cfg := MonitorConfig{
		CheckIntervalSeconds: 300, // very long interval so only the immediate check fires
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent__"},
		},
	}

	m.ApplyConfig(cfg)
	// Wait for the async immediate check to fire instead of racing a fixed sleep.
	count := waitForCallCount(t, &mu, &callCount, 1)
	m.Stop()

	if count < 1 {
		t.Fatalf("callCount = %d, want >= 1 (immediate check should have fired)", count)
	}
}

func TestApplyConfigRestopsAndRestarts(t *testing.T) {
	var mu sync.Mutex
	var callCount int

	m := New(func(results []CheckResult) {
		mu.Lock()
		callCount++
		mu.Unlock()
	})

	cfg1 := MonitorConfig{
		CheckIntervalSeconds: 300,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_proc_1__"},
		},
	}
	m.ApplyConfig(cfg1)
	// Wait for the first ApplyConfig's immediate check before re-applying, so the
	// second config can't clobber the first check before it runs.
	waitForCallCount(t, &mu, &callCount, 1)

	// Re-apply with different config — should stop and restart
	cfg2 := MonitorConfig{
		CheckIntervalSeconds: 300,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_proc_2__"},
		},
	}
	m.ApplyConfig(cfg2)
	// Wait for the second ApplyConfig's immediate check (total >= 2).
	count := waitForCallCount(t, &mu, &callCount, 2)
	m.Stop()

	// Should have fired at least twice (one immediate check per ApplyConfig)
	if count < 2 {
		t.Fatalf("callCount = %d, want >= 2 (one per ApplyConfig immediate check)", count)
	}
}

func TestRunChecksResetsConsecutiveFailuresOnSuccess(t *testing.T) {
	m := New(func(results []CheckResult) {})

	// Use a process name that won't be found — simulating failure
	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent__"},
		},
	}
	m.states["process:__breeze_test_nonexistent__"] = &watchState{
		consecutiveFailures: 5,
	}
	m.mu.Unlock()

	m.runChecks() // not found → failure++

	m.mu.RLock()
	failures := m.states["process:__breeze_test_nonexistent__"].consecutiveFailures
	m.mu.RUnlock()

	if failures != 6 {
		t.Errorf("consecutiveFailures = %d, want 6 (incremented from 5)", failures)
	}
}

func TestRunChecksAutoRestartNotAttemptedForNotFound(t *testing.T) {
	var mu sync.Mutex
	var received []CheckResult

	m := New(func(results []CheckResult) {
		mu.Lock()
		received = append(received, results...)
		mu.Unlock()
	})

	// Auto-restart should only trigger on StatusStopped, not on StatusNotFound
	// or StatusError — this prevents restart spam for unresolvable names.
	// See the comment in monitor.go runChecks() around the auto-restart branch.
	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent__",
				AutoRestart:            true,
				MaxRestartAttempts:     3,
				RestartCooldownSeconds: 0,
			},
		},
	}
	m.states["process:__breeze_test_nonexistent__"] = &watchState{}
	m.mu.Unlock()

	m.runChecks()

	mu.Lock()
	defer mu.Unlock()

	if len(received) != 1 {
		t.Fatalf("len(received) = %d, want 1", len(received))
	}

	r := received[0]
	if r.Status == StatusRunning {
		t.Fatal("Status should not be running for nonexistent process")
	}
	if r.AutoRestartAttempted {
		t.Error("AutoRestartAttempted should be false for StatusNotFound — auto-restart must only fire for StatusStopped")
	}
}

// --- Concurrency tests ---

func TestConcurrentApplyConfig(t *testing.T) {
	m := New(func(results []CheckResult) {})

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			cfg := MonitorConfig{
				CheckIntervalSeconds: 30,
				Watches: []WatchConfig{
					{WatchType: WatchTypeService, Name: "test"},
				},
			}
			if i%3 == 0 {
				cfg.Watches = nil // empty — should stop
			}
			m.ApplyConfig(cfg)
		}(i)
	}

	wg.Wait()
	m.Stop()
}

func TestConcurrentStartStop(t *testing.T) {
	m := New(func(results []CheckResult) {})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "test"},
		},
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				m.Start()
			} else {
				m.Stop()
			}
		}(i)
	}

	wg.Wait()
	m.Stop()
}
