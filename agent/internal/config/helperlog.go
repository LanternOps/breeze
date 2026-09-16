package config

import (
	"os"
	"path/filepath"
	"runtime"
)

// helperLogDirBase is the per-user log directory macOS reserves for
// application logs, relative to the user's home directory.
var helperLogDirBase = filepath.Join("Library", "Logs", "Breeze")

// HelperLogDir returns the directory a helper process should write its own
// log file into.
//
// On macOS the root agent hardens the shared log directory
// (/Library/Application Support/Breeze/logs) to 0700 root-owned and
// *repairs* it back to 0700 before every open and rotation
// (logging.secureLogDirectory). The desktop-helper and user-helper run as
// the logged-in user via an Aqua LaunchAgent, so they can neither create
// nor append to a file in there: a manual `chmod 755` survives only until
// the agent next reopens agent.log, and a root-owned 0755 directory would
// not grant the user write access anyway. Those helpers therefore get a
// per-user location the LaunchAgent can always write (#5877).
//
// Every other case keeps the historical behaviour of sharing the agent's
// log directory: Linux and Windows helpers, and any macOS helper that does
// run as root (the login-window desktop-helper), where the shared
// directory is writable.
// The returned homeErr is diagnostic only: the directory is always
// usable-as-returned, but on darwin an unresolvable home directory means
// the caller falls back to the shared directory it cannot write. Callers
// log homeErr so that failure is attributed to "HOME could not be
// resolved" rather than looking like a plain permissions problem.
func HelperLogDir() (dir string, homeErr error) {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	return helperLogDir(runtime.GOOS, os.Geteuid(), home, LogDir()), err
}

// helperLogDir is the pure core of HelperLogDir, parameterised so the
// platform/euid/home matrix is testable on any host.
func helperLogDir(goos string, euid int, home string, sharedDir string) string {
	if goos != "darwin" || euid == 0 || home == "" {
		return sharedDir
	}
	return filepath.Join(home, helperLogDirBase)
}
