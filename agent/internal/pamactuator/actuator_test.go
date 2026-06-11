package pamactuator

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// TestNewReturnsConcreteActuator verifies the package exposes a working
// Actuator on every platform. On non-Windows this is the no-op stub; on
// Windows it's *windowsActuator.
func TestNewReturnsConcreteActuator(t *testing.T) {
	a := New()
	if a == nil {
		t.Fatalf("New returned nil Actuator")
	}
}

// TestNoopActuatorReturnsUnsupportedReason guards the !windows behavior:
// callers must be able to distinguish "we can't do this here" from any
// real failure. The reason string is part of the Track 6 server contract
// for failure handling — changing it would break the approval flow's
// retry/escalate switch.
//
// Only runs on non-Windows because newActuator returns the real
// windowsActuator on Windows.
func TestNoopActuatorReturnsUnsupportedReason(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	a := New()
	res := a.Trigger(context.Background(), Request{
		ElevationRequestID: "abc-123",
		Username:           "svc-admin",
		Password:           "irrelevant",
		TimeoutMs:          1000,
	})

	if res.Success {
		t.Fatalf("expected Success=false on non-Windows, got true")
	}
	if res.Reason != "unsupported_platform" {
		t.Fatalf("expected Reason=unsupported_platform, got %q", res.Reason)
	}
	if res.DetailMessage == "" {
		t.Fatalf("expected non-empty DetailMessage")
	}
}

// TestNoopActuatorIsNonBlocking confirms the stub doesn't honor TimeoutMs
// by sleeping — Track 6 must be able to fan a single approval out to many
// non-Windows agents without each one stalling for the full timeout.
func TestNoopActuatorIsNonBlocking(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	a := New()
	start := time.Now()
	a.Trigger(context.Background(), Request{TimeoutMs: 10000})
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("no-op Trigger blocked for %v, expected near-instant", elapsed)
	}
}

// TestRequestZeroValuesAreSafe sanity-checks that a zero-valued Request
// doesn't make the stub panic. The Windows impl applies a default 8000ms
// timeout when TimeoutMs<=0; the stub doesn't need to but must not crash.
func TestRequestZeroValuesAreSafe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Trigger panicked on zero Request: %v", r)
		}
	}()

	a := New()
	res := a.Trigger(context.Background(), Request{})
	if res.Success {
		t.Fatalf("zero Request should not succeed on no-op stub")
	}
}
