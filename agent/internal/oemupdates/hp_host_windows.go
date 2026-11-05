//go:build windows

package oemupdates

import (
	"os"
	"path/filepath"
)

func hpSMBIOSIdentity() (string, string, error) { return readSMBIOSIdentity() }

// hpPowerShellPath is run by full path, never looked up: this runs as SYSTEM.
func hpPowerShellPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	return filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}
