package main

import (
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// ensureHelperStateDir creates the console-user macOS helper's state dir
// (config.ProcessDataDir: ~/Library/Application Support/Breeze) as 0700 and
// proves it is writable (#10870). It must run before the ECH dialer and the
// log shipper start: the ECH and DNS caches persist via CreateTemp+rename and
// do not create their directory themselves.
//
// The write probe is what makes a bad resolution visible. When HOME cannot be
// resolved, ProcessDataDir falls back to the root-only agent data dir, which
// already exists, so MkdirAll alone would succeed and the original symptoms
// would come back with nothing in the log naming the cause.
//
// It does nothing for a root helper (the login-window helper), whose state is
// the agent data dir that the agent creates and owns, or off macOS, where the
// helpers keep the agent data dir. The returned dir is "" then.
func ensureHelperStateDir(goos string, euid int, stateDir func() string) (string, error) {
	if goos != "darwin" || euid == 0 {
		return "", nil
	}
	dir := stateDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return dir, err
	}
	probe, err := os.CreateTemp(dir, ".breeze-write-check-*")
	if err != nil {
		return dir, fmt.Errorf("state dir is not writable by this user (is HOME set?): %w", err)
	}
	name := probe.Name()
	_ = probe.Close()
	_ = os.Remove(name)
	return dir, nil
}

// recoverWallpaperAtStart runs wallpaper crash recovery in the console-user
// macOS helper (#10870). That helper suppresses and restores the user's
// wallpaper, so a record left by a crash mid-session is its own, in its
// per-user state dir. The root agent's startup recovery can neither see that
// record nor act on it (a root daemon cannot set a user's desktop picture).
// The login-window helper, and any helper started as root, resolves to the
// agent data dir where the agent's own startup recovery already looks, so it
// is skipped. It reports whether recovery ran.
func recoverWallpaperAtStart(goos string, euid int, desktopContext string, recoverWallpaper func()) bool {
	if goos != "darwin" || euid == 0 || desktopContext != ipc.DesktopContextUserSession {
		return false
	}
	recoverWallpaper()
	return true
}
