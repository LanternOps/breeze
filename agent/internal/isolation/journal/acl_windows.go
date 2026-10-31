//go:build windows

package journal

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// journalSDDL is a protected DACL (nothing inherited from the data directory)
// granting full control to SYSTEM and the local Administrators group only:
// the Windows equivalent of mode 0600 for a service that runs as SYSTEM.
// Administrators stay on it so an elevated `containment` CLI and the test
// suite (which runs elevated, not as SYSTEM) can read the journal; the agent's
// private directories use the same pair (securefs privateDirSDDLPrefix).
const journalSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)"

// restrictFile replaces the temp file's DACL before any content is written.
func restrictFile(_ *os.File, path string) error {
	sd, err := windows.SecurityDescriptorFromString(journalSDDL)
	if err != nil {
		return fmt.Errorf("build journal security descriptor: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("read journal DACL: %w", err)
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

// syncDir is a no-op on Windows: a directory handle cannot be fsynced there,
// and atomicrename.Replace's rename is durable once it returns.
func syncDir(string) error { return nil }
