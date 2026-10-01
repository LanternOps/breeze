//go:build windows

package bmr

import "errors"

// errWindowsLiveSystemState: a Windows recovery never applies system state
// to the running system. RunRecoveryContext does not reach the restorer on
// Windows (deferWindowsSystemState); the bare-metal rebuild applies the
// state offline (RestoreSystemStateOfflineWindows). This is a guard should
// anything call it anyway.
var errWindowsLiveSystemState = errors.New("bmr: system state is applied by a bare-metal rebuild, not to the running Windows system")

// windowsRestorer refuses every live system-state operation.
type windowsRestorer struct{}

func newRestorer() Restorer {
	return &windowsRestorer{}
}

// RestoreSystemState refuses: see errWindowsLiveSystemState.
func (r *windowsRestorer) RestoreSystemState(string) error {
	return errWindowsLiveSystemState
}

// InjectDrivers refuses: see errWindowsLiveSystemState.
func (r *windowsRestorer) InjectDrivers(string) (int, error) {
	return 0, errWindowsLiveSystemState
}
