package collectors

import (
	"errors"
	"testing"

	"github.com/shirou/gopsutil/v3/net"
)

func swapNetIOCounters(t *testing.T, fn func(bool) ([]net.IOCountersStat, error)) {
	t.Helper()
	orig := netIOCounters
	netIOCounters = fn
	t.Cleanup(func() { netIOCounters = orig })
}

// The core regression for #3459: a panic inside gopsutil must come back as an
// error, not unwind the caller.
func TestSafeNetIOCountersConvertsPanicToError(t *testing.T) {
	swapNetIOCounters(t, func(bool) ([]net.IOCountersStat, error) {
		// The exact shape of the gopsutil darwin bug: parseNetstatLine reads
		// columns[2] of a line that only has one field.
		columns := []string{"lo0"}
		_ = columns[2]
		return nil, nil
	})

	stats, err := safeNetIOCounters(false)
	if err == nil {
		t.Fatal("expected an error, got nil — the panic was not converted")
	}
	if stats != nil {
		t.Fatalf("expected nil stats on panic, got %v", stats)
	}
	var panicErr *PanicError
	if !errors.As(err, &panicErr) {
		t.Fatalf("expected *PanicError, got %T", err)
	}
	if panicErr.Op != "net.IOCounters" {
		t.Fatalf("Op = %q, want %q", panicErr.Op, "net.IOCounters")
	}
	if !errors.As(err, &panicErr) || panicErr.Stack == "" {
		t.Fatal("expected a captured stack")
	}
}

func TestSafeNetIOCountersPassesThrough(t *testing.T) {
	want := []net.IOCountersStat{{Name: "en0", BytesRecv: 100, BytesSent: 200}}
	swapNetIOCounters(t, func(bool) ([]net.IOCountersStat, error) { return want, nil })

	got, err := safeNetIOCounters(false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].BytesRecv != 100 {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSafeNetIOCountersPassesThroughOrdinaryError(t *testing.T) {
	sentinel := errors.New("netstat: executable file not found in $PATH")
	swapNetIOCounters(t, func(bool) ([]net.IOCountersStat, error) { return nil, sentinel })

	if _, err := safeNetIOCounters(true); !errors.Is(err, sentinel) {
		t.Fatalf("got %v, want %v", err, sentinel)
	}
}

// MetricsCollector.Collect must still produce a usable sample when the network
// source is crashing — CPU/RAM/disk are what keep heartbeats meaningful.
func TestMetricsCollectSurvivesNetworkPanic(t *testing.T) {
	swapNetIOCounters(t, func(bool) ([]net.IOCountersStat, error) {
		panic("index out of range [2] with length 1")
	})

	c := NewMetricsCollector()
	metrics, err := Guard("metrics", c.Collect)
	if err != nil {
		t.Fatalf("Collect must not fail because the network source panicked: %v", err)
	}
	if metrics == nil {
		t.Fatal("Collect returned nil metrics")
	}
	if metrics.NetworkInBytes != 0 || metrics.BandwidthInBps != 0 {
		t.Fatalf("expected no network figures when the source panicked, got in=%d bps=%d",
			metrics.NetworkInBytes, metrics.BandwidthInBps)
	}
	if len(metrics.InterfaceStats) != 0 {
		t.Fatalf("expected no interface stats, got %d", len(metrics.InterfaceStats))
	}
}

// A missed sample must not turn into a fabricated bandwidth spike on the next
// successful cycle: lastTime advances every cycle, so a stale byte baseline
// would divide a multi-interval delta by a single interval.
func TestMetricsDropsNetworkBaselineAfterFailedSample(t *testing.T) {
	c := NewMetricsCollector()

	// Cycle 1: healthy, seeds the baseline.
	swapNetIOCounters(t, func(bool) ([]net.IOCountersStat, error) {
		return []net.IOCountersStat{{Name: "en0", BytesRecv: 1_000, BytesSent: 1_000}}, nil
	})
	if _, err := c.Collect(); err != nil {
		t.Fatalf("cycle 1: %v", err)
	}
	if c.lastNetIn != 1_000 {
		t.Fatalf("cycle 1 should have seeded the baseline, got %d", c.lastNetIn)
	}

	// Cycle 2: the source panics. The baseline must be dropped, not kept.
	netIOCounters = func(bool) ([]net.IOCountersStat, error) {
		panic("index out of range [2] with length 1")
	}
	if _, err := c.Collect(); err != nil {
		t.Fatalf("cycle 2: %v", err)
	}
	if c.lastNetIn != 0 || c.lastNetOut != 0 {
		t.Fatalf("baseline must be dropped after a failed sample, got in=%d out=%d",
			c.lastNetIn, c.lastNetOut)
	}
	if len(c.lastIface) != 0 {
		t.Fatalf("per-interface baseline must be cleared, got %d entries", len(c.lastIface))
	}

	// Cycle 3: healthy again, with a counter far ahead of the cycle-1 value.
	// Because the baseline was dropped, this cycle reports no throughput
	// rather than attributing two intervals of traffic to one.
	netIOCounters = func(bool) ([]net.IOCountersStat, error) {
		return []net.IOCountersStat{{Name: "en0", BytesRecv: 9_000_000, BytesSent: 9_000_000}}, nil
	}
	metrics, err := c.Collect()
	if err != nil {
		t.Fatalf("cycle 3: %v", err)
	}
	if metrics.NetworkInBytes != 0 || metrics.BandwidthInBps != 0 {
		t.Fatalf("recovery cycle fabricated throughput: in=%d bps=%d",
			metrics.NetworkInBytes, metrics.BandwidthInBps)
	}
	if c.lastNetIn != 9_000_000 {
		t.Fatalf("recovery cycle should re-seed the baseline, got %d", c.lastNetIn)
	}
}
