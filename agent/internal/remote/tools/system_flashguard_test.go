package tools

import (
	"errors"
	"os/exec"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

// recordShutdowns replaces the OS invocation for the test and records each argv.
func recordShutdowns(t *testing.T, run func() error) func() [][]string {
	t.Helper()
	var mu sync.Mutex
	var calls [][]string
	original := runShutdownCommand
	runShutdownCommand = func(cmd *exec.Cmd) error {
		mu.Lock()
		calls = append(calls, cmd.Args)
		mu.Unlock()
		if run != nil {
			return run()
		}
		return nil
	}
	t.Cleanup(func() { runShutdownCommand = original })
	return func() [][]string {
		mu.Lock()
		defer mu.Unlock()
		return append([][]string(nil), calls...)
	}
}

func useTestGuard(t *testing.T, opts ...flashguard.Option) *flashguard.Guard {
	t.Helper()
	opts = append([]flashguard.Option{flashguard.WithLockWait(50 * time.Millisecond)}, opts...)
	g := flashguard.New(t.TempDir(), opts...)
	t.Cleanup(flashguard.SetDefault(g))
	return g
}

func wantArgv(t *testing.T, isReboot, force bool, delay int) []string {
	t.Helper()
	name, args, err := shutdownArgv(runtime.GOOS, isReboot, force, delay)
	if err != nil {
		t.Fatalf("shutdownArgv: %v", err)
	}
	return append([]string{name}, args...)
}

func TestPowerCommandsWithNoSectionAreUnchanged(t *testing.T) {
	tests := []struct {
		name string
		run  func() CommandResult
		want func(t *testing.T) []string
	}{
		{"reboot", func() CommandResult { return Reboot(map[string]any{"delay": 5}) },
			func(t *testing.T) []string { return wantArgv(t, true, false, 5) }},
		{"shutdown", func() CommandResult { return Shutdown(map[string]any{"delay": 5}) },
			func(t *testing.T) []string { return wantArgv(t, false, false, 5) }},
		{"force reboot", func() CommandResult { return ForceReboot(nil) },
			func(t *testing.T) []string { return wantArgv(t, true, true, 0) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			useTestGuard(t)
			calls := recordShutdowns(t, nil)
			result := tt.run()
			if result.Status != "completed" {
				t.Fatalf("result = %+v", result)
			}
			got := calls()
			if len(got) != 1 || !reflect.DeepEqual(got[0], tt.want(t)) {
				t.Fatalf("argv = %v, want one call of %v", got, tt.want(t))
			}
		})
	}
}

func TestRebootAndShutdownAreRefusedDuringASection(t *testing.T) {
	tests := []struct {
		name string
		run  func() CommandResult
	}{
		{"reboot", func() CommandResult { return Reboot(map[string]any{"delay": 5}) }},
		{"shutdown", func() CommandResult { return Shutdown(map[string]any{"delay": 5}) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := useTestGuard(t)
			if _, err := g.Enter("bios", "cmd-1", time.Hour); err != nil {
				t.Fatalf("Enter: %v", err)
			}
			calls := recordShutdowns(t, nil)
			result := tt.run()
			if result.Status != "failed" || !strings.Contains(result.Error, "firmware update") {
				t.Fatalf("result = %+v, want a failure naming the firmware update", result)
			}
			if got := calls(); len(got) != 0 {
				t.Fatalf("ran %v during a firmware section", got)
			}
		})
	}
}

func TestForceRebootWaitsForSection(t *testing.T) {
	g := useTestGuard(t, flashguard.WithWaitTiming(5*time.Millisecond, time.Minute))
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	calls := recordShutdowns(t, nil)

	results := make(chan CommandResult, 1)
	go func() { results <- ForceReboot(nil) }()

	select {
	case result := <-results:
		t.Fatalf("force reboot returned during the section: %+v", result)
	case <-time.After(50 * time.Millisecond):
	}
	if got := calls(); len(got) != 0 {
		t.Fatalf("force reboot ran %v during the section", got)
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	select {
	case result := <-results:
		if result.Status != "completed" {
			t.Fatalf("result = %+v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("force reboot did not proceed after the section ended")
	}
	if got := calls(); len(got) != 1 {
		t.Fatalf("calls = %v, want one", got)
	}
}

// The wait is bounded. Running out reports failure; it never reboots mid-flash.
func TestForceRebootGivesUpWithoutRebooting(t *testing.T) {
	g := useTestGuard(t, flashguard.WithWaitTiming(time.Millisecond, 20*time.Millisecond))
	if _, err := g.Enter("bios", "cmd-1", time.Hour); err != nil {
		t.Fatalf("Enter: %v", err)
	}
	calls := recordShutdowns(t, nil)

	result := ForceReboot(nil)
	if result.Status != "failed" || !strings.Contains(result.Error, "firmware update") {
		t.Fatalf("result = %+v", result)
	}
	if got := calls(); len(got) != 0 {
		t.Fatalf("ran %v", got)
	}
}

// Admission spans the invocation, and a delayed reboot's countdown outlives it.
func TestRebootKeepsAFlashOutThroughItsCountdown(t *testing.T) {
	g := useTestGuard(t)
	var duringInvocation error
	recordShutdowns(t, func() error {
		_, duringInvocation = g.Enter("bios", "cmd-1", time.Hour)
		return nil
	})

	if result := Reboot(map[string]any{"delay": 30}); result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	if !errors.Is(duringInvocation, flashguard.ErrPowerActionPending) {
		t.Fatalf("Enter during the invocation = %v, want ErrPowerActionPending", duringInvocation)
	}
	if _, err := g.Enter("bios", "cmd-1", time.Hour); !errors.Is(err, flashguard.ErrPowerActionPending) {
		t.Fatalf("Enter during the 30-minute countdown = %v, want ErrPowerActionPending", err)
	}
}

// restart_service aimed at the agent stops it, and with it whatever it is running.
func TestAgentRestartRefusedDuringSection(t *testing.T) {
	g := useTestGuard(t)
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter: %v", err)
	}
	spawned := 0
	original := spawnDelayedRestartFn
	spawnDelayedRestartFn = func() error { spawned++; return nil }
	t.Cleanup(func() { spawnDelayedRestartFn = original })

	result := RestartService(map[string]any{"name": agentServiceName})
	if result.Status != "failed" || !strings.Contains(result.Error, "firmware update") {
		t.Fatalf("result = %+v, want a failure naming the firmware update", result)
	}
	if spawned != 0 {
		t.Fatal("the restart helper was spawned during a firmware section")
	}

	if err := release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if result := RestartService(map[string]any{"name": agentServiceName}); result.Status != "completed" {
		t.Fatalf("agent restart with no section = %+v", result)
	}
	if spawned != 1 {
		t.Fatalf("spawned = %d, want 1", spawned)
	}
	// The helper restarts the agent from another process a few seconds from now,
	// so this process keeps its admission until it is stopped.
	if _, err := g.Enter("bios", "cmd-2", time.Hour); !errors.Is(err, flashguard.ErrPowerActionPending) {
		t.Fatalf("Enter after a scheduled agent restart = %v, want ErrPowerActionPending", err)
	}
}

func TestFailedAgentRestartReleasesItsAdmission(t *testing.T) {
	g := useTestGuard(t)
	original := spawnDelayedRestartFn
	spawnDelayedRestartFn = func() error { return errors.New("spawn blocked") }
	t.Cleanup(func() { spawnDelayedRestartFn = original })

	if result := RestartService(map[string]any{"name": agentServiceName}); result.Status != "failed" {
		t.Fatalf("result = %+v", result)
	}
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter after a failed agent restart: %v", err)
	}
	_ = release()
}

// A shutdown that failed armed nothing, so it must not refuse a later flash.
func TestFailedRebootLeavesNoCountdown(t *testing.T) {
	g := useTestGuard(t)
	recordShutdowns(t, func() error { return errors.New("shutdown refused") })

	if result := Reboot(map[string]any{"delay": 30}); result.Status != "failed" {
		t.Fatalf("result = %+v", result)
	}
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter after a failed reboot: %v", err)
	}
	_ = release()
}
