//go:build windows

package logging

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// levelOverrideFileSDDL mirrors config.windowsConfigFileSDDL (agent.yaml):
// SYSTEM and Administrators full control, BUILTIN\Users read. It must be set
// explicitly — the config directory's Users ACE is not inheritable, so a new
// file there would otherwise be unreadable to user-context helpers, which
// would then report the unreadable file on every start. logging cannot import
// config (config imports logging), hence the duplicated constant.
const levelOverrideFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)`

func makeLevelOverrideFileReadable(path string) error {
	sd, err := windows.SecurityDescriptorFromString(levelOverrideFileSDDL)
	if err != nil {
		return fmt.Errorf("parse DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("extract DACL: %w", err)
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION)
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, info, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("set DACL on %s: %w", path, err)
	}
	return nil
}
