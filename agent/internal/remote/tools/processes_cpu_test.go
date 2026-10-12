package tools

import (
	"os"
	"runtime"
	"sync"
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

// A process burning CPU during the window must read the CPU it actually burned
// in that window, scaled correctly (100% == one core). That a past burst does
// not leak into the reading is pinned separately by
// TestSampleProcessCPUPercents_PastBurstDoesNotInflateCurrent.
//
// The assertion is relative to ground truth, not an absolute percentage. How
// much CPU the burners get is up to the scheduler: on a loaded CI runner under
// -race the process can get as little as a few percent of one core (#8361 saw
// 12.9% against a 25% floor). An absolute floor tests scheduler fairness, not
// the sampler. Instead we bracket the sampler call with our own CPU-time reads
// and require the sampler's figure to agree with what the process really
// consumed. A sampler that always reports 0 still fails: the bracket proves CPU
// was burned, so pct must be > 0 and within a factor of the bracket's rate.
func TestSampleProcessCPUPercents_BusyProcessReadsHigh(t *testing.T) {
	self, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatalf("NewProcess: %v", err)
	}

	var stop atomic.Bool
	// Two burners, even on one core: the sampler goroutine is preempted, not
	// starved, and the process is still busy.
	var started, exited sync.WaitGroup
	// Join the burners on exit so they cannot spin into a later test's window.
	defer func() {
		stop.Store(true)
		exited.Wait()
	}()
	for i := 0; i < 2; i++ {
		started.Add(1)
		exited.Add(1)
		go func() {
			defer exited.Done()
			started.Done()
			x := 0
			for !stop.Load() {
				x++ // busy loop
				_ = x
			}
		}()
	}
	started.Wait()

	readCPUSeconds := func() float64 {
		t.Helper()
		ts, err := self.Times()
		if err != nil {
			t.Fatalf("Times: %v", err)
		}
		return cpuSeconds(ts)
	}

	// Below this much bracketed CPU time the comparison is dominated by
	// counter granularity (Linux /proc ticks are 10ms), so widen the window
	// and try again rather than compare noise. At 20ms (two ticks) a one-tick
	// disagreement between the bracket and the sampler is a 2x swing, which the
	// 4x bound below absorbs; tighten the bound only if you raise this floor.
	const minBracketCPUSeconds = 0.020

	var pct, groundPct, bracketCPU float64
	for _, window := range []time.Duration{300 * time.Millisecond, 600 * time.Millisecond, 1200 * time.Millisecond} {
		s0, t0 := readCPUSeconds(), time.Now()
		pct = sampleProcessCPUPercents([]*process.Process{self}, window)[self.Pid]
		s1, elapsed := readCPUSeconds(), time.Since(t0)

		bracketCPU = s1 - s0
		groundPct = cpuPercentFromCPUSeconds(s0, s1, elapsed)
		if bracketCPU >= minBracketCPUSeconds {
			break
		}
	}

	if bracketCPU < minBracketCPUSeconds {
		// The scheduler gave the process almost nothing (<2% of a core even
		// over 1.2s). That says nothing about the sampler, and failing here
		// would bring back the #8361 flake. Skip loudly instead. Whenever the
		// process does get CPU, the checks below run.
		t.Skipf("environment starved: two busy burners consumed only %.1fms CPU over a 1.2s window; "+
			"cannot validate the sampler (sampler read %.1f%%)", bracketCPU*1000, pct)
	}
	if pct <= 0 {
		t.Fatalf("busy process reported %.1f%% CPU, but it burned %.1fms CPU (%.1f%%) during the sample",
			pct, bracketCPU*1000, groundPct)
	}
	// The sampler's window sits inside the bracket, so its reading should be
	// close to the bracket's rate. The factor-of-4 bounds absorb scheduling
	// jitter between the two sets of reads without letting a sampler that is
	// off by an order of magnitude through.
	if pct < groundPct/4 || pct > groundPct*4 {
		t.Fatalf("sampler read %.1f%% CPU but the process actually used %.1f%% over the bracketing window",
			pct, groundPct)
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
