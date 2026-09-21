package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestApplyWarrantyConfig_DispatchAndParse pins the two things that silently
// break this feature: the key names, and WHERE the dispatch sits inside
// applyConfigUpdate. Every case below is driven through applyConfigUpdate with
// an update carrying NO policy-probe keys — the probe path returns
// unconditionally when none are present, so a dispatch added below it would
// fail here instead of shipping unreachable.
func TestApplyWarrantyConfig_DispatchAndParse(t *testing.T) {
	tests := []struct {
		name        string
		start       bool
		update      map[string]any
		wantCalled  bool
		wantEnabled bool
		wantMemory  bool
	}{
		{
			name:        "snake_case block + snake_case field, true (the wire shape the API sends)",
			update:      map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}},
			wantCalled:  true,
			wantEnabled: true,
			wantMemory:  true,
		},
		{
			name:        "camelCase block + camelCase field, true",
			update:      map[string]any{"warrantySettings": map[string]any{"hpCmslEnabled": true}},
			wantCalled:  true,
			wantEnabled: true,
			wantMemory:  true,
		},
		{
			name:        "revocation: true → false persists and clears memory",
			start:       true,
			update:      map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": false}},
			wantCalled:  true,
			wantEnabled: false,
			wantMemory:  false,
		},
		{
			name:       "unchanged value does not rewrite agent.yaml",
			start:      true,
			update:     map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}},
			wantCalled: false,
			wantMemory: true,
		},
		{
			name:       "missing field → no-op",
			update:     map[string]any{"warranty_settings": map[string]any{}},
			wantCalled: false,
		},
		{
			name:       "non-boolean field → no-op",
			update:     map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": "yes"}},
			wantCalled: false,
		},
		{
			name:       "non-object payload → no-op",
			update:     map[string]any{"warranty_settings": "enabled"},
			wantCalled: false,
		},
		{
			name:       "block absent entirely → no-op",
			update:     map[string]any{"event_log_settings": map[string]any{}},
			wantCalled: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := persistWarrantyCollectionEnabled
			t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
			var got *bool
			persistWarrantyCollectionEnabled = func(enabled bool) error {
				e := enabled
				got = &e
				return nil
			}

			cfg := config.Default()
			cfg.HPWarrantyCollectionEnabled = tt.start
			h := &Heartbeat{config: cfg}
			h.applyConfigUpdate(tt.update)

			if tt.wantCalled {
				if got == nil {
					t.Fatalf("persistence was not invoked; expected it with enabled=%v", tt.wantEnabled)
				}
				if *got != tt.wantEnabled {
					t.Errorf("persisted enabled = %v, want %v", *got, tt.wantEnabled)
				}
			} else if got != nil {
				t.Errorf("persistence was invoked (enabled=%v) but the payload should have been a no-op", *got)
			}

			if tt.wantCalled || tt.start {
				if h.hpWarrantyCollectionEnabled() != tt.wantMemory {
					t.Errorf("in-memory flag = %v, want %v", h.hpWarrantyCollectionEnabled(), tt.wantMemory)
				}
			}
		})
	}
}

// A persistence failure must not leave the in-memory flag disagreeing with what
// the control plane just said: the agent keeps applying the pushed value for
// this process and re-persists on the next heartbeat that changes it.
func TestApplyWarrantyConfig_PersistFailureKeepsInMemoryValue(t *testing.T) {
	orig := persistWarrantyCollectionEnabled
	t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
	persistWarrantyCollectionEnabled = func(bool) error { return errPersistStub }

	h := &Heartbeat{config: config.Default()}
	h.applyConfigUpdate(map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}})

	if !h.hpWarrantyCollectionEnabled() {
		t.Fatal("in-memory flag was not set after a persistence failure")
	}
}

type persistStubError struct{}

func (persistStubError) Error() string { return "stub persist failure" }

var errPersistStub = persistStubError{}
