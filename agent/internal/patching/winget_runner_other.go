//go:build !windows

package patching

import "os/exec"

// hideWindowCmd is a no-op on non-Windows platforms, which have no console
// window to hide.
func hideWindowCmd(cmd *exec.Cmd) {}
