//go:build windows

package config

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The Breeze Helper ("Breeze Assist") runs in the logged-in user's session,
// while the agent (SYSTEM) writes these files. The config dir and agent.yaml
// grant BUILTIN\Users read so the Helper can read the server URL, agent ID, and
// helper-scoped token — restoring the default ProgramData ACL that #568's
// PROTECTED DACL stripped. SYSTEM and Administrators keep full control. The
// directory's Users ACE is read+traverse (FRFX) and intentionally NOT
// inheritable, so it never propagates to secrets.yaml. The full agent/watchdog
// tokens and mTLS keys live ONLY in secrets.yaml, which stays SYSTEM +
// Administrators (never Users).
const (
	windowsConfigDirSDDL  = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)`
	windowsConfigFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)`
	windowsSecretFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)`

	// windowsProgramDataDirSDDL mirrors the MSI HardenProgramDataAcl action
	// (icacls /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F):
	// SYSTEM and Administrators get full control, container+object inheritable,
	// the DACL is PROTECTED (no inheritance), and BUILTIN\Users gets NOTHING.
	// Unlike the config dir — which intentionally grants Users read so the
	// Breeze Helper can read agent.yaml — the logs/data trees must never be
	// Users-readable or -writable.
	windowsProgramDataDirSDDL = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
)

func enforceConfigDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigDirSDDL)
}

func enforceConfigFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigFileSDDL)
}

func enforceSecretFilePermissionsImpl(path string) error {
	return applyWindowsDACL(path, windowsSecretFileSDDL)
}

// enforceSecretFilePermissions is a package-level var so tests can inject a
// failure to verify that SaveTo propagates it as a fatal error. Production
// code always routes through enforceSecretFilePermissionsImpl.
var enforceSecretFilePermissions = enforceSecretFilePermissionsImpl

// enforceProgramDataDirPermissions re-applies the PROTECTED DACL (SYSTEM +
// Administrators full, no Users) to a ProgramData logs/data dir, self-healing
// the drift left when the MSI HardenProgramDataAcl action was skipped or
// blocked. See permissions_drift.go.
func enforceProgramDataDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsProgramDataDirSDDL)
}

// programDataDirACLDrifted reports whether path still carries a BUILTIN\Users
// allow ACE — the signature of the default ProgramData ACL, i.e. the MSI
// hardening never ran or was blocked. A hardened dir grants only SYSTEM and
// Administrators, so the presence of a Users ACE is the drift signal.
func programDataDirACLDrifted(path string) (bool, error) {
	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		return false, fmt.Errorf("create Users SID: %w", err)
	}
	sd, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return false, fmt.Errorf("get security info on %s: %w", path, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return false, fmt.Errorf("extract DACL on %s: %w", path, err)
	}
	if dacl == nil {
		return false, nil
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			continue
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID.Equals(usersSID) {
			return true, nil
		}
	}
	return false, nil
}

func applyWindowsDACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("parse DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("extract DACL: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set DACL on %s: %w", path, err)
	}
	return nil
}
