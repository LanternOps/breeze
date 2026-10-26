package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/winupdate"
)

// recordingFeatureProvider captures the policy the manager fans out.
type recordingFeatureProvider struct {
	policy *patching.FeatureUpdatePolicy
}

func (p *recordingFeatureProvider) ID() string                                     { return "windows_update" }
func (p *recordingFeatureProvider) Name() string                                   { return "fake" }
func (p *recordingFeatureProvider) Scan() ([]patching.AvailablePatch, error)       { return nil, nil }
func (p *recordingFeatureProvider) Install(string) (patching.InstallResult, error) { return patching.InstallResult{}, nil }
func (p *recordingFeatureProvider) Uninstall(string) error                         { return nil }
func (p *recordingFeatureProvider) GetInstalled() ([]patching.InstalledPatch, error) {
	return nil, nil
}
func (p *recordingFeatureProvider) SetFeatureUpdatePolicy(policy patching.FeatureUpdatePolicy) {
	p.policy = &policy
}

func TestApplyFeatureUpdateConfig_DispatchAndParse(t *testing.T) {
	pin := patching.FeatureUpdatePolicy{Mode: patching.FeatureUpdatePin, Product: "windows-11", TargetVersion: "25H2"}

	tests := []struct {
		name         string
		update       map[string]any
		wantPolicy   *patching.FeatureUpdatePolicy
		wantRegistry bool
		wantPin      *winupdate.TargetRelease
	}{
		{
			name:         "snake_case block: pin → provider policy + registry pin",
			update:       map[string]any{"feature_update_settings": map[string]any{"mode": "pin", "product": "windows-11", "targetVersion": "25h2"}},
			wantPolicy:   &pin,
			wantRegistry: true,
			wantPin:      &winupdate.TargetRelease{ProductVersion: "Windows 11", TargetVersion: "25H2"},
		},
		{
			name:         "camelCase block: allow → provider policy + registry revert",
			update:       map[string]any{"featureUpdateSettings": map[string]any{"mode": "allow"}},
			wantPolicy:   &patching.FeatureUpdatePolicy{Mode: patching.FeatureUpdateAllow},
			wantRegistry: true,
			wantPin:      nil,
		},
		{
			name:         "block → provider policy + registry revert",
			update:       map[string]any{"feature_update_settings": map[string]any{"mode": "block"}},
			wantPolicy:   &patching.FeatureUpdatePolicy{Mode: patching.FeatureUpdateBlock},
			wantRegistry: true,
			wantPin:      nil,
		},
		{
			name:   "malformed payload → nothing applied (keep the last policy)",
			update: map[string]any{"feature_update_settings": map[string]any{"mode": "latest"}},
		},
		{
			name:   "non-object payload → nothing applied",
			update: map[string]any{"feature_update_settings": "allow"},
		},
		{
			name:   "block absent → nothing applied",
			update: map[string]any{"event_log_settings": map[string]any{}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := applyTargetRelease
			t.Cleanup(func() { applyTargetRelease = orig })
			var registryCalled bool
			var gotPin *winupdate.TargetRelease
			applyTargetRelease = func(pin *winupdate.TargetRelease) (winupdate.Result, error) {
				registryCalled = true
				gotPin = pin
				return winupdate.Result{Supported: true, Reason: "stub"}, nil
			}

			provider := &recordingFeatureProvider{}
			h := &Heartbeat{config: config.Default(), patchMgr: patching.NewPatchManager(provider)}
			h.applyConfigUpdate(tt.update)

			if tt.wantPolicy == nil {
				if provider.policy != nil {
					t.Errorf("provider received %+v but the payload should have been a no-op", *provider.policy)
				}
				if registryCalled {
					t.Error("registry policy was applied but the payload should have been a no-op")
				}
				return
			}
			if provider.policy == nil || *provider.policy != *tt.wantPolicy {
				t.Fatalf("provider policy = %+v, want %+v", provider.policy, *tt.wantPolicy)
			}
			if registryCalled != tt.wantRegistry {
				t.Fatalf("registry called = %v, want %v", registryCalled, tt.wantRegistry)
			}
			if (gotPin == nil) != (tt.wantPin == nil) {
				t.Fatalf("registry pin = %+v, want %+v", gotPin, tt.wantPin)
			}
			if gotPin != nil && *gotPin != *tt.wantPin {
				t.Errorf("registry pin = %+v, want %+v", *gotPin, *tt.wantPin)
			}
		})
	}
}

func TestApplyFeatureUpdateConfig_NoPatchManager(t *testing.T) {
	orig := applyTargetRelease
	t.Cleanup(func() { applyTargetRelease = orig })
	called := false
	applyTargetRelease = func(*winupdate.TargetRelease) (winupdate.Result, error) {
		called = true
		return winupdate.Result{Supported: true}, nil
	}
	h := &Heartbeat{config: config.Default()}
	// Must not panic without a patch manager; the registry policy still applies.
	h.applyConfigUpdate(map[string]any{"feature_update_settings": map[string]any{"mode": "allow"}})
	if !called {
		t.Error("registry policy should still be applied without a patch manager")
	}
}

func TestProductVersionFor(t *testing.T) {
	if got := productVersionFor("windows-11"); got != "Windows 11" {
		t.Errorf("windows-11 → %q", got)
	}
	if got := productVersionFor("windows-10"); got != "Windows 10" {
		t.Errorf("windows-10 → %q", got)
	}
	if got := productVersionFor("windows-7"); got != "" {
		t.Errorf("unknown product → %q, want empty", got)
	}
}
