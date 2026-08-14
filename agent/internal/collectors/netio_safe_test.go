package collectors

import (
	"errors"
	"testing"
)

// safeNetIOCounters must not panic on any supported platform. On a healthy host
// it returns stats; on a host whose netstat output trips the gopsutil darwin
// parser (issue #3459) it must return an error rather than crashing the caller.
func TestSafeNetIOCountersNeverPanics(t *testing.T) {
	for _, pernic := range []bool{false, true} {
		stats, err := safeNetIOCounters(pernic)
		if err != nil {
			// An error is an acceptable outcome (no netstat, parse failure, or a
			// recovered panic) — the contract is only that we got here at all.
			var panicErr *PanicError
			if errors.As(err, &panicErr) {
				t.Logf("pernic=%v recovered a gopsutil panic as expected: %v", pernic, err)
			}
			continue
		}
		if stats == nil {
			t.Fatalf("pernic=%v: nil stats with nil error", pernic)
		}
	}
}

// MetricsCollector.Collect must survive a network-stats failure — the rest of
// the sample (CPU, RAM, disk) is what keeps heartbeats useful.
func TestMetricsCollectSurvivesNetworkFailure(t *testing.T) {
	c := NewMetricsCollector()
	metrics, err := Guard("metrics", c.Collect)
	if err != nil {
		t.Fatalf("Collect returned an error: %v", err)
	}
	if metrics == nil {
		t.Fatal("Collect returned nil metrics")
	}
}

func TestLogNetIOPanicIgnoresOrdinaryErrors(t *testing.T) {
	// Must not panic or mis-handle a plain error; there is nothing to assert on
	// the log output, only that a non-PanicError is a no-op.
	logNetIOPanic(false, errors.New("netstat: executable file not found in $PATH"))
	logNetIOPanic(true, nil)
}
