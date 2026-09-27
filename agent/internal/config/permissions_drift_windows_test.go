//go:build windows

package config

import (
	"errors"
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
// edit can't silently re-introduce Users access to the logs/data trees, and
// that it also carries an explicit trusted owner — a bare DACL rewrite never
// touches an existing directory's owner, so a pre-created directory's owner
// (and its implicit WRITE_DAC) would otherwise survive hardening forever.
func TestProgramDataDirSDDLExcludesUsers(t *testing.T) {
	if !strings.HasPrefix(windowsProgramDataDirSDDL, "O:SYG:SYD:P") {
		t.Errorf("ProgramData SDDL must set an explicit SYSTEM owner/group ahead of a PROTECTED DACL (O:SYG:SYD:P prefix): %s", windowsProgramDataDirSDDL)
	}
	if strings.Contains(windowsProgramDataDirSDDL, "BU") || strings.Contains(windowsProgramDataDirSDDL, "IU") {
		t.Errorf("ProgramData DACL must NOT grant Users/Interactive: %s", windowsProgramDataDirSDDL)
	}
	sd, err := windows.SecurityDescriptorFromString(windowsProgramDataDirSDDL)
	if err != nil {
		t.Fatalf("ProgramData SDDL does not parse: %v", err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatalf("read owner: %v", err)
	}
	if !trustedMainAgentOwner(owner) {
		t.Errorf("ProgramData SDDL owner must be LocalSystem or BUILTIN\\Administrators, got %v", owner)
	}
}

// TestProgramDataDirACLDriftDetectsUntrustedOwner covers the case this
// hardening exists for: a directory a standard user pre-created (and
// therefore owns) before install/startup hardening ran. Even after its DACL
// is rewritten to grant only SYSTEM/Administrators, the original owner keeps
// an implicit WRITE_DAC unless the owner itself is repaired — so drift
// detection must treat an untrusted owner as drift on its own, independent
// of which ACEs are present.
func TestProgramDataDirACLDriftDetectsUntrustedOwner(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Simulate a directory already hardened to SYSTEM/Administrators-only ACEs
	// but never had its owner corrected (the pre-fix applyWindowsDACL shape).
	if err := applyWindowsDACL(dir, `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`); err != nil {
		t.Fatalf("seed hardened-DACL-but-unrepaired-owner dir: %v", err)
	}
	// The test process itself is the "untrusted" owner here (neither SYSTEM
	// nor Administrators in the general case), so no further owner
	// manipulation is needed to exercise the untrusted-owner branch.
	owner, _, err := func() (*windows.SID, bool, error) {
		sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err != nil {
			return nil, false, err
		}
		return sd.Owner()
	}()
	if err != nil {
		t.Fatalf("read seeded owner: %v", err)
	}
	if trustedMainAgentOwner(owner) {
		t.Skip("test process owner is already SYSTEM/Administrators — cannot exercise the untrusted-owner branch in this environment")
	}

	drifted, err := programDataDirACLDrifted(dir)
	if err != nil {
		t.Fatalf("programDataDirACLDrifted: %v", err)
	}
	if !drifted {
		t.Error("expected drift on a dir with SY/BA-only ACEs but an untrusted (non-SY/BA) owner")
	}

	if err := enforceProgramDataDirPermissions(dir); err != nil {
		t.Fatalf("enforceProgramDataDirPermissions: %v", err)
	}
	drifted, err = programDataDirACLDrifted(dir)
	if err != nil {
		t.Fatalf("programDataDirACLDrifted (post): %v", err)
	}
	if drifted {
		t.Error("drift must clear after the owner is repaired to SYSTEM")
	}
}

// TestConfigDirOwnerDriftDetectAndHealPreservesUsersRead covers the
// ProgramData ROOT self-heal path: a directory owned by an untrusted
// principal but already carrying the config dir's normal DACL (SY/BA full
// control, BUILTIN\Users read+traverse) must be flagged as drifted on owner
// alone, and repairing it must fix the owner WITHOUT touching the Users ACE —
// unlike the strict logs/data check, this path must never strip Helper read
// access.
func TestConfigDirOwnerDriftDetectAndHealPreservesUsersRead(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Breeze")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Seed the normal config-dir DACL (SY/BA full, BU read) without an owner
	// prefix — the pre-fix shape, and also what a directory pre-created by an
	// untrusted local principal before hardening would look like once only
	// its DACL (not owner) had been rewritten.
	if err := applyWindowsDACL(dir, `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)`); err != nil {
		t.Fatalf("seed hardened-DACL-but-unrepaired-owner dir: %v", err)
	}

	owner, _, err := func() (*windows.SID, bool, error) {
		sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err != nil {
			return nil, false, err
		}
		return sd.Owner()
	}()
	if err != nil {
		t.Fatalf("read seeded owner: %v", err)
	}
	if trustedMainAgentOwner(owner) {
		t.Skip("test process owner is already SYSTEM/Administrators — cannot exercise the untrusted-owner branch in this environment")
	}

	drifted, err := configDirOwnerDrifted(dir)
	if err != nil {
		t.Fatalf("configDirOwnerDrifted: %v", err)
	}
	if !drifted {
		t.Fatal("expected drift on a root dir with an untrusted owner, even with an otherwise-correct DACL")
	}

	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(Users): %v", err)
	}
	if err := enforceConfigDirPermissions(dir); err != nil {
		t.Fatalf("enforceConfigDirPermissions: %v", err)
	}

	drifted, err = configDirOwnerDrifted(dir)
	if err != nil {
		t.Fatalf("configDirOwnerDrifted (post): %v", err)
	}
	if drifted {
		t.Error("drift must clear once the owner is repaired to SYSTEM")
	}
	if !daclGrantsSID(t, dir, usersSID) {
		t.Error("repairing the root owner must NOT strip BUILTIN\\Users' read+traverse ACE — the Helper still needs to read agent.yaml")
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

// TestEnforceProgramDataTreeCreatesMissingDataDirTrusted covers the fresh
// non-MSI install: data\ does not exist when the startup pass runs. It must
// be created with the hardened descriptor (no Users ACE, trusted owner) and
// recorded as trusted in the same pass, so the first run can load code from
// it.
func TestEnforceProgramDataTreeCreatesMissingDataDirTrusted(t *testing.T) {
	base := t.TempDir()
	if err := createProgramDataDir(filepath.Join(base, "probe")); errors.Is(err, windows.ERROR_INVALID_OWNER) {
		t.Skip("test process may not assign BUILTIN\\Administrators as owner (not elevated)")
	} else if err != nil {
		t.Fatalf("probe create: %v", err)
	}
	data := filepath.Join(base, "data")
	swapDriftSeams(t, func() []string { return []string{data} }, programDataDirACLDrifted, enforceProgramDataDirPermissions)
	swapCreateSeam(t, createProgramDataDir)

	EnforceProgramDataTreePermissions()

	info, err := os.Stat(data)
	if err != nil || !info.IsDir() {
		t.Fatalf("missing data dir must be created, stat err=%v", err)
	}
	drifted, err := programDataDirACLDrifted(data)
	if err != nil {
		t.Fatalf("programDataDirACLDrifted: %v", err)
	}
	if drifted {
		t.Error("a data dir created by the startup pass must already carry the hardened owner and DACL")
	}
	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid(Users): %v", err)
	}
	if daclGrantsSID(t, data, usersSID) {
		t.Error("a created data dir must NOT grant BUILTIN\\Users")
	}
	if !ProgramDataDirTrusted(data) {
		t.Error("a data dir created hardened and verified in this pass must be trusted")
	}
}

// TestCreateProgramDataDirExistingReportsErrExist pins the contract the
// startup pass relies on to fall back to the drift check when another
// creator won the race.
func TestCreateProgramDataDirExistingReportsErrExist(t *testing.T) {
	dir := t.TempDir()
	if err := createProgramDataDir(dir); !errors.Is(err, os.ErrExist) {
		t.Fatalf("creating an existing dir must report os.ErrExist, got %v", err)
	}
}
