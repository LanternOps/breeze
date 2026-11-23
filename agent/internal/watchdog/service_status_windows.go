//go:build windows

package watchdog

// QueryAgentService asks SCM for the agent service's state and process id.
// Any failure, or a state this file does not map, reads as
// AgentServiceUnknown, never as stopped.
func QueryAgentService() AgentServiceStatus {
	backend, err := openWindowsServiceBackend(agentWindowsServiceName)
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: err.Error()}
	}
	defer backend.Close()
	snap, err := backend.Query()
	if err != nil {
		return AgentServiceStatus{State: AgentServiceUnknown, Detail: err.Error()}
	}
	return agentServiceStatusFromSnapshot(snap)
}
