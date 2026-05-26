//go:build windows

package pam

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// cacheFileSDDL: SYSTEM and BUILTIN\Administrators get full access; no
// inheritance, no other principals. Matches the windowsConfigFileSDDL pattern
// at agent/internal/config/permissions_windows.go:13.
//
// Format: D:P(A;;FA;;;SY)(A;;FA;;;BA)
//   D:P        — discretionary ACL, protected (no inheritance from parent)
//   (A;;FA;;;SY) — Allow / no flags / Full Access / SYSTEM
//   (A;;FA;;;BA) — Allow / no flags / Full Access / BUILTIN\Administrators
//
// Deliberately omits BUILTIN\Users (BU) because the IPC helper and the rule
// engine both run as SYSTEM. A logged-in user has no business reading PAM rules
// on disk — those would leak the enforcement policy.
const cacheFileSDDL = `D:P(A;;FA;;;SY)(A;;FA;;;BA)`

// applyCacheACL pins the file's DACL to SYSTEM+Admins only. Same call shape as
// applyWindowsDACL at agent/internal/config/permissions_windows.go:28.
func applyCacheACL(path string) error {
	sd, err := windows.SecurityDescriptorFromString(cacheFileSDDL)
	if err != nil {
		return fmt.Errorf("pam: parse cache DACL: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("pam: extract cache DACL: %w", err)
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
		return fmt.Errorf("pam: set DACL on %s: %w", path, err)
	}
	return nil
}
