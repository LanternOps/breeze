package patching

import "testing"

func TestExcludeFeatureUpdate(t *testing.T) {
	feature := AvailablePatch{Title: "Windows 11, version 24H2", UpdateType: "feature"}
	driver := AvailablePatch{Title: "Intel - Net - 1.2.3", UpdateType: "driver"}
	allow := FeatureUpdatePolicy{Mode: FeatureUpdateAllow}
	block := FeatureUpdatePolicy{Mode: FeatureUpdateBlock}
	pin25 := FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-11", TargetVersion: "25H2"}

	tests := []struct {
		name       string
		killSwitch bool
		policy     FeatureUpdatePolicy
		patch      AvailablePatch
		want       bool
	}{
		{"operator kill switch wins over an allowing ring", true, allow, feature, true},
		{"block excludes", false, block, feature, true},
		{"allow includes", false, allow, feature, false},
		{"pin excludes a non-matching release", false, pin25, feature, true},
		{"pin includes the pinned release", false, pin25, AvailablePatch{Title: "Windows 11, version 25H2", UpdateType: "feature"}, false},
		{"non-feature patches are never touched", false, block, driver, false},
		{"kill switch leaves non-feature patches alone", true, block, driver, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := excludeFeatureUpdate(tt.killSwitch, tt.policy, tt.patch); got != tt.want {
				t.Errorf("excludeFeatureUpdate() = %v, want %v", got, tt.want)
			}
		})
	}
}

// policyAwareProvider is a fakeProvider that also accepts the ring policy.
type policyAwareProvider struct {
	fakeProvider
	policy *FeatureUpdatePolicy
}

func (p *policyAwareProvider) SetFeatureUpdatePolicy(policy FeatureUpdatePolicy) {
	p.policy = &policy
}

func TestPatchManagerSetFeatureUpdatePolicy(t *testing.T) {
	aware := &policyAwareProvider{fakeProvider: fakeProvider{id: "windows_update"}}
	plain := &fakeProvider{id: "chocolatey"}
	m := NewPatchManager(aware, plain)

	want := FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-11", TargetVersion: "25H2"}
	m.SetFeatureUpdatePolicy(want)

	if aware.policy == nil || *aware.policy != want {
		t.Fatalf("policy-aware provider got %+v, want %+v", aware.policy, want)
	}
	// The plain provider has no setter; reaching here without a panic is the assertion.
}
