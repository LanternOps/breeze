package elevaccount

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestGeneratePasswordComplexityLengthAndUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		pw, err := GeneratePassword(32)
		if err != nil {
			t.Fatalf("GeneratePassword returned error: %v", err)
		}
		if len(pw) < 32 {
			t.Fatalf("password length = %d, want >=32", len(pw))
		}
		if seen[pw] {
			t.Fatalf("GeneratePassword produced duplicate password %q", pw)
		}
		seen[pw] = true
		assertPasswordComplexity(t, pw)
	}
}

func TestGeneratePasswordRaisesShortLengthToMinimum(t *testing.T) {
	pw, err := GeneratePassword(8)
	if err != nil {
		t.Fatalf("GeneratePassword returned error: %v", err)
	}
	if len(pw) < minPasswordLength {
		t.Fatalf("password length = %d, want >=%d", len(pw), minPasswordLength)
	}
}

func TestNoopManagerReturnsUnsupportedReason(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	mgr := New()
	if err := mgr.EnsureProvisioned(); err != nil {
		t.Fatalf("EnsureProvisioned returned error: %v", err)
	}
	cred, err := mgr.Promote(context.Background())
	if err == nil {
		t.Fatalf("Promote returned nil error with cred %+v", cred)
	}
	if err != ErrUnsupportedPlatform {
		t.Fatalf("Promote error = %q, want %q", err.Error(), ErrUnsupportedPlatform.Error())
	}
	if err := mgr.Demote(context.Background()); err != nil {
		t.Fatalf("Demote returned error: %v", err)
	}
}

func TestNoopManagerIsNonBlocking(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}

	mgr := New()
	start := time.Now()
	_, _ = mgr.Promote(context.Background())
	_ = mgr.Demote(context.Background())
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("noop manager blocked for %v, expected near-instant", elapsed)
	}
}

func TestLifecycleStateTransitions(t *testing.T) {
	state := nextLifecycleState("", "ensure")
	if state != stateProvisioned {
		t.Fatalf("ensure state = %q, want %q", state, stateProvisioned)
	}
	state = nextLifecycleState(state, "promote")
	if state != statePromoted {
		t.Fatalf("promote state = %q, want %q", state, statePromoted)
	}
	state = nextLifecycleState(state, "demote")
	if state != stateDemoted {
		t.Fatalf("demote state = %q, want %q", state, stateDemoted)
	}
}

func TestStartupCrashRecoveryDecision(t *testing.T) {
	tests := []struct {
		name             string
		accountExists    bool
		inAdministrators bool
		want             bool
	}{
		{"missing account", false, false, false},
		{"provisioned at rest", true, false, false},
		{"leaked admin membership", true, true, true},
		{"impossible missing admin member", false, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldStartupDemote(tt.accountExists, tt.inAdministrators)
			if got != tt.want {
				t.Fatalf("shouldStartupDemote(%v, %v) = %v, want %v",
					tt.accountExists, tt.inAdministrators, got, tt.want)
			}
		})
	}
}

func TestWindowsNetapiRoundTripManual(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("netapi32 round-trip requires a Windows VM running with admin rights")
	}
	t.Skip("manual destructive local-account test; enable on a disposable Windows VM")
}

func assertPasswordComplexity(t *testing.T, pw string) {
	t.Helper()
	hasUpper := strings.ContainsAny(pw, string(upperChars))
	hasLower := strings.ContainsAny(pw, string(lowerChars))
	hasDigit := strings.ContainsAny(pw, string(digitChars))
	hasSymbol := strings.ContainsAny(pw, string(symbolChars))
	if !hasUpper || !hasLower || !hasDigit || !hasSymbol {
		t.Fatalf("password does not meet complexity requirements: upper=%v lower=%v digit=%v symbol=%v",
			hasUpper, hasLower, hasDigit, hasSymbol)
	}
}
