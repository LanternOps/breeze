package winupdate

import "testing"

func TestPlanTargetRelease(t *testing.T) {
	pin := &TargetRelease{ProductVersion: "Windows 11", TargetVersion: "25H2"}

	t.Run("pin with nothing present writes the policy and claims ownership", func(t *testing.T) {
		p := planTargetRelease(pin, targetReleaseState{})
		if !p.write || p.revert {
			t.Fatalf("plan = %+v, want write", p)
		}
		if !p.result.Managed || !p.result.Enforced || !p.result.Supported {
			t.Errorf("result = %+v, want managed+enforced", p.result)
		}
	})

	t.Run("pin over an admin-set TargetReleaseVersion leaves it as-found", func(t *testing.T) {
		st := targetReleaseState{keyExists: true, targetPresent: true, targetVersion: "24H2", productVersion: "Windows 11", breezeManaged: false}
		p := planTargetRelease(pin, st)
		if p.write || p.revert {
			t.Fatalf("plan = %+v, want no mutation", p)
		}
		if p.result.Managed {
			t.Error("Breeze must not claim an admin's policy")
		}
		if p.result.Reason == "" {
			t.Error("reason should name the pre-existing policy")
		}
	})

	t.Run("pin re-asserts a Breeze-owned policy", func(t *testing.T) {
		st := targetReleaseState{keyExists: true, targetPresent: true, targetVersion: "24H2", productVersion: "Windows 11", breezeManaged: true}
		p := planTargetRelease(pin, st)
		if !p.write {
			t.Fatalf("plan = %+v, want write (move the pin from 24H2 to 25H2)", p)
		}
		if !p.result.Managed {
			t.Error("result should stay managed")
		}
	})

	t.Run("revert deletes only a Breeze-owned policy", func(t *testing.T) {
		st := targetReleaseState{keyExists: true, targetPresent: true, targetVersion: "25H2", productVersion: "Windows 11", breezeManaged: true}
		p := planTargetRelease(nil, st)
		if !p.revert || p.write {
			t.Fatalf("plan = %+v, want revert", p)
		}
		if p.result.Managed || p.result.Enforced || !p.result.Reverted {
			t.Errorf("result = %+v, want reverted and unmanaged", p.result)
		}
	})

	t.Run("revert leaves an admin-set policy as-found", func(t *testing.T) {
		st := targetReleaseState{keyExists: true, targetPresent: true, targetEnabled: true, targetVersion: "24H2", breezeManaged: false}
		p := planTargetRelease(nil, st)
		if p.revert || p.write {
			t.Fatalf("plan = %+v, want no mutation", p)
		}
		if !p.result.Enforced {
			t.Error("an admin pin is still in effect and should be reported as enforced")
		}
	})

	t.Run("revert with nothing present is a no-op", func(t *testing.T) {
		p := planTargetRelease(nil, targetReleaseState{})
		if p.revert || p.write || p.result.Enforced || p.result.Reverted {
			t.Fatalf("plan = %+v, want nothing", p)
		}
	})
}

func TestExecuteTargetReleaseRevert(t *testing.T) {
	t.Run("deletes the three policy values and the sentinel", func(t *testing.T) {
		k := &fakeRegKey{deleteErr: map[string]error{}}
		if err := executeTargetReleaseRevert(k, fakeIsNotExist); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []string{targetReleaseVersionValue, targetReleaseVersionInfoValue, productVersionValue, breezeManagedTargetReleaseValue}
		if len(k.deleted) != len(want) {
			t.Fatalf("deleted %v, want %v", k.deleted, want)
		}
		for i, name := range want {
			if k.deleted[i] != name {
				t.Errorf("deleted[%d] = %q, want %q", i, k.deleted[i], name)
			}
		}
	})

	t.Run("a missing value is tolerated", func(t *testing.T) {
		k := &fakeRegKey{deleteErr: map[string]error{productVersionValue: errFakeNotExist}}
		if err := executeTargetReleaseRevert(k, fakeIsNotExist); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("a real delete failure propagates", func(t *testing.T) {
		k := &fakeRegKey{deleteErr: map[string]error{targetReleaseVersionValue: errFakeAccessDenied}}
		if err := executeTargetReleaseRevert(k, fakeIsNotExist); err == nil {
			t.Fatal("expected the access-denied error to propagate")
		}
	})
}
