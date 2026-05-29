//go:build windows

package config

import (
	"fmt"

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
)

func enforceConfigDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigDirSDDL)
}

func enforceConfigFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigFileSDDL)
}

func enforceSecretFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsSecretFileSDDL)
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
