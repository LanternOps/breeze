//go:build windows

package backup

import (
	"errors"
	"testing"
)

// forceDisabledForTest disables name on the process token for the rest of
// the test (restoring its original state in Cleanup), so a later "enabled"
// observation can only come from the code under test and a later
// "disabled" observation proves that code released it. It refuses to run
// while any acquirePrivilege scope in this process still holds name: the
// ref count would otherwise be corrupted.
func forceDisabledForTest(t *testing.T, name string) {
	t.Helper()
	privMu.Lock()
	r := privRefs[name]
	held := r != nil && r.refs > 0
	privMu.Unlock()
	if held {
		t.Fatalf("%s is held by a live acquirePrivilege scope; test isolation broken", name)
	}
	was, err := setPrivilege(name, false)
	if err != nil {
		t.Fatalf("disable %s: %v", name, err)
	}
	t.Cleanup(func() {
		if _, err := setPrivilege(name, was); err != nil {
			t.Errorf("restore %s to enabled=%v: %v", name, was, err)
		}
	})
	if privilegeEnabledForTest(t, name) {
		t.Fatalf("%s still enabled after disabling it", name)
	}
}

// TestAcquireHivePrivileges_ScopesRelease proves AcquireHivePrivileges
// really enables SeBackupPrivilege AND SeRestorePrivilege (RegLoadKeyW /
// RegUnLoadKeyW need both) and that its release really drops them again:
// both start force-disabled, so neither the in-scope "enabled" check nor
// the post-release "disabled" check can pass vacuously.
//
// Skips — loudly — on a non-elevated token that lacks either privilege.
// Task 13's Windows gate lists this test as must-not-skip.
func TestAcquireHivePrivileges_ScopesRelease(t *testing.T) {
	privs := []string{"SeBackupPrivilege", "SeRestorePrivilege"}
	for _, p := range privs {
		if !privilegeHeldForTest(t, p) {
			t.Skipf("process token does not hold %s (non-elevated runner): privilege-scope assertions would be vacuous — run elevated", p)
		}
	}
	for _, p := range privs {
		forceDisabledForTest(t, p)
	}
	release, err := AcquireHivePrivileges()
	if err != nil {
		t.Fatalf("AcquireHivePrivileges: %v", err)
	}
	for _, p := range privs {
		if !privilegeEnabledForTest(t, p) {
			t.Errorf("%s not enabled inside the AcquireHivePrivileges scope", p)
		}
	}
	release()
	release() // idempotent: a second call must not underflow the ref count
	for _, p := range privs {
		if privilegeEnabledForTest(t, p) {
			t.Errorf("%s still enabled after release", p)
		}
		privMu.Lock()
		refs := 0
		if r := privRefs[p]; r != nil {
			refs = r.refs
		}
		privMu.Unlock()
		if refs != 0 {
			t.Errorf("%s ref count = %d after release, want 0", p, refs)
		}
	}
}

// TestAcquirePrivileges_PartialFailureReleasesEarlier proves the
// all-or-nothing contract AcquireHivePrivileges is built on: when a later
// privilege cannot be acquired, the ones already enabled are released
// before the error returns.
func TestAcquirePrivileges_PartialFailureReleasesEarlier(t *testing.T) {
	if !privilegeHeldForTest(t, "SeBackupPrivilege") {
		t.Skip("process token does not hold SeBackupPrivilege (non-elevated runner): the partial-failure release would be vacuous — run elevated")
	}
	forceDisabledForTest(t, "SeBackupPrivilege")
	release, err := acquirePrivileges("SeBackupPrivilege", "SeNotARealPrivilegeName")
	if err == nil {
		release()
		t.Fatal("acquirePrivileges with a bogus privilege name succeeded")
	}
	if release == nil {
		t.Fatal("acquirePrivileges returned a nil release on error")
	}
	release() // must be a safe no-op
	if privilegeEnabledForTest(t, "SeBackupPrivilege") {
		t.Error("SeBackupPrivilege left enabled after the second privilege failed")
	}
	if errors.Is(err, errPrivNotHeld) {
		t.Errorf("error = %v; a bogus name should fail at LookupPrivilegeValue, not as not-held", err)
	}
}
