package isolation

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// The periodic tick must not inspect the firewall engine on a never-isolated
// device while capability is 0: on Windows that is a WFP session per minute on
// every device, and on Linux/macOS (ErrUnsupported) a warning per minute.
// Startup still checks once, so a capability-0 build can clean orphan rules.
func TestTickSkipsOrphanInspectionAtCapabilityZero(t *testing.T) {
	h := newHarness(t)
	h.iso.set(func(f *fakeIsolator) {
		f.cap = Capability{Version: 0, Mechanism: "wfp", UnsupportedReason: "not_activated"}
	})
	h.log.reset()
	for i := 0; i < 3; i++ {
		h.m.Tick(context.Background())
	}
	if n := h.log.count("iso:Owned"); n != 0 {
		t.Fatalf("tick inspected the engine %d times at capability 0; want 0", n)
	}
	h.log.reset()
	h.m.Startup(context.Background())
	if n := h.log.count("iso:Owned"); n == 0 {
		t.Fatal("startup must still look for orphan rules at capability 0")
	}
}

// Startup at capability 0 still releases orphan rules left by a capable build.
func TestStartupReleasesOrphansAtCapabilityZero(t *testing.T) {
	h := newHarness(t)
	h.iso.set(func(f *fakeIsolator) {
		f.cap = Capability{Version: 0, Mechanism: "wfp", UnsupportedReason: "not_activated"}
		f.installed = true
	})
	h.m.Startup(context.Background())
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("orphan rules survived startup at capability 0")
	}
}

// Uninstall must not be blocked on a device whose state directory was never
// created (nothing was ever journalled), unless the engine still shows rules.
func TestReleaseAllWithoutStateDirectory(t *testing.T) {
	missing := t.TempDir() + "/absent"
	if err := NewManager(ManagerDeps{DataDir: missing}).ReleaseAll(context.Background(), ReleaseUninstall); err != nil {
		t.Fatalf("unsupported platform, no state directory: %v", err)
	}
	h := newHarness(t)
	if err := NewManager(ManagerDeps{DataDir: missing, Isolator: h.iso, Scheduler: h.sched}).ReleaseAll(context.Background(), ReleaseUninstall); err != nil {
		t.Fatalf("engine confirms no rules, no state directory: %v", err)
	}
	h.iso.set(func(f *fakeIsolator) { f.installed = true })
	if err := NewManager(ManagerDeps{DataDir: missing, Isolator: h.iso, Scheduler: h.sched}).ReleaseAll(context.Background(), ReleaseUninstall); err == nil {
		t.Fatal("owned rules with no state directory must refuse uninstall")
	}
}

// An orphan cleanup whose release failed leaves phase=releasing with no
// episode id. ReleaseAll (uninstall) must finish that cleanup, not refuse it
// as "this device does not hold that episode" forever.
func TestReleaseAllFinishesInterruptedOrphanRelease(t *testing.T) {
	h := newHarness(t)
	h.iso.set(func(f *fakeIsolator) { f.installed = true; f.releaseErr = errors.New("engine busy") })
	if err := h.m.BootApply(context.Background()); err == nil {
		t.Fatal("setup: release failure must surface")
	}
	if j := h.journal(); j.Phase != journal.PhaseReleasing {
		t.Fatalf("setup: phase %s, want releasing", j.Phase)
	}
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = nil })
	if err := h.newManager().ReleaseAll(context.Background(), ReleaseUninstall); err != nil {
		t.Fatalf("uninstall refused an interrupted orphan release: %v", err)
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("orphan rules remain")
	}
}

// With a one-minute tick, a healthy cache must never be observed as expired:
// the periodic refresh runs before the result ages out, so an activated
// device does not flap between capable and not capable.
func TestReadinessCacheDoesNotFlapOnMinuteTicks(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	probes := 0
	c := &readinessCache{
		now:   func() time.Time { return now },
		probe: func(context.Context) readinessInputs { probes++; return readinessInputs{schedulerReady: true} },
	}
	c.refresh(context.Background(), true)
	for minute := 1; minute <= 30; minute++ {
		now = now.Add(time.Minute)
		if got := c.capability(true); !got.Ready {
			t.Fatalf("minute %d before tick: capability flapped to %+v", minute, got)
		}
		c.refresh(context.Background(), false)
	}
	if probes < 2 || probes > 30 {
		t.Fatalf("probes = %d; refresh must be bounded but periodic", probes)
	}
}

// Orphan rules found by an uninstall release cannot be attributed to an
// episode: the receipt is kind system (never rewritten as uninstall), the
// rules are gone, and the receipt survives a restart for the next report.
func TestReleaseAllOrphansKeepSystemReceipt(t *testing.T) {
	for _, raw := range []string{"", "{", `{"schemaVersion":900,"phase":"committed"}`} {
		t.Run(raw, func(t *testing.T) {
			h := newHarness(t)
			h.iso.set(func(f *fakeIsolator) { f.installed = true })
			if raw != "" {
				if err := os.WriteFile(h.m.path(), []byte(raw), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := h.m.ReleaseAll(context.Background(), ReleaseUninstall); err != nil {
				t.Fatal(err)
			}
			if installed, _, _ := h.iso.state(); installed {
				t.Fatal("orphan rules remain")
			}
			j := h.journal()
			if j.PendingReport == nil || j.PendingReport.Kind != ReleaseSystem {
				t.Fatalf("receipt = %+v, want kind %q", j.PendingReport, ReleaseSystem)
			}
			if err := h.newManager().RecoveryExpireCheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			if h.journal().PendingReport == nil {
				t.Fatal("restart lost the receipt")
			}
		})
	}
}
