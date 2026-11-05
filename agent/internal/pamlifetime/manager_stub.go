//go:build !windows

package pamlifetime

import (
	"context"
	"errors"
	"sync"
)

type stubManager struct {
	store    *Store
	mu       sync.RWMutex
	enabled  bool
	declines DeclineChecker
}

func NewManager(store *Store) *stubManager {
	return &stubManager{store: store}
}

func (m *stubManager) ProtocolVersion() int { return 0 }
func (m *stubManager) Available() bool      { return false }

func (*stubManager) AcquireLegacyActuation(context.Context) (func(), error) {
	return nil, errors.New("PAM legacy actuation unavailable on this platform")
}

// SetDeclineChecker installs the end user's decision record (#8971). nil
// disables the check.
func (m *stubManager) SetDeclineChecker(checker DeclineChecker) {
	m.mu.Lock()
	m.declines = checker
	m.mu.Unlock()
}

func (m *stubManager) Apply(_ context.Context, cmd ApplyCommand) Result {
	m.mu.RLock()
	checker := m.declines
	m.mu.RUnlock()
	if checker != nil {
		if refuse, code := checker.Check(cmd.RequestID); refuse {
			return failedResult(cmd.ActuationID, cmd.Generation, code)
		}
	}
	if _, err := m.store.PrepareApply(cmd); err != nil {
		return failedResult(cmd.ActuationID, cmd.Generation, "invalid_command")
	}
	return failedResult(cmd.ActuationID, cmd.Generation, FailureUnsupportedPlatform)
}

func (m *stubManager) Cleanup(_ context.Context, cmd CleanupCommand) Result {
	if _, err := m.store.PrepareCleanup(cmd); err != nil {
		return failedResult(cmd.ActuationID, cmd.Generation, "invalid_command")
	}
	return failedResult(cmd.ActuationID, cmd.Generation, FailureUnsupportedPlatform)
}

func (m *stubManager) Reconcile(context.Context) []Result { return nil }

func (m *stubManager) SetEnabled(_ context.Context, enabled bool) error {
	m.mu.Lock()
	m.enabled = enabled
	m.mu.Unlock()
	return nil
}
