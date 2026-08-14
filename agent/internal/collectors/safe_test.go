package collectors

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestGuardPassesThroughSuccess(t *testing.T) {
	got, err := Guard("ok", func() (int, error) { return 42, nil })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 42 {
		t.Fatalf("got %d, want 42", got)
	}
}

func TestGuardPassesThroughError(t *testing.T) {
	sentinel := errors.New("collector failed")
	got, err := Guard("failing", func() (*SystemMetrics, error) { return nil, sentinel })
	if !errors.Is(err, sentinel) {
		t.Fatalf("got err %v, want %v", err, sentinel)
	}
	if got != nil {
		t.Fatalf("got %v, want nil result", got)
	}
	var panicErr *PanicError
	if errors.As(err, &panicErr) {
		t.Fatal("ordinary error must not be reported as a PanicError")
	}
}

func TestGuardRecoversPanicAsError(t *testing.T) {
	tests := []struct {
		name      string
		panicWith any
		wantMsg   string
	}{
		{"runtime error", nil, "index out of range"},
		{"string panic", "boom", "panic in metrics: boom"},
		{"error panic", errors.New("kaboom"), "panic in metrics: kaboom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Guard("metrics", func() (*SystemMetrics, error) {
				if tt.panicWith == nil {
					// Reproduce the shape of the gopsutil darwin netstat bug:
					// indexing a short slice (issue #3459).
					columns := []string{"only-one-field"}
					_ = columns[2]
					return nil, nil
				}
				panic(tt.panicWith)
			})

			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if got != nil {
				t.Fatalf("expected nil result on panic, got %v", got)
			}
			var panicErr *PanicError
			if !errors.As(err, &panicErr) {
				t.Fatalf("expected *PanicError, got %T", err)
			}
			if panicErr.Op != "metrics" {
				t.Fatalf("Op = %q, want %q", panicErr.Op, "metrics")
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("error %q does not contain %q", err.Error(), tt.wantMsg)
			}
			if !strings.Contains(panicErr.Stack, "collectors.") {
				t.Fatalf("stack does not look like a real stack: %q", panicErr.Stack)
			}
		})
	}
}

// The whole point of the guard is that the caller's goroutine survives, so
// assert the panic really does not propagate past Guard.
func TestGuardDoesNotPropagatePanicToCaller(t *testing.T) {
	done := make(chan error, 1)
	go func() {
		_, err := Guard("goroutine", func() (int, error) { panic("collector exploded") })
		done <- err
	}()
	if err := <-done; err == nil {
		t.Fatal("goroutine should have received an error instead of dying")
	}
}

// Sentry reporting is throttled per (op, panic value) so a collector that
// panics on every cycle doesn't flood, while a DIFFERENT panic still reports
// immediately.
func TestShouldReportPanicThrottlesPerOpAndValue(t *testing.T) {
	resetPanicReportState()

	base := time.Now()
	val := "index out of range [2] with length 1"

	if !shouldReportPanic("metrics", val, base) {
		t.Fatal("first occurrence must report")
	}
	if shouldReportPanic("metrics", val, base.Add(time.Minute)) {
		t.Fatal("a repeat inside the interval must be throttled")
	}
	if !shouldReportPanic("metrics", val, base.Add(panicReportInterval+time.Second)) {
		t.Fatal("a repeat after the interval must report again")
	}
	// A different panic value on the same op is a different bug.
	if !shouldReportPanic("metrics", "nil pointer dereference", base.Add(time.Minute)) {
		t.Fatal("a different panic value must report immediately")
	}
	// A different op with the same value is a different site.
	if !shouldReportPanic("software", val, base.Add(time.Minute)) {
		t.Fatal("a different op must report immediately")
	}
}

// Go runtime panics embed varying operands. If those reached the throttle key
// verbatim, the same recurring bug would report on every cycle — the flood the
// throttle exists to prevent — and grow the map without bound.
func TestShouldReportPanicThrottlesAcrossVaryingOperands(t *testing.T) {
	resetPanicReportState()

	base := time.Now()
	if !shouldReportPanic("metrics", "index out of range [2] with length 1", base) {
		t.Fatal("first occurrence must report")
	}
	if shouldReportPanic("metrics", "index out of range [17] with length 12", base.Add(time.Minute)) {
		t.Fatal("same bug with different operands must be throttled, not re-reported")
	}
}

func TestShouldReportPanicBoundsMapGrowth(t *testing.T) {
	resetPanicReportState()

	now := time.Now()
	for i := 0; i < panicReportMaxKeys*3; i++ {
		// Alphabetic-only distinct ops: digit-normalisation must not be what
		// keeps this map small, or the test would pass with no bound at all.
		shouldReportPanic(alphaOpName(i), "boom", now)
	}

	panicReportMu.Lock()
	size := len(panicReportSeen)
	panicReportMu.Unlock()

	if size > panicReportMaxKeys {
		t.Fatalf("throttle map grew to %d entries, want <= %d", size, panicReportMaxKeys)
	}
}

// alphaOpName renders i in base-26 using letters only.
func alphaOpName(i int) string {
	name := ""
	for {
		name = string(rune('a'+i%26)) + name
		i /= 26
		if i == 0 {
			return "op" + name
		}
	}
}

func resetPanicReportState() {
	panicReportMu.Lock()
	panicReportSeen = map[string]time.Time{}
	panicReportMu.Unlock()
}

func TestPanicErrorMessage(t *testing.T) {
	err := &PanicError{Op: "net.IOCounters", Value: "index out of range [2] with length 1"}
	want := "panic in net.IOCounters: index out of range [2] with length 1"
	if err.Error() != want {
		t.Fatalf("Error() = %q, want %q", err.Error(), want)
	}
}
