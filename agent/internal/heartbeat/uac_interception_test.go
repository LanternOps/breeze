package heartbeat

import "testing"

func boolPtr(b bool) *bool { return &b }

func TestUACInterceptionFlag(t *testing.T) {
	tests := []struct {
		name        string
		sequence    []*bool // values passed to handleUACInterception in order
		wantEnabled bool
	}{
		{"default before any heartbeat", nil, true},
		{"nil from old server keeps default on", []*bool{nil}, true},
		{"explicit true stays on", []*bool{boolPtr(true)}, true},
		{"explicit false disables", []*bool{boolPtr(false)}, false},
		{"false then true re-enables", []*bool{boolPtr(false), boolPtr(true)}, true},
		{"false then nil re-enables (policy unassigned on old server)", []*bool{boolPtr(false), nil}, true},
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
