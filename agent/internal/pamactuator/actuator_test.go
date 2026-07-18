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

// TestDismissUnsupportedOnNonWindows guards the deny-path stub: on
// non-Windows hosts Dismiss must report "unsupported_platform" so the
// Track 6 deny flow can record the outcome rather than block.
func TestDismissUnsupportedOnNonWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	res := New().Dismiss(context.Background())
	if res.Success {
		t.Fatal("Dismiss should not succeed on non-windows")
	}
	if res.Reason != "unsupported_platform" {
		t.Fatalf("reason = %q, want unsupported_platform", res.Reason)
	}
}

func TestDismissCancellationResult(t *testing.T) {
	if result, ok := dismissCancellationResult(context.Background()); ok {
		t.Fatalf("live context returned cancellation result: %+v", result)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, ok := dismissCancellationResult(ctx)
	if !ok {
		t.Fatal("cancelled context did not return cancellation result")
	}
	if result.Success {
		t.Fatal("cancelled dismissal should not succeed")
	}
	if result.Reason != "dismiss_cancelled" {
		t.Fatalf("reason = %q, want dismiss_cancelled", result.Reason)
	}
	if result.DetailMessage == "" {
		t.Fatal("cancelled dismissal should include detail")
	}

	result, ok = dismissPostInputCancellationResult(ctx)
	if !ok {
		t.Fatal("post-input cancellation did not return a cancellation result")
	}
	if result.Reason != "dismiss_cancelled" {
		t.Fatalf("post-input reason = %q, want dismiss_cancelled", result.Reason)
	}
	if result.DetailMessage != "PAM consent dismissal cancelled after Escape while waiting for consent.exe to close: context canceled" {
		t.Fatalf("post-input detail = %q", result.DetailMessage)
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

func TestNewWithStrategyReturnsNonNil(t *testing.T) {
	for _, s := range []Strategy{StrategySendInput, StrategyTokenLaunch, "bogus"} {
		if got := NewWithStrategy(s); got == nil {
			t.Fatalf("NewWithStrategy(%q) = nil", s)
		}
	}
}

func TestRequestCarriesTarget(t *testing.T) {
	r := Request{TargetPath: `C:\Windows\System32\mmc.exe`, CommandLine: `mmc.exe devmgmt.msc`}
	if r.TargetPath == "" || r.CommandLine == "" {
		t.Fatal("Request target fields not set")
	}
}
