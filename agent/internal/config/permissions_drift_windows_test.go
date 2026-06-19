//go:build windows

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// TestProgramDataDirACLDriftDetectAndHeal exercises the #1481 self-heal on a
// real DACL: a dir carrying a BUILTIN\Users ACE (the default ProgramData state
// left when the MSI HardenProgramDataAcl was skipped/blocked) is detected as
// drifted, re-hardened, and afterward grants only SYSTEM + Administrators.
func TestProgramDataDirACLDriftDetectAndHeal(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	if err := windowsMkdirWithUsersACE(t, dir); err != nil {
		t.Fatalf("seed default-ACL dir: %v", err)
	}

	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(Users): %v", err)
	}
	systemSID, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(System): %v", err)
	}
	adminsSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(Admins): %v", err)
	}

	// Before: a Users ACE is present, so drift must be reported.
	drifted, err := programDataDirACLDrifted(dir)
	if err != nil {
		t.Fatalf("programDataDirACLDrifted (pre): %v", err)
	}
	if !drifted {
		t.Fatal("expected drift on a dir with a BUILTIN\\Users ACE")
	}

	// Heal it.
	if err := enforceProgramDataDirPermissions(dir); err != nil {
		t.Fatalf("enforceProgramDataDirPermissions: %v", err)
	}

	// After: no Users ACE, no drift, and SYSTEM + Administrators retained.
	drifted, err = programDataDirACLDrifted(dir)
	if err != nil {
		t.Fatalf("programDataDirACLDrifted (post): %v", err)
	}
	if drifted {
		t.Error("drift must clear after re-hardening")
	}
	if daclGrantsSID(t, dir, usersSID) {
		t.Error("hardened logs dir must NOT grant BUILTIN\\Users")
	}
	if !daclGrantsSID(t, dir, systemSID) {
		t.Error("hardened logs dir must grant SYSTEM full control")
	}
	if !daclGrantsSID(t, dir, adminsSID) {
		t.Error("hardened logs dir must grant Administrators full control")
	}
}

// TestProgramDataDirSDDLExcludesUsers locks the hardened DACL string so a future
// edit can't silently re-introduce Users access to the logs/data trees.
func TestProgramDataDirSDDLExcludesUsers(t *testing.T) {
	if !strings.HasPrefix(windowsProgramDataDirSDDL, "D:P") {
		t.Errorf("ProgramData DACL must be PROTECTED (D:P prefix): %s", windowsProgramDataDirSDDL)
	}
	if strings.Contains(windowsProgramDataDirSDDL, "BU") || strings.Contains(windowsProgramDataDirSDDL, "IU") {
		t.Errorf("ProgramData DACL must NOT grant Users/Interactive: %s", windowsProgramDataDirSDDL)
	}
	if _, err := windows.SecurityDescriptorFromString(windowsProgramDataDirSDDL); err != nil {
		t.Errorf("ProgramData DACL does not parse: %v", err)
	}
}

// windowsMkdirWithUsersACE creates dir and sets a non-protected DACL that grants
// BUILTIN\Users read+execute, simulating the default ProgramData ACL the MSI
// hardening would otherwise strip.
func windowsMkdirWithUsersACE(t *testing.T, dir string) error {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return applyWindowsDACL(dir, `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)`)
}
