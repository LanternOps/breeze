//go:build windows

package patching

import (
	"os/exec"
	"syscall"
)

// hideWindowCmd suppresses the console window that would otherwise flash
// briefly when the SYSTEM agent process spawns winget.exe / powershell.exe.
func hideWindowCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
