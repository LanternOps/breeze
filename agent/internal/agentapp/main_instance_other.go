//go:build !windows

package agentapp

type noopMainAgentGuard struct{}

func acquireMainAgentGuard(ProcessStartup) (mainAgentGuard, error) {
	return noopMainAgentGuard{}, nil
}

func (noopMainAgentGuard) Close() error { return nil }
