package main

import (
	"os"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// ensureHelperStateDir creates the macOS helper's process-local state dir
// (config.ProcessDataDir: ~/Library/Application Support/Breeze for the
// console-user helper, the shared data dir for the root login-window helper)
// as 0700 (#10870). It must run before the ECH dialer and the log shipper
// start: the ECH and DNS caches persist via CreateTemp+rename and do not
// create their directory themselves.
//
// Windows and Linux are untouched: their helpers keep the agent data dir,
// whose creation and ACLs the agent owns. The returned dir is "" there.
func ensureHelperStateDir(goos string, stateDir func() string) (string, error) {
	if goos != "darwin" {
		return "", nil
	}
	dir := stateDir()
	return dir, os.MkdirAll(dir, 0o700)
}

// recoverWallpaperAtStart runs wallpaper crash recovery in the macOS
// user-session helper (#10870). That helper is the process that suppresses
// and restores the console user's wallpaper, so a record left by a crash
// mid-session is its own, in its per-user state dir. The root agent's startup
// recovery can neither see that record nor act on it (a root daemon cannot
// set a user's desktop picture). The login-window helper runs as root against
// the shared data dir, where the agent's own startup recovery already looks.
// It reports whether recovery ran.
func recoverWallpaperAtStart(goos, desktopContext string, recoverWallpaper func()) bool {
	if goos != "darwin" || desktopContext != ipc.DesktopContextUserSession {
		return false
	}
	recoverWallpaper()
	return true
}
