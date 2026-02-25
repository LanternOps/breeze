//go:build !windows

package sessionbroker

import "context"

// SCMSessionEvent is a no-op placeholder on non-Windows platforms.
type SCMSessionEvent struct {
	EventType uint32
	SessionID uint32
}

// HelperLifecycleManager is a no-op on non-Windows platforms.
// Helper spawning is only needed for Windows services running in Session 0.
type HelperLifecycleManager struct{}

// NewHelperLifecycleManager returns a no-op lifecycle manager on non-Windows.
func NewHelperLifecycleManager(_ *Broker, _ <-chan SCMSessionEvent) *HelperLifecycleManager {
	return &HelperLifecycleManager{}
}

// Start is a no-op on non-Windows platforms.
func (m *HelperLifecycleManager) Start(ctx context.Context) {
	<-ctx.Done()
}
