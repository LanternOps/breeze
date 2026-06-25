package heartbeat

import "testing"

func boolPtr(b bool) *bool { return &b }

func TestUACInterceptionFlag(t *testing.T) {
	tests := []struct {
		name        string
		sequence    []*bool // values passed to handleUACInterception in order
		wantEnabled bool
	}{
		{"default before any heartbeat is off (opt-in)", nil, false},
		{"nil from old server stays off (opt-in)", []*bool{nil}, false},
		{"explicit true enables", []*bool{boolPtr(true)}, true},
		{"explicit false stays off", []*bool{boolPtr(false)}, false},
		{"true then false disables", []*bool{boolPtr(true), boolPtr(false)}, false},
		{"true then nil disables (policy unassigned or old server)", []*bool{boolPtr(true), nil}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{}
			for _, v := range tt.sequence {
				h.handleUACInterception(v)
			}
			if got := h.IsUACInterceptionEnabled(); got != tt.wantEnabled {
				t.Fatalf("IsUACInterceptionEnabled() = %v, want %v", got, tt.wantEnabled)
			}
		})
	}
}
