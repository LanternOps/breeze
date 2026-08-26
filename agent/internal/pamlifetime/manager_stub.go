package pamlifetime

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
)

type stubManager struct {
	store   *Store
	mu      sync.RWMutex
	enabled bool
}

func NewManager(store *Store) *stubManager {
	return &stubManager{store: store}
}

func (m *stubManager) ProtocolVersion() int { return 0 }

func (m *stubManager) Apply(_ context.Context, cmd ApplyCommand) Result {
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

func failedResult(actuationID string, generation uint64, code string) Result {
	return Result{
		ProtocolVersion: 2,
		ObservationID:   uuid.NewString(),
		ActuationID:     actuationID,
		Generation:      generation,
		State:           ResultFailed,
		ObservedAt:      time.Now().UTC(),
		FailureCode:     code,
		Evidence:        ResultEvidence{},
	}
}
