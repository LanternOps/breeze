//go:build !windows

package procoutput

import "os/exec"

// WindowsScriptCommand passes the script path as the last argument on
// non-Windows platforms.
func WindowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) ScriptCommand {
	return ScriptCommand{Name: shellCmd, Args: append(append([]string{}, shellArgs...), scriptPath)}
}

// SetCmdLine is a no-op on non-Windows platforms.
func SetCmdLine(cmd *exec.Cmd, line string) {}
