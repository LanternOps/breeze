package winupdate

import (
	"errors"
	"testing"
)

var (
	errFakeNotExist     = errors.New("value not present")
	errFakeAccessDenied = errors.New("access denied")
)

func fakeIsNotExist(err error) bool { return errors.Is(err, errFakeNotExist) }

// fakeRegKey implements regKey so executeRevert's safety logic runs on any OS.
type fakeRegKey struct {
	deleteErr     map[string]error // per-value-name error returned by DeleteValue
	deleted       []string
	valueNames    []string
	valueNamesErr error
	subKeys       []string
	subKeysErr    error
}

func (f *fakeRegKey) DeleteValue(name string) error {
	if e := f.deleteErr[name]; e != nil {
		return e
	}
	f.deleted = append(f.deleted, name)
	return nil
}
func (f *fakeRegKey) ReadValueNames(int) ([]string, error)  { return f.valueNames, f.valueNamesErr }
func (f *fakeRegKey) ReadSubKeyNames(int) ([]string, error) { return f.subKeys, f.subKeysErr }

func TestExecuteRevert(t *testing.T) {
	t.Run("deletes all managed values and removes a confirmed-empty Breeze-created key", func(t *testing.T) {
		k := &fakeRegKey{valueNames: []string{}, subKeys: []string{}}
		removeKey, err := executeRevert(k, true, fakeIsNotExist)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !removeKey {
			t.Errorf("removeKey = false, want true for a confirmed-empty created key")
		}
		if len(k.deleted) != 3 {
			t.Errorf("deleted %v values, want 3 (NoAutoUpdate + 2 sentinels)", k.deleted)
		}
	})

	t.Run("tolerates not-present values (idempotent revert)", func(t *testing.T) {
		k := &fakeRegKey{
			deleteErr:  map[string]error{noAutoUpdateValue: errFakeNotExist, breezeManagedValue: errFakeNotExist},
			valueNames: []string{}, subKeys: []string{},
		}
		removeKey, err := executeRevert(k, true, fakeIsNotExist)
		if err != nil {
			t.Fatalf("unexpected error for not-present values: %v", err)
		}
		if !removeKey {
			t.Errorf("removeKey = false, want true")
		}
	})

	t.Run("propagates a real delete error instead of reporting a clean revert", func(t *testing.T) {
		// ACCESS_DENIED on the ownership sentinel must surface — otherwise the
		// sentinel persists while the caller reports Reverted:true.
		k := &fakeRegKey{deleteErr: map[string]error{breezeManagedValue: errFakeAccessDenied}}
		removeKey, err := executeRevert(k, true, fakeIsNotExist)
		if err == nil {
			t.Fatalf("expected error to propagate, got nil")
		}
		if !errors.Is(err, errFakeAccessDenied) {
			t.Errorf("error = %v, want it to wrap access-denied", err)
		}
		if removeKey {
			t.Errorf("removeKey = true after a failed delete; must be false")
		}
	})

	t.Run("does NOT delete the key when emptiness cannot be confirmed (read error)", func(t *testing.T) {
		k := &fakeRegKey{valueNamesErr: errFakeAccessDenied}
		removeKey, err := executeRevert(k, true, fakeIsNotExist)
		if err != nil {
			t.Fatalf("read error should not fail the revert: %v", err)
		}
		if removeKey {
			t.Errorf("removeKey = true on a read error; a transient failure must never delete the key")
		}
	})

	t.Run("does NOT delete the key when other values remain", func(t *testing.T) {
		k := &fakeRegKey{valueNames: []string{"SomeAdminValue"}, subKeys: []string{}}
		removeKey, err := executeRevert(k, true, fakeIsNotExist)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if removeKey {
			t.Errorf("removeKey = true with a surviving admin value; must be false")
		}
	})

	t.Run("never deletes the key when deleteKeyIfEmpty is false", func(t *testing.T) {
		k := &fakeRegKey{valueNames: []string{}, subKeys: []string{}}
		removeKey, err := executeRevert(k, false, fakeIsNotExist)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if removeKey {
			t.Errorf("removeKey = true with deleteKeyIfEmpty=false; must be false")
		}
	})
}

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
