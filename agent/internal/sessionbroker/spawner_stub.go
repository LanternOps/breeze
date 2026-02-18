//go:build !windows

package sessionbroker

import "fmt"

// SpawnHelperInSession is only implemented on Windows.
// On other platforms the user helper is launched by the OS login mechanism
// (launchd LaunchAgent, systemd user service, XDG autostart).
func SpawnHelperInSession(sessionID uint32) error {
	return fmt.Errorf("helper spawning not supported on this platform")
}
