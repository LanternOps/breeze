//go:build !windows

package sessionbroker

import "context"

// NewHelperLifecycleManager returns a no-op lifecycle manager on non-Windows.
func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent, modeOverride string) *HelperLifecycleManager {
	m := newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, nil)
	m.mode = resolveLifecycleMode(modeOverride, detectRDSHost())
	return m
}

// Start is a no-op on non-Windows platforms.
func (m *HelperLifecycleManager) Start(ctx context.Context) {
	defer m.finishStart()
	select {
	case <-ctx.Done():
	case <-m.stopCh:
	}
}
