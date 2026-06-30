package winupdate

import "testing"

// planAction is platform-independent, so these run on the Linux CI agent even
// though the registry I/O in winupdate_windows.go does not.
func TestPlanAction(t *testing.T) {
	tests := []struct {
		name          string
		enforce       bool
		st            regState
		wantWrite     bool
		wantRecordKey bool
		wantRevert    bool
		wantDeleteKey bool
		wantManaged   bool
		wantEnforced  bool
		wantReverted  bool
	}{
		{
			name:          "enforce on clean machine creates and manages the key",
			enforce:       true,
			st:            regState{keyExists: false},
			wantWrite:     true,
			wantRecordKey: true,
			wantManaged:   true,
			wantEnforced:  true,
		},
		{
			name:         "enforce re-asserts when already Breeze-managed",
			enforce:      true,
			st:           regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 1, breezeManaged: true},
			wantWrite:    true,
			wantManaged:  true,
			wantEnforced: true,
		},
		{
			name:         "enforce leaves a pre-existing admin GPO (NoAutoUpdate=1) as-found",
			enforce:      true,
			st:           regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 1, breezeManaged: false},
			wantWrite:    false,
			wantManaged:  false,
			wantEnforced: true, // reflects the admin's value, Breeze did not set it
		},
		{
			name:         "enforce leaves a pre-existing admin NoAutoUpdate=0 as-found",
			enforce:      true,
			st:           regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 0, breezeManaged: false},
			wantWrite:    false,
			wantManaged:  false,
			wantEnforced: false,
		},
		{
			name:          "revert removes Breeze enforcement and deletes a Breeze-created key",
			enforce:       false,
			st:            regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 1, breezeManaged: true, breezeCreatedKey: true},
			wantRevert:    true,
			wantDeleteKey: true,
			wantReverted:  true,
			wantManaged:   false,
			wantEnforced:  false,
		},
		{
			name:          "revert keeps a pre-existing key Breeze did not create",
			enforce:       false,
			st:            regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 1, breezeManaged: true, breezeCreatedKey: false},
			wantRevert:    true,
			wantDeleteKey: false,
			wantReverted:  true,
		},
		{
			name:        "revert is a no-op when not Breeze-managed",
			enforce:     false,
			st:          regState{keyExists: true, noAutoUpdatePresent: true, noAutoUpdateValue: 1, breezeManaged: false},
			wantRevert:  false,
			wantManaged: false,
			// Enforced reflects the surviving admin value.
			wantEnforced: true,
		},
		{
			name:    "revert is a no-op when the key is absent",
			enforce: false,
			st:      regState{keyExists: false},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := planAction(tt.enforce, tt.st)
			if p.writeEnforcement != tt.wantWrite {
				t.Errorf("writeEnforcement = %v, want %v", p.writeEnforcement, tt.wantWrite)
			}
			if p.recordKeyCreated != tt.wantRecordKey {
				t.Errorf("recordKeyCreated = %v, want %v", p.recordKeyCreated, tt.wantRecordKey)
			}
			if p.revert != tt.wantRevert {
				t.Errorf("revert = %v, want %v", p.revert, tt.wantRevert)
			}
			if p.deleteKeyIfEmpty != tt.wantDeleteKey {
				t.Errorf("deleteKeyIfEmpty = %v, want %v", p.deleteKeyIfEmpty, tt.wantDeleteKey)
			}
			if p.result.Managed != tt.wantManaged {
				t.Errorf("result.Managed = %v, want %v", p.result.Managed, tt.wantManaged)
			}
			if p.result.Enforced != tt.wantEnforced {
				t.Errorf("result.Enforced = %v, want %v", p.result.Enforced, tt.wantEnforced)
			}
			if p.result.Reverted != tt.wantReverted {
				t.Errorf("result.Reverted = %v, want %v", p.result.Reverted, tt.wantReverted)
			}
			if !p.result.Supported {
				t.Errorf("result.Supported = false, want true for planned action")
			}
			if p.result.Reason == "" {
				t.Errorf("result.Reason is empty; want a human-readable detail")
			}
		})
	}
}
