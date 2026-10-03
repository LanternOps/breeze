//go:build windows

package main

import (
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// defaultConsoleHost is the WinPE media host: newWinPEConsoleHost over the
// real Windows rebuild engine and this executable's directory.
func defaultConsoleHost() consoleHost {
	var ws winPEProbe
	if s := rebuild.NewWinSystem(); s != nil {
		ws = s
	}
	return newWinPEConsoleHost(ws, executableDir())
}

// executableDir is the directory holding this binary (X:\breeze on the
// media), with symlinks resolved. "" when it cannot be determined; the
// media-relative paths are then left empty (no cmdline, nothing baked), so
// the guard refuses rather than reading files from the working directory.
func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}
