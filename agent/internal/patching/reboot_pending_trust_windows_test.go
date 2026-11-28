//go:build windows

package patching

import (
	"path/filepath"
	"testing"
)

// trustDataDirForTest stands in for the agent-start ACL verification
// (config.EnforceProgramDataTreePermissions), which hardens the real
// ProgramData folders and so cannot run on a temp directory. Only dir is
// trusted; everything else about the record (a regular file, not a link, the
// same file checked and read) is still checked for real.
func trustDataDirForTest(t *testing.T, dir string) {
	t.Helper()
	prev := programDataDirTrusted
	want := filepath.Clean(dir)
	programDataDirTrusted = func(d string) bool { return filepath.Clean(d) == want || prev(d) }
	t.Cleanup(func() { programDataDirTrusted = prev })
}
