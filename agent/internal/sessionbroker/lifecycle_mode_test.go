package sessionbroker

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestIsRDSSuiteMask(t *testing.T) {
	tests := []struct {
		name string
		mask uint16
		want bool
	}{
		{"terminal only (RD Session Host role)", 0x0010, true},
		{"terminal plus other suites", 0x0010 | 0x0002, true},
		{"terminal AND single-user TS (normal workstation)", 0x0010 | 0x0100, false},
		{"single-user TS only", 0x0100, false},
		{"neither bit", 0x0000, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRDSSuiteMask(tt.mask); got != tt.want {
				t.Errorf("isRDSSuiteMask(%#x) = %v, want %v", tt.mask, got, tt.want)
			}
		})
	}
}

func TestResolveLifecycleMode(t *testing.T) {
	tests := []struct {
		name     string
		override string
		rdsHost  bool
		want     LifecycleMode
	}{
		{"auto on RDS host", "", true, LifecycleModeOnDemand},
		{"auto on workstation", "", false, LifecycleModeAlwaysOn},
		{"explicit auto on RDS host", "auto", true, LifecycleModeOnDemand},
		{"override always-on beats RDS detection", "always-on", true, LifecycleModeAlwaysOn},
		{"override on-demand beats workstation detection", "on-demand", false, LifecycleModeOnDemand},
		{"garbage override falls back to auto", "bogus", true, LifecycleModeOnDemand},
		{"garbage override on workstation", "bogus", false, LifecycleModeAlwaysOn},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveLifecycleMode(tt.override, tt.rdsHost); got != tt.want {
				t.Errorf("resolveLifecycleMode(%q, %v) = %q, want %q", tt.override, tt.rdsHost, got, tt.want)
			}
		})
	}
}

func TestManagerModeDefaultsToAlwaysOn(t *testing.T) {
	m := newHelperLifecycleManager(nil, nil, nil, nil)
	if m.mode != LifecycleModeAlwaysOn {
		t.Fatalf("mode = %q, want always-on default", m.mode)
	}
	if m.Mode() != string(LifecycleModeAlwaysOn) {
		t.Fatalf("Mode() = %q, want %q", m.Mode(), LifecycleModeAlwaysOn)
	}
}

func TestSetModeOverride(t *testing.T) {
	newMgr := func(localOverride string, rdsHost bool) *HelperLifecycleManager {
		b := New("mode-override-"+t.Name(), nil)
		m := newHelperLifecycleManager(b, &stubLeaseDetector{}, nil, nil)
		m.rdsHost = rdsHost
		m.localOverride = localOverride
		m.mode = resolveLifecycleMode(localOverride, rdsHost)
		return m
	}

	t.Run("server override flips auto RDS host to always-on and clears leases", func(t *testing.T) {
		m := newMgr("", true) // auto -> on-demand
		m.mu.Lock()
		m.leases[HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}] = &helperLease{}
		m.mu.Unlock()

		m.SetModeOverride("always-on")
		if m.Mode() != string(LifecycleModeAlwaysOn) {
			t.Fatalf("mode = %s", m.Mode())
		}
		m.mu.Lock()
		n := len(m.leases)
		m.mu.Unlock()
		if n != 0 {
			t.Fatalf("leases must be cleared on switch to always-on, have %d", n)
		}
	})

	t.Run("server override flips workstation to on-demand", func(t *testing.T) {
		m := newMgr("", false)
		m.SetModeOverride("on-demand")
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("mode = %s", m.Mode())
		}
	})

	t.Run("server auto returns to detection", func(t *testing.T) {
		m := newMgr("", true)
		m.SetModeOverride("always-on")
		m.SetModeOverride("auto")
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("auto on RDS host must resolve on-demand, got %s", m.Mode())
		}
	})

	t.Run("explicit local config wins over server override", func(t *testing.T) {
		m := newMgr("always-on", true)
		m.SetModeOverride("on-demand")
		if m.Mode() != string(LifecycleModeAlwaysOn) {
			t.Fatalf("local explicit override must win, got %s", m.Mode())
		}
	})

	t.Run("no-op when unchanged", func(t *testing.T) {
		m := newMgr("", true)
		m.SetModeOverride("on-demand") // already on-demand
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("mode = %s", m.Mode())
		}
	})
}
