//go:build !windows

package procoutput

// WindowsScriptCommand is a no-op on non-Windows platforms.
func WindowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) (string, []string) {
	return shellCmd, append(append([]string{}, shellArgs...), scriptPath)
}
