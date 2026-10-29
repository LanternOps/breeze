package winupdate

import (
	"strings"
	"testing"
)

// Issue #10305: ownership must key on ANY of the three policy values, not just
// the TargetReleaseVersion DWORD. An admin who set only TargetReleaseVersionInfo
// (or only ProductVersion) was overwritten by a ring pin and then deleted by a
// ring block.
func TestPlanTargetReleasePartialAdminPolicy(t *testing.T) {
	pin := &TargetRelease{ProductVersion: "Windows 11", TargetVersion: "25H2"}

	cases := []struct {
		name string
		st   targetReleaseState
	}{
		{"info only", targetReleaseState{keyExists: true, infoPresent: true, targetVersion: "23H2"}},
		{"product only", targetReleaseState{keyExists: true, productPresent: true, productVersion: "Windows 11"}},
		{"info + product, no DWORD", targetReleaseState{keyExists: true, infoPresent: true, targetVersion: "23H2", productPresent: true, productVersion: "Windows 11"}},
		{"DWORD 0 only", targetReleaseState{keyExists: true, targetPresent: true}},
	}
	for _, tc := range cases {
		t.Run("pin leaves admin "+tc.name+" as-found", func(t *testing.T) {
			p := planTargetRelease(pin, tc.st)
			if p.write || p.revert {
				t.Fatalf("plan = %+v, want no mutation", p)
			}
			if p.result.Managed {
				t.Error("Breeze must not claim an admin's partial policy")
			}
			if p.result.Enforced {
				t.Error("without TargetReleaseVersion=1 the admin policy is inert; must not report enforced")
			}
			if !strings.Contains(p.result.Reason, "not managed by Breeze") {
				t.Errorf("reason = %q, want it to say not managed by Breeze", p.result.Reason)
			}
		})
		t.Run("revert leaves admin "+tc.name+" as-found", func(t *testing.T) {
			p := planTargetRelease(nil, tc.st)
			if p.write || p.revert {
				t.Fatalf("plan = %+v, want no mutation", p)
			}
		})
	}

	t.Run("reason names the admin's Info value", func(t *testing.T) {
		p := planTargetRelease(pin, targetReleaseState{keyExists: true, infoPresent: true, targetVersion: "23H2"})
		if !strings.Contains(p.result.Reason, "TargetReleaseVersionInfo=23H2") {
			t.Errorf("reason = %q, want it to name TargetReleaseVersionInfo=23H2", p.result.Reason)
		}
	})

	t.Run("a Breeze sentinel with only partial values is still Breeze-owned", func(t *testing.T) {
		// The sentinel is written first; a crash mid-write leaves a partial set
		// that Breeze must still converge or clean up.
		st := targetReleaseState{keyExists: true, infoPresent: true, targetVersion: "25H2", breezeManaged: true}
		if p := planTargetRelease(pin, st); !p.write || !p.result.Managed {
			t.Fatalf("pin plan = %+v, want write+managed", p)
		}
		if p := planTargetRelease(nil, st); !p.revert {
			t.Fatalf("revert plan = %+v, want revert", p)
		}
	})
}

// Issue #10305 part 2: a moved pin must not log "already pinned".
func TestPlanTargetReleaseReasonWording(t *testing.T) {
	owned := func(target string) targetReleaseState {
		return targetReleaseState{keyExists: true, targetPresent: true, targetEnabled: true, infoPresent: true, productPresent: true,
			targetVersion: target, productVersion: "Windows 11", breezeManaged: true}
	}

	t.Run("unchanged pin says re-asserted", func(t *testing.T) {
		p := planTargetRelease(&TargetRelease{ProductVersion: "Windows 11", TargetVersion: "25H2"}, owned("25H2"))
		if !strings.Contains(p.result.Reason, "already pinned") {
			t.Errorf("reason = %q", p.result.Reason)
		}
	})

	t.Run("changed pin says moved, from and to", func(t *testing.T) {
		p := planTargetRelease(&TargetRelease{ProductVersion: "Windows 11", TargetVersion: "24H2"}, owned("25H2"))
		if strings.Contains(p.result.Reason, "already pinned") {
			t.Errorf("reason = %q must not say already pinned on a changed target", p.result.Reason)
		}
		if !strings.Contains(p.result.Reason, "moved") || !strings.Contains(p.result.Reason, "25H2") || !strings.Contains(p.result.Reason, "24H2") {
			t.Errorf("reason = %q, want 'moved' with old and new targets", p.result.Reason)
		}
	})
}

// fakeValueReader implements targetReleaseValueReader for observeTargetRelease.
type fakeValueReader struct {
	ints    map[string]uint64
	strs    map[string]string
	readErr map[string]error
}

func (f *fakeValueReader) GetIntegerValue(name string) (uint64, uint32, error) {
	if e := f.readErr[name]; e != nil {
		return 0, 0, e
	}
	if v, ok := f.ints[name]; ok {
		return v, 4, nil
	}
	return 0, 0, errFakeNotExist
}

func (f *fakeValueReader) GetStringValue(name string) (string, uint32, error) {
	if e := f.readErr[name]; e != nil {
		return "", 0, e
	}
	if v, ok := f.strs[name]; ok {
		return v, 1, nil
	}
	return "", 0, errFakeNotExist
}

func TestObserveTargetRelease(t *testing.T) {
	t.Run("admin Info without DWORD is observed as present", func(t *testing.T) {
		st := observeTargetRelease(&fakeValueReader{strs: map[string]string{targetReleaseVersionInfoValue: "23H2"}}, fakeIsNotExist)
		if !st.keyExists || !st.infoPresent || st.targetVersion != "23H2" || st.targetPresent || st.breezeManaged {
			t.Fatalf("state = %+v", st)
		}
	})

	t.Run("an empty-string Info is still present", func(t *testing.T) {
		st := observeTargetRelease(&fakeValueReader{strs: map[string]string{targetReleaseVersionInfoValue: ""}}, fakeIsNotExist)
		if !st.infoPresent {
			t.Fatalf("state = %+v, want infoPresent", st)
		}
	})

	t.Run("a value of the wrong type or unreadable counts as present", func(t *testing.T) {
		st := observeTargetRelease(&fakeValueReader{readErr: map[string]error{
			targetReleaseVersionValue:     errFakeAccessDenied,
			targetReleaseVersionInfoValue: errFakeAccessDenied,
			productVersionValue:           errFakeAccessDenied,
		}}, fakeIsNotExist)
		if !st.targetPresent || !st.infoPresent || !st.productPresent || st.targetEnabled {
			t.Fatalf("state = %+v, want all present, not enabled", st)
		}
	})

	t.Run("an unreadable sentinel is not Breeze ownership", func(t *testing.T) {
		st := observeTargetRelease(&fakeValueReader{
			strs:    map[string]string{targetReleaseVersionInfoValue: "23H2"},
			readErr: map[string]error{breezeManagedTargetReleaseValue: errFakeAccessDenied},
		}, fakeIsNotExist)
		if st.breezeManaged {
			t.Fatal("unreadable sentinel must not grant ownership")
		}
	})

	t.Run("full Breeze set", func(t *testing.T) {
		st := observeTargetRelease(&fakeValueReader{
			ints: map[string]uint64{targetReleaseVersionValue: 1, breezeManagedTargetReleaseValue: 1},
			strs: map[string]string{targetReleaseVersionInfoValue: "25H2", productVersionValue: "Windows 11"},
		}, fakeIsNotExist)
		want := targetReleaseState{keyExists: true, targetPresent: true, targetEnabled: true, infoPresent: true, productPresent: true,
			targetVersion: "25H2", productVersion: "Windows 11", breezeManaged: true}
		if st != want {
			t.Fatalf("state = %+v, want %+v", st, want)
		}
	})
}
