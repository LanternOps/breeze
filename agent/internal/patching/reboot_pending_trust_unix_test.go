//go:build !windows

package patching

import "testing"

// trustDataDirForTest is a no-op off Windows: the unix trust check reads the
// temp directory's real owner and mode.
func trustDataDirForTest(*testing.T, string) {}
