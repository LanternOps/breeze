//go:build windows

package config

import (
	"fmt"

	"golang.org/x/sys/windows"
)

const (
	windowsConfigDirSDDL  = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`
	windowsConfigFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)`
)

func enforceConfigDirPermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigDirSDDL)
}

func enforceConfigFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigFileSDDL)
}

func enforceSecretFilePermissions(path string) error {
	return applyWindowsDACL(path, windowsConfigFileSDDL)
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
