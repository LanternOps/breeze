package monitoring

import (
	"os"
	"testing"
	"time"
)

// TestMain turns the first-run jitter off for the legacy lifecycle tests, which
// build a Monitor with New() (the production constructor, jitter on) and expect
// the immediate check to be immediate. Tests of the jitter itself opt back in
// through jitteredMonitor.
func TestMain(m *testing.M) {
	defaultFirstRunJitter = false
	os.Exit(m.Run())
}

const hangGuard = 5 * time.Second

// jitteredMonitor builds a Monitor with the first-run jitter on, a fixed random
// draw, and an injected wait that records its duration and is released by
// closing (or never releasing) the returned channel. No real time passes.
func jitteredMonitor(t *testing.T, draw float64) (m *Monitor, waits chan time.Duration, release chan time.Time, results chan []CheckResult, exited chan struct{}) {
	t.Helper()
	results = make(chan []CheckResult, 16)
	waits = make(chan time.Duration, 16)
	release = make(chan time.Time)
	exited = make(chan struct{}, 16)

	m = New(func(r []CheckResult) { results <- r })
	m.firstRunJitter = true
	m.rnd = func() float64 { return draw }
	m.after = func(d time.Duration) <-chan time.Time {
		waits <- d
		return release
	}
	m.loopExited = func() { exited <- struct{}{} }
	t.Cleanup(m.Stop)
	return m, waits, release, results, exited
}

func jitterCfg(interval int) MonitorConfig {
	return MonitorConfig{
		CheckIntervalSeconds: interval,
		Watches: []WatchConfig{
			{WatchType: WatchTypeProcess, Name: "__breeze_test_nonexistent__"},
		},
	}
}

func recvWait(t *testing.T, waits <-chan time.Duration) time.Duration {
	t.Helper()
	select {
	case d := <-waits:
		return d
	case <-time.After(hangGuard):
		t.Fatal("first-run wait was never registered")
		return 0
	}
}

func recvResults(t *testing.T, results <-chan []CheckResult, what string) {
	t.Helper()
	select {
	case <-results:
	case <-time.After(hangGuard):
		t.Fatalf("no check ran: %s", what)
	}
}

func TestMonitorFirstRunJitteredOnce(t *testing.T) {
	m, waits, release, results, _ := jitteredMonitor(t, 0.5)

	m.ApplyConfig(jitterCfg(30))

	if got := recvWait(t, waits); got != 15*time.Second {
		t.Fatalf("first-run wait = %v, want 15s (0.5 * interval 30s)", got)
	}
	select {
	case <-results:
		t.Fatal("a check ran before the first-run wait fired")
	default:
	}

	close(release)
	recvResults(t, results, "after the first-run wait fired")

	// A config refresh (Stop + Start on the same Monitor) must not draw again.
	m.Stop()
	m.Start()
	recvResults(t, results, "restart must run its immediate check at once")
	select {
	case d := <-waits:
		t.Fatalf("restart registered a new first-run wait of %v", d)
	default:
	}
}

func TestMonitorFirstRunJitterCappedAtSixtySeconds(t *testing.T) {
	m, waits, _, _, _ := jitteredMonitor(t, 0.5)

	m.ApplyConfig(jitterCfg(600))

	if got := recvWait(t, waits); got != 30*time.Second {
		t.Fatalf("first-run wait = %v, want 30s (0.5 * min(600s, 60s))", got)
	}
}

func TestMonitorStopDuringFirstRunDelay(t *testing.T) {
	m, waits, _, results, exited := jitteredMonitor(t, 0.9)

	m.ApplyConfig(jitterCfg(30))
	recvWait(t, waits) // the loop is now parked in the wait; release is never closed

	m.Stop()

	select {
	case <-exited:
	case <-time.After(hangGuard):
		t.Fatal("loop did not exit when Stop cancelled the first-run wait")
	}
	select {
	case <-results:
		t.Fatal("a check ran after Stop cancelled the first-run wait")
	default:
	}
}

func TestMonitorFirstRunJitterOffByDefaultInTests(t *testing.T) {
	// The legacy lifecycle tests depend on New() producing no wait once
	// TestMain has disabled the default; guard that contract.
	m := New(nil)
	if m.firstRunJitter {
		t.Fatal("New() must honour defaultFirstRunJitter (disabled by TestMain)")
	}
}

func TestNewEnablesFirstRunJitterInProduction(t *testing.T) {
	prev := defaultFirstRunJitter
	defaultFirstRunJitter = true
	t.Cleanup(func() { defaultFirstRunJitter = prev })

	m := New(nil)
	if !m.firstRunJitter {
		t.Fatal("production New() must enable the first-run jitter")
	}
	if m.rnd == nil || m.after == nil {
		t.Fatal("production New() must wire a random source and a timer")
	}
}
