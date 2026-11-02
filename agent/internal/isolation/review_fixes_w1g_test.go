package isolation

import (
	"context"
	"testing"
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
