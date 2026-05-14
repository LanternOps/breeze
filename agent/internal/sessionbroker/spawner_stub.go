//go:build !windows

package sessionbroker

import "fmt"

// SpawnedHelper is only populated on Windows. On other platforms helper
// spawning is handled by OS-level mechanisms (launchd LaunchAgent, systemd
// user service, XDG autostart), so the lifecycle manager does not track
// child processes directly.
//
// BinaryPath records which executable the spawner actually launched so
// callers can distinguish the GUI-subsystem sibling (breeze-user-helper.exe)
// from the console-subsystem agent fallback in their telemetry. Always
// empty on non-Windows builds since the stub never spawns.
type SpawnedHelper struct {
	PID        uint32
	BinaryPath string
}

// Close is a no-op on non-Windows platforms.
func (s *SpawnedHelper) Close() {}

// Wait is a no-op on non-Windows platforms. Returns (exitCode=-1, nil).
func (s *SpawnedHelper) Wait() (int, error) { return -1, nil }

// SpawnHelperInSession is only implemented on Windows.
// On other platforms the user helper is launched by the OS login mechanism
// (launchd LaunchAgent, systemd user service, XDG autostart).
func SpawnHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	return nil, fmt.Errorf("helper spawning not supported on this platform")
}

// SpawnUserHelperInSession is only implemented on Windows.
func SpawnUserHelperInSession(sessionID uint32) (*SpawnedHelper, error) {
	return nil, fmt.Errorf("user helper spawning not supported on this platform")
}
