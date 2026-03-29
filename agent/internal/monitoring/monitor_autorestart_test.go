package monitoring

import (
	"testing"
	"time"
)

// TestMaybeAutoRestart consolidates all auto-restart behavior tests into a
// single table-driven test.
func TestMaybeAutoRestart(t *testing.T) {
	tests := []struct {
		name            string
		watchConfig     WatchConfig
		initialState    *watchState
		wantAttempted   bool
		wantSucceeded   bool
		wantAttempts    int
		wantAutoRestSuc *bool // expected AutoRestartSucceeded on result (nil = not set)
	}{
		{
			name: "respects max attempts",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent__",
				AutoRestart:            true,
				MaxRestartAttempts:     2,
				RestartCooldownSeconds: 0,
			},
			initialState:  &watchState{restartAttempts: 2}, // already at max
			wantAttempted: false,
			wantAttempts:  2,
		},
		{
			name: "respects cooldown",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent__",
				AutoRestart:            true,
				MaxRestartAttempts:     5,
				RestartCooldownSeconds: 60,
			},
			initialState: &watchState{
				restartAttempts:    1,
				lastRestartAttempt: time.Now(), // just attempted — within cooldown
			},
			wantAttempted: false,
			wantAttempts:  1,
		},
		{
			name: "allows after cooldown",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent__",
				AutoRestart:            true,
				MaxRestartAttempts:     5,
				RestartCooldownSeconds: 1,
			},
			initialState: &watchState{
				restartAttempts:    1,
				lastRestartAttempt: time.Now().Add(-2 * time.Second), // well past cooldown
			},
			wantAttempted: true,
			wantAttempts:  2,
		},
		{
			name: "increments attempts",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent__",
				AutoRestart:            true,
				MaxRestartAttempts:     10,
				RestartCooldownSeconds: 0,
			},
			initialState:  &watchState{restartAttempts: 0},
			wantAttempted: true,
			wantAttempts:  1,
		},
		{
			name: "sets AutoRestartSucceeded false on error",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_nonexistent_for_restart__",
				AutoRestart:            true,
				MaxRestartAttempts:     5,
				RestartCooldownSeconds: 0,
			},
			initialState:    &watchState{},
			wantAttempted:   true,
			wantSucceeded:   false,
			wantAttempts:    1,
			wantAutoRestSuc: boolPtr(false),
		},
		{
			name: "creates state if missing",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_newwatch__",
				AutoRestart:            true,
				MaxRestartAttempts:     5,
				RestartCooldownSeconds: 0,
			},
			initialState: nil, // don't pre-create
			wantAttempted: true,
			wantAttempts:  1,
		},
		{
			name: "zero max attempts never restarts",
			watchConfig: WatchConfig{
				WatchType:              WatchTypeProcess,
				Name:                   "__breeze_test_zero_max__",
				AutoRestart:            true,
				MaxRestartAttempts:     0, // zero means never restart
				RestartCooldownSeconds: 0,
			},
			initialState:  &watchState{},
			wantAttempted: false,
			wantAttempts:  0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := New(func(results []CheckResult) {})

			key := tt.watchConfig.WatchType + ":" + tt.watchConfig.Name
			if tt.initialState != nil {
				m.states[key] = tt.initialState
			}

			result := CheckResult{Status: StatusNotFound}
			attempted, succeeded := m.maybeAutoRestart(tt.watchConfig, &result)

			if attempted != tt.wantAttempted {
				t.Errorf("attempted = %v, want %v", attempted, tt.wantAttempted)
			}

			if tt.wantAttempted && succeeded != tt.wantSucceeded {
				t.Errorf("succeeded = %v, want %v", succeeded, tt.wantSucceeded)
			}

			m.mu.RLock()
			state, ok := m.states[key]
			m.mu.RUnlock()

			if tt.wantAttempted || tt.initialState != nil {
				if !ok {
					t.Fatal("state should exist")
				}
				if state.restartAttempts != tt.wantAttempts {
					t.Errorf("restartAttempts = %d, want %d", state.restartAttempts, tt.wantAttempts)
				}
			}

			if tt.wantAutoRestSuc != nil {
				if result.AutoRestartSucceeded == nil {
					t.Fatal("AutoRestartSucceeded should not be nil")
				}
				if *result.AutoRestartSucceeded != *tt.wantAutoRestSuc {
					t.Errorf("AutoRestartSucceeded = %v, want %v", *result.AutoRestartSucceeded, *tt.wantAutoRestSuc)
				}
			}
		})
	}
}

func boolPtr(b bool) *bool { return &b }
