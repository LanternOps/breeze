//go:build windows

package isolation

import (
	"context"
	"errors"
	"testing"
)

func TestWindowsShippedActivationSwitchRemainsOff(t *testing.T) {
	if windowsIsolationActivated {
		t.Fatal("activation PR must visibly update this fail-closed test")
	}
	i := newWindowsIsolator(nil).(*windowsIsolator)
	probed := false
	i.readiness.probe = func(context.Context) readinessInputs { probed = true; return readinessInputs{schedulerReady: true} }
	i.RefreshReadiness(context.Background())
	if probed {
		t.Fatal("a not-activated agent must not probe readiness (WFP session / Task Scheduler on a timer)")
	}
	got := i.Capability()
	if got != (Capability{Mechanism: "wfp", UnsupportedReason: "not_activated"}) {
		t.Fatalf("shipped capability %+v", got)
	}
}

func TestWindowsReadinessWiring(t *testing.T) {
	failure := errors.New("failed")
	for _, tc := range []struct {
		name             string
		engine, recovery error
		ready            bool
		reason           string
	}{
		{"engine", failure, nil, true, "bfe_unavailable"}, {"recovery", nil, failure, true, "recovery_unavailable"}, {"scheduler", nil, nil, false, "scheduler_unavailable"}, {"ready", nil, nil, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := newWindowsIsolator(nil).(*windowsIsolator)
			i.activated = true // test seam: the shipped value is covered by the tripwire above
			i.open = func() (windowsWFPSession, error) { return &fakeWindowsSession{}, tc.engine }
			recoveryCalls, schedulerCalls := 0, 0
			i.configureReadiness(func(context.Context) (string, error) { recoveryCalls++; return "recovery.exe", tc.recovery }, func() (bool, string) { schedulerCalls++; return tc.ready, "details" })
			i.RefreshReadiness(context.Background())
			got := i.readiness.capability(true)
			if got.UnsupportedReason != tc.reason || got.Ready != (tc.reason == "") || (got.Version == 1) != (tc.reason == "") || got.Mechanism != "wfp" {
				t.Fatalf("cap=%+v", got)
			}
			_ = i.Capability()
			_ = i.Capability()
			if recoveryCalls != 1 || schedulerCalls != 1 {
				t.Fatalf("uncached calls %d %d", recoveryCalls, schedulerCalls)
			}
		})
	}
}
