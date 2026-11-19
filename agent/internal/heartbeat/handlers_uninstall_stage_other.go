//go:build !windows

package heartbeat

import "errors"

// stageWindowsUninstallHelper exists only so the Windows hand-off compiles
// (and is tested) everywhere; prepareSelfUninstall never reaches it off
// Windows.
func stageWindowsUninstallHelper(string) (string, func(), error) {
	return "", nil, errors.New("the Windows self-uninstall helper is only staged on Windows")
}
