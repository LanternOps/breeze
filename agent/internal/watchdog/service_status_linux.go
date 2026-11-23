//go:build linux

package watchdog

import (
	"context"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// serviceQueryTimeout bounds a service-manager status query. It runs on the
// watchdog main loop, which also services shutdown.
const serviceQueryTimeout = 5 * time.Second

// QueryAgentService asks systemd for the agent unit's state and main PID.
// Any failure reads as AgentServiceUnknown, never as stopped.
func QueryAgentService() AgentServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), serviceQueryTimeout)
	defer cancel()
	out, err := procspawn.CommandContext(ctx, "systemctl", "show",
		"--property=LoadState", "--property=ActiveState", "--property=MainPID",
		agentServiceName).Output()
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: strings.TrimSpace(err.Error())}
	}
	return parseSystemctlShow(string(out))
}
