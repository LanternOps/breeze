//go:build darwin

package isolation

import (
	"context"
	"errors"
	"testing"
)

// The tripwire: activation is a separate one-line PR after lab leg L3 (Todd
// gate). Until then a shipped agent advertises capability 0 and probes nothing.
func TestDarwinShippedActivationSwitchRemainsOff(t *testing.T) {
	if darwinIsolationActivated {
		t.Fatal("activation PR must visibly update this fail-closed test")
	}
	for name, iso := range map[string]*darwinIsolator{
		"constructor": newDarwinIsolator(t.TempDir()),
		"platform":    NewPlatformIsolator().(*darwinIsolator),
	} {
		t.Run(name, func(t *testing.T) {
			probed := false
			iso.readiness.probe = func(context.Context) readinessInputs { probed = true; return readinessInputs{schedulerReady: true} }
			iso.RefreshReadiness(context.Background())
			RefreshCachedReadiness(context.Background(), iso)
			if probed {
				t.Fatal("a not-activated agent must not probe readiness (pfctl, launchd) on a timer")
			}
			if got := iso.Capability(); got != (Capability{Mechanism: "pf", UnsupportedReason: "not_activated"}) {
				t.Fatalf("shipped capability %+v", got)
			}
		})
	}
}

func TestDarwinReadinessWiring(t *testing.T) {
	failure := errors.New("failed")
	for _, tc := range []struct {
		name               string
		pfctl, recovery    error
		schedulerReady     bool
		wantReason         string
		wantVersion, ready bool
	}{
		{name: "pfctl missing", pfctl: failure, schedulerReady: true, wantReason: "pfctl_missing"},
		{name: "recovery missing", recovery: failure, schedulerReady: true, wantReason: "recovery_unavailable"},
		{name: "scheduler not ready", wantReason: "scheduler_unavailable"},
		{name: "ready", schedulerReady: true, wantVersion: true, ready: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := newDarwinIsolator(t.TempDir())
			i.activated = true // test seam: the shipped value is covered by the tripwire above
			i.pfctlPresent = func() error { return tc.pfctl }
			recoveryCalls, schedulerCalls := 0, 0
			i.configureReadiness(
				func(context.Context) (string, error) {
					recoveryCalls++
					return "/Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery", tc.recovery
				},
				func() (bool, string) { schedulerCalls++; return tc.schedulerReady, "details" },
			)
			i.RefreshReadiness(context.Background())
			got := i.Capability()
			want := Capability{Mechanism: "pf", UnsupportedReason: tc.wantReason, Ready: tc.ready}
			if tc.wantVersion {
				want.Version = 1
			}
			if got != want {
				t.Fatalf("capability %+v, want %+v", got, want)
			}
			// Heartbeats read the cache; they never run the installer or launchd.
			_ = i.Capability()
			_ = i.Capability()
			if recoveryCalls != 1 || schedulerCalls != 1 {
				t.Fatalf("uncached calls %d %d", recoveryCalls, schedulerCalls)
			}
		})
	}
}

// CheckCompatible is an apply-time decision (a refusal reports
// mechanism_unavailable with its reason). Capability must not run pfctl at all:
// it is read on every heartbeat.
func TestDarwinCapabilityNeverConsultsPf(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	i.activated = true
	i.pfctlPresent = func() error { return nil }
	i.configureReadiness(func(context.Context) (string, error) { return "", nil }, func() (bool, string) { return true, "" })
	i.RefreshReadiness(context.Background())
	if got := i.Capability(); got.Version != 1 || !got.Ready {
		t.Fatalf("capability %+v", got)
	}
	f.useLive(pfFixtureLive(t, "internet-sharing.txt"))
	if got := i.Capability(); got.Version != 1 || !got.Ready {
		t.Fatalf("an incompatible ruleset must not change capability: %+v", got)
	}
	if len(f.calls) != 0 {
		t.Fatalf("capability ran pfctl: %v", f.calls)
	}
}

func TestDarwinPlatformWiring(t *testing.T) {
	if _, ok := NewPlatformScheduler(t.TempDir()).(*darwinScheduler); !ok {
		t.Fatal("macOS must use the launchd scheduler")
	}
	if i := NewPlatformIsolator().(*darwinIsolator); i.tokens.path != DarwinDataDir+"/"+pfTokenFile {
		t.Fatalf("token journal at %q", i.tokens.path)
	}
}
