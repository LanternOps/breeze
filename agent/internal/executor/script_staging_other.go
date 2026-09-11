//go:build !windows

package executor

import "os"

// createPrivateScriptDir returns a fresh 0700 directory created atomically by
// the OS. A fixed shared /tmp tree can be pre-created by a less-privileged
// helper, which could then replace a root script between write and interpreter
// open; a per-execution private directory removes that opportunity without
// changing interpreter invocation semantics.
func createPrivateScriptDir() (string, error) {
	return os.MkdirTemp("", "breeze-scripts-")
}
