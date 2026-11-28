//go:build windows

package patching

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/config"
)

// trustPendingRecordFile refuses a pending-restart record outside a data
// directory whose protected ACL (SYSTEM and Administrators only) was verified
// or repaired at this agent start (config.EnforceProgramDataTreePermissions).
// A standard user can neither write nor delete a file there, so cannot
// schedule or cancel a restart through it. A link is refused outright.
func trustPendingRecordFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file (mode %s)", info.Mode())
	}
	if dir := filepath.Dir(path); !config.ProgramDataDirTrusted(dir) {
		return fmt.Errorf("data directory %s has not been verified as SYSTEM/Administrators-only", dir)
	}
	return nil
}
