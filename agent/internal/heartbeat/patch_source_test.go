package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/winupdate"
)

func TestApplyPatchSourceConfig_DispatchAndParse(t *testing.T) {
	tests := []struct {
		name        string
		update      map[string]any
		wantCalled  bool
		wantEnforce bool
	}{
		{
			name:        "snake_case block + camelCase field, true",
			update:      map[string]any{"patch_source_settings": map[string]any{"exclusiveWindowsUpdate": true}},
			wantCalled:  true,
			wantEnforce: true,
		},
		{
			name:        "camelCase block + snake_case field, false",
			update:      map[string]any{"patchSourceSettings": map[string]any{"exclusive_windows_update": false}},
			wantCalled:  true,
			wantEnforce: false,
		},
		{
			name:       "missing field → no-op (never calls enforcement)",
			update:     map[string]any{"patch_source_settings": map[string]any{}},
			wantCalled: false,
		},
		{
			name:       "non-boolean field → no-op",
			update:     map[string]any{"patch_source_settings": map[string]any{"exclusiveWindowsUpdate": "yes"}},
			wantCalled: false,
		},
		{
			name:       "non-object payload → no-op",
			update:     map[string]any{"patch_source_settings": "enabled"},
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
			orig := applyWinUpdate
			t.Cleanup(func() { applyWinUpdate = orig })
			var gotEnforce *bool
			applyWinUpdate = func(enforce bool) (winupdate.Result, error) {
				e := enforce
				gotEnforce = &e
				return winupdate.Result{Supported: true, Reason: "stub"}, nil
			}

			h := &Heartbeat{config: config.Default()}
			h.applyConfigUpdate(tt.update)

			if tt.wantCalled {
				if gotEnforce == nil {
					t.Fatalf("enforcement was not invoked; expected it with enforce=%v", tt.wantEnforce)
				}
				if *gotEnforce != tt.wantEnforce {
					t.Errorf("enforce = %v, want %v", *gotEnforce, tt.wantEnforce)
				}
			} else if gotEnforce != nil {
				t.Errorf("enforcement was invoked (enforce=%v) but the payload should have been a no-op", *gotEnforce)
			}
		})
	}
}
