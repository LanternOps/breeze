package config

import (
	"os"
	"path/filepath"
	"runtime"
)

// userStateDirBase is the per-user directory macOS reserves for application
// state, relative to the user's home directory.
var userStateDirBase = filepath.Join("Library", "Application Support", "Breeze")

// ProcessDataDir returns the directory this process keeps its own
// process-local state in: caches and recovery records that a Breeze process
// writes for itself and reads back on its next start. Today that is the ECH
// config cache, the DNS last-known-good cache and the wallpaper
// crash-recovery record.
//
// For every process except one, this is GetDataDir(). The exception is a
// macOS process running as a non-root user, which in practice is the
// console-user desktop helper (an Aqua LaunchAgent). The agent keeps
// /Library/Application Support/Breeze/data 0700 root:breeze, so that helper
// could neither read nor write anything there (#10870): the wallpaper
// recovery record was never written and the ECH cache started empty every
// time. It gets ~/Library/Application Support/Breeze instead, the state-side
// twin of the ~/Library/Logs/Breeze directory HelperLogDir gives its log
// (#5877), and the daemon's data dir stays root-private.
//
// Kept unchanged:
//   - root processes on macOS (the agent daemon, the watchdog, the
//     login-window desktop helper), where the shared dir is writable;
//   - Windows and Linux, whatever the process identity;
//   - a process with a registered user workspace (Quick Support), whose
//     GetDataDir is already private to it;
//   - a macOS process whose home directory cannot be resolved to an absolute
//     path, which falls back to the shared dir. The desktop helper's startup
//     write probe reports that case.
//
// Never put anything a process will load as code here: on macOS the result
// is user-writable. The OpenH264 codec is staged by the root agent in a
// root-owned directory instead (encoder_openh264_dl_other.go). Use
// GetDataDir, not this, for agent-owned state another process must find: a
// per-user path is invisible to the root agent.
func ProcessDataDir() string {
	shared := GetDataDir()
	if registeredUserWorkspace() != "" {
		return shared
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return processDataDir(runtime.GOOS, os.Geteuid(), home, shared)
}

// processDataDir is the pure core of ProcessDataDir, parameterised so the
// platform/euid/home matrix is testable on any host.
func processDataDir(goos string, euid int, home, sharedDir string) string {
	if goos != "darwin" || euid == 0 || home == "" || !filepath.IsAbs(home) {
		return sharedDir
	}
	return filepath.Join(home, userStateDirBase)
}
