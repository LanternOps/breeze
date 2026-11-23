//go:build windows

package watchdog

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// QueryAgentService asks SCM for the agent service's state and process id.
// Any failure, or a state this file does not map, reads as
// AgentServiceUnknown, never as stopped.
func QueryAgentService() AgentServiceStatus {
	backend, err := openWindowsServiceBackend(agentWindowsServiceName)
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: err.Error()}
	}
	defer backend.Close()
	status, err := backend.svc.Query()
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: fmt.Sprintf("query service %q: %v", backend.name, err)}
	}
	state, err := windowsServiceState(status.State)
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: err.Error()}
	}
	snap := serviceSnapshot{State: state, PID: windowsServicePID(status)}
	neverStarted := status.Win32ExitCode == uint32(windows.ERROR_SERVICE_NEVER_STARTED)
	return agentServiceStatusFromSnapshot(snap, neverStarted)
}
