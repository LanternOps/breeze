//go:build windows

package procoutput

import (
	"path/filepath"
	"strings"
)

const powershellUTF8Bootstrap = "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "

// WindowsScriptCommand adjusts shell argv so script invocations emit UTF-8 on
// Windows consoles before output is captured.
func WindowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) (string, []string) {
	switch strings.ToLower(filepath.Base(shellCmd)) {
	case "powershell.exe", "pwsh.exe":
		quoted := escapePowerShellSingleQuotedPath(scriptPath)
		return shellCmd, []string{
			"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			powershellUTF8Bootstrap + "& '" + quoted + "'",
		}
	case "cmd.exe":
		// GetShellCommand returns ["/C"]; run chcp before the script/batch file.
		args := append(append([]string{}, shellArgs...), "chcp 65001 >nul & "+scriptPath)
		return shellCmd, args
	default:
		return shellCmd, append(append([]string{}, shellArgs...), scriptPath)
	}
}

func escapePowerShellSingleQuotedPath(path string) string {
	return strings.ReplaceAll(path, "'", "''")
}
