package heartbeat

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/winupdate"
)

// recordingFeatureProvider captures the policy the manager fans out.
type recordingFeatureProvider struct {
	policy *patching.FeatureUpdatePolicy
}

func (p *recordingFeatureProvider) ID() string                               { return "windows_update" }
func (p *recordingFeatureProvider) Name() string                             { return "fake" }
func (p *recordingFeatureProvider) Scan() ([]patching.AvailablePatch, error) { return nil, nil }
func (p *recordingFeatureProvider) Install(string) (patching.InstallResult, error) {
	return patching.InstallResult{}, nil
}
func (p *recordingFeatureProvider) Uninstall(string) error { return nil }
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

// TestApplyFeatureUpdateConfig_LogsInfoOnlyOnChange pins #10382: the policy is
// re-applied on every heartbeat (60 s), but INFO is emitted only when the
// outcome changes; the steady-state re-assert drops to DEBUG. Enforcement
// itself (the registry call) still runs on every beat.
func TestApplyFeatureUpdateConfig_LogsInfoOnlyOnChange(t *testing.T) {
	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	orig := applyTargetRelease
	t.Cleanup(func() { applyTargetRelease = orig })

	// Fake registry: a pin to the version already written is a re-assert.
	var calls int
	var writtenTarget string
	var failNext bool
	applyTargetRelease = func(pin *winupdate.TargetRelease) (winupdate.Result, error) {
		calls++
		if failNext {
			failNext = false
			return winupdate.Result{Supported: true}, errors.New("registry access denied")
		}
		if pin == nil {
			if writtenTarget != "" {
				writtenTarget = ""
				return winupdate.Result{Supported: true, Reverted: true, Reason: "reverted Breeze Windows Update target-release pin"}, nil
			}
			return winupdate.Result{Supported: true, Reason: "no Breeze-managed Windows Update target-release pin to revert; left as-found"}, nil
		}
		reason := "Windows Update target release pinned (" + pin.TargetVersion + ")"
		if writtenTarget == pin.TargetVersion {
			reason = "Windows Update target release already pinned (re-asserted " + pin.TargetVersion + ")"
		}
		writtenTarget = pin.TargetVersion
		return winupdate.Result{Supported: true, Managed: true, Enforced: true, Reason: reason}, nil
	}

	h := &Heartbeat{config: config.Default()}
	beat := func(block map[string]any) {
		h.applyConfigUpdate(map[string]any{"feature_update_settings": block})
	}
	pin := func(v string) map[string]any {
		return map[string]any{"mode": "pin", "product": "windows-11", "targetVersion": v}
	}
	countInfo := func() int {
		return strings.Count(buf.String(), `level=INFO msg="applied Windows feature-update policy"`)
	}

	for i := 0; i < 8; i++ {
		beat(pin("25H2"))
	}
	if got := countInfo(); got != 1 {
		t.Fatalf("8 identical pinned heartbeats logged %d INFO lines, want 1\n%s", got, buf.String())
	}
	if !strings.Contains(buf.String(), `level=DEBUG msg="applied Windows feature-update policy"`) {
		t.Errorf("steady-state re-assert should still be visible at DEBUG\n%s", buf.String())
	}

	// A changed target is a state change: one more INFO, then quiet again.
	for i := 0; i < 3; i++ {
		beat(pin("26H1"))
	}
	if got := countInfo(); got != 2 {
		t.Fatalf("re-pin to a new target: %d INFO lines total, want 2\n%s", got, buf.String())
	}

	// Switching to block reverts the pin (INFO), then settles on left-as-found
	// (one more INFO for that new steady state), then quiet.
	for i := 0; i < 4; i++ {
		beat(map[string]any{"mode": "block"})
	}
	if got := countInfo(); got != 4 {
		t.Fatalf("revert + left-as-found: %d INFO lines total, want 4\n%s", got, buf.String())
	}

	// A failure is always logged, and the next successful apply is reported
	// at INFO again even though the outcome matches the last one logged.
	failNext = true
	beat(map[string]any{"mode": "block"})
	if !strings.Contains(buf.String(), `level=ERROR msg="failed to apply Windows Update target-release policy"`) {
		t.Fatalf("apply error not logged\n%s", buf.String())
	}
	beat(map[string]any{"mode": "block"})
	beat(map[string]any{"mode": "block"})
	if got := countInfo(); got != 5 {
		t.Fatalf("recovery after an error: %d INFO lines total, want 5\n%s", got, buf.String())
	}

	// Enforcement is unchanged: the registry policy is applied on every beat.
	if calls != 8+3+4+3 {
		t.Errorf("applyTargetRelease called %d times, want %d (one per heartbeat)", calls, 8+3+4+3)
	}
}
