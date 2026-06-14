package tools

import (
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// cpuPercentFromCPUSeconds is the pure core of the instantaneous-CPU
// calculation. 100% == one full core (Activity Monitor / top convention),
// so a process pinning two cores reads 200%.
func TestCPUPercentFromCPUSeconds(t *testing.T) {
	cases := []struct {
		name      string
		prevTotal float64
		curTotal  float64
		elapsed   time.Duration
		want      float64
	}{
		{"idle: no cpu consumed", 10, 10, time.Second, 0},
		{"one core fully busy for 1s", 5, 6, time.Second, 100},
		{"half a core", 5, 5.5, time.Second, 50},
		{"two cores over a 250ms window", 1, 1.5, 250 * time.Millisecond, 200},
		{"zero elapsed is not a divide-by-zero", 1, 2, 0, 0},
		{"negative elapsed clamps to zero", 1, 2, -time.Second, 0},
		{"counter reset (proc replaced) clamps to zero", 100, 1, time.Second, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cpuPercentFromCPUSeconds(tc.prevTotal, tc.curTotal, tc.elapsed)
			if got != tc.want {
				t.Fatalf("cpuPercentFromCPUSeconds(%v, %v, %v) = %v, want %v",
					tc.prevTotal, tc.curTotal, tc.elapsed, got, tc.want)
			}
		})
	}
}

// A process that did heavy work in the past but is idle during the sample
// window must read ~0 — this is the bug we are fixing (gopsutil's
// Process.CPUPercent reports a lifetime average that stays high after a burst).
// We approximate "idle now" by sampling a process that is not spinning.
func TestSampleProcessCPUPercents_IdleProcessReadsLow(t *testing.T) {
	self, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatalf("NewProcess: %v", err)
	}

	// No CPU burned during the window -> should be near zero, definitely not
	// pinned. We assert a generous ceiling to stay non-flaky on busy CI.
	got := sampleProcessCPUPercents([]*process.Process{self}, 200*time.Millisecond)
	pct, ok := got[self.Pid]
	if !ok {
		t.Fatalf("no sample returned for self pid %d", self.Pid)
	}
	if pct > 50 {
		t.Fatalf("idle process reported %.1f%% CPU, expected near-idle", pct)
	}
}

// A process burning a full core during the window must read meaningfully
// above zero, proving the sampler reflects *current* usage.
func TestSampleProcessCPUPercents_BusyProcessReadsHigh(t *testing.T) {
	self, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatalf("NewProcess: %v", err)
	}

	var stop atomic.Bool
	var burners int
	// Pin a couple of cores so the reading clears any noise floor.
	for i := 0; i < 2 && i < runtime.NumCPU(); i++ {
		burners++
		go func() {
			x := 0
			for !stop.Load() {
				x++ // busy loop
				_ = x
			}
		}()
	}
	defer stop.Store(true)
	if burners == 0 {
		t.Skip("single-core environment; cannot create a busy burner")
	}

	got := sampleProcessCPUPercents([]*process.Process{self}, 300*time.Millisecond)
	pct := got[self.Pid]
	if pct < 25 {
		t.Fatalf("busy process reported only %.1f%% CPU, expected clearly active", pct)
	}
}

// This is the regression test for the actual bug: CPU that was burned in the
// PAST must not inflate the CURRENT reading. The old gopsutil CPUPercent()
// (lifetime average) would stay high here because the burst raised the lifetime
// total; the interval sampler must read low because the burst ended before the
// sample window opened.
func TestSampleProcessCPUPercents_PastBurstDoesNotInflateCurrent(t *testing.T) {
	if runtime.NumCPU() < 2 {
		t.Skip("single-core environment; cannot burn then idle deterministically")
	}
	self, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatalf("NewProcess: %v", err)
	}

	// Burn a couple of cores for a while to push up the lifetime CPU total.
	var stop atomic.Bool
	for i := 0; i < 2; i++ {
		go func() {
			x := 0
			for !stop.Load() {
				x++
				_ = x
			}
		}()
	}
	time.Sleep(600 * time.Millisecond)
	stop.Store(true)
	time.Sleep(50 * time.Millisecond) // let the burners actually wind down

	// Sample AFTER the burst is over. Instantaneous usage should be low even
	// though the process has a high lifetime CPU total.
	got := sampleProcessCPUPercents([]*process.Process{self}, 250*time.Millisecond)
	if pct := got[self.Pid]; pct > 50 {
		t.Fatalf("post-burst idle process reported %.1f%% CPU; interval sampler must "+
			"reflect current usage, not the earlier burst", pct)
	}
}

// A process that cannot be read (gone / invalid PID) is absent from the result
// map, and callers fall back to the 0.0 zero value rather than crashing. This
// pins the graceful-degradation contract that getProcessInfo / collectProcessEvidence
// rely on (cpuPercents[pid]).
func TestSampleProcessCPUPercents_UnreadableProcessDefaultsToZero(t *testing.T) {
	// A PID that does not exist: both Times() reads fail, so it never enters
	// the map.
	ghost := &process.Process{Pid: 0x7fffffff}

	got := sampleProcessCPUPercents([]*process.Process{ghost}, 50*time.Millisecond)
	if _, present := got[ghost.Pid]; present {
		t.Fatalf("unreadable process should be absent from the result map, got entry %v", got[ghost.Pid])
	}
	// Caller access pattern: map miss yields 0.0, not a panic.
	if pct := got[ghost.Pid]; pct != 0 {
		t.Fatalf("absent pid lookup = %v, want 0", pct)
	}
}
