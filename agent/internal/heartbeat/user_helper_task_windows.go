//go:build windows

package heartbeat

import (
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
	"github.com/breeze-rmm/agent/internal/userhelpertask"
	"golang.org/x/sys/windows/svc/mgr"
)

// startUserHelperTaskRepair starts the logon task repair loop (#12580) for the
// installed agent running as the service; never for a support session or a
// foreground run, which do not own the machine's install.
func (h *Heartbeat) startUserHelperTaskRepair() {
	if h.config == nil || !h.config.IsService || !h.config.IsInstalledAgent || h.config.SupportMode {
		return
	}
	repairer := userhelpertask.NewWindows(config.GetDataDir(), userHelperTaskUninstalling)
	go func() {
		defer observability.Recoverer("heartbeat.userHelperTaskRepair")
		h.runUserHelperTaskRepair(repairer, defaultUserHelperTaskTiming, userHelperTaskRand, h.stopChan, h.userHelperTaskKick)
	}()
}

var scmReadWarned atomic.Bool

// userHelperTaskUninstalling reports an uninstall in progress: this process's
// own self_uninstall hand-off, or the agent service set to disabled, which is
// what phase 1 of a self-uninstall leaves for any agent process that outlives
// it. An unreadable service configuration counts as uninstalling: the repair
// fails closed.
func userHelperTaskUninstalling() bool {
	if selfUninstallInProgress.Load() || uninstallHelperWatch.Load() != nil {
		return true
	}
	disabled, err := agentServiceDisabled()
	if err != nil {
		if scmReadWarned.CompareAndSwap(false, true) {
			log.Warn("could not read the agent service configuration; not repairing the user-helper logon task",
				"error", err.Error())
		}
		return true
	}
	return disabled
}

func agentServiceDisabled() (bool, error) {
	m, err := mgr.Connect()
	if err != nil {
		return false, err
	}
	defer func() { _ = m.Disconnect() }()
	s, err := m.OpenService(selfuninstall.AgentServiceName)
	if err != nil {
		return false, err
	}
	defer func() { _ = s.Close() }()
	cfg, err := s.Config()
	if err != nil {
		return false, err
	}
	return cfg.StartType == mgr.StartDisabled, nil
}
