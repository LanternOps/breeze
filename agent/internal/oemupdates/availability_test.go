package oemupdates

import (
	"bytes"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return &buf
}

func TestAbsentToolDetectsOncePerTTL(t *testing.T) {
	var calls atomic.Int64
	gate := NewToolGate("dcu", func() ToolState {
		calls.Add(1)
		return ToolState{}
	})
	for i := 0; i < 100; i++ {
		if gate.Get().Present {
			t.Fatal("an absent tool reported present")
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("detect ran %d times, want 1: a negative answer is cached too", got)
	}
}

func TestConcurrentGetsShareOneDetect(t *testing.T) {
	var calls atomic.Int64
	gate := NewToolGate("dcu", func() ToolState {
		calls.Add(1)
		time.Sleep(10 * time.Millisecond)
		return ToolState{Present: true, Path: `C:\tool.exe`}
	})
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !gate.Get().Present {
				t.Error("a waiter saw no answer")
			}
		}()
	}
	wg.Wait()
	if got := calls.Load(); got != 1 {
		t.Fatalf("detect ran %d times, want 1", got)
	}
}

func TestNoWarnWhenAbsent(t *testing.T) {
	logs := captureLogs(t)
	now := time.Unix(1_800_000_000, 0)
	gate := NewToolGate("dcu", func() ToolState { return ToolState{} })
	gate.now = func() time.Time { return now }

	for i := 0; i < 5; i++ {
		gate.Get()
		now = now.Add(toolAvailabilityTTL)
	}
	gate.Invalidate()
	gate.Get()

	output := logs.String()
	for _, level := range []string{"level=WARN", "level=ERROR"} {
		if strings.Contains(output, level) {
			t.Fatalf("a missing optional tool must stay quiet, found %s:\n%s", level, output)
		}
	}
}

func TestStateChangeLogsOnceAtDebug(t *testing.T) {
	logs := captureLogs(t)
	now := time.Unix(1_800_000_000, 0)
	state := ToolState{}
	gate := NewToolGate("dcu", func() ToolState { return state })
	gate.now = func() time.Time { return now }

	gate.Get() // the first answer is not a change
	if got := strings.Count(logs.String(), toolStateChangedLog); got != 0 {
		t.Fatalf("logged %d changes on the first answer:\n%s", got, logs.String())
	}

	state = ToolState{Present: true, Path: `C:\tool.exe`, Version: "5.7.2"}
	for i := 0; i < 3; i++ {
		now = now.Add(toolAvailabilityTTL)
		gate.Get()
	}
	output := logs.String()
	if got := strings.Count(output, toolStateChangedLog); got != 1 {
		t.Fatalf("logged %d changes, want 1:\n%s", got, output)
	}
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, toolStateChangedLog) && !strings.Contains(line, "level=DEBUG") {
			t.Fatalf("a state change should log at DEBUG: %s", line)
		}
	}

	// A new version is a change too: the runner decides on the version.
	state.Version = "5.8.0"
	now = now.Add(toolAvailabilityTTL)
	gate.Get()
	if got := strings.Count(logs.String(), toolStateChangedLog); got != 2 {
		t.Fatalf("a version change logged %d lines in total, want 2", got)
	}
}

func TestInvalidateForcesRedetect(t *testing.T) {
	var calls atomic.Int64
	gate := NewToolGate("dcu", func() ToolState {
		calls.Add(1)
		return ToolState{}
	})
	gate.Get()
	gate.Get()
	gate.Invalidate()
	gate.Get()
	gate.Get()
	if got := calls.Load(); got != 2 {
		t.Fatalf("detect ran %d times, want 2", got)
	}
}

func TestRedetectsAfterTTL(t *testing.T) {
	var calls atomic.Int64
	now := time.Unix(1_800_000_000, 0)
	gate := NewToolGate("dcu", func() ToolState {
		calls.Add(1)
		return ToolState{}
	})
	gate.now = func() time.Time { return now }

	gate.Get()
	now = now.Add(toolAvailabilityTTL - time.Second)
	gate.Get()
	if got := calls.Load(); got != 1 {
		t.Fatalf("detect ran %d times just inside the TTL, want 1", got)
	}
	now = now.Add(time.Second)
	gate.Get()
	if got := calls.Load(); got != 2 {
		t.Fatalf("detect ran %d times at the TTL, want 2", got)
	}
}

// An absent tool has no path or version, whatever detect returned with it.
func TestAnAbsentAnswerCarriesNoPath(t *testing.T) {
	gate := NewToolGate("dcu", func() ToolState {
		return ToolState{Present: false, Path: `C:\stale\dcu-cli.exe`, Version: "5.7.2"}
	})
	if got := gate.Get(); got.Path != "" || got.Version != "" {
		t.Fatalf("absent answer = %+v, want no path or version", got)
	}
}

// A clock wound back must not make one answer last for ever.
func TestAClockWoundBackRedetects(t *testing.T) {
	var calls atomic.Int64
	now := time.Unix(1_800_000_000, 0)
	gate := NewToolGate("dcu", func() ToolState { calls.Add(1); return ToolState{} })
	gate.now = func() time.Time { return now }
	gate.Get()
	now = now.Add(-time.Hour)
	gate.Get()
	if got := calls.Load(); got != 2 {
		t.Fatalf("detect ran %d times, want 2 after the clock went backwards", got)
	}
}

func TestANilDetectReportsAbsent(t *testing.T) {
	if NewToolGate("dcu", nil).Get().Present {
		t.Fatal("a gate with no detect reported a tool")
	}
}

// CheckedAt is the gate's to set, so a detect cannot make an answer look fresher
// or staler than it is.
func TestCheckedAtComesFromTheGate(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	gate := NewToolGate("dcu", func() ToolState {
		return ToolState{Present: true, CheckedAt: time.Unix(1, 0)}
	})
	gate.now = func() time.Time { return now }

	if got := gate.Get().CheckedAt; !got.Equal(now) {
		t.Fatalf("CheckedAt = %v, want %v", got, now)
	}
	// A cached answer keeps the time it was actually checked.
	later := now.Add(time.Hour)
	gate.now = func() time.Time { return later }
	if got := gate.Get().CheckedAt; !got.Equal(now) {
		t.Fatalf("cached CheckedAt = %v, want %v", got, now)
	}
}
