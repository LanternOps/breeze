package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/onedrivehelper"
)

func TestApplyConfigUpdateOneDrive(t *testing.T) {
	tests := []struct {
		name       string
		update     map[string]any
		wantCalled bool
		wantLibs   int
	}{
		{
			name: "snake_case key dispatches",
			update: map[string]any{"onedrive_helper_settings": map[string]any{
				"base":      map[string]any{"silentAccountConfig": true, "restartOnChange": true},
				"libraries": []any{map[string]any{"libraryId": "l-1", "displayName": "D", "targetingMode": "everyone"}},
			}},
			wantCalled: true, wantLibs: 1,
		},
		{
			name: "camelCase key dispatches",
			update: map[string]any{"onedriveHelperSettings": map[string]any{
				"base": map[string]any{}, "libraries": []any{},
			}},
			wantCalled: true, wantLibs: 0,
		},
		{name: "absent key does not dispatch", update: map[string]any{"monitoring_settings": map[string]any{}}, wantCalled: false},
		{name: "invalid payload does not dispatch", update: map[string]any{"onedrive_helper_settings": "garbage"}, wantCalled: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			var gotCfg onedrivehelper.Config
			orig := applyOneDrive
			t.Cleanup(func() { applyOneDrive = orig })
			applyOneDrive = func(cfg onedrivehelper.Config) (*onedrivehelper.DeviceState, error) {
				called = true
				gotCfg = cfg
				return &onedrivehelper.DeviceState{SignedIn: true}, nil
			}

			h := &Heartbeat{config: config.Default()}
			h.applyConfigUpdate(tt.update)

			if called != tt.wantCalled {
				t.Fatalf("applyOneDrive called = %v, want %v", called, tt.wantCalled)
			}
			if called && len(gotCfg.Libraries) != tt.wantLibs {
				t.Errorf("libraries = %d, want %d", len(gotCfg.Libraries), tt.wantLibs)
			}
			if called {
				h.onedriveMu.Lock()
				if h.onedriveState == nil || !h.onedriveState.SignedIn {
					t.Error("state not captured on Heartbeat")
				}
				h.onedriveMu.Unlock()
			}
		})
	}
}
