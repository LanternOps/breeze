//go:build darwin

package watchdog

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// serviceQueryTimeout bounds a service-manager status query. It runs on the
// watchdog main loop, which also services shutdown.
const serviceQueryTimeout = 5 * time.Second

// QueryAgentService asks launchd for the agent job's state and PID. Any
// failure, including a job launchd does not know, reads as
// AgentServiceUnknown, never as stopped.
func QueryAgentService() AgentServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), serviceQueryTimeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, "launchctl", "print", "system/"+agentServiceLabel).Output()
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: serviceQueryErrorDetail(err)}
	}
	return parseLaunchctlPrint(string(out))
}
