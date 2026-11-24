//go:build windows

package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
	"github.com/breeze-rmm/agent/internal/userhelpertask"
	"golang.org/x/sys/windows/svc/mgr"
)

// startUserHelperTaskRepair starts the logon task repair loop (#12580); see
// userHelperTaskRepairEnabled for where it runs.
func (h *Heartbeat) startUserHelperTaskRepair() {
	if !userHelperTaskRepairEnabled(h.config) {
		return
	}
	repairer := userhelpertask.NewWindows(config.GetDataDir(), func() (bool, error) {
		return userHelperTaskUninstallState(agentServiceDisabled)
	})
	go func() {
		defer observability.Recoverer("heartbeat.userHelperTaskRepair")
		h.runUserHelperTaskRepair(repairer, defaultUserHelperTaskTiming, userHelperTaskRand, h.stopChan, h.userHelperTaskKick)
	}()
}

// agentServiceDisabled reads whether the agent's own service is configured
// start=disabled.
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
