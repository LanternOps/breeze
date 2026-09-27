//go:build windows

package sessionbroker

import (
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// trustedInstallerSID is NT SERVICE\TrustedInstaller, which owns and has full
// control of %ProgramFiles% and much of what Windows installs under it.
const trustedInstallerSID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"

// installWriteMask is every right that lets a principal change a file's
// content, replace or delete it, add files to a directory, or rewrite the
// object's security.
const installWriteMask = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA |
	0x40 /* FILE_DELETE_CHILD */ | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER |
	windows.GENERIC_WRITE | windows.GENERIC_ALL

// helperBinaryInstallTrusted requires the helper binary and its directory to
// be owned by SYSTEM, Administrators or TrustedInstaller, and to grant no
// write, delete or re-ACL right to any other principal — the shape of a
// per-machine MSI install under %ProgramFiles%.
func helperBinaryInstallTrusted(path string) error {
	if err := adminOnlyWritable(path); err != nil {
		return err
	}
	return adminOnlyWritable(filepath.Dir(path))
}

func adminOnlyWritable(path string) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("%s: read security info: %w", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("%s: read owner: %w", path, err)
	}
	if !trustedInstallPrincipal(owner) {
		return fmt.Errorf("%s: owner %s is not SYSTEM, Administrators or TrustedInstaller", path, owner.String())
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("%s: read DACL: %w", path, err)
	}
	if dacl == nil {
		return fmt.Errorf("%s: no DACL (everyone has full access)", path)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return fmt.Errorf("%s: read ACE %d: %w", path, i, err)
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue // applies to children only, not this object
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE:
			continue
		case windows.ACCESS_ALLOWED_ACE_TYPE:
		default:
			return fmt.Errorf("%s: unsupported ACE type %d", path, ace.Header.AceType)
		}
		if uint32(ace.Mask)&installWriteMask == 0 {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !trustedInstallPrincipal(sid) {
			return fmt.Errorf("%s: %s may modify it", path, sid.String())
		}
	}
	return nil
}

func trustedInstallPrincipal(sid *windows.SID) bool {
	if sid == nil {
		return false
	}
	if sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return true
	}
	return sid.String() == trustedInstallerSID
}
