//go:build windows

package config

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"github.com/spf13/viper"
	"golang.org/x/sys/windows"
)

// These tests are the #7620 regression: the Quick Support client is run by an
// end user WITHOUT elevation, and its config dir must still be secured.
// asStandardUser reproduces that token from any runner (elevated or not), so
// the CI step that runs them asserts zero skips.

var procCreateRestrictedToken = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")

const disableMaxPrivilege = 0x1

// asStandardUser runs fn on this OS thread while impersonating a filtered copy
// of the process token: BUILTIN\Administrators is deny-only and every
// privilege except SeChangeNotify is removed. That is what UAC hands a
// standard user (and an administrator's unelevated prompt) for the purposes
// that matter here: the token may assign only its own user SID as owner, and
// Administrators-granted access does not apply.
func asStandardUser(t *testing.T, fn func()) {
	t.Helper()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	var proc windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_IMPERSONATE, &proc); err != nil {
		t.Fatalf("open process token: %v", err)
	}
	defer func() { _ = proc.Close() }()

	disable := []windows.SIDAndAttributes{{Sid: admins}}
	var restricted windows.Token
	r, _, callErr := procCreateRestrictedToken.Call(
		uintptr(proc),
		disableMaxPrivilege,
		uintptr(len(disable)), uintptr(unsafe.Pointer(&disable[0])),
		0, 0,
		0, 0,
		uintptr(unsafe.Pointer(&restricted)),
	)
	if r == 0 {
		t.Fatalf("CreateRestrictedToken: %v", callErr)
	}
	defer func() { _ = restricted.Close() }()

	var imp windows.Token
	if err := windows.DuplicateTokenEx(restricted,
		windows.TOKEN_IMPERSONATE|windows.TOKEN_QUERY,
		nil, windows.SecurityImpersonation, windows.TokenImpersonation, &imp); err != nil {
		t.Fatalf("duplicate impersonation token: %v", err)
	}
	defer func() { _ = imp.Close() }()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.SetThreadToken(nil, imp); err != nil {
		t.Fatalf("impersonate filtered token: %v", err)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			panic("RevertToSelf failed; the test thread would keep the filtered token: " + err.Error())
		}
	}()

	// Sanity: the impersonated token really is the restricted one.
	if isAdminEnabled(t) {
		t.Fatal("impersonation did not take effect: Administrators is still enabled")
	}
	fn()
}

func isAdminEnabled(t *testing.T) bool {
	t.Helper()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	member, err := windows.Token(0).IsMember(admins) // 0 = effective (thread) token
	if err != nil {
		t.Fatal(err)
	}
	return member
}

func currentUserSID(t *testing.T) *windows.SID {
	t.Helper()
	sid, err := currentUserSIDFn()
	if err != nil {
		t.Fatal(err)
	}
	return sid
}

// assertUserPrivate checks path is owned by owner (when non-nil) and carries
// exactly the user-private PROTECTED DACL for user built from format.
func assertUserPrivate(t *testing.T, path string, user, owner *windows.SID, format string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("read security of %s: %v", path, err)
	}
	if owner != nil {
		got, _, err := sd.Owner()
		if err != nil {
			t.Fatal(err)
		}
		if !got.Equals(owner) {
			t.Errorf("%s owner = %v, want %v", path, got, owner)
		}
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Errorf("%s DACL is not protected", path)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	want := wantDACLOf(t, sprintfSDDL(format, user))
	if !equalMainAgentACL(dacl, want) {
		t.Errorf("%s DACL = %s, want only the user, SYSTEM and Administrators", path, sd.String())
	}
	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatal(err)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if (*windows.SID)(unsafe.Pointer(&ace.SidStart)).Equals(users) {
			t.Errorf("%s grants BUILTIN\\Users access", path)
		}
	}
}

func sprintfSDDL(format string, user *windows.SID) string {
	return fmt.Sprintf(format, user.String())
}

// TestUserWorkspaceStandardUserCannotClaimMachineConfigDir pins the #7620
// root cause and the boundary that must keep holding: a standard user's token
// may assign neither SYSTEM nor the Administrators fallback as owner, so the
// machine-wide config-dir policy fails for it (this is the exact error the
// Quick Support client hit). The installed agent's config dir must stay
// unclaimable by a standard user; the support client gets the user-private
// policy instead (tests below).
func TestUserWorkspaceStandardUserCannotClaimMachineConfigDir(t *testing.T) {
	dir := t.TempDir()
	var err error
	asStandardUser(t, func() { err = applyWindowsDACL(dir, windowsConfigDirSDDL) })
	if !errors.Is(err, windows.ERROR_INVALID_OWNER) {
		t.Fatalf("applyWindowsDACL as a standard user = %v, want ERROR_INVALID_OWNER", err)
	}
}

// TestUserWorkspaceStandardUserEnrollmentSaves is the #7620 acceptance test:
// as a standard user, the support workspace is created and secured, the
// enrollment pre-flight passes, SaveEnrollment writes agent.yaml and
// secrets.yaml, the user can read them back, and every one of them is owned
// by / private to that user, with no BUILTIN\Users access.
func TestUserWorkspaceStandardUserEnrollmentSaves(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	viper.Reset()
	t.Cleanup(viper.Reset)
	user := currentUserSID(t)
	ws := filepath.Join(t.TempDir(), "breeze-support-7620")
	cfgPath := filepath.Join(ws, "agent.yaml")

	asStandardUser(t, func() {
		if err := SecureUserWorkspace(ws); err != nil {
			t.Fatalf("SecureUserWorkspace as a standard user: %v", err)
		}
		if err := PrepareSaveDir(cfgPath); err != nil {
			t.Fatalf("PrepareSaveDir as a standard user (the #7620 failure): %v", err)
		}
		cfg := Default()
		cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
		cfg.ServerURL = "https://api.example.test"
		cfg.AuthToken = "brz_support_agent"
		cfg.HelperAuthToken = "brz_support_helper"
		if err := SaveEnrollment(cfg, cfgPath); err != nil {
			t.Fatalf("SaveEnrollment as a standard user: %v", err)
		}
		creds, err := readPersistedCredentialsAt(cfgPath)
		if err != nil {
			t.Fatalf("read back secrets.yaml as a standard user: %v", err)
		}
		if creds.AuthToken != "brz_support_agent" {
			t.Errorf("read-back auth token = %q", creds.AuthToken)
		}
		if _, err := os.ReadFile(cfgPath); err != nil {
			t.Errorf("read back agent.yaml as a standard user: %v", err)
		}
	})

	assertUserPrivate(t, ws, user, user, userWorkspaceDirSDDLFormat)
	assertUserPrivate(t, cfgPath, user, nil, userWorkspaceFileSDDLFormat)
	assertUserPrivate(t, filepath.Join(ws, "secrets.yaml"), user, nil, userWorkspaceFileSDDLFormat)
}

// TestUserWorkspaceRepairsAnExistingPermissiveDir: a pre-existing workspace
// directory of ours (a PID reused after a crashed session, or anything left
// with an inherited or widened ACL) is re-secured, not trusted as found.
func TestUserWorkspaceRepairsAnExistingPermissiveDir(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	user := currentUserSID(t)
	ws := filepath.Join(t.TempDir(), "breeze-support-7620")
	if err := os.Mkdir(ws, 0o777); err != nil {
		t.Fatal(err)
	}
	wide, err := windows.SecurityDescriptorFromString("D:(A;OICI;FA;;;WD)(A;OICI;FA;;;" + user.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	wideDACL, _, err := wide.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(ws, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, wideDACL, nil); err != nil {
		t.Fatal(err)
	}

	asStandardUser(t, func() {
		if err := SecureUserWorkspace(ws); err != nil {
			t.Fatalf("SecureUserWorkspace on an existing dir: %v", err)
		}
	})
	assertUserPrivate(t, ws, user, user, userWorkspaceDirSDDLFormat)
}

// TestUserWorkspaceRefusesJunction: a junction planted at the workspace path
// is refused, not followed: nothing is registered and the junction target's
// security descriptor is untouched.
func TestUserWorkspaceRefusesJunction(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	base := t.TempDir()
	target := filepath.Join(base, "elsewhere")
	if err := os.Mkdir(target, 0o777); err != nil {
		t.Fatal(err)
	}
	ws := filepath.Join(base, "breeze-support-7620")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", ws, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
	before := sddlOf(t, target)

	var err error
	asStandardUser(t, func() { err = SecureUserWorkspace(ws) })
	if err == nil || !strings.Contains(err.Error(), "refuse reparse-point") {
		t.Fatalf("SecureUserWorkspace on a junction = %v, want a reparse-point refusal", err)
	}
	if inUserWorkspace(ws) {
		t.Error("a refused workspace must not be registered")
	}
	if after := sddlOf(t, target); after != before {
		t.Errorf("junction target security changed:\nbefore %s\nafter  %s", before, after)
	}
}

func sddlOf(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return sd.String()
}

// TestUserWorkspaceCallerTokenOwnsWorkspace: run with the process token as
// is (elevated on the CI runner, i.e. an administrator who ran Quick Support
// from an elevated prompt), the same policy applies: the owner is still the
// caller's own user, no privilege needed, and the workspace is registered.
func TestUserWorkspaceCallerTokenOwnsWorkspace(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	user := currentUserSID(t)
	ws := filepath.Join(t.TempDir(), "breeze-support-7620")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	assertUserPrivate(t, ws, user, user, userWorkspaceDirSDDLFormat)
	if !inUserWorkspace(filepath.Join(ws, "secrets.yaml")) {
		t.Error("secured workspace not registered")
	}
}

// TestUserWorkspaceRefusesForeignOwnedDir: a pre-existing directory another
// principal owns is refused even when its DACL would let this user take it
// over, and is left exactly as found.
func TestUserWorkspaceRefusesForeignOwnedDir(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("needs an elevated token holding SeRestorePrivilege to plant a foreign owner")
	}
	ws := filepath.Join(t.TempDir(), "breeze-support-7620")
	if err := os.Mkdir(ws, 0o777); err != nil {
		t.Fatal(err)
	}
	// Owner BUILTIN\Users stands in for "another account": not the caller,
	// not SYSTEM, not Administrators. Everyone-FA so access is not what
	// stops the takeover.
	foreign, err := windows.SecurityDescriptorFromString("O:BUD:(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	fOwner, _, _ := foreign.Owner()
	fDACL, _, _ := foreign.DACL()
	release, err := enableRestorePrivilege()
	if err != nil {
		t.Fatalf("enable SeRestorePrivilege: %v", err)
	}
	err = windows.SetNamedSecurityInfo(ws, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION, fOwner, nil, fDACL, nil)
	release()
	if err != nil {
		t.Fatalf("plant foreign owner: %v", err)
	}
	before := sddlOf(t, ws)

	asStandardUser(t, func() { err = SecureUserWorkspace(ws) })
	if err == nil || !strings.Contains(err.Error(), "not the current user") {
		t.Fatalf("SecureUserWorkspace on a foreign-owned dir = %v, want an owner refusal", err)
	}
	if inUserWorkspace(ws) {
		t.Error("a refused workspace must not be registered")
	}
	if after := sddlOf(t, ws); after != before {
		t.Errorf("foreign-owned dir security changed:\nbefore %s\nafter  %s", before, after)
	}
}

// TestUserWorkspaceLeavesMachineConfigPolicyAlone: registering a workspace
// changes nothing outside it. The installed agent's config dir, agent.yaml and
// secrets.yaml keep the machine-wide descriptors, including the SYSTEM owner
// and the #7394 privilege/fallback path, exactly as before.
func TestUserWorkspaceLeavesMachineConfigPolicyAlone(t *testing.T) {
	t.Cleanup(resetUserWorkspaceForTest)
	if err := SecureUserWorkspace(filepath.Join(t.TempDir(), "breeze-support-7620")); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	machine := filepath.Join(t.TempDir(), "Breeze")
	if err := os.Mkdir(machine, 0o755); err != nil {
		t.Fatal(err)
	}

	calls, _ := stubOwnerSeams(t, nil, refuseSystemOwnerWithoutPrivilege)
	if err := enforceConfigDirPermissions(machine); err != nil {
		t.Fatalf("enforceConfigDirPermissions: %v", err)
	}
	if err := enforceConfigFilePermissions(filepath.Join(machine, "agent.yaml")); err != nil {
		t.Fatalf("enforceConfigFilePermissions: %v", err)
	}
	if err := enforceSecretFilePermissions(filepath.Join(machine, "secrets.yaml")); err != nil {
		t.Fatalf("enforceSecretFilePermissions: %v", err)
	}
	if len(*calls) != 4 {
		t.Fatalf("SetNamedSecurityInfo calls = %d, want 4 (dir refused, dir with privilege, agent.yaml, secrets.yaml)", len(*calls))
	}
	dir := (*calls)[1]
	if !dir.owner.IsWellKnown(windows.WinLocalSystemSid) {
		t.Errorf("machine config dir owner = %v, want LocalSystem", dir.owner)
	}
	if !equalMainAgentACL(dir.dacl, wantDACLOf(t, windowsConfigDirSDDL)) {
		t.Error("machine config dir must keep windowsConfigDirSDDL's DACL")
	}
	if !equalMainAgentACL((*calls)[2].dacl, wantDACLOf(t, windowsConfigFileSDDL)) {
		t.Error("machine agent.yaml must keep windowsConfigFileSDDL's DACL (Helper read)")
	}
	if !equalMainAgentACL((*calls)[3].dacl, wantDACLOf(t, windowsSecretFileSDDL)) {
		t.Error("machine secrets.yaml must keep windowsSecretFileSDDL's DACL")
	}
}
