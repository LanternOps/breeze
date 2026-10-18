//go:build windows

package watchdoginstall

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/serviceinstall"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

// WindowsServiceName is the SCM name `breeze-watchdog service install`
// registers.
const WindowsServiceName = "BreezeWatchdog"

// Detect reports whether the watchdog is registered: the protected Program
// Files binary and the BreezeWatchdog SCM entry.
func Detect(stat StatFunc) Status {
	bin, err := serviceinstall.ProtectedBinaryPath("breeze-watchdog.exe")
	if err != nil {
		return StatusUnknown
	}
	return detectService(stat, bin, scmServiceExists)
}

func scmServiceExists() (bool, error) {
	m, err := mgr.Connect()
	if err != nil {
		return false, err
	}
	defer m.Disconnect()
	s, err := m.OpenService(WindowsServiceName)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return false, nil
		}
		return false, err
	}
	_ = s.Close()
	return true, nil
}
