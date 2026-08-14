package collectors

import (
	"errors"
	"strings"
	"testing"
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

func TestPanicErrorMessage(t *testing.T) {
	err := &PanicError{Op: "net.IOCounters", Value: "index out of range [2] with length 1"}
	want := "panic in net.IOCounters: index out of range [2] with length 1"
	if err.Error() != want {
		t.Fatalf("Error() = %q, want %q", err.Error(), want)
	}
}
