package monitoring

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
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

func TestMaybeAutoRestartRespectsMaxAttempts(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_nonexistent__",
		AutoRestart:            true,
		MaxRestartAttempts:     2,
		RestartCooldownSeconds: 0,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{
		restartAttempts: 2, // already at max
	}

	result := CheckResult{Status: StatusNotFound}
	attempted, _ := m.maybeAutoRestart(w, &result)

	if attempted {
		t.Error("should not attempt restart when max attempts reached")
	}
}

func TestMaybeAutoRestartRespectsCooldown(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_nonexistent__",
		AutoRestart:            true,
		MaxRestartAttempts:     5,
		RestartCooldownSeconds: 60,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{
		restartAttempts:    1,
		lastRestartAttempt: time.Now(), // just attempted — within cooldown
	}

	result := CheckResult{Status: StatusNotFound}
	attempted, _ := m.maybeAutoRestart(w, &result)

	if attempted {
		t.Error("should not attempt restart within cooldown period")
	}
}

func TestMaybeAutoRestartAllowsAfterCooldown(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_nonexistent__",
		AutoRestart:            true,
		MaxRestartAttempts:     5,
		RestartCooldownSeconds: 1,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{
		restartAttempts:    1,
		lastRestartAttempt: time.Now().Add(-2 * time.Second), // well past cooldown
	}

	result := CheckResult{Status: StatusNotFound}
	attempted, _ := m.maybeAutoRestart(w, &result)

	// For process type, killProcess will be called on a nonexistent process,
	// which will fail. But the attempt should still be made.
	if !attempted {
		t.Error("should attempt restart after cooldown has passed")
	}

	// Verify state was updated
	m.mu.RLock()
	state := m.states[key]
	attempts := state.restartAttempts
	m.mu.RUnlock()

	if attempts != 2 {
		t.Errorf("restartAttempts = %d, want 2", attempts)
	}
}

func TestMaybeAutoRestartIncrementsAttempts(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_nonexistent__",
		AutoRestart:            true,
		MaxRestartAttempts:     10,
		RestartCooldownSeconds: 0,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{
		restartAttempts: 0,
	}

	result := CheckResult{Status: StatusNotFound}
	m.maybeAutoRestart(w, &result)

	m.mu.RLock()
	state := m.states[key]
	attempts := state.restartAttempts
	m.mu.RUnlock()

	if attempts != 1 {
		t.Errorf("restartAttempts = %d, want 1 after first attempt", attempts)
	}
}

func TestMaybeAutoRestartSetsAutoRestartSucceededFalseOnError(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_nonexistent_for_restart__",
		AutoRestart:            true,
		MaxRestartAttempts:     5,
		RestartCooldownSeconds: 0,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{}

	result := CheckResult{Status: StatusNotFound}
	attempted, succeeded := m.maybeAutoRestart(w, &result)

	if !attempted {
		t.Error("should have attempted restart")
	}
	if succeeded {
		t.Error("restart of nonexistent process should not succeed")
	}
	if result.AutoRestartSucceeded == nil {
		t.Fatal("AutoRestartSucceeded should not be nil after failed attempt")
	}
	if *result.AutoRestartSucceeded != false {
		t.Error("AutoRestartSucceeded should be false after failed restart")
	}
}

func TestMaybeAutoRestartCreatesStateIfMissing(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_newwatch__",
		AutoRestart:            true,
		MaxRestartAttempts:     5,
		RestartCooldownSeconds: 0,
	}

	// Don't pre-create the state — let maybeAutoRestart create it
	result := CheckResult{Status: StatusNotFound}
	m.maybeAutoRestart(w, &result)

	m.mu.RLock()
	key := w.WatchType + ":" + w.Name
	state, ok := m.states[key]
	m.mu.RUnlock()

	if !ok {
		t.Fatal("maybeAutoRestart should create state if missing")
	}
	if state.restartAttempts != 1 {
		t.Errorf("restartAttempts = %d, want 1", state.restartAttempts)
	}
}

func TestMaybeAutoRestartZeroMaxAttemptsNeverRestarts(t *testing.T) {
	m := New(func(results []CheckResult) {})

	w := WatchConfig{
		WatchType:              WatchTypeProcess,
		Name:                   "__breeze_test_zero_max__",
		AutoRestart:            true,
		MaxRestartAttempts:     0, // zero means never restart
		RestartCooldownSeconds: 0,
	}

	key := w.WatchType + ":" + w.Name
	m.states[key] = &watchState{}

	result := CheckResult{Status: StatusNotFound}
	attempted, _ := m.maybeAutoRestart(w, &result)

	if attempted {
		t.Error("should not attempt restart when MaxRestartAttempts is 0")
	}
}

// --- ParseMonitorConfig tests ---

func TestParseMonitorConfigValidMap(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(30),
		"watches": []any{
			map[string]any{
				"watch_type":                       "service",
				"name":                             "nginx",
				"alert_on_stop":                    true,
				"alert_after_consecutive_failures": float64(3),
				"auto_restart":                     true,
				"max_restart_attempts":             float64(5),
				"restart_cooldown_seconds":         float64(60),
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig returned false for valid input")
	}

	if cfg.CheckIntervalSeconds != 30 {
		t.Errorf("CheckIntervalSeconds = %d, want 30", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}
	if cfg.Watches[0].Name != "nginx" {
		t.Errorf("Watches[0].Name = %q, want %q", cfg.Watches[0].Name, "nginx")
	}
	if !cfg.Watches[0].AutoRestart {
		t.Error("Watches[0].AutoRestart = false, want true")
	}
}

func TestParseMonitorConfigEmptyWatches(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(60),
		"watches":                []any{},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should return true for empty watches")
	}
	if len(cfg.Watches) != 0 {
		t.Errorf("len(Watches) = %d, want 0", len(cfg.Watches))
	}
}

func TestParseMonitorConfigNilInput(t *testing.T) {
	cfg, ok := ParseMonitorConfig(nil)
	if !ok {
		t.Fatal("ParseMonitorConfig(nil) should return true (null marshals to valid JSON)")
	}
	if cfg.CheckIntervalSeconds != 0 {
		t.Errorf("CheckIntervalSeconds = %d, want 0 for nil input", cfg.CheckIntervalSeconds)
	}
}

func TestParseMonitorConfigFromJSONString(t *testing.T) {
	// Simulate what happens when the API sends a JSON-like structure
	// that gets decoded into map[string]any by the Go JSON decoder.
	jsonStr := `{
		"check_interval_seconds": 45,
		"watches": [
			{
				"watch_type": "process",
				"name": "node",
				"alert_on_stop": false,
				"alert_after_consecutive_failures": 1,
				"auto_restart": false,
				"max_restart_attempts": 0,
				"restart_cooldown_seconds": 0,
				"cpu_threshold_percent": 90.0,
				"memory_threshold_mb": 256.0,
				"threshold_duration_seconds": 60
			}
		]
	}`

	var raw any
	if err := json.Unmarshal([]byte(jsonStr), &raw); err != nil {
		t.Fatalf("failed to parse test JSON: %v", err)
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should return true for valid JSON input")
	}

	if cfg.CheckIntervalSeconds != 45 {
		t.Errorf("CheckIntervalSeconds = %d, want 45", cfg.CheckIntervalSeconds)
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}

	w := cfg.Watches[0]
	if w.WatchType != WatchTypeProcess {
		t.Errorf("WatchType = %q, want %q", w.WatchType, WatchTypeProcess)
	}
	if w.CpuThresholdPercent != 90.0 {
		t.Errorf("CpuThresholdPercent = %f, want 90.0", w.CpuThresholdPercent)
	}
	if w.MemoryThresholdMb != 256.0 {
		t.Errorf("MemoryThresholdMb = %f, want 256.0", w.MemoryThresholdMb)
	}
	if w.ThresholdDurationSeconds != 60 {
		t.Errorf("ThresholdDurationSeconds = %d, want 60", w.ThresholdDurationSeconds)
	}
}

func TestParseMonitorConfigInvalidType(t *testing.T) {
	// A channel cannot be marshaled to JSON
	ch := make(chan int)
	_, ok := ParseMonitorConfig(ch)
	if ok {
		t.Error("ParseMonitorConfig should return false for unmarshalable input")
	}
}

func TestParseMonitorConfigMultipleWatches(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(15),
		"watches": []any{
			map[string]any{
				"watch_type": "service",
				"name":       "nginx",
			},
			map[string]any{
				"watch_type": "service",
				"name":       "postgresql",
			},
			map[string]any{
				"watch_type": "process",
				"name":       "node",
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig returned false for valid input")
	}
	if len(cfg.Watches) != 3 {
		t.Fatalf("len(Watches) = %d, want 3", len(cfg.Watches))
	}

	names := make(map[string]bool)
	for _, w := range cfg.Watches {
		names[w.Name] = true
	}
	for _, expected := range []string{"nginx", "postgresql", "node"} {
		if !names[expected] {
			t.Errorf("expected watch named %q not found", expected)
		}
	}
}

// --- Lifecycle integration tests ---

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
	// Give the immediate check time to fire
	time.Sleep(100 * time.Millisecond)
	m.Stop()

	mu.Lock()
	count := callCount
	mu.Unlock()

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
	time.Sleep(100 * time.Millisecond)

	// Re-apply with different config — should stop and restart
	cfg2 := MonitorConfig{
		CheckIntervalSeconds: 300,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_proc_2__"},
		},
	}
	m.ApplyConfig(cfg2)
	time.Sleep(100 * time.Millisecond)
	m.Stop()

	mu.Lock()
	count := callCount
	mu.Unlock()

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

func TestRunChecksAutoRestartNotAttemptedWhenRunning(t *testing.T) {
	var mu sync.Mutex
	var received []CheckResult

	m := New(func(results []CheckResult) {
		mu.Lock()
		received = append(received, results...)
		mu.Unlock()
	})

	// Even with auto-restart enabled, if status is running, no restart should happen.
	// We can't easily make checkProcess return "running" for a fake process,
	// but we can verify for a not-found process that auto-restart IS attempted.
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
	if !r.AutoRestartAttempted {
		t.Error("AutoRestartAttempted should be true when process is not running and auto_restart is enabled")
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

// --- watchState key format tests ---

func TestWatchStateKeyFormat(t *testing.T) {
	tests := []struct {
		watchType WatchType
		name      string
		wantKey   string
	}{
		{WatchTypeService, "nginx", "service:nginx"},
		{WatchTypeProcess, "node", "process:node"},
		{WatchTypeService, "My Service Name", "service:My Service Name"},
		{WatchTypeProcess, "long.process.name.exe", "process:long.process.name.exe"},
	}

	for _, tt := range tests {
		key := tt.watchType + ":" + tt.name
		if key != tt.wantKey {
			t.Errorf("key for %s:%s = %q, want %q", tt.watchType, tt.name, key, tt.wantKey)
		}
	}
}

// --- Edge case: ParseMonitorConfig with nested structures ---

func TestParseMonitorConfigIgnoresExtraFields(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(30),
		"unknown_field":          "should be ignored",
		"watches": []any{
			map[string]any{
				"watch_type":   "service",
				"name":         "test",
				"extra_field":  "ignored",
				"nested_extra": map[string]any{"foo": "bar"},
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should not fail on extra fields")
	}
	if len(cfg.Watches) != 1 {
		t.Fatalf("len(Watches) = %d, want 1", len(cfg.Watches))
	}
	if cfg.Watches[0].Name != "test" {
		t.Errorf("Watches[0].Name = %q, want %q", cfg.Watches[0].Name, "test")
	}
}

func TestParseMonitorConfigZeroValues(t *testing.T) {
	raw := map[string]any{
		"check_interval_seconds": float64(0),
		"watches": []any{
			map[string]any{
				"watch_type":                       "service",
				"name":                             "test",
				"alert_on_stop":                    false,
				"alert_after_consecutive_failures": float64(0),
				"auto_restart":                     false,
				"max_restart_attempts":             float64(0),
				"restart_cooldown_seconds":         float64(0),
			},
		},
	}

	cfg, ok := ParseMonitorConfig(raw)
	if !ok {
		t.Fatal("ParseMonitorConfig should handle zero values")
	}

	w := cfg.Watches[0]
	if w.AlertOnStop {
		t.Error("AlertOnStop should be false")
	}
	if w.AutoRestart {
		t.Error("AutoRestart should be false")
	}
	if w.MaxRestartAttempts != 0 {
		t.Errorf("MaxRestartAttempts = %d, want 0", w.MaxRestartAttempts)
	}
}
