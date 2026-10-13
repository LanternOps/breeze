//go:build windows

package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/config"
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

// verifyStagedWatchdog refuses a staged watchdog whose folder chain is
// writable by anyone but SYSTEM/Administrators (or not under the agent data
// dir at all). Same gate as the OpenH264 codec load.
func verifyStagedWatchdog(path string) error { return config.VerifyProgramDataPath(path) }
