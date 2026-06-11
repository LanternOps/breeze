//go:build windows

package serviceinstall

import (
	"fmt"
	"path/filepath"

	"golang.org/x/sys/windows"
)

const (
	protectedInstallDirSDDL = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)`
	protectedBinaryFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)`
)

func HardenProtectedBinaryACL(binaryPath string) error {
	if err := applyDACL(filepath.Dir(binaryPath), protectedInstallDirSDDL); err != nil {
		return fmt.Errorf("harden protected service install directory ACL: %w", err)
	}
	if err := applyDACL(binaryPath, protectedBinaryFileSDDL); err != nil {
		return fmt.Errorf("harden protected service binary ACL: %w", err)
	}
	return nil
}

func applyDACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	)
}
