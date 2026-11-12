//go:build windows

package procoutput

import (
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/psscript"
)

const powershellUTF8Bootstrap = "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "

// WindowsScriptCommand adjusts shell argv so script invocations emit UTF-8 on
// Windows consoles before output is captured.
func WindowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) (string, []string) {
	switch strings.ToLower(filepath.Base(shellCmd)) {
	case "powershell.exe", "pwsh.exe":
		return shellCmd, []string{
			"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			powershellUTF8Bootstrap + "& " + psscript.Quote(scriptPath),
		}
	case "cmd.exe":
		// GetShellCommand returns ["/C"]; run chcp before the script/batch file.
		args := append(append([]string{}, shellArgs...), "chcp 65001 >nul & "+scriptPath)
		return shellCmd, args
	default:
		return shellCmd, append(append([]string{}, shellArgs...), scriptPath)
	}
}
