//go:build windows

package procoutput

import (
	"os/exec"
	"syscall"
)

// WindowsScriptCommand returns how to start scriptPath with the given shell so
// its output is UTF-8 before it is captured.
func WindowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) ScriptCommand {
	return windowsScriptCommand(shellCmd, shellArgs, scriptPath)
}

// SetCmdLine makes cmd start with exactly line as its command line, keeping
// any other SysProcAttr settings. An empty line leaves cmd unchanged.
func SetCmdLine(cmd *exec.Cmd, line string) {
	if line == "" {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CmdLine = line
}
