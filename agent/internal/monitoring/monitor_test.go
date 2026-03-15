package monitoring

import (
	"sync"
	"testing"
)

func TestNewReturnsNonNilMonitor(t *testing.T) {
	m := New(nil)
	if m == nil {
		t.Fatal("New() returned nil")
	}
	if m.states == nil {
		t.Fatal("New() did not initialize states map")
	}
}

func TestNewPreservesCallback(t *testing.T) {
	called := false
	cb := func(results []CheckResult) {
		called = true
	}

	m := New(cb)
	if m.sendResults == nil {
		t.Fatal("New() did not store sendResults callback")
	}

	// Invoke the stored callback to verify it's the right one
	m.sendResults(nil)
	if !called {
		t.Fatal("stored callback is not the one we passed in")
	}
}

func TestApplyConfigEmptyWatchesDoesNotStart(t *testing.T) {
	m := New(nil)
	m.ApplyConfig(MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches:              []WatchConfig{},
	})

	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()

	if running {
		t.Fatal("Monitor should not be running with empty watches")
		m.Stop()
	}
}

func TestApplyConfigCreatesStatesForWatches(t *testing.T) {
	m := New(func(results []CheckResult) {})

	cfg := MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "nginx"},
			{WatchType: WatchTypeProcess, Name: "node"},
		},
	}

	m.ApplyConfig(cfg)
	// Stop immediately so the background goroutine doesn't run indefinitely
	m.Stop()

	m.mu.RLock()
	defer m.mu.RUnlock()

	if _, ok := m.states["service:nginx"]; !ok {
		t.Error("state for service:nginx not found")
	}
	if _, ok := m.states["process:node"]; !ok {
		t.Error("state for process:node not found")
	}
}

func TestApplyConfigRemovesStaleStates(t *testing.T) {
	m := New(func(results []CheckResult) {})

	// Apply initial config with two watches
	cfg1 := MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "nginx"},
			{WatchType: WatchTypeService, Name: "apache"},
		},
	}
	m.ApplyConfig(cfg1)
	m.Stop()

	// Apply new config with only one watch
	cfg2 := MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "nginx"},
		},
	}
	m.ApplyConfig(cfg2)
	m.Stop()

	m.mu.RLock()
	defer m.mu.RUnlock()

	if _, ok := m.states["service:nginx"]; !ok {
		t.Error("state for service:nginx should still exist")
	}
	if _, ok := m.states["service:apache"]; ok {
		t.Error("state for service:apache should have been removed")
	}
}

func TestApplyConfigPreservesExistingState(t *testing.T) {
	m := New(func(results []CheckResult) {})

	cfg := MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "nginx"},
		},
	}
	m.ApplyConfig(cfg)
	m.Stop()

	// Manually modify state to simulate accumulated failures
	m.mu.Lock()
	m.states["service:nginx"].consecutiveFailures = 5
	m.states["service:nginx"].restartAttempts = 2
	m.mu.Unlock()

	// Re-apply same config — state should be preserved
	m.ApplyConfig(cfg)
	m.Stop()

	m.mu.RLock()
	defer m.mu.RUnlock()

	state := m.states["service:nginx"]
	if state.consecutiveFailures != 5 {
		t.Errorf("consecutiveFailures = %d, want 5 (should be preserved)", state.consecutiveFailures)
	}
	if state.restartAttempts != 2 {
		t.Errorf("restartAttempts = %d, want 2 (should be preserved)", state.restartAttempts)
	}
}

func TestStartClampsIntervalBelow10(t *testing.T) {
	m := New(func(results []CheckResult) {})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 3, // below minimum
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "test"},
		},
	}
	m.mu.Unlock()

	m.Start()
	defer m.Stop()

	// The monitor should be running (it didn't reject the config)
	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()

	if !running {
		t.Fatal("Monitor should be running even with low interval (clamped to 10s)")
	}
}

func TestStartIdempotent(t *testing.T) {
	m := New(func(results []CheckResult) {})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "test"},
		},
	}
	m.mu.Unlock()

	m.Start()
	m.Start() // second call should be no-op
	defer m.Stop()

	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()

	if !running {
		t.Fatal("Monitor should be running")
	}
}

func TestStopIdempotent(t *testing.T) {
	m := New(func(results []CheckResult) {})

	// Stop on an unstarted monitor should not panic
	m.Stop()
	m.Stop()

	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()

	if running {
		t.Fatal("Monitor should not be running after Stop")
	}
}

func TestStopAfterStart(t *testing.T) {
	m := New(func(results []CheckResult) {})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeService, Name: "test"},
		},
	}
	m.mu.Unlock()

	m.Start()
	m.Stop()

	m.mu.RLock()
	running := m.running
	m.mu.RUnlock()

	if running {
		t.Fatal("Monitor should not be running after Stop")
	}
}

func TestRunChecksSendsResults(t *testing.T) {
	var mu sync.Mutex
	var received []CheckResult

	m := New(func(results []CheckResult) {
		mu.Lock()
		received = append(received, results...)
		mu.Unlock()
	})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			// Use a name that won't match any real service/process
			{WatchType: WatchTypeService, Name: "__breeze_test_nonexistent_svc__"},
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent_proc__"},
		},
	}
	// Initialize states
	for _, w := range m.config.Watches {
		key := w.WatchType + ":" + w.Name
		m.states[key] = &watchState{}
	}
	m.mu.Unlock()

	m.runChecks()

	mu.Lock()
	defer mu.Unlock()

	if len(received) != 2 {
		t.Fatalf("len(received) = %d, want 2", len(received))
	}

	for _, r := range received {
		if r.Name == "" {
			t.Error("result Name should not be empty")
		}
		if r.WatchType == "" {
			t.Error("result WatchType should not be empty")
		}
	}
}

func TestRunChecksUnsupportedWatchType(t *testing.T) {
	var mu sync.Mutex
	var received []CheckResult

	m := New(func(results []CheckResult) {
		mu.Lock()
		received = append(received, results...)
		mu.Unlock()
	})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: "unknown_type", Name: "test"},
		},
	}
	m.states["unknown_type:test"] = &watchState{}
	m.mu.Unlock()

	m.runChecks()

	mu.Lock()
	defer mu.Unlock()

	if len(received) != 1 {
		t.Fatalf("len(received) = %d, want 1", len(received))
	}

	if received[0].Status != StatusError {
		t.Errorf("Status = %q, want %q for unsupported watch type", received[0].Status, StatusError)
	}
	if received[0].Details == nil {
		t.Fatal("Details should not be nil for error result")
	}
	if _, ok := received[0].Details["error"]; !ok {
		t.Error("Details should contain 'error' key")
	}
}

func TestRunChecksEmptyWatchesNoCallback(t *testing.T) {
	called := false
	m := New(func(results []CheckResult) {
		called = true
	})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches:              []WatchConfig{},
	}
	m.mu.Unlock()

	m.runChecks()

	if called {
		t.Fatal("sendResults should not be called when there are no watches")
	}
}

func TestRunChecksNilCallbackDoesNotPanic(t *testing.T) {
	m := New(nil)

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent__"},
		},
	}
	m.states["process:__breeze_test_nonexistent__"] = &watchState{}
	m.mu.Unlock()

	// Should not panic even with nil sendResults
	m.runChecks()
}

func TestRunChecksTracksConsecutiveFailures(t *testing.T) {
	m := New(func(results []CheckResult) {})

	m.mu.Lock()
	m.config = MonitorConfig{
		CheckIntervalSeconds: 30,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent_proc__"},
		},
	}
	m.states["process:__breeze_test_nonexistent_proc__"] = &watchState{}
	m.mu.Unlock()

	// Run checks multiple times — process doesn't exist, so failures should accumulate
	m.runChecks()
	m.runChecks()
	m.runChecks()

	m.mu.RLock()
	state := m.states["process:__breeze_test_nonexistent_proc__"]
	failures := state.consecutiveFailures
	m.mu.RUnlock()

	if failures != 3 {
		t.Errorf("consecutiveFailures = %d, want 3", failures)
	}
}

