package sessionbroker

import "testing"

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
