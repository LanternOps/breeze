//go:build windows

package heartbeat

import (
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func watchdogExecutableName() string { return "breeze-watchdog.exe" }

// registerVerifiedWatchdog runs the verified watchdog's own `service install`
// (winsvcinstall: stage to Program Files, create or update the SCM entry, set
// recovery actions, start). The agent runs as LocalSystem.
func registerVerifiedWatchdog(stagedPath string) error {
	return runWatchdogInstallCommand(watchdogRegisterTimeout, stagedPath, "service", "install")
}

// waitWatchdogRunning polls the SCM for BreezeWatchdog reaching Running.
func waitWatchdogRunning(timeout time.Duration) bool {
	return pollWatchdogRunning(timeout, func() bool {
		m, err := mgr.Connect()
		if err != nil {
			return false
		}
		defer m.Disconnect()
		s, err := m.OpenService(windowsWatchdogServiceName)
		if err != nil {
			return false
		}
		defer s.Close()
		st, err := s.Query()
		return err == nil && st.State == svc.Running
	})
}
