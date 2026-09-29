package config

import (
	"errors"
	"reflect"
	"testing"
)

var (
	errTestInvalidOwner = errors.New("this security ID may not be assigned as the owner of this object")
	errTestAccessDenied = errors.New("access is denied")
	errTestPrivNotHeld  = errors.New("privilege not held")
)

// ownerFallbackHarness records every side effect assignOwnerWithFallback
// performs, in order, so each case can assert the exact sequence.
type ownerFallbackHarness struct {
	events []string
	// results maps an owner to the errors successive apply(owner) calls
	// return; once exhausted, apply succeeds.
	results  map[string][]error
	privErr  error
	released int
}

func (h *ownerFallbackHarness) apply(owner string) error {
	h.events = append(h.events, "apply:"+owner)
	errs := h.results[owner]
	if len(errs) == 0 {
		return nil
	}
	h.results[owner] = errs[1:]
	return errs[0]
}

func (h *ownerFallbackHarness) enable() (func(), error) {
	h.events = append(h.events, "enable-privilege")
	if h.privErr != nil {
		return nil, h.privErr
	}
	return func() {
		h.released++
		h.events = append(h.events, "release-privilege")
	}, nil
}

func (h *ownerFallbackHarness) run(primary, fallback string) (ownerAssignResult, error) {
	return assignOwnerWithFallback(primary, fallback, h.apply,
		func(err error) bool { return errors.Is(err, errTestInvalidOwner) }, h.enable)
}

// TestAssignOwnerWithFallback covers the #7394 owner decision: the LocalSystem
// service keeps the SYSTEM owner untouched; an elevated administrator gets the
// SYSTEM owner through SeRestorePrivilege; only when both are refused is the
// owner lowered to BUILTIN\Administrators; and no other failure is ever
// masked by the fallback.
func TestAssignOwnerWithFallback(t *testing.T) {
	tests := []struct {
		name       string
		results    map[string][]error
		privErr    error
		primary    string
		wantHow    ownerAssignment
		wantErr    []error // each must satisfy errors.Is on the returned error
		wantEvents []string
		wantPriv   error
		wantPrim   error
	}{
		{
			name:       "SYSTEM token assigns SYSTEM directly, never touches the privilege",
			primary:    "SY",
			wantHow:    ownerAssignedDirect,
			wantEvents: []string{"apply:SY"},
		},
		{
			name:       "elevated admin assigns SYSTEM once SeRestorePrivilege is enabled",
			results:    map[string][]error{"SY": {errTestInvalidOwner}},
			primary:    "SY",
			wantHow:    ownerAssignedWithPrivilege,
			wantEvents: []string{"apply:SY", "enable-privilege", "apply:SY", "release-privilege"},
		},
		{
			name:       "privilege unavailable falls back to Administrators owner",
			results:    map[string][]error{"SY": {errTestInvalidOwner}},
			privErr:    errTestPrivNotHeld,
			primary:    "SY",
			wantHow:    ownerAssignedFallback,
			wantEvents: []string{"apply:SY", "enable-privilege", "apply:BA"},
			wantPriv:   errTestPrivNotHeld,
			wantPrim:   errTestInvalidOwner,
		},
		{
			name:       "still refused with the privilege falls back, privilege released first",
			results:    map[string][]error{"SY": {errTestInvalidOwner, errTestInvalidOwner}},
			primary:    "SY",
			wantHow:    ownerAssignedFallback,
			wantEvents: []string{"apply:SY", "enable-privilege", "apply:SY", "release-privilege", "apply:BA"},
			wantPrim:   errTestInvalidOwner,
		},
		{
			name:       "a non-owner failure is returned as-is with no privilege or fallback",
			results:    map[string][]error{"SY": {errTestAccessDenied}},
			primary:    "SY",
			wantErr:    []error{errTestAccessDenied},
			wantEvents: []string{"apply:SY"},
		},
		{
			name:       "a non-owner failure under the privilege is returned, not masked by the fallback",
			results:    map[string][]error{"SY": {errTestInvalidOwner, errTestAccessDenied}},
			primary:    "SY",
			wantErr:    []error{errTestAccessDenied},
			wantEvents: []string{"apply:SY", "enable-privilege", "apply:SY", "release-privilege"},
		},
		{
			name:       "a failed fallback reports both the refusal and the fallback error",
			results:    map[string][]error{"SY": {errTestInvalidOwner}, "BA": {errTestAccessDenied}},
			privErr:    errTestPrivNotHeld,
			primary:    "SY",
			wantErr:    []error{errTestInvalidOwner, errTestAccessDenied},
			wantEvents: []string{"apply:SY", "enable-privilege", "apply:BA"},
		},
		{
			name:       "primary already the fallback owner: nothing to fall back to",
			results:    map[string][]error{"BA": {errTestInvalidOwner, errTestInvalidOwner}},
			privErr:    errTestPrivNotHeld,
			primary:    "BA",
			wantErr:    []error{errTestInvalidOwner},
			wantEvents: []string{"apply:BA", "enable-privilege"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results := tt.results
			if results == nil {
				results = map[string][]error{}
			}
			h := &ownerFallbackHarness{results: results, privErr: tt.privErr}
			got, err := h.run(tt.primary, "BA")

			if len(tt.wantErr) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if got.how != tt.wantHow {
					t.Errorf("how = %d, want %d", got.how, tt.wantHow)
				}
				if !errors.Is(got.privilegeErr, tt.wantPriv) || (tt.wantPriv == nil && got.privilegeErr != nil) {
					t.Errorf("privilegeErr = %v, want %v", got.privilegeErr, tt.wantPriv)
				}
				if !errors.Is(got.primaryErr, tt.wantPrim) || (tt.wantPrim == nil && got.primaryErr != nil) {
					t.Errorf("primaryErr = %v, want %v", got.primaryErr, tt.wantPrim)
				}
			} else {
				if err == nil {
					t.Fatalf("want an error matching %v, got nil (result %+v)", tt.wantErr, got)
				}
				for _, want := range tt.wantErr {
					if !errors.Is(err, want) {
						t.Errorf("error %q does not wrap %q", err, want)
					}
				}
			}
			if !reflect.DeepEqual(h.events, tt.wantEvents) {
				t.Errorf("events = %v, want %v", h.events, tt.wantEvents)
			}
		})
	}
}
