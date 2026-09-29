//go:build windows

package config

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

// securityCall is one SetNamedSecurityInfo call captured by stubSetNamedSecurityInfo.
type securityCall struct {
	info  windows.SECURITY_INFORMATION
	owner *windows.SID
	group *windows.SID
	dacl  *windows.ACL
}

// stubOwnerSeams replaces the SetNamedSecurityInfo and privilege seams for one
// test. set decides each call's result; privEnabled reports whether the stub
// privilege is currently held, so set can refuse SYSTEM without it, the way
// the real kernel check does for an elevated administrator.
func stubOwnerSeams(t *testing.T, privErr error, set func(c securityCall, privEnabled bool) error) (calls *[]securityCall, released *int) {
	t.Helper()
	oldSet, oldEnable := setNamedSecurityInfoFn, enableRestorePrivilegeFn
	t.Cleanup(func() { setNamedSecurityInfoFn, enableRestorePrivilegeFn = oldSet, oldEnable })

	var got []securityCall
	var rel int
	privEnabled := false
	setNamedSecurityInfoFn = func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, owner, group *windows.SID, dacl, _ *windows.ACL) error {
		c := securityCall{info: info, owner: owner, group: group, dacl: dacl}
		got = append(got, c)
		return set(c, privEnabled)
	}
	enableRestorePrivilegeFn = func() (func(), error) {
		if privErr != nil {
			return nil, privErr
		}
		privEnabled = true
		return func() { privEnabled = false; rel++ }, nil
	}
	return &got, &rel
}

func refuseSystemOwnerWithoutPrivilege(c securityCall, privEnabled bool) error {
	if c.owner != nil && c.owner.IsWellKnown(windows.WinLocalSystemSid) && !privEnabled {
		return windows.ERROR_INVALID_OWNER
	}
	return nil
}

func wantDACLOf(t *testing.T, sddl string) *windows.ACL {
	t.Helper()
	dacl, _, err := mustWindowsSecurityDescriptor(t, sddl).DACL()
	if err != nil {
		t.Fatal(err)
	}
	return dacl
}

const fullOwnerInfo = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION |
	windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION

// TestApplyWindowsDACLAssignsSystemOwnerWithRestorePrivilege: an elevated
// administrator is refused SYSTEM as owner until SeRestorePrivilege is
// enabled (#7394); with it, the SYSTEM owner #7199 wants is still written, and
// the privilege is released again.
func TestApplyWindowsDACLAssignsSystemOwnerWithRestorePrivilege(t *testing.T) {
	calls, released := stubOwnerSeams(t, nil, refuseSystemOwnerWithoutPrivilege)

	if err := applyWindowsDACL(t.TempDir(), windowsConfigDirSDDL); err != nil {
		t.Fatalf("applyWindowsDACL: %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("SetNamedSecurityInfo calls = %d, want 2 (refused, then with privilege)", len(*calls))
	}
	last := (*calls)[1]
	if !last.owner.IsWellKnown(windows.WinLocalSystemSid) {
		t.Errorf("owner = %v, want LocalSystem", last.owner)
	}
	if last.info != fullOwnerInfo {
		t.Errorf("info = %#x, want %#x", last.info, fullOwnerInfo)
	}
	if *released != 1 {
		t.Errorf("privilege released %d times, want 1", *released)
	}
}

// TestApplyWindowsDACLFallsBackToAdministratorsOwner is the #7394 regression:
// when SYSTEM cannot be assigned even with the privilege path (here the token
// does not hold SeRestorePrivilege), the config dir must still be secured, with
// BUILTIN\Administrators as owner and group and the same PROTECTED DACL,
// instead of failing the enrollment.
func TestApplyWindowsDACLFallsBackToAdministratorsOwner(t *testing.T) {
	for name, sddl := range map[string]string{
		"config dir":      windowsConfigDirSDDL,
		"ProgramData dir": windowsProgramDataDirSDDL,
	} {
		t.Run(name, func(t *testing.T) {
			calls, _ := stubOwnerSeams(t, errRestorePrivilegeNotHeld, refuseSystemOwnerWithoutPrivilege)

			if err := applyWindowsDACL(t.TempDir(), sddl); err != nil {
				t.Fatalf("applyWindowsDACL must fall back, not fail: %v", err)
			}
			if len(*calls) != 2 {
				t.Fatalf("SetNamedSecurityInfo calls = %d, want 2 (SYSTEM refused, Administrators fallback)", len(*calls))
			}
			fb := (*calls)[1]
			if fb.owner == nil || !fb.owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
				t.Errorf("fallback owner = %v, want BUILTIN\\Administrators", fb.owner)
			}
			if !trustedMainAgentOwner(fb.owner) {
				t.Errorf("fallback owner %v is not an owner trustedMainAgentOwner accepts", fb.owner)
			}
			if fb.group == nil || !fb.group.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
				t.Errorf("fallback group = %v, want BUILTIN\\Administrators", fb.group)
			}
			if fb.info != fullOwnerInfo {
				t.Errorf("fallback info = %#x, want owner+group+PROTECTED DACL %#x", fb.info, fullOwnerInfo)
			}
			if !equalMainAgentACL(fb.dacl, wantDACLOf(t, sddl)) {
				t.Error("fallback must write the same protected DACL as the preferred descriptor")
			}
		})
	}
}

// TestApplyWindowsDACLDoesNotMaskOtherErrors: only ERROR_INVALID_OWNER may
// trigger the fallback. Access denied (for example a directory whose DACL
// does not let this caller write it) must fail as before.
func TestApplyWindowsDACLDoesNotMaskOtherErrors(t *testing.T) {
	calls, _ := stubOwnerSeams(t, nil, func(securityCall, bool) error { return windows.ERROR_ACCESS_DENIED })

	err := applyWindowsDACL(t.TempDir(), windowsConfigDirSDDL)
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("err = %v, want ERROR_ACCESS_DENIED", err)
	}
	if len(*calls) != 1 {
		t.Errorf("SetNamedSecurityInfo calls = %d, want 1 (no retry, no fallback)", len(*calls))
	}
}

// TestApplyWindowsDACLWithoutOwnerLeavesOwnerAlone: file SDDLs carry no owner,
// so they must set the DACL only and never touch the privilege.
func TestApplyWindowsDACLWithoutOwnerLeavesOwnerAlone(t *testing.T) {
	calls, released := stubOwnerSeams(t, errors.New("privilege must not be requested"), func(securityCall, bool) error { return nil })

	if err := applyWindowsDACL(t.TempDir(), windowsConfigFileSDDL); err != nil {
		t.Fatalf("applyWindowsDACL: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("SetNamedSecurityInfo calls = %d, want 1", len(*calls))
	}
	c := (*calls)[0]
	if c.info&windows.OWNER_SECURITY_INFORMATION != 0 || c.owner != nil {
		t.Errorf("owner must not be written for an owner-less SDDL (info %#x, owner %v)", c.info, c.owner)
	}
	if *released != 0 {
		t.Errorf("privilege released %d times, want 0", *released)
	}
}

// disableRestorePrivilegeForTest puts this process's token into the state of
// an interactive elevated administrator prompt: SeRestorePrivilege held but
// disabled. Remote shells (OpenSSH, some CI runners) run with it already
// enabled, which hides #7394. The previous state is restored at cleanup.
// It reports whether the token holds the privilege at all.
func disableRestorePrivilegeForTest(t *testing.T) (held bool) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("needs an elevated token: a filtered token may not assign SYSTEM or Administrators as owner")
	}
	wasEnabled, err := setRestorePrivilege(false)
	if errors.Is(err, errRestorePrivilegeNotHeld) {
		return false
	}
	if err != nil {
		t.Fatalf("disable SeRestorePrivilege: %v", err)
	}
	t.Cleanup(func() {
		if wasEnabled {
			_, _ = setRestorePrivilege(true)
		}
	})
	return true
}

func runningAsLocalSystem(t *testing.T) bool {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
}

// assertSecuredLike checks dir carries a trusted owner and exactly sddl's
// protected DACL, and returns the owner.
func assertSecuredLike(t *testing.T, dir, sddl string) *windows.SID {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatal(err)
	}
	if !trustedMainAgentOwner(owner) {
		t.Errorf("owner = %v, want LocalSystem or BUILTIN\\Administrators", owner)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Error("DACL is not protected")
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if !equalMainAgentACL(dacl, wantDACLOf(t, sddl)) {
		t.Error("DACL does not match the requested SDDL")
	}
	return owner
}

// TestApplyWindowsDACLRealTokenSecuresConfigDir runs the real syscalls from an
// elevated administrator token with SeRestorePrivilege disabled, the state
// #7394 was reported from. Before the fix this returned "This security ID may
// not be assigned as the owner of this object." With it, the privilege path
// assigns SYSTEM (or, on a token without the privilege, the fallback assigns
// BUILTIN\Administrators; either way the directory is secured).
func TestApplyWindowsDACLRealTokenSecuresConfigDir(t *testing.T) {
	held := disableRestorePrivilegeForTest(t)
	dir := t.TempDir()
	if err := applyWindowsDACL(dir, windowsConfigDirSDDL); err != nil {
		t.Fatalf("applyWindowsDACL on the config dir: %v", err)
	}
	owner := assertSecuredLike(t, dir, windowsConfigDirSDDL)
	if held && !owner.IsWellKnown(windows.WinLocalSystemSid) {
		t.Errorf("owner = %v, want LocalSystem: the token holds SeRestorePrivilege, so the privilege path must assign it", owner)
	}
}

// TestApplyWindowsDACLRealTokenFallbackWritesAdministratorsOwner exercises the
// fallback through the real SetNamedSecurityInfo: with the privilege path
// unavailable, an elevated administrator still secures the directory, owned
// by BUILTIN\Administrators, with the protected DACL.
func TestApplyWindowsDACLRealTokenFallbackWritesAdministratorsOwner(t *testing.T) {
	disableRestorePrivilegeForTest(t)
	if runningAsLocalSystem(t) {
		t.Skip("LocalSystem assigns itself as owner directly; the fallback is unreachable")
	}
	oldEnable := enableRestorePrivilegeFn
	t.Cleanup(func() { enableRestorePrivilegeFn = oldEnable })
	enableRestorePrivilegeFn = func() (func(), error) { return nil, errRestorePrivilegeNotHeld }

	dir := t.TempDir()
	if err := applyWindowsDACL(dir, windowsProgramDataDirSDDL); err != nil {
		t.Fatalf("applyWindowsDACL must fall back, not fail: %v", err)
	}
	owner := assertSecuredLike(t, dir, windowsProgramDataDirSDDL)
	if !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Errorf("owner = %v, want BUILTIN\\Administrators", owner)
	}
}
